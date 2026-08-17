#!/usr/bin/env node
/** Parser isolation regressions. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseOpencodeDb, parseOpencodeSession } from '../lib/parsers.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-session-search-parser-'))
try {
  const openCodePath = join(dir, 'opencode.db')
  const openCode = new DatabaseSync(openCodePath)
  openCode.exec(`
    CREATE TABLE session (
      id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `)
  const insertSession = openCode.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)')
  insertSession.run('populated', '/work', 'Populated', 1, 2)
  insertSession.run('empty', '/work', '', 1, 2)
  const insertMessage = openCode.prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
  insertMessage.run('m1', 'populated', 1, JSON.stringify({ role: 'user' }))
  insertMessage.run('m2', 'populated', 2, JSON.stringify({ role: 'assistant' }))
  const insertPart = openCode.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)')
  insertPart.run('p1', 'm1', 'populated', 1, JSON.stringify({ type: 'text', text: 'only message one' }))
  insertPart.run('p2', 'm2', 'populated', 2, JSON.stringify({ type: 'text', text: 'only message two' }))
  openCode.close()

  const openCodeSessions = parseOpencodeDb(openCodePath)
  if (openCodeSessions === undefined) throw new Error('valid OpenCode database failed to parse')
  if (openCodeSessions.length !== 1 || openCodeSessions[0].session.sessionId !== 'populated') {
    throw new Error(`empty OpenCode session was retained: ${JSON.stringify(openCodeSessions)}`)
  }
  const contents = openCodeSessions[0].messages.map(message => message.content)
  if (contents[0] !== 'only message one' || contents[1] !== 'only message two') {
    throw new Error(`OpenCode message parts crossed message boundaries: ${JSON.stringify(contents)}`)
  }
  const exactOpenCode = parseOpencodeSession(openCodePath, 'populated')
  if (exactOpenCode?.session.sessionId !== 'populated' || exactOpenCode.messages.length !== 2) {
    throw new Error(`exact OpenCode read failed: ${JSON.stringify(exactOpenCode)}`)
  }

  console.log('parser-correctness: all assertions passed')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
