/**
 * Direct, index-free search over normalized session artifacts.
 *
 * Each call discovers and parses the current source files, then performs a
 * case-insensitive literal substring scan in process. No derived database or
 * persistent cache is created.
 * @module @dsh-external/dsh-session-search/search
 */
import type { AgentMessageRecord, AgentSearchHit, AgentSessionRecord, AgentSource, ParsedSession } from './types.js';
/** One artifact accepted by the direct scanner. */
export interface SessionArtifact {
    /** Source family owning the artifact. */
    source: AgentSource;
    /** Absolute artifact path. */
    path: string;
}
/** One direct-search request. */
export interface SearchRequest {
    /** Literal text matched case-insensitively. */
    query: string;
    /** Optional source restriction. */
    sources?: readonly AgentSource[];
    /** Optional role restriction; defaults to user and assistant. */
    roles?: readonly AgentMessageRecord['role'][];
    /** Optional case-insensitive working-directory substring. */
    cwd?: string;
    /** Maximum returned sessions. */
    limit: number;
    /** Result ordering. */
    sort?: 'relevance' | 'newest' | 'oldest';
    /** Messages returned around the strongest match. */
    window?: number;
}
/** One direct-search result. */
export interface SearchHit extends AgentSearchHit {
    /** Number of literal occurrences in the strongest message. */
    score: number;
}
/**
 * Search artifacts one at a time and retain only the bounded best results.
 * Plain JSONL sources use ripgrep as a conservative candidate stage when the
 * query can appear verbatim in JSON; parser-decoded messages remain the final
 * search authority. Missing or failed ripgrep falls back to parsing the full
 * artifact set.
 */
export declare function searchArtifacts(artifacts: readonly SessionArtifact[], enabled: ReadonlySet<AgentSource>, request: SearchRequest, signal?: AbortSignal): Promise<SearchHit[]>;
/** Read one session by trying its source-native artifact id before a safe fallback scan. */
export declare function readArtifactSession(artifacts: readonly (SessionArtifact & {
    sessionId?: string;
})[], source: AgentSource, sessionId: string, aroundSeq?: number, window?: number, signal?: AbortSignal): Promise<{
    session: AgentSessionRecord | undefined;
    messages: AgentMessageRecord[];
}>;
/** Whether a query can safely appear verbatim inside canonical JSON strings. */
export declare function canRawPrefilter(query: string): boolean;
/** Search already-parsed sessions with literal substring matching. */
export declare function searchSessions(sessions: readonly ParsedSession[], request: SearchRequest): SearchHit[];
/** Read one parsed session and a bounded message window. */
export declare function readSession(sessions: readonly ParsedSession[], source: AgentSource, sessionId: string, aroundSeq?: number, window?: number): {
    session: AgentSessionRecord | undefined;
    messages: AgentMessageRecord[];
};
