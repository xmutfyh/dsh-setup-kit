#!/usr/bin/env node
/**
 * Regression test: search queries are literal substring data. Punctuation,
 * quotes, wildcard-looking text, CJK, and Unicode case folding stay inert.
 */
import { searchSessions } from '../lib/search.js'

const rows = [
  ['hello test-Tieboyh world', 'assistant'],
  ['date 2026-08-03 stamp', 'user'],
  ['query time: now please', 'assistant'],
  ['one -two three', 'user'],
  ['say a"b loudly', 'assistant'],
  ['prefix testing only', 'user'],
  ['test Tieboyh with space', 'assistant'],
  ['Äx', 'user'],
]
const sessions = [parsedSession('seed-session', rows)]

// `bestMatch` is the strongest matching message; windows contain neighbors.
const bestContents = (query) => searchSessions(sessions, { query, limit: 10 }).map(hit => hit.bestMatch.content)

// Punctuation, CJK, and wildcard-looking text must not change meaning.
const dashBest = bestContents('test-Tieboyh')
if (dashBest.length !== 1 || dashBest[0] !== 'hello test-Tieboyh world') {
  throw new Error(`query "test-Tieboyh" expected the exact-dash message, got ${JSON.stringify(dashBest)}`)
}
const dateBest = bestContents('2026-08-03')
if (dateBest.length !== 1 || dateBest[0] !== 'date 2026-08-03 stamp') {
  throw new Error(`query "2026-08-03" expected the date message, got ${JSON.stringify(dateBest)}`)
}
const colonBest = bestContents('time: now')
if (colonBest.length !== 1 || colonBest[0] !== 'query time: now please') {
  throw new Error(`query "time: now" expected the colon message, got ${JSON.stringify(colonBest)}`)
}
const notBest = bestContents('one -two')
if (notBest.length !== 1 || notBest[0] !== 'one -two three') {
  throw new Error(`query "one -two" expected the dash message, got ${JSON.stringify(notBest)}`)
}
bestContents('test*')
bestContents('中文-测试')

// Quotes and short queries stay literal too.
const quoteHits = searchSessions(sessions, { query: 'a"b', limit: 10 })
const quoteBest = quoteHits.map(hit => hit.bestMatch.content)
if (quoteBest.length !== 1 || quoteBest[0] !== 'say a"b loudly') {
  throw new Error(`query 'a"b' expected the quoted message, got ${JSON.stringify(quoteBest)}`)
}
if (quoteHits.length !== 1 || quoteHits[0].snippet.length === 0) {
  throw new Error(`short-query snippet must fall back to content, got ${JSON.stringify(quoteHits[0]?.snippet)}`)
}
const unicodeBest = bestContents('äx')
if (unicodeBest.length !== 1 || unicodeBest[0] !== 'Äx') {
  throw new Error(`short Unicode query must use case folding, got ${JSON.stringify(unicodeBest)}`)
}

console.log('query-safety: all assertions passed')

function parsedSession(sessionId, values) {
  const messages = values.map(([content, role], seq) => ({
    source: 'dsh', sessionId, seq, msgId: String(seq), role, content, ts: seq + 1,
  }))
  return {
    session: {
      source: 'dsh', sessionId, path: `${sessionId}.jsonl`, title: sessionId,
      cwd: '/work', createdAt: 1, updatedAt: 2, messageCount: messages.length,
      size: 0, mtime: 0,
    },
    messages,
  }
}
