// lib/convert/chatgpt.mjs — ChatGPT 网页导出 conversations.json → DSH 会话（纯函数）

import {
  SESSION_FORMAT_VERSION,
  applyBudgetTrim,
  mintSessionId,
  parseTime,
  synthesizeSession,
} from './core.mjs'

// ChatGPT 网页导出 conversations.json → 每个会话一个 DSH 会话。
//
// 与 Claude/Codex 不同：顶层是 JSON 数组（一文件多会话），每个会话对象含
// `mapping`（DAG：nodeId → { id, message, parent, children }）。沿 active
// branch（children 最后一个）从 root 遍历得到主线程；`message: null` 的
// 占位节点与 `author.role === 'system'` 跳过；时间戳是 Unix 秒。
// 无 cwd 字段（ChatGPT 是聊天，无工作目录）→ 不归组工作区。
export function convertChatgptJson(raw, args = {}) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 整个文件不是合法 JSON：跳过，不产生会话（整文件无行概念，行号明细保持空）
    return { conversations: [], skipped: 1, records: 0, skippedLines: [], secrets: [] }
  }
  if (!Array.isArray(parsed)) {
    return { conversations: [], skipped: 1, records: 0, skippedLines: [], secrets: [] }
  }

  const conversations = []
  let skipped = 0
  for (const conv of parsed) {
    if (!conv || typeof conv !== 'object') { skipped++; continue }
    const out = convertChatgptConversation(conv, args)
    if (out) conversations.push(out)
    else skipped++
  }
  return { conversations, skipped, records: parsed.length, skippedLines: [], secrets: [] }
}

function convertChatgptConversation(conv, args) {
  const mapping = conv.mapping || {}
  const nodes = Object.values(mapping).filter((n) => n && typeof n === 'object')

  // 找 root：parent 不存在于 mapping 且带 message；遍历沿最后一个 child
  let root = null
  for (const n of nodes) {
    if (n.message && !(n.parent && mapping[n.parent])) { root = n; break }
  }
  if (!root) return null

  const thread = []
  const seen = new Set()
  let node = root
  while (node && !seen.has(node.id)) {
    seen.add(node.id)
    thread.push(node)
    const kids = (node.children || []).map((id) => mapping[id]).filter((n) => n && n.message)
    node = kids.length > 0 ? kids[kids.length - 1] : null
  }

  let title = null
  if (typeof conv.title === 'string' && conv.title.trim()) title = conv.title.trim()
  const createdAt = parseTime(conv.create_time)

  const turns = []
  let cur = null
  let lastStep = null
  for (const n of thread) {
    const msg = n.message
    const role = msg && msg.author ? msg.author.role : null
    if (role === 'user') {
      const text = chatgptMessageText(msg)
      if (text) {
        cur = { prompt: text, steps: [] }
        turns.push(cur)
        lastStep = null
      }
    } else if (role === 'assistant' && cur) {
      const step = { content: [], toolCalls: [], toolResults: [] }
      const text = chatgptMessageText(msg)
      if (text) step.content.push({ type: 'text', text })
      cur.steps.push(step)
      lastStep = step
    } else if (role === 'tool' && cur && lastStep) {
      // 工具消息降级为最近一步的文本块：ChatGPT 网页导出无结构化 tool-call
      // （assistant 节点从不产生 tool-call block），挂 tool/result 只会产生
      // 没有对应 tool/call 的孤儿结果，resume 时被模型 API 拒绝。与 README
      // 契约一致：工具消息按文本挂最近一步。
      const text = chatgptMessageText(msg)
      if (text) lastStep.content.push({ type: 'text', text })
    }
    // system 与占位节点跳过
  }

  const sessionId = args.sessionId || mintSessionId(conv.id)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt }
  if (conv.id) meta.sourceId = conv.id
  // 无用户回合（如只有 system 注入的会话）不产生空会话
  if (turns.length === 0) return null
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const out = synthesizeSession({ meta, turns: seedTurns, title, provider: 'chatgpt', model: 'chatgpt', skipped: 0, records: thread.length, imported: { sourcePath: args.sourcePath } })
  return trimmed ? { ...out, trimmed } : out
}

// 提取 ChatGPT 消息正文：content.parts 数组（字符串或 {text} 对象）。
function chatgptMessageText(msg) {
  if (!msg || !msg.content || typeof msg.content !== 'object') return ''
  const parts = Array.isArray(msg.content.parts) ? msg.content.parts : []
  const texts = []
  for (const p of parts) {
    if (typeof p === 'string') texts.push(p)
    else if (p && typeof p === 'object' && typeof p.text === 'string') texts.push(p.text)
  }
  return texts.join('\n').trim()
}
