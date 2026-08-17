/**
 * Direct, index-free search over normalized session artifacts.
 *
 * Each call discovers and parses the current source files, then performs a
 * case-insensitive literal substring scan in process. No derived database or
 * persistent cache is created.
 * @module @dsh-external/dsh-session-search/search
 */

import { stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { parseFile, parseOpencodeSession, visitOpencodeDb } from './parsers.js'
import type {
  AgentMessageRecord,
  AgentSearchHit,
  AgentSessionRecord,
  AgentSource,
  ParsedSession,
} from './types.js'

/** One artifact accepted by the direct scanner. */
export interface SessionArtifact {
  /** Source family owning the artifact. */
  source: AgentSource
  /** Absolute artifact path. */
  path: string
}

/** One direct-search request. */
export interface SearchRequest {
  /** Literal text matched case-insensitively. */
  query: string
  /** Optional source restriction. */
  sources?: readonly AgentSource[]
  /** Optional role restriction; defaults to user and assistant. */
  roles?: readonly AgentMessageRecord['role'][]
  /** Optional case-insensitive working-directory substring. */
  cwd?: string
  /** Maximum returned sessions. */
  limit: number
  /** Result ordering. */
  sort?: 'relevance' | 'newest' | 'oldest'
  /** Messages returned around the strongest match. */
  window?: number
}

/** One direct-search result. */
export interface SearchHit extends AgentSearchHit {
  /** Number of literal occurrences in the strongest message. */
  score: number
}

const DEFAULT_WINDOW = 10
const SNIPPET_CHARS = 350
const RG_BATCH_SIZE = 128
const RG_OUTPUT_LIMIT = 8 * 1024 * 1024
const RAW_PREFILTER_SOURCES = new Set<AgentSource>(['codex', 'claude', 'pi'])

/**
 * Search artifacts one at a time and retain only the bounded best results.
 * Plain JSONL sources use ripgrep as a conservative candidate stage when the
 * query can appear verbatim in JSON; parser-decoded messages remain the final
 * search authority. Missing or failed ripgrep falls back to parsing the full
 * artifact set.
 */
export async function searchArtifacts(
  artifacts: readonly SessionArtifact[],
  enabled: ReadonlySet<AgentSource>,
  request: SearchRequest,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const query = request.query.trim()
  if (query.length === 0) return []
  const candidates = await prefilterArtifacts(artifacts, query, signal)
  const hits: SearchHit[] = []
  const seenArtifacts = new Set<string>()
  const seenSessions = new Set<string>()

  const consider = (parsed: ParsedSession): void => {
    const sessionKey = key(parsed.session.source, parsed.session.sessionId)
    if (seenSessions.has(sessionKey)) return
    seenSessions.add(sessionKey)
    const hit = hitForSession(parsed, request, normalize(query))
    if (hit === undefined) return
    hits.push(hit)
    hits.sort((left, right) => compareHits(left, right, request.sort ?? 'relevance'))
    if (hits.length > request.limit) hits.length = request.limit
  }

  for (const artifact of candidates) {
    throwIfAborted(signal)
    if (!enabled.has(artifact.source)) continue
    const artifactKey = key(artifact.source, artifact.path)
    if (seenArtifacts.has(artifactKey)) continue
    seenArtifacts.add(artifactKey)

    if (artifact.source === 'opencode') {
      visitOpencodeDb(artifact.path, consider)
      continue
    }
    const parsed = await parseFile(artifact.source, artifact.path)
    if (parsed === undefined) continue
    const metadata = await stat(artifact.path).catch(() => undefined)
    for (const session of parsed) {
      session.session.size = metadata?.size ?? 0
      session.session.mtime = metadata === undefined ? 0 : Math.round(metadata.mtimeMs)
      consider(session)
    }
  }
  throwIfAborted(signal)
  return hits
}

/** Read one session by trying its source-native artifact id before a safe fallback scan. */
export async function readArtifactSession(
  artifacts: readonly (SessionArtifact & { sessionId?: string })[],
  source: AgentSource,
  sessionId: string,
  aroundSeq?: number,
  window = DEFAULT_WINDOW,
  signal?: AbortSignal,
): Promise<{ session: AgentSessionRecord | undefined; messages: AgentMessageRecord[] }> {
  const direct = artifacts.filter(artifact => artifact.source === source && artifact.sessionId === sessionId)
  const remaining = artifacts.filter(artifact => artifact.source === source && artifact.sessionId !== sessionId)
  for (const artifact of [...direct, ...remaining]) {
    throwIfAborted(signal)
    if (source === 'opencode') {
      const parsed = parseOpencodeSession(artifact.path, sessionId)
      if (parsed !== undefined) return readSession([parsed], source, sessionId, aroundSeq, window)
      continue
    }
    const parsed = await parseFile(source, artifact.path)
    const target = parsed?.find(candidate => candidate.session.sessionId === sessionId)
    if (target !== undefined) return readSession([target], source, sessionId, aroundSeq, window)
  }
  throwIfAborted(signal)
  return { session: undefined, messages: [] }
}

/** Whether a query can safely appear verbatim inside canonical JSON strings. */
export function canRawPrefilter(query: string): boolean {
  return query.length > 0 && !/["\\\u0000-\u001f]/u.test(query)
}

/** Search already-parsed sessions with literal substring matching. */
export function searchSessions(sessions: readonly ParsedSession[], request: SearchRequest): SearchHit[] {
  const query = request.query.trim()
  if (query.length === 0) return []
  const normalizedQuery = normalize(query)
  const roles = new Set(request.roles !== undefined && request.roles.length > 0
    ? request.roles
    : ['user', 'assistant'] as const)
  const sources = request.sources === undefined || request.sources.length === 0
    ? undefined
    : new Set(request.sources)
  const cwd = request.cwd === undefined || request.cwd.length === 0 ? undefined : normalize(request.cwd)
  const hits: SearchHit[] = []

  for (const parsed of sessions) {
    const hit = hitForSession(parsed, request, normalizedQuery, roles, sources, cwd)
    if (hit !== undefined) hits.push(hit)
  }

  hits.sort((left, right) => compareHits(left, right, request.sort ?? 'relevance'))
  return hits.slice(0, request.limit)
}

async function prefilterArtifacts(
  artifacts: readonly SessionArtifact[],
  query: string,
  signal?: AbortSignal,
): Promise<SessionArtifact[]> {
  if (!canRawPrefilter(query)) return [...artifacts]
  const eligible = artifacts.filter(artifact => RAW_PREFILTER_SOURCES.has(artifact.source))
  if (eligible.length === 0) return [...artifacts]
  const matches = await ripgrepCandidates(eligible.map(artifact => artifact.path), query, signal)
  if (matches === undefined) return [...artifacts]
  return artifacts.filter(artifact => !RAW_PREFILTER_SOURCES.has(artifact.source) || matches.has(artifact.path))
}

async function ripgrepCandidates(
  paths: readonly string[],
  query: string,
  signal?: AbortSignal,
): Promise<Set<string> | undefined> {
  const matches = new Set<string>()
  for (let start = 0; start < paths.length; start += RG_BATCH_SIZE) {
    throwIfAborted(signal)
    const batch = paths.slice(start, start + RG_BATCH_SIZE)
    const output = await runRipgrep(batch, query, signal)
    if (output === undefined) return undefined
    for (const path of output.split('\u0000')) {
      if (path.length > 0) matches.add(path)
    }
  }
  return matches
}

function runRipgrep(paths: readonly string[], query: string, signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('rg', [
      '--files-with-matches', '--fixed-strings', '--ignore-case', '--null', '--no-messages', '--', query, ...paths,
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      resolve(value)
    }
    const abort = (): void => {
      child.kill()
      finish(undefined)
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', () => finish(undefined))
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > RG_OUTPUT_LIMIT) {
        child.kill()
        finish(undefined)
        return
      }
      chunks.push(chunk)
    })
    child.on('close', code => finish(code === 0 || code === 1 ? Buffer.concat(chunks).toString('utf8') : undefined))
  })
}

function hitForSession(
  parsed: ParsedSession,
  request: SearchRequest,
  normalizedQuery: string,
  roles = new Set(request.roles !== undefined && request.roles.length > 0
    ? request.roles
    : ['user', 'assistant'] as const),
  sources = request.sources === undefined || request.sources.length === 0
    ? undefined
    : new Set(request.sources),
  cwd = request.cwd === undefined || request.cwd.length === 0 ? undefined : normalize(request.cwd),
): SearchHit | undefined {
  if (sources !== undefined && !sources.has(parsed.session.source)) return undefined
  if (cwd !== undefined && !normalize(parsed.session.cwd).includes(cwd)) return undefined
  let strongest: { message: AgentMessageRecord; score: number } | undefined
  for (const message of parsed.messages) {
    if (!roles.has(message.role)) continue
    const score = occurrenceCount(normalize(message.content), normalizedQuery)
    if (score === 0) continue
    if (strongest === undefined
      || score > strongest.score
      || (score === strongest.score && newerMessage(message, strongest.message))) {
      strongest = { message, score }
    }
  }
  if (strongest === undefined) return undefined
  const matchIndex = parsed.messages.findIndex(message => message.seq === strongest?.message.seq)
  return {
    session: parsed.session,
    bestMatch: strongest.message,
    snippet: snippet(strongest.message.content, normalizedQuery),
    window: matchIndex < 0 ? [] : centeredWindow(parsed.messages, matchIndex, request.window ?? DEFAULT_WINDOW),
    score: strongest.score,
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason
}

/** Read one parsed session and a bounded message window. */
export function readSession(
  sessions: readonly ParsedSession[],
  source: AgentSource,
  sessionId: string,
  aroundSeq?: number,
  window = DEFAULT_WINDOW,
): { session: AgentSessionRecord | undefined; messages: AgentMessageRecord[] } {
  const parsed = sessions.find(candidate => (
    candidate.session.source === source && candidate.session.sessionId === sessionId
  ))
  if (parsed === undefined) return { session: undefined, messages: [] }
  if (aroundSeq === undefined) return { session: parsed.session, messages: parsed.messages.slice(-window) }
  const index = parsed.messages.findIndex(message => message.seq === aroundSeq)
  if (index < 0) return { session: parsed.session, messages: parsed.messages.slice(-window) }
  return { session: parsed.session, messages: centeredWindow(parsed.messages, index, window) }
}

function normalize(value: string): string {
  return value.toLocaleLowerCase()
}

function occurrenceCount(value: string, query: string): number {
  let count = 0
  let offset = 0
  while (offset <= value.length - query.length) {
    const found = value.indexOf(query, offset)
    if (found < 0) break
    count += 1
    offset = found + Math.max(1, query.length)
  }
  return count
}

function newerMessage(candidate: AgentMessageRecord, existing: AgentMessageRecord): boolean {
  if (candidate.ts !== existing.ts) return candidate.ts > existing.ts
  return candidate.seq > existing.seq
}

function compareHits(left: SearchHit, right: SearchHit, sort: NonNullable<SearchRequest['sort']>): number {
  if (sort === 'newest' || sort === 'oldest') {
    const direction = sort === 'newest' ? -1 : 1
    const byTime = direction * (left.session.updatedAt - right.session.updatedAt)
    if (byTime !== 0) return byTime
  } else if (left.score !== right.score) {
    return right.score - left.score
  }
  if (left.bestMatch.ts !== right.bestMatch.ts) return right.bestMatch.ts - left.bestMatch.ts
  if (left.session.updatedAt !== right.session.updatedAt) return right.session.updatedAt - left.session.updatedAt
  return key(left.session.source, left.session.sessionId)
    .localeCompare(key(right.session.source, right.session.sessionId))
}

function snippet(content: string, normalizedQuery: string): string {
  if (content.length <= SNIPPET_CHARS) return content
  const match = normalize(content).indexOf(normalizedQuery)
  if (match < 0) return `${content.slice(0, SNIPPET_CHARS)}…`
  const before = Math.floor((SNIPPET_CHARS - normalizedQuery.length) / 2)
  const start = Math.max(0, Math.min(match - before, content.length - SNIPPET_CHARS))
  const end = Math.min(content.length, start + SNIPPET_CHARS)
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`
}

function centeredWindow<T>(values: readonly T[], index: number, requested: number): T[] {
  const size = Number.isSafeInteger(requested) && requested > 0 ? requested : DEFAULT_WINDOW
  const before = Math.floor((size - 1) / 2)
  let start = Math.max(0, index - before)
  const end = Math.min(values.length, start + size)
  start = Math.max(0, end - size)
  return values.slice(start, end)
}

function key(source: AgentSource, value: string): string {
  return `${source}\u0000${value}`
}
