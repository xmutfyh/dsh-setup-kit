/**
 * Shared types for the cross-agent session search plugin.
 *
 * Every source (dsh, codex, claude, pi, opencode) is normalized into the same
 * two records: one per session file, one per extractable message. The direct
 * scanner searches these shapes and renders them back to the model.
 * @module @dsh-external/dsh-session-search/types
 */
/** One session-file source family supported by the scanner. */
export type AgentSource = 'dsh' | 'codex' | 'claude' | 'pi' | 'opencode';
/** Normalized session metadata extracted from one source file. */
export interface AgentSessionRecord {
    /** Source family owning the session file. */
    source: AgentSource;
    /** Session id unique within its source family. */
    sessionId: string;
    /** Absolute path of the session artifact (JSONL file or opencode db). */
    path: string;
    /** Best-effort title: claude `ai-title`, first user message, or fallback. */
    title: string;
    /** Working directory the session ran in, when the source records one. */
    cwd: string;
    /** Session creation time in Unix epoch milliseconds; 0 when unknown. */
    createdAt: number;
    /** Last observed event time in Unix epoch milliseconds; 0 when unknown. */
    updatedAt: number;
    /** Number of searchable messages from this session. */
    messageCount: number;
    /** Artifact size in bytes when parsed. */
    size: number;
    /** Artifact mtime in Unix epoch milliseconds when parsed. */
    mtime: number;
}
/** Normalized message extracted from one session. */
export interface AgentMessageRecord {
    /** Source family owning the message. */
    source: AgentSource;
    /** Session id owning the message (matches AgentSessionRecord.sessionId). */
    sessionId: string;
    /** Monotonic message position within the session. */
    seq: number;
    /** Source-native message id when the source records one; else the seq. */
    msgId: string;
    /** Model-facing role label. */
    role: 'user' | 'assistant' | 'tool';
    /** Extracted text content searched by the direct scanner. */
    content: string;
    /** Message time in Unix epoch milliseconds; 0 when unknown. */
    ts: number;
}
/** Parsed result of one session file. */
export interface ParsedSession {
    /** Normalized session metadata. */
    session: AgentSessionRecord;
    /** Normalized messages, in file order. */
    messages: AgentMessageRecord[];
}
/** One literal-text hit grouped by its owning session. */
export interface AgentSearchHit {
    /** Session metadata of the hit. */
    session: AgentSessionRecord;
    /** Strongest matching message within the session. */
    bestMatch: AgentMessageRecord;
    /** Bounded excerpt around the literal match. */
    snippet: string;
    /** Messages surrounding the match (bookend window). */
    window: AgentMessageRecord[];
}
