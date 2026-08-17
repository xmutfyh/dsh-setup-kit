#!/usr/bin/env node
/** Candidate filtering, streaming ranking, and direct-read regressions. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canRawPrefilter,
  readArtifactSession,
  searchArtifacts,
} from '../lib/search.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-session-search-streaming-'))
try {
  const strongest = writeCodex('rollout-strongest', 'needle needle in the decoded message')
  const unrelated = writeCodex('rollout-unrelated', 'nothing relevant here')
  const quoted = writeCodex('rollout-quoted', 'say "hello" precisely')
  const artifacts = [strongest, unrelated, quoted]
  const enabled = new Set(['codex'])

  const hits = await searchArtifacts(artifacts, enabled, { query: 'needle', limit: 1, window: 1 })
  if (hits.length !== 1 || hits[0].session.sessionId !== 'rollout-strongest' || hits[0].score !== 2) {
    throw new Error(`streaming Top-K returned the wrong hit: ${JSON.stringify(hits)}`)
  }

  if (!canRawPrefilter('needle') || canRawPrefilter('say "hello"') || canRawPrefilter('line\nbreak')) {
    throw new Error('raw-prefilter eligibility did not preserve escaped-query fallback')
  }
  const escaped = await searchArtifacts(artifacts, enabled, { query: 'say "hello"', limit: 2 })
  if (escaped.length !== 1 || escaped[0].session.sessionId !== 'rollout-quoted') {
    throw new Error(`escaped query lost recall: ${JSON.stringify(escaped)}`)
  }

  const read = await readArtifactSession(
    [strongest, { source: 'codex', sessionId: 'missing', path: join(dir, 'missing.jsonl') }],
    'codex',
    'rollout-strongest',
    undefined,
    1,
  )
  if (read.session?.sessionId !== 'rollout-strongest' || read.messages.length !== 1) {
    throw new Error(`direct session read failed: ${JSON.stringify(read)}`)
  }

  const controller = new AbortController()
  controller.abort(new Error('cancelled search'))
  await expectReject(
    searchArtifacts(artifacts, enabled, { query: 'needle', limit: 1 }, controller.signal),
    'cancelled search',
  )

  console.log('streaming-search: all assertions passed')

  function writeCodex(sessionId, message) {
    const path = join(dir, `${sessionId}.jsonl`)
    writeFileSync(path, [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { cwd: '/work' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-01-01T00:00:01Z', payload: { type: 'user_message', message } }),
    ].join('\n'))
    return { source: 'codex', sessionId, path }
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

async function expectReject(promise, message) {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error && error.message === message) return
    throw error
  }
  throw new Error(`expected rejection: ${message}`)
}
