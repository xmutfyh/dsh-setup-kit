#!/usr/bin/env node
/** Result bounds, ranking, and caller-selected message-window regressions. */
import { readSession, searchSessions } from '../lib/search.js'

const sessions = Array.from({ length: 4 }, (_, sessionIndex) => parsedSession(sessionIndex))
const hits = searchSessions(sessions, { query: 'common phrase', cwd: 'ärea', limit: 2, window: 3 })
if (hits.length !== 2) throw new Error(`result limit expected 2 sessions, got ${hits.length}`)
if (hits[0].session.sessionId !== 'session-0' || hits[0].score !== 2) {
  throw new Error(`relevance did not prefer the strongest literal match: ${JSON.stringify(hits[0])}`)
}
if (hits.some(hit => hit.window.length !== 3)) {
  throw new Error(`search window ignored requested size: ${JSON.stringify(hits.map(hit => hit.window.length))}`)
}

const one = readSession(sessions, 'dsh', 'session-0', 7, 1).messages.map(message => message.seq)
const ten = readSession(sessions, 'dsh', 'session-0', 7, 10).messages.map(message => message.seq)
if (one.length !== 1 || one[0] !== 7) throw new Error(`one-message window was not centered: ${JSON.stringify(one)}`)
if (ten.length !== 10 || !ten.includes(7)) throw new Error(`ten-message window was not honored: ${JSON.stringify(ten)}`)

console.log('query-bounds: all assertions passed')

function parsedSession(sessionIndex) {
  const sessionId = `session-${sessionIndex}`
  const messages = Array.from({ length: 15 }, (_, seq) => ({
    source: 'dsh', sessionId, seq, msgId: String(seq),
    role: seq % 2 === 0 ? 'user' : 'assistant',
    content: `${sessionIndex === 0 && seq === 0 ? 'common phrase ' : ''}common phrase session ${sessionIndex} message ${seq}`,
    ts: seq,
  }))
  return {
    session: {
      source: 'dsh', sessionId, path: `${sessionId}.jsonl`, title: sessionId,
      cwd: '/Ärea/work', createdAt: 1, updatedAt: 100 + sessionIndex,
      messageCount: messages.length, size: 3, mtime: 4,
    },
    messages,
  }
}
