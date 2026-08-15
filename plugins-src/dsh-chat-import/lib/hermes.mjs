// lib/hermes.mjs — Hermes（本地 AI 编码 CLI）SQLite 历史库读取（第 11 源）
//
// Hermes 会话存于 ~/.hermes/（Windows %LOCALAPPDATA%\hermes）：state.db（SQLite，
// 权威索引）+ sessions/*.jsonl|.json（回退）。readHermesDb 只读打开 state.db
//（node:sqlite DatabaseSync readOnly，对齐 lib/zcode.mjs readZcodeDb），把
// sessions + messages 两表抽成中间会话 JSON 数组（供 convertHermesJson 消费）：
//   { id, title, cwd, createdAt, messages: [{ role, content, ts }] }
// content 原样保留（string 或 Claude 风格 block 数组——DB 里 block 数组以 JSON 文本
// 存储，读时解析回数组）；ts/createdAt 归一为毫秒。列名兼容两种变体（cc-switch 的
// cwd|directory、started_at|created_at、ended_at|updated_at；hermes-agent 的
// messages.timestamp），messages 按时间升序（无时间列回退 rowid, id）。不设
// cc-switch 的 LIMIT 500：导入不应静默丢弃第 500 个之后的会话。db 不可用（不存在 /
// 非 SQLite / 无 sessions 表 / 查询失败）返回 null，由 index 层回退 sessions/*.jsonl。
import { DatabaseSync } from 'node:sqlite'
import { parseHermesTime } from './convert/hermes.mjs'

export function readHermesDb(dbPath) {
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    // 文件不存在 / 非 SQLite / 损坏 → db 不可用（index 层回退 JSONL）
    return null
  }
  try {
    const has = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='sessions'").get()
    if (!has || has.n === 0) return null // 无 sessions 表 → 不是 hermes 库
    const sCols = tableColumns(db, 'sessions')
    const cwdCol = pickCol(sCols, 'cwd', 'directory')
    const startCol = pickCol(sCols, 'started_at', 'created_at')
    const endCol = pickCol(sCols, 'ended_at', 'updated_at')
    const mCols = tableColumns(db, 'messages')
    const timeCol = pickCol(mCols, 'created_at', 'timestamp')

    const sessions = []
    for (const row of db.prepare('SELECT * FROM sessions ORDER BY rowid DESC').all()) {
      const id = typeof row.id === 'string' && row.id ? row.id : undefined
      if (!id) continue // 缺 id 的脏行不成会话（cc-switch 同款）
      const startedAt = startCol ? parseHermesTime(row[startCol]) : undefined
      const endedAt = endCol ? parseHermesTime(row[endCol]) : undefined
      const messages = []
      if (mCols.includes('session_id') && mCols.includes('role')) {
        const hasContent = mCols.includes('content')
        const order = (timeCol || 'rowid') + (mCols.includes('id') ? ', id' : '')
        const stmt = db.prepare(
          `SELECT role, ${hasContent ? 'content' : "'' AS content"}, ${timeCol ? `${timeCol} AS ts` : 'NULL AS ts'} FROM messages WHERE session_id = ? ORDER BY ${order}`
        )
        for (const m of stmt.all(id)) {
          const role = typeof m.role === 'string' ? m.role : undefined
          if (!role) continue
          const content = hermesContent(m.content)
          if (content === undefined) continue // 空内容消息跳过（cc-switch 同款）
          messages.push({ role, content, ts: timeCol ? parseHermesTime(m.ts) : undefined })
        }
      }
      sessions.push({
        id,
        title: typeof row.title === 'string' && row.title ? row.title : undefined,
        cwd: cwdCol && typeof row[cwdCol] === 'string' && row[cwdCol] ? row[cwdCol] : undefined,
        createdAt: startedAt ?? endedAt,
        messages,
      })
    }
    return sessions
  } catch {
    // 查询失败（表损坏 / 非 hermes 库）→ db 不可用，回退 JSONL
    return null
  } finally {
    db.close()
  }
}

// PRAGMA table_info 列名列表（兼容不同 hermes 变体列名）。
function tableColumns(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  } catch {
    // 表不存在 → 空列（调用方按无该表处理）
    return []
  }
}

// 按优先级取第一个存在的列名。
function pickCol(cols, ...names) {
  for (const n of names) if (cols.includes(n)) return n
  return undefined
}

// content 归一：DB 存的是 TEXT——Claude 风格 block 数组以 JSON 文本存储 → 解析回
// 数组；其余字符串原样；空/缺失 → undefined（该消息跳过）。
function hermesContent(raw) {
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) return parsed.length > 0 ? parsed : undefined
      } catch {
        // 字面 '[' 开头的普通文本，按字符串保留
      }
    }
    return raw
  }
  if (Array.isArray(raw) && raw.length > 0) return raw
  return undefined
}
