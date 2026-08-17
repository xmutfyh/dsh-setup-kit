/**
 * Session-file discovery across all supported agent sources.
 *
 * Each source family declares a root and a walk pattern; discovery returns
 * the candidate files with their logical source and session id derived from
 * the path. The dsh source additionally resolves zstd-compressed logs.
 * @module @dsh-external/dsh-session-search/discovery
 */
import type { AgentSource } from './types.js';
/** One discovered session artifact. */
export interface SessionFile {
    /** Source family owning the file. */
    source: AgentSource;
    /** Absolute path of the artifact. */
    path: string;
    /** Session id derived from the path (source-native). */
    sessionId: string;
}
/** Resolved per-source roots; overrides only replace the default home root. */
export interface SourceRoots {
    /** dsh session store (`$DSH_HOME/sessions`). */
    dsh?: string;
    /** Codex session + archived session roots (`~/.codex`). */
    codex?: string;
    /** Claude Code project transcripts (`~/.claude/projects`). */
    claude?: string;
    /** pi session store (`~/.pi/agent/sessions`). */
    pi?: string;
    /** OpenCode data dir containing `opencode.db` (`~/.local/share/opencode`). */
    opencode?: string;
}
/** Default per-source roots under the current user's home. */
export declare function defaultRoots(): Required<SourceRoots>;
/**
 * Discover candidate session artifacts for the enabled sources.
 * @param enabled - set of enabled source families.
 * @param roots - per-source roots (defaults fill gaps).
 * @returns discovered files, newest-mtime first per source.
 */
export declare function discoverFiles(enabled: ReadonlySet<AgentSource>, roots?: SourceRoots): Promise<SessionFile[]>;
/** Relative path from the root, used by diagnostics. */
export declare function relativePath(root: string, path: string): string;
