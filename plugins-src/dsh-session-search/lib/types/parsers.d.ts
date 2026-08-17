/**
 * Per-source session parsers: read one artifact and normalize it into the
 * shared ParsedSession shape.
 *
 * All parsers are defensive: unreadable, oversized, or malformed lines are
 * skipped without failing the whole file. The dsh source decompresses zstd
 * frames with node:zlib (available since Node 22.13). The opencode source
 * opens its SQLite database read-only (PRAGMA query_only) and never writes.
 * @module @dsh-external/dsh-session-search/parsers
 */
import type { AgentSource, ParsedSession } from './types.js';
/** Per-message content cap kept for search (long tool dumps stay out). */
export declare const MAX_MSG_CHARS = 4000;
/** Per-file byte cap; larger artifacts are skipped entirely. */
export declare const MAX_FILE_BYTES: number;
/** Aggregate decompressed byte cap for one dsh artifact. */
export declare const MAX_DECOMPRESSED_BYTES: number;
/** Per-line byte cap; larger lines are skipped. */
export declare const MAX_LINE_CHARS: number;
/** Byte range occupied by one complete Zstandard frame. */
interface ZstdFrameRange {
    /** Inclusive frame start. */
    start: number;
    /** Exclusive frame end. */
    end: number;
}
/**
 * Locate complete Zstandard frames in a concatenated-frame stream without
 * decompressing their blocks. DSH persists each event batch as its own
 * independently compressed frame appended to the same file; the structural
 * scan mirrors `scanZstdFrames()` in `dsh-session-persistence-jsonl`, which
 * owns that container format. Invalid complete structure throws; EOF inside
 * the final frame omits that torn frame (a later scan can observe it after
 * the source finishes writing).
 * @param buffer - complete bytes of the session artifact.
 * @returns complete frame ranges in file order.
 */
export declare function scanZstdFrames(buffer: Buffer): ZstdFrameRange[];
/**
 * Decode complete concatenated frames within one aggregate output budget.
 * @param buffer - compressed dsh artifact bytes.
 * @param maxOutputBytes - maximum aggregate decoded bytes.
 * @returns decoded bytes in frame order.
 */
export declare function decompressZstdFrames(buffer: Buffer, maxOutputBytes?: number): Buffer;
/**
 * Parse one dsh session log (zstd-compressed JSONL). DSH appends each event
 * batch as its own independently compressed zstd frame to the same file, and
 * Node's decompressor only decodes the first frame of a concatenated stream —
 * so frames are located structurally and decoded one at a time. Logs are
 * Frames are decoded and consumed one at a time so a large session does not
 * materialize its complete decompressed log.
 */
export declare function parseDsh(path: string): Promise<ParsedSession | undefined>;
/** Parse one Codex rollout JSONL. */
export declare function parseCodex(path: string): Promise<ParsedSession | undefined>;
/** Parse one Claude Code project transcript JSONL. */
export declare function parseClaude(path: string): Promise<ParsedSession | undefined>;
/** Parse one pi session JSONL. */
export declare function parsePi(path: string): Promise<ParsedSession | undefined>;
/**
 * Visit sessions from one OpenCode SQLite database without retaining the
 * complete source in memory. Message text comes from `part` rows with
 * `data.type === 'text'`.
 * @param path - OpenCode database path.
 * @param visit - synchronous consumer invoked once per valid session.
 * @param sessionId - optional exact session restriction.
 * @returns false when the database cannot be read completely.
 */
export declare function visitOpencodeDb(path: string, visit: (session: ParsedSession) => void, sessionId?: string): boolean;
/** Parse all OpenCode sessions for compatibility with artifact consumers. */
export declare function parseOpencodeDb(path: string): ParsedSession[] | undefined;
/** Parse one exact OpenCode session without materializing its peers. */
export declare function parseOpencodeSession(path: string, sessionId: string): ParsedSession | undefined;
/**
 * Parse one discovered artifact into one or more ParsedSessions.
 * @param source - source family of the artifact.
 * @param path - absolute artifact path.
 * @returns parsed sessions, or undefined when the artifact cannot be read completely.
 */
export declare function parseFile(source: AgentSource, path: string): Promise<ParsedSession[] | undefined>;
/** Whether this source is a single-database source (discovered as one artifact). */
export declare function isDatabaseSource(source: AgentSource): boolean;
export {};
