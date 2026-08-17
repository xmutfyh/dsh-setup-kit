/**
 * Cross-agent session search for DeepSeek Harness.
 *
 * Searches past conversations from dsh, Codex, Claude Code, pi, and OpenCode
 * directly from their source artifacts and exposes two model-facing tools:
 *
 * - `agent_session_search` — literal search across parsed sessions, grouped
 *   by session, returning the strongest match, a snippet, and a message window.
 * - `agent_session_read` — read one session's metadata and a message window.
 *
 * Everything is read-only: source artifacts are only opened for reading and
 * opencode.db is opened with `query_only`. The plugin creates no database,
 * index, or persistent cache of its own.
 *
 * @module @dsh-external/dsh-session-search
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { discoverFiles } from './discovery.js';
import { readArtifactSession, searchArtifacts } from './search.js';
/** Cordis plugin name used by Loader diagnostics. */
export const name = 'dsh-session-search';
/** Capability services required by the model-facing consumer. */
export const inject = ['tools', 'systemPrompt'];
/** Default maximum sessions returned by one search call. */
export const DEFAULT_MAX_RESULTS = 10;
/** Default window size for session reads. */
export const DEFAULT_READ_WINDOW = 10;
/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config = z.object({
    sources: z.object({
        dsh: z.boolean(),
        codex: z.boolean(),
        claude: z.boolean(),
        pi: z.boolean(),
        opencode: z.boolean(),
    }),
    roots: z.object({
        dsh: z.string(),
        codex: z.string(),
        claude: z.string(),
        pi: z.string(),
        opencode: z.string(),
    }),
    maxResults: z.number().step(1).min(1).max(100).default(DEFAULT_MAX_RESULTS),
    readWindow: z.number().step(1).min(1).max(50).default(DEFAULT_READ_WINDOW),
});
const TEXT_OUTPUT = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
};
const PROMPT_TEXT = 'Use agent_session_search to find relevant work from prior sessions across dsh, Codex, '
    + 'Claude Code, pi, and OpenCode, then agent_session_read to view a full message window '
    + 'of one hit. Search is a case-insensitive literal scan over user/assistant messages; tool output is excluded. '
    + 'Results are read-only snapshots of past conversations on this machine.';
const SOURCE_IDS = ['dsh', 'codex', 'claude', 'pi', 'opencode'];
/** Register the search tools and their shared model guidance. */
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    ctx.systemPrompt.section({
        name: 'tool:dsh-session-search',
        order: 115,
        text: PROMPT_TEXT,
    });
    ctx.tools.register(defineTool({
        name: 'agent_session_search',
        description: 'Search prior sessions from dsh, Codex, Claude Code, pi, and OpenCode with a case-insensitive literal scan; returns the strongest matching message per session with a snippet and message window.',
        parameters: {
            query: { type: 'string', required: true, description: 'Literal text to find in user and assistant messages.' },
            sources: { type: 'array', items: { type: 'string', enum: SOURCE_IDS }, description: 'Restrict to these sources; omit for all.' },
            cwd: { type: 'string', description: 'Restrict to sessions whose working directory contains this substring.' },
            sort: { type: 'string', enum: ['relevance', 'newest', 'oldest'], description: 'Result ordering; defaults to relevance.' },
            limit: { type: 'number', description: `Maximum sessions to return (default ${resolved.maxResults}).` },
        },
        output: TEXT_OUTPUT,
        execute: async (args, exec) => {
            const query = typeof args.query === 'string' ? args.query : '';
            const sources = args.sources ?? [];
            const sort = args.sort === 'newest' || args.sort === 'oldest' ? args.sort : 'relevance';
            const limit = typeof args.limit === 'number' && Number.isSafeInteger(args.limit) && args.limit > 0
                ? Math.min(args.limit, resolved.maxResults)
                : resolved.maxResults;
            const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : undefined;
            const enabled = sources.length === 0
                ? resolved.enabled
                : new Set(sources.filter(source => resolved.enabled.has(source)));
            const files = await discoverFiles(enabled, resolved.roots);
            const hits = await searchArtifacts(files, enabled, { query, sources, cwd, limit, sort, window: resolved.readWindow }, exec.signal);
            return JSON.stringify({
                query,
                count: hits.length,
                hits: hits.map(hit => ({
                    source: hit.session.source,
                    sessionId: hit.session.sessionId,
                    title: hit.session.title,
                    cwd: hit.session.cwd,
                    updatedAt: hit.session.updatedAt,
                    snippet: hit.snippet,
                    bestMatch: {
                        role: hit.bestMatch.role,
                        seq: hit.bestMatch.seq,
                        text: clip(hit.bestMatch.content),
                    },
                    window: hit.window.map(m => ({
                        seq: m.seq,
                        role: m.role,
                        text: clip(m.content),
                    })),
                })),
            }, null, 2) ?? '';
        },
    }));
    ctx.tools.register(defineTool({
        name: 'agent_session_read',
        description: 'Read the metadata and a message window of one discovered session (source + sessionId from agent_session_search).',
        parameters: {
            source: { type: 'string', enum: SOURCE_IDS, required: true, description: 'Source family of the session.' },
            sessionId: { type: 'string', required: true, description: 'Session id as returned by agent_session_search.' },
            aroundSeq: { type: 'number', description: 'Optional: center the window on this message seq.' },
            window: { type: 'number', description: `Optional: window size (default ${resolved.readWindow}).` },
        },
        output: TEXT_OUTPUT,
        execute: async (args, exec) => {
            const source = args.source;
            const sessionId = args.sessionId;
            const aroundSeq = typeof args.aroundSeq === 'number' && Number.isSafeInteger(args.aroundSeq)
                ? args.aroundSeq
                : undefined;
            const window = typeof args.window === 'number' && Number.isSafeInteger(args.window) && args.window > 0
                ? Math.min(args.window, resolved.readWindow)
                : resolved.readWindow;
            const enabled = resolved.enabled.has(source) ? new Set([source]) : new Set();
            const files = await discoverFiles(enabled, resolved.roots);
            const { session, messages } = await readArtifactSession(files, source, sessionId, aroundSeq, window, exec.signal);
            if (session === undefined) {
                return JSON.stringify({ error: `session not found: ${source}/${sessionId}`, source, sessionId }, null, 2) ?? '';
            }
            return JSON.stringify({
                source: session.source,
                sessionId: session.sessionId,
                title: session.title,
                cwd: session.cwd,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                messageCount: session.messageCount,
                messages: messages.map(m => ({
                    seq: m.seq,
                    role: m.role,
                    text: clip(m.content),
                })),
            }, null, 2) ?? '';
        },
    }));
}
/** Resolve config defaults into plain values used by the tool bodies. */
function resolveConfig(config) {
    const enabled = new Set();
    for (const source of SOURCE_IDS) {
        if (config.sources?.[source] !== false)
            enabled.add(source);
    }
    return {
        enabled,
        roots: config.roots ?? {},
        maxResults: config.maxResults ?? DEFAULT_MAX_RESULTS,
        readWindow: config.readWindow ?? DEFAULT_READ_WINDOW,
    };
}
/** Truncate long message text for model output. */
function clip(content) {
    const MAX = 600;
    return content.length > MAX ? `${content.slice(0, MAX)}…` : content;
}
