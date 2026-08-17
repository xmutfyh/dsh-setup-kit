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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type SourceRoots } from './discovery.js';
import type { AgentSource } from './types.js';
/** Cordis plugin name used by Loader diagnostics. */
export declare const name = "dsh-session-search";
/** Capability services required by the model-facing consumer. */
export declare const inject: string[];
/** Default maximum sessions returned by one search call. */
export declare const DEFAULT_MAX_RESULTS = 10;
/** Default window size for session reads. */
export declare const DEFAULT_READ_WINDOW = 10;
/** Deployment-owned configuration. */
export interface Config {
    /** Source families enabled for scanning. Defaults to all five. */
    sources?: Partial<Record<AgentSource, boolean>>;
    /** Per-source root overrides (defaults resolve under the home dir). */
    roots?: SourceRoots;
    /** Maximum sessions returned by one `agent_session_search` call. Defaults to 10. */
    maxResults?: number;
    /** Window size for `agent_session_read` and search windows. Defaults to 10. */
    readWindow?: number;
}
/** Schemastery config for Loader defaults and generated configuration docs. */
export declare const Config: z<Config>;
/** Register the search tools and their shared model guidance. */
export declare function apply(ctx: Context, config: Config): void;
