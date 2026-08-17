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
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { zstdDecompressSync } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname } from 'node:path';
/** Per-message content cap kept for search (long tool dumps stay out). */
export const MAX_MSG_CHARS = 4000;
/** Per-file byte cap; larger artifacts are skipped entirely. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Aggregate decompressed byte cap for one dsh artifact. */
export const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
/** Per-line byte cap; larger lines are skipped. */
export const MAX_LINE_CHARS = 512 * 1024;
/** Time from a number (ms) or ISO string; 0 when unparsable. */
function tsOf(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') {
        const t = Date.parse(value);
        return Number.isNaN(t) ? 0 : t;
    }
    return 0;
}
/** Parse a JSON value defensively; null for anything non-object. */
function asRecord(line) {
    if (line.length > MAX_LINE_CHARS)
        return null;
    let data;
    try {
        data = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data))
        return null;
    return data;
}
/** Extract plain text from a content block list or string. */
function extractText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (typeof block !== 'object' || block === null)
            continue;
        const b = block;
        if (b.type === 'text' && typeof b.text === 'string')
            parts.push(b.text);
    }
    return parts.join('\n');
}
/** Cap a message body before it enters the searchable transcript. */
function cap(s) {
    return s.length > MAX_MSG_CHARS ? s.slice(0, MAX_MSG_CHARS) : s;
}
/** Stream a JSONL file line by line with size guards. */
async function eachLine(path, fn) {
    let st;
    try {
        st = await stat(path);
    }
    catch {
        return false;
    }
    if (st.size > MAX_FILE_BYTES)
        return false;
    const rl = createInterface({
        input: createReadStream(path, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });
    try {
        let valid = true;
        for await (const line of rl) {
            if (fn(line) === false)
                valid = false;
        }
        return valid;
    }
    catch {
        return false;
    }
    finally {
        rl.close();
    }
}
/** Build the shared ParsedSession shell from tracked fields. */
function parsed(source, path, sessionId, fields) {
    return {
        session: {
            source,
            sessionId,
            path,
            title: fields.title,
            cwd: fields.cwd,
            createdAt: fields.createdAt,
            updatedAt: fields.updatedAt,
            messageCount: fields.messages.length,
            size: 0, // filled by the scanner after stat
            mtime: 0,
        },
        messages: fields.messages,
    };
}
// ------------------------------------------------------------------ dsh
/** Zstandard frame magic number (little-endian 0xFD2FB528). */
const ZSTD_MAGIC = 0xfd2fb528;
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
export function scanZstdFrames(buffer) {
    const frames = [];
    let offset = 0;
    while (offset < buffer.length) {
        const start = offset;
        if (buffer.length - offset < 4)
            return frames;
        if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
            throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
        }
        offset += 4;
        if (offset === buffer.length)
            return frames;
        const descriptor = buffer.readUInt8(offset);
        offset += 1;
        if ((descriptor & 0x18) !== 0) {
            throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
        }
        const contentSizeFlag = descriptor >>> 6;
        const singleSegment = (descriptor & 0x20) !== 0;
        const checksum = (descriptor & 0x04) !== 0;
        const dictionaryFlag = descriptor & 0x03;
        const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
        const contentSizeBytes = contentSizeFlag === 0
            ? (singleSegment ? 1 : 0)
            : 1 << contentSizeFlag;
        const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
        if (buffer.length - offset < remainingHeaderBytes)
            return frames;
        offset += remainingHeaderBytes;
        for (;;) {
            if (buffer.length - offset < 3)
                return frames;
            const blockHeader = buffer.readUIntLE(offset, 3);
            offset += 3;
            const lastBlock = (blockHeader & 1) !== 0;
            const blockType = (blockHeader >>> 1) & 0x03;
            const blockSize = blockHeader >>> 3;
            if (blockType === 0x03) {
                throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
            }
            const payloadBytes = blockType !== 0x01 ? blockSize : 1;
            if (buffer.length - offset < payloadBytes)
                return frames;
            offset += payloadBytes;
            if (lastBlock)
                break;
        }
        if (checksum) {
            if (buffer.length - offset < 4)
                return frames;
            offset += 4;
        }
        frames.push({ start, end: offset });
    }
    return frames;
}
/**
 * Decode complete concatenated frames within one aggregate output budget.
 * @param buffer - compressed dsh artifact bytes.
 * @param maxOutputBytes - maximum aggregate decoded bytes.
 * @returns decoded bytes in frame order.
 */
export function decompressZstdFrames(buffer, maxOutputBytes = MAX_DECOMPRESSED_BYTES) {
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
        throw new TypeError('dsh decompression budget must be a positive safe integer');
    }
    const chunks = [];
    let outputBytes = 0;
    for (const frame of scanZstdFrames(buffer)) {
        const remaining = maxOutputBytes - outputBytes;
        if (remaining < 1)
            throw new Error(`dsh session exceeds the ${maxOutputBytes}-byte decompression budget`);
        const chunk = zstdDecompressSync(buffer.subarray(frame.start, frame.end), {
            maxOutputLength: remaining,
        });
        outputBytes += chunk.byteLength;
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, outputBytes);
}
/** Chat event types whose text enters the transcript. */
const DSH_CHAT_TYPES = new Set(['user/message', 'steering/message', 'assistant/message']);
/** Extract the chat text of one dsh event (both content shapes). */
function dshEventText(data) {
    if (data === undefined)
        return '';
    if (Array.isArray(data.content))
        return extractText(data.content);
    const message = data.message;
    if (typeof message === 'object' && message !== null && Array.isArray(message.content)) {
        return extractText(message.content);
    }
    return '';
}
/**
 * Parse one dsh session log (zstd-compressed JSONL). DSH appends each event
 * batch as its own independently compressed zstd frame to the same file, and
 * Node's decompressor only decodes the first frame of a concatenated stream —
 * so frames are located structurally and decoded one at a time. Logs are
 * Frames are decoded and consumed one at a time so a large session does not
 * materialize its complete decompressed log.
 */
export async function parseDsh(path) {
    let buffer;
    try {
        buffer = await readFile(path);
    }
    catch {
        return undefined;
    }
    if (buffer.byteLength > MAX_FILE_BYTES)
        return undefined;
    try {
        const state = createDshState(path);
        const decoder = new StringDecoder('utf8');
        let carry = '';
        let outputBytes = 0;
        for (const frame of scanZstdFrames(buffer)) {
            const remaining = MAX_DECOMPRESSED_BYTES - outputBytes;
            if (remaining < 1)
                return undefined;
            const chunk = zstdDecompressSync(buffer.subarray(frame.start, frame.end), {
                maxOutputLength: remaining,
            });
            outputBytes += chunk.byteLength;
            const lines = `${carry}${decoder.write(chunk)}`.split('\n');
            carry = lines.pop() ?? '';
            for (const line of lines)
                consumeDshLine(state, line);
        }
        carry += decoder.end();
        if (carry.length > 0)
            consumeDshLine(state, carry);
        return finishDshState(state);
    }
    catch {
        return undefined;
    }
}
/** Parse the decompressed dsh JSONL text. */
function parseDshLines(path, text) {
    const state = createDshState(path);
    for (const raw of text.split('\n')) {
        consumeDshLine(state, raw);
    }
    return finishDshState(state);
}
function createDshState(path) {
    return {
        path,
        messages: [],
        sessionId: basename(path).replace(/\.jsonl(\.zstd)?$/, ''),
        cwd: '',
        title: '',
        createdAt: 0,
        updatedAt: 0,
        seq: 0,
        records: 0,
        malformed: false,
    };
}
function consumeDshLine(state, raw) {
    if (raw.length === 0)
        return;
    const d = asRecord(raw);
    if (!d) {
        state.malformed = true;
        return;
    }
    state.records += 1;
    const eventTs = typeof d.time === 'number' && Number.isFinite(d.time) ? d.time : 0;
    if (eventTs > state.updatedAt)
        state.updatedAt = eventTs;
    if (state.createdAt === 0 || (eventTs !== 0 && eventTs < state.createdAt))
        state.createdAt = eventTs;
    if (d.type === 'session') {
        if (typeof d.id === 'string')
            state.sessionId = d.id;
        if (typeof d.cwd === 'string')
            state.cwd = d.cwd;
        if (typeof d.createdAt === 'number')
            state.createdAt = d.createdAt;
    }
    else if (d.type === 'session/title' && typeof d.data === 'object') {
        const data = d.data;
        if (typeof data.title === 'string' && data.title.trim().length > 0)
            state.title = data.title.trim();
    }
    else if (DSH_CHAT_TYPES.has(String(d.type))) {
        const data = d.data;
        const text = dshEventText(data).trim();
        if (text.length === 0)
            return;
        const role = String(d.type) === 'assistant/message' ? 'assistant' : 'user';
        if (role === 'user' && state.title === '')
            state.title = text.slice(0, 80);
        const messageSeq = state.seq++;
        const msgId = typeof d.seq === 'number' && Number.isSafeInteger(d.seq) ? String(d.seq) : String(messageSeq);
        state.messages.push({
            source: 'dsh', sessionId: state.sessionId, seq: messageSeq, msgId, role,
            content: cap(text), ts: eventTs,
        });
    }
}
function finishDshState(state) {
    if (state.malformed || state.records === 0)
        return undefined;
    for (const message of state.messages)
        message.sessionId = state.sessionId;
    return parsed('dsh', state.path, state.sessionId, {
        title: state.title || 'dsh session',
        cwd: state.cwd,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        messages: state.messages,
    });
}
// ------------------------------------------------------------------ codex
/** Parse one Codex rollout JSONL. */
export async function parseCodex(path) {
    const messages = [];
    // The rollout filename is unique per artifact; payload.id is a logical
    // session id reused across rotation snapshots, so it must not key search results.
    const sessionId = basename(path).replace(/\.jsonl$/, '');
    let cwd = '';
    let createdAt = 0;
    let updatedAt = 0;
    let seq = 0;
    let firstUser = '';
    let records = 0;
    const complete = await eachLine(path, (raw) => {
        const d = asRecord(raw);
        if (!d)
            return false;
        records += 1;
        const ts = tsOf(d.timestamp);
        if (ts > updatedAt)
            updatedAt = ts;
        if (createdAt === 0 || (ts !== 0 && ts < createdAt))
            createdAt = ts;
        const payload = (d.payload ?? {});
        if (d.type === 'session_meta') {
            if (typeof payload.cwd === 'string')
                cwd = payload.cwd;
        }
        else if (d.type === 'event_msg') {
            const ptype = payload.type;
            if (ptype === 'user_message' || ptype === 'agent_message') {
                const text = typeof payload.message === 'string' ? payload.message.trim() : '';
                if (text.length === 0)
                    return;
                const role = ptype === 'user_message' ? 'user' : 'assistant';
                if (role === 'user' && firstUser === '')
                    firstUser = text.slice(0, 80);
                messages.push({ source: 'codex', sessionId, seq: seq++, msgId: String(seq), role, content: cap(text), ts });
            }
        }
    });
    if (!complete || records === 0)
        return undefined;
    return parsed('codex', path, sessionId, {
        title: firstUser || 'Codex session',
        cwd: cwd || 'unknown',
        createdAt,
        updatedAt,
        messages,
    });
}
// ------------------------------------------------------------------ claude
/** Decode a Claude Code project dir name back into a filesystem path. */
function decodeClaudeCwd(dirName) {
    // Claude Code encodes the project path as: '/' -> '-', '-' -> '--'.
    // Decode '--' to a placeholder first so literal '-' pairs survive.
    return dirName.replaceAll('--', '\u0000').replaceAll('-', '/').replaceAll('\u0000', '-');
}
/** Parse one Claude Code project transcript JSONL. */
export async function parseClaude(path) {
    const messages = [];
    let title = '';
    let createdAt = 0;
    let updatedAt = 0;
    let seq = 0;
    let records = 0;
    const sessionId = basename(path).replace(/\.jsonl$/, '');
    const cwd = decodeClaudeCwd(dirname(path).split(/[\\/]/).pop() ?? '');
    const complete = await eachLine(path, (raw) => {
        const d = asRecord(raw);
        if (!d)
            return false;
        records += 1;
        const ts = tsOf(d.timestamp);
        if (ts > updatedAt)
            updatedAt = ts;
        if (createdAt === 0 || (ts !== 0 && ts < createdAt))
            createdAt = ts;
        if (d.type === 'ai-title' && typeof d.title === 'string' && d.title.trim()) {
            title = d.title.trim();
        }
        else if (d.type === 'user' || d.type === 'assistant') {
            const message = d.message;
            const text = extractText(message?.content).trim();
            if (text.length === 0)
                return;
            messages.push({
                source: 'claude',
                sessionId,
                seq: seq++,
                msgId: typeof d.uuid === 'string' ? d.uuid : String(seq),
                role: d.type === 'user' ? 'user' : 'assistant',
                content: cap(text),
                ts,
            });
        }
    });
    if (!complete || records === 0)
        return undefined;
    return parsed('claude', path, sessionId, {
        title: title || 'Claude Code session',
        cwd: cwd || 'unknown',
        createdAt,
        updatedAt,
        messages,
    });
}
// ------------------------------------------------------------------ pi
/** Parse one pi session JSONL. */
export async function parsePi(path) {
    const messages = [];
    let sessionId = basename(path).replace(/\.jsonl$/, '');
    let cwd = '';
    let createdAt = 0;
    let updatedAt = 0;
    let seq = 0;
    let firstUser = '';
    let records = 0;
    const complete = await eachLine(path, (raw) => {
        const d = asRecord(raw);
        if (!d)
            return false;
        records += 1;
        const ts = tsOf(d.timestamp);
        if (ts > updatedAt)
            updatedAt = ts;
        if (createdAt === 0 || (ts !== 0 && ts < createdAt))
            createdAt = ts;
        if (d.type === 'session') {
            if (typeof d.id === 'string')
                sessionId = d.id;
            if (typeof d.cwd === 'string')
                cwd = d.cwd;
        }
        else if (d.type === 'message') {
            const m = (d.message ?? {});
            let role;
            if (m.role === 'user')
                role = 'user';
            else if (m.role === 'assistant')
                role = 'assistant';
            else if (m.role === 'toolResult' || m.role === 'tool')
                role = 'tool';
            else
                return;
            const text = extractText(m.content).trim();
            if (text.length === 0)
                return;
            if (role === 'user' && firstUser === '')
                firstUser = text.slice(0, 80);
            messages.push({
                source: 'pi',
                sessionId,
                seq: seq++,
                msgId: typeof d.id === 'string' ? d.id : String(seq),
                role,
                content: cap(text),
                ts,
            });
        }
    });
    if (!complete || records === 0)
        return undefined;
    return parsed('pi', path, sessionId, {
        title: firstUser || 'pi session',
        cwd: cwd || 'unknown',
        createdAt,
        updatedAt,
        messages,
    });
}
// ------------------------------------------------------------------ opencode
/**
 * Visit sessions from one OpenCode SQLite database without retaining the
 * complete source in memory. Message text comes from `part` rows with
 * `data.type === 'text'`.
 * @param path - OpenCode database path.
 * @param visit - synchronous consumer invoked once per valid session.
 * @param sessionId - optional exact session restriction.
 * @returns false when the database cannot be read completely.
 */
export function visitOpencodeDb(path, visit, sessionId) {
    let db;
    try {
        db = new DatabaseSync(path, { readOnly: true });
    }
    catch {
        return false;
    }
    try {
        // Guard: only open when the expected tables exist.
        const hasTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'message', 'part')").all();
        if (hasTables.length < 3)
            return false;
        const sessionStatement = db.prepare(sessionId === undefined
            ? 'SELECT id, directory, title, time_created, time_updated FROM session'
            : 'SELECT id, directory, title, time_created, time_updated FROM session WHERE id = ?');
        const sessionRows = (sessionId === undefined ? sessionStatement.all() : sessionStatement.all(sessionId));
        const partStmt = db.prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id');
        const messageStmt = db.prepare('SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id');
        for (const row of sessionRows) {
            const messages = [];
            let seq = 0;
            const msgRows = messageStmt.all(row.id);
            const partsByMessage = new Map();
            const partRows = partStmt.all(row.id);
            for (const part of partRows) {
                let data;
                try {
                    data = JSON.parse(part.data);
                }
                catch {
                    return false;
                }
                if (typeof data !== 'object' || data === null || Array.isArray(data))
                    return false;
                if (data.type !== 'text' || typeof data.text !== 'string' || !data.text.trim())
                    continue;
                const parts = partsByMessage.get(part.message_id) ?? [];
                parts.push(data.text);
                partsByMessage.set(part.message_id, parts);
            }
            for (const msg of msgRows) {
                let data = null;
                try {
                    data = JSON.parse(msg.data);
                }
                catch {
                    return false;
                }
                if (typeof data !== 'object' || data === null || Array.isArray(data))
                    return false;
                const role = data.role === 'user' ? 'user' : data.role === 'assistant' ? 'assistant' : 'tool';
                const ts = msg.time_created;
                const parts = partsByMessage.get(msg.id) ?? [];
                const text = parts.join('\n').trim();
                if (text.length === 0)
                    continue;
                messages.push({
                    source: 'opencode',
                    sessionId: row.id,
                    seq: seq++,
                    msgId: msg.id,
                    role,
                    content: cap(text),
                    ts,
                });
            }
            if (messages.length === 0 && !row.title?.trim())
                continue;
            visit(parsed('opencode', path, row.id, {
                title: row.title && row.title.trim() ? row.title.trim() : (messages[0]?.content.slice(0, 80) ?? 'opencode session'),
                cwd: row.directory ?? 'unknown',
                createdAt: row.time_created ?? 0,
                updatedAt: row.time_updated ?? 0,
                messages,
            }));
        }
        return true;
    }
    catch {
        return false;
    }
    finally {
        db.close();
    }
}
/** Parse all OpenCode sessions for compatibility with artifact consumers. */
export function parseOpencodeDb(path) {
    const results = [];
    return visitOpencodeDb(path, session => results.push(session)) ? results : undefined;
}
/** Parse one exact OpenCode session without materializing its peers. */
export function parseOpencodeSession(path, sessionId) {
    let result;
    return visitOpencodeDb(path, session => { result = session; }, sessionId) ? result : undefined;
}
// ------------------------------------------------------------------ dispatch
/**
 * Parse one discovered artifact into one or more ParsedSessions.
 * @param source - source family of the artifact.
 * @param path - absolute artifact path.
 * @returns parsed sessions, or undefined when the artifact cannot be read completely.
 */
export async function parseFile(source, path) {
    switch (source) {
        case 'dsh': return materializeSingle(await parseDsh(path));
        case 'codex': return materializeSingle(await parseCodex(path));
        case 'claude': return materializeSingle(await parseClaude(path));
        case 'pi': return materializeSingle(await parsePi(path));
        case 'opencode': return parseOpencodeDb(path);
    }
}
function materializeSingle(value) {
    return value === undefined ? undefined : [value];
}
/** Whether this source is a single-database source (discovered as one artifact). */
export function isDatabaseSource(source) {
    return source === 'opencode';
}
