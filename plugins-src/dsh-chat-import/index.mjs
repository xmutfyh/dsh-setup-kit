// index.mjs — 外部聊天记录（Claude Code / Codex-ChatGPT / ChatGPT / Cursor /
// Gemini / Reasonix / Pi Coding Agent / opencode / zcode / grokbuild / openclaw /
// hermes）→ DSH 会话导入器 + DSH → Claude Code JSONL 反向导出
//
// 消费 host 的 sessionPersistence / fs / tools / workspaceRegistry 服务，注册
// `import_claude` 等导入工具：读取各自源格式的 transcript（单个文件或整个目录；
// opencode / zcode / hermes 直接读 SQLite 库；grokbuild 读会话目录的 summary.json +
// chat_history.jsonl），把对话合成 DSH 事件日志（turn/start、step/start、
// user/message、assistant/message、tool/call、tool/result、step/end、turn/end），
// 经 sessionPersistence.create + append 落盘，再挂接到其 cwd 对应的工作区；
// 并注册 `export_claude`（REQ-16）：把 DSH 会话日志只读序列化为 Claude Code
// JSONL（export.mjs 纯函数），写到 <outputDir>/<slug>/<uuid>.jsonl；
// 注册 `sync_to_claude`（REQ-36）：把 DSH 会话新增轮次增量写回 Claude Code
// JSONL（lib/backfill.mjs 纯逻辑 + ctx 注入），守卫冲突绝不静默覆盖。
// REQ-17：import_* 支持 preview / dryRun 参数——只读转换 + 统计返回将导入清单
//（标题 / cwd / 时间 / 规模 / 跳过明细），零副作用（不落盘、不写 registry）。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  convertClaudeJsonl, convertCodexJsonl, convertChatgptJson, convertCursorJsonl,
  convertGeminiJson, convertReasonixJsonl, convertPiJsonl, convertOpencodeJson,
  convertZcodeJson, convertGrokbuildJson, convertOpenclawJson, convertHermesJson,
} from './convert.mjs'
import { openclawDisplayNames } from './lib/convert/openclaw.mjs'
import { readHermesDb } from './lib/hermes.mjs'
import { slugifyClaudeCwd, serializeClaudeJsonl } from './export.mjs'
import { syncClaudeSession } from './lib/backfill.mjs'
import { resolveRegistryDir, loadImports, rememberImport, removeImport, unwrapRecord, listPersistedIds, argsFingerprint, isSessionIdChange, decideSingle, decideMulti } from './lib/imports.mjs'
import { readOpencodeDb, importOpencodeFile, importOpencodeDirectory } from './lib/opencode.mjs'
import { readZcodeDb, readZcodeTranscript, zcodeDefaultDbPath, importZcodeFile, importZcodeDirectory } from './lib/zcode.mjs'
import { discoverSessions, FORMATS } from './lib/discovery.mjs'

const name = 'import-claude'
const inject = ['sessionPersistence', 'fs', 'tools', 'webServer']

// ── REQ-37 上下文预算解析（纯 host 面）──────────────────────────────────
// 导入会话无 provider 配置时不会被 dsh 自动压缩（routedTarget 解析失败），超长
// 会话全量落盘后恢复对话直接 400。预算（token 数）解析优先级：
//   工具参数 budget > 环境变量 DSH_IMPORT_CONTEXT_BUDGET >
//   动态（agentDefaultModel.currentSelection + llm.resolveModelInfo 模型窗口）>
//   静态默认 550k。
// agentDefaultModel / llm 在 rc.6 host 服务面存在但可能未挂载：任一步不可用或
// 抛错都回退静态默认，绝不报错。解析结果盖写进 args.budget（转换层消费）与
// args.budgetSource（裁剪上报标注来源），并落进 imports registry。
const DEFAULT_CONTEXT_BUDGET = 550000
const IMPORT_BUDGET_ENV = 'DSH_IMPORT_CONTEXT_BUDGET'

// 预算值归一：缺省/非法（非正数）返回 null。
function parseBudgetValue(v) {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

// 动态预算：默认模型窗口 − 默认输出上限 − max(25% 窗口, 40k)。
async function dynamicContextBudget(ctx) {
  try {
    const adm = ctx.get('agentDefaultModel')
    const llm = ctx.get('llm')
    if (!adm || typeof adm.currentSelection !== 'function') return null
    if (!llm || typeof llm.resolveModelInfo !== 'function') return null
    const selection = adm.currentSelection()
    if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return null
    const info = await llm.resolveModelInfo(selection.provider, selection.model)
    const window = info && info.context && typeof info.context.contextWindow === 'number' ? info.context.contextWindow : null
    if (window === null || window <= 0) return null
    const maxTokens = typeof info.defaultMaxTokens === 'number' && info.defaultMaxTokens > 0 ? info.defaultMaxTokens : 0
    const budget = window - maxTokens - Math.max(Math.floor(window * 0.25), 40000)
    return Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : null
  } catch {
    // 动态解析任一环不可用（服务未挂载 / 模型无窗口元数据）→ 回退静态默认
    return null
  }
}

// 完整解析链，返回 { budget, source }（source ∈ param|env|dynamic|default）。
async function resolveImportBudget(ctx, args) {
  const param = parseBudgetValue(args.budget)
  if (param !== null) return { budget: param, source: 'param' }
  const env = parseBudgetValue(process.env[IMPORT_BUDGET_ENV])
  if (env !== null) return { budget: env, source: 'env' }
  const dynamic = await dynamicContextBudget(ctx)
  if (dynamic !== null) return { budget: dynamic, source: 'dynamic' }
  return { budget: DEFAULT_CONTEXT_BUDGET, source: 'default' }
}

// 把预算来源标注并入转换层裁剪上报（convert.mjs 纯函数只知预算值，不知来源）。
function markTrimmedSource(out, args) {
  if (out && out.trimmed && typeof args.budgetSource === 'string') {
    out.trimmed = { ...out.trimmed, source: args.budgetSource }
  }
  return out
}

// REQ-26：把转换层的畸形行明细 / secrets 位置 / permission 计数附加到公开结果。
// decideItem（lib/imports.mjs）只透传固定字段，这三个字段在此补透；非空才附加
//（schema 均为可选字段，空值不占键）。
function attachReq26(out, res) {
  if (out.skippedLines && out.skippedLines.length > 0) res.skippedLines = out.skippedLines
  if (out.secrets && out.secrets.length > 0) res.secrets = out.secrets
  if (out.permissionCount && out.permissionCount > 0) res.permissionCount = out.permissionCount
  return res
}

// 把导入的会话挂到其 cwd 对应的工作区（否则会显示为"未分组"）。
async function attachToWorkspace(ctx, meta) {
  if (!meta.cwd) return false
  const wr = ctx.get('workspaceRegistry')
  if (!wr || typeof wr.resolveByPath !== 'function') return false
  try {
    let ws = await wr.resolveByPath(meta.cwd)
    if (!ws) ws = await wr.create(meta.cwd)
    await ws.attachSession(meta.id)
    return true
  } catch (err) {
    console.error('workspace attach failed:', String((err && err.message) || err))
    return false
  }
}

// 预热投影缓存：冷读一次持久化会话并回写，让侧边栏无需打开会话即可显示
// 标题/模型等元数据（否则列表先显示 cwd 目录名，点开后才出现真实标题）。
// 失败不影响导入结果，仅记录日志。
async function warmProjection(ctx, sessionId) {
  const projectionCache = ctx.get('sessionProjectionCache')
  if (!projectionCache || typeof projectionCache.coldSnapshot !== 'function') return false
  try {
    await projectionCache.coldSnapshot(sessionId)
    return true
  } catch (err) {
    console.error('projection warm-up failed:', String((err && err.message) || err))
    return false
  }
}

// 执行 decideSingle / decideMulti 返回的决策并落盘；剥离 __ 载荷后返回公开结果。
// create 时才归组（append 续写不重复 attachToWorkspace）；persisted 就地更新供批量
// 内 id 避让；__record（新导入记录）经 rememberImport 写回 registry。
async function runDecision(ctx, decision, registryDir, sourcePath, persisted) {
  if (decision.__action === 'create') {
    const { __meta, __events } = decision
    await ctx.sessionPersistence.create(__meta)
    await ctx.sessionPersistence.append(__meta.id, __events)
    await attachToWorkspace(ctx, __meta)
    await warmProjection(ctx, __meta.id)
    persisted.add(__meta.id)
  } else if (decision.__action === 'append') {
    await ctx.sessionPersistence.append(decision.__targetId, decision.__tailEvents)
  } else if (decision.__action === 'multi') {
    for (const c of decision.__creates) {
      await ctx.sessionPersistence.create(c.meta)
      await ctx.sessionPersistence.append(c.meta.id, c.events)
      await attachToWorkspace(ctx, c.meta)
      await warmProjection(ctx, c.meta.id)
      persisted.add(c.meta.id)
    }
    for (const a of decision.__appends) {
      await ctx.sessionPersistence.append(a.targetId, a.events)
    }
  }
  if (decision.__record) await rememberImport(registryDir, sourcePath, decision.__record)
  const pub = {}
  for (const [k, v] of Object.entries(decision)) {
    if (!k.startsWith('__')) pub[k] = v
  }
  return pub
}

// 解析单个 transcript（REQ-24 状态机入口）：stat → registry 短路径判定 → 读取转换 →
// decideSingle 决策落盘 → 归组。幂等键 = sourcePath（fs 服务归一化路径）。persisted
// 可传入共享快照（批量模式），缺省按需取一次。
async function importTranscript(ctx, target, args, convert, { registryDir, persisted, fingerprintKeys = [] } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const stat = await ctx.fs.stat(target)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[sourcePath])
  if (known && known.kind !== 'single') known = null
  // 记录指向的会话已不存在（被删 / DSH_HOME 迁移）→ 视作无记录重导
  if (known && (!known.dshId || !persistedSet.has(known.dshId))) known = null
  const fingerprint = argsFingerprint(args, fingerprintKeys)

  // S3 短路径（不 readText）：force / 显式 sessionId 变更需读文件建副本，不在此跳过
  if (known && args.force !== true && !isSessionIdChange(args, known.dshId)) {
    if (typeof known.args === 'string' && fingerprint !== known.args) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported', argsChanged: true }
    }
    // REQ-37：预算变化（文件未变）→ 跳过并报告（同 argsChanged 语义）；需要按新预算
    // 导入用 force:true。budget 为 index 层解析后的实际预算（registry 记录同一口径）。
    if (typeof known.budget === 'number' && known.budget !== args.budget) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported', budgetChanged: true }
    }
    if (stat && stat.version === known.version && stat.size === known.sizeBytes) {
      // 未变：短路径跳过（不 readText），重复导入同一会话幂等
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported' }
    }
  }

  const raw = await ctx.fs.readText(target)
  const out = markTrimmedSource(convert(raw, { ...args, sourcePath }), args)
  // 无可导入内容（空文件 / 非目标格式 / 辅助 transcript）：计入 skipped，不落盘空会话
  if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
    const res = { sessionId: 'none', turns: 0, messages: 0, toolCalls: 0, skipped: 1, alreadyImported: false, status: 'skipped' }
    if (out.skipReason) res.skipReason = out.skipReason
    return attachReq26(out, res)
  }
  const decision = await decideSingle(ctx, { known, converted: out, stat, args, fingerprint, persisted: persistedSet, sourcePath, budget: args.budget })
  return attachReq26(out, await runDecision(ctx, decision, registryDir, sourcePath, persistedSet))
}

// 递归收集目录下的 .jsonl 文件（按名称稳定排序）。
async function collectJsonlFiles(ctx, dirTarget, out, recursive) {
  const entries = await ctx.fs.listDir(dirTarget)
  for (const entry of entries) {
    if (entry.type === 'directory') {
      if (recursive) await collectJsonlFiles(ctx, entry.target, out, recursive)
    } else if (entry.type === 'file' && /\.jsonl$/i.test(entry.name) && !isSidecarJsonl(entry.name)) {
      out.push(entry.target)
    }
  }
}

// 会话主 transcript 的伴生 JSONL（事件日志 / 冲突日志 / 守护文件）不是会话本身，
// 目录批量扫描时排除（Reasonix V2 的 <id>.events.jsonl 是 WAL，非主 transcript）。
function isSidecarJsonl(name) {
  return /\.(events|conflicts|guardian)\.jsonl$/i.test(name)
}

// 递归收集目录下的 .json 文件（ChatGPT 导出，按名称稳定排序）。
async function collectJsonFiles(ctx, dirTarget, out, recursive) {
  const entries = await ctx.fs.listDir(dirTarget)
  for (const entry of entries) {
    if (entry.type === 'directory') {
      if (recursive) await collectJsonFiles(ctx, entry.target, out, recursive)
    } else if (entry.type === 'file' && /\.json$/i.test(entry.name)) {
      out.push(entry.target)
    }
  }
}

// 把单文件结果归一为批量 results 条目（skipReason → reason；可选字段原样带过）。
function batchItem(path, single) {
  const item = {
    path,
    status: single.status,
    sessionId: single.sessionId,
    turns: single.turns,
    messages: single.messages,
    toolCalls: single.toolCalls,
    skipped: single.skipped,
  }
  for (const k of ['skipReason', 'error', 'appendedTurns', 'appendedEvents', 'appendedSkipped', 'sourceShrunk', 'changedInPlace', 'argsChanged', 'budgetChanged', 'backfilled', 'droppedBoundaryResults', 'forceImported', 'trimmed', 'skippedLines', 'secrets', 'permissionCount']) {
    if (single[k] !== undefined) item[k === 'skipReason' ? 'reason' : k] = single[k]
  }
  return item
}

// 批量导入：把目录下匹配 pattern 的文件都作为独立会话导入（每个文件走
// importTranscript 状态机，共享 persisted 快照与 registry 目录）。
// deriveArgs(target) 允许按文件派生转换参数（可 async；Cursor 取文件名 composer id，
// Reasonix 读同目录 meta.json 拿 workspace/summary）；collect 默认收集 .jsonl。
async function importDirectory(ctx, dirTarget, args, { convert, sourceLabel, deriveArgs, collect, registryDir, fingerprintKeys = [] }) {
  const files = []
  const collector = collect || collectJsonlFiles
  await collector(ctx, dirTarget, files, args.recursive !== false)
  const results = []
  let imported = 0
  let alreadyImported = 0
  let appended = 0
  let skipped = 0
  let failed = 0
  const persisted = await listPersistedIds(ctx)
  for (const target of files) {
    const path = target.displayPath || ctx.fs.processPath(target)
    try {
      const derived = deriveArgs ? await deriveArgs(target) : {}
      // 展开 args（含 REQ-37 预算 budget/budgetSource），deriveArgs 可覆盖
      const single = await importTranscript(ctx, target, { ...args, ...derived, force: args.force === true }, convert, { registryDir, persisted, fingerprintKeys })
      if (single.status === 'imported') imported++
      else if (single.status === 'appended') appended++
      else if (single.status === 'already-imported') alreadyImported++
      else skipped++
      const item = batchItem(path, single)
      if (item.status === 'skipped' && !item.reason) item.reason = 'not a ' + sourceLabel + ' transcript (no user turns)'
      results.push(item)
    } catch (err) {
      failed++
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: files.length, imported, alreadyImported, appended, skipped, failed, results }
}

// ChatGPT 导出导入：单个 conversations.json 可能含多个会话，每个会话独立落盘
// （REQ-24：逐会话判增 append / 消失 missingFromSource；force=全量新副本）。
async function importChatgptFile(ctx, target, args, { registryDir, persisted } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const path = target.displayPath || ctx.fs.processPath(target)
  const stat = await ctx.fs.stat(target)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[path])
  if (known && known.kind !== 'multi') known = null
  const fingerprint = argsFingerprint(args, [])

  // S3 短路径（不 readText）：version/size 未变 → 逐会话跳过。仅当记录里所有会话
  // 仍存在时短路径才成立（会话被删 / DSH_HOME 迁移 → 走全量重导）
  if (known && (!known.conversations || typeof known.conversations !== 'object')) known = null
  if (known && args.force !== true) {
    const subs = Object.values(known.conversations)
    const allPersisted = subs.length > 0 && subs.every((sub) => persistedSet.has(sub.dshId))
    // REQ-37：预算变化 → 跳过并上报 budgetChanged（同 argsChanged 语义）
    if (allPersisted && typeof known.budget === 'number' && known.budget !== args.budget) {
      const results = Object.entries(known.conversations).map(([, sub]) => ({
        path, status: 'already-imported', sessionId: sub.dshId, turns: sub.turns, messages: 0, toolCalls: 0, skipped: 0, budgetChanged: true,
      }))
      return { total: results.length, imported: 0, alreadyImported: results.length, appended: 0, skipped: 0, failed: 0, results }
    }
    if (allPersisted && stat && stat.version === known.version && stat.size === known.sizeBytes) {
      const results = Object.entries(known.conversations).map(([, sub]) => ({
        path, status: 'already-imported', sessionId: sub.dshId, turns: sub.turns, messages: 0, toolCalls: 0, skipped: 0,
      }))
      return { total: results.length, imported: 0, alreadyImported: results.length, appended: 0, skipped: 0, failed: 0, results }
    }
  }

  const raw = await ctx.fs.readText(target)
  const { conversations, skipped: skippedFiles } = convertChatgptJson(raw, { sourcePath: path, budget: args.budget })
  for (const conv of conversations) markTrimmedSource(conv, args)
  const items = conversations.map((conv) => ({ key: conv.meta.sourceId || conv.meta.id, converted: conv }))
  const decision = await decideMulti(ctx, { known, items, stat, args, fingerprint, persisted: persistedSet, sourcePath: path, subTable: 'conversations', budget: args.budget })
  const missing = known ? Object.keys(known.conversations).filter((k) => !items.some((i) => i.key === k)) : []
  const result = await runDecision(ctx, decision, registryDir, path, persistedSet)
  return {
    ...result,
    total: result.results.length + skippedFiles,
    skipped: result.skipped + skippedFiles,
    ...(missing.length ? { missingFromSource: missing } : {}),
  }
}

// ChatGPT 目录导入：扫描 .json 文件，每个文件可含多个会话。
async function importChatgptDirectory(ctx, dirTarget, args, { registryDir, persisted } = {}) {
  const files = []
  await collectJsonFiles(ctx, dirTarget, files, args.recursive !== false)
  const results = []
  let imported = 0
  let alreadyImported = 0
  let appended = 0
  let skipped = 0
  let failed = 0
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  for (const target of files) {
    try {
      const r = await importChatgptFile(ctx, target, args, { registryDir, persisted: persistedSet })
      imported += r.imported
      alreadyImported += r.alreadyImported
      appended += r.appended
      skipped += r.skipped
      failed += r.failed
      results.push(...r.results)
    } catch (err) {
      const path = target.displayPath || ctx.fs.processPath(target)
      failed++
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: results.length, imported, alreadyImported, appended, skipped, failed, results }
}

// ── import_grokbuild 编排：源是会话目录（summary.json + chat_history.jsonl）────

// 会话目录复合 stat：两文件 size/version 拼接（任一文件变化 → 复合指纹变化 → 重读）。
// registry 的 sizeBytes/version 落复合值，REQ-24 短路径判定对双文件都有效。
async function grokbuildStat(ctx, summaryTarget, chatTarget) {
  const s = await ctx.fs.stat(summaryTarget)
  const c = await ctx.fs.stat(chatTarget)
  return {
    type: 'file',
    size: (s && typeof s.size === 'number' ? s.size : 0) + (c && typeof c.size === 'number' ? c.size : 0),
    version: (s ? s.version : '') + '|' + (c ? c.version : ''),
  }
}

// 递归收集会话目录：目录含 summary.json 即会话（收下，不下钻）；否则 recursive 时
// 下钻（sessions 根 → <project>/ → <session_id>/ 两级结构）。
async function collectGrokbuildSessions(ctx, dirTarget, out, recursive) {
  const entries = await ctx.fs.listDir(dirTarget)
  for (const entry of entries) {
    if (entry.type !== 'directory') continue
    const sub = await ctx.fs.resolve(entry.target.displayPath || entry.target.targetKey)
    const sumTarget = await ctx.fs.resolve(join(sub.targetKey, 'summary.json'))
    const sumStat = await ctx.fs.stat(sumTarget)
    if (sumStat && sumStat.type === 'file') {
      out.push(sub)
    } else if (recursive) {
      await collectGrokbuildSessions(ctx, sub, out, recursive)
    }
  }
}

// chat_history.jsonl 可选：会话目录缺失该文件（仅 summary 的会话）按空文本读，
// 转换层按无回合跳过（meta 仍来自 summary）。
async function readGrokHistory(ctx, chatTarget) {
  try {
    return await ctx.fs.readText(chatTarget)
  } catch {
    // 缺失 chat_history.jsonl：视为无历史，不当作失败
    return ''
  }
}

// 单会话目录导入（REQ-24 状态机）：幂等键 = 会话目录路径；复合 stat 指纹；
// 读 summary.json + chat_history.jsonl 再转换落盘。persisted 可传共享快照。
async function importGrokbuildSession(ctx, target, args, { registryDir, persisted } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[sourcePath])
  if (known && known.kind !== 'single') known = null
  // 记录指向的会话已不存在（被删 / DSH_HOME 迁移）→ 视作无记录重导
  if (known && (!known.dshId || !persistedSet.has(known.dshId))) known = null
  const fingerprint = argsFingerprint(args, [])

  const summaryTarget = await ctx.fs.resolve(join(sourcePath, 'summary.json'))
  const chatTarget = await ctx.fs.resolve(join(sourcePath, 'chat_history.jsonl'))
  const stat = await grokbuildStat(ctx, summaryTarget, chatTarget)

  // S3 短路径（不 readText）：force / 显式 sessionId 变更需读文件建副本，不在此跳过
  if (known && args.force !== true && !isSessionIdChange(args, known.dshId)) {
    if (typeof known.args === 'string' && fingerprint !== known.args) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported', argsChanged: true }
    }
    // REQ-37：预算变化（文件未变）→ 跳过并报告（同 argsChanged 语义）
    if (typeof known.budget === 'number' && known.budget !== args.budget) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported', budgetChanged: true }
    }
    if (stat && stat.version === known.version && stat.size === known.sizeBytes) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported' }
    }
  }

  const summaryText = await ctx.fs.readText(summaryTarget)
  const chatText = await readGrokHistory(ctx, chatTarget)
  const out = markTrimmedSource(convertGrokbuildJson(summaryText, chatText, { ...args, sourcePath }), args)
  // 无可导入内容（空 chat_history / 畸形 summary）：计入 skipped，不落盘空会话
  if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
    const res = { sessionId: 'none', turns: 0, messages: 0, toolCalls: 0, skipped: 1, alreadyImported: false, status: 'skipped' }
    if (out.skipReason) res.skipReason = out.skipReason
    return attachReq26(out, res)
  }
  const decision = await decideSingle(ctx, { known, converted: out, stat, args, fingerprint, persisted: persistedSet, sourcePath, budget: args.budget })
  return attachReq26(out, await runDecision(ctx, decision, registryDir, sourcePath, persistedSet))
}

// grokbuild 目录批量：递归扫 summary.json 收集会话目录，逐目录走单会话状态机。
async function importGrokbuildDirectory(ctx, dirTarget, args, { registryDir, persisted } = {}) {
  const sessions = []
  await collectGrokbuildSessions(ctx, dirTarget, sessions, args.recursive !== false)
  const results = []
  let imported = 0
  let alreadyImported = 0
  let appended = 0
  let skipped = 0
  let failed = 0
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  for (const target of sessions) {
    const path = target.displayPath || ctx.fs.processPath(target)
    try {
      const single = await importGrokbuildSession(ctx, target, { ...args, force: args.force === true }, { registryDir, persisted: persistedSet })
      if (single.status === 'imported') imported++
      else if (single.status === 'appended') appended++
      else if (single.status === 'already-imported') alreadyImported++
      else skipped++
      const item = batchItem(path, single)
      if (item.status === 'skipped' && !item.reason) item.reason = 'not a grokbuild session (no user turns)'
      results.push(item)
    } catch (err) {
      failed++
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: sessions.length, imported, alreadyImported, appended, skipped, failed, results }
}

// ── import_hermes 编排：state.db（SQLite，恒批量）或 sessions/*.jsonl 回退 ──────

// hermes 文件参数派生：无 session 记录时用文件 stem 作会话 id（幂等、确定性）。
function hermesFileArgs(ctx, target) {
  const p = target.displayPath || ctx.fs.processPath(target)
  const base = String(p).split(/[\\/]/).pop() || ''
  return { fileStem: base.replace(/\.(jsonl|json)$/i, '') }
}

// hermes 单库导入：DB 内每个会话独立落盘，恒返回批量形态（对齐 importOpencodeFile）。
// REQ-24：DB 级 version/size 短路径检测；逐会话判增 append / 会话消失 missingFromSource。
// sessions 可预读传入（目录模式已读一次判 db 可用性，避免二次打开）。
async function importHermesDbFile(ctx, target, args, { registryDir, persisted, sessions } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const path = target.displayPath || ctx.fs.processPath(target)
  const stat = await ctx.fs.stat(target)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[path])
  if (known && known.kind !== 'multi') known = null
  const fingerprint = argsFingerprint(args, [])

  // S3 短路径（不重读 SQLite）。仅当记录里所有会话仍存在时短路径才成立
  if (known && (!known.sessions || typeof known.sessions !== 'object')) known = null
  if (known && args.force !== true) {
    const subs = Object.values(known.sessions)
    const allPersisted = subs.length > 0 && subs.every((sub) => persistedSet.has(sub.dshId))
    if (allPersisted) {
      const skipResults = () => Object.entries(known.sessions).map(([, sub]) => ({
        path, status: 'already-imported', sessionId: sub.dshId, turns: sub.turns, messages: 0, toolCalls: 0, skipped: 0,
      }))
      if (typeof known.args === 'string' && fingerprint !== known.args) {
        const results = skipResults().map((r) => ({ ...r, argsChanged: true }))
        return { total: results.length, imported: 0, alreadyImported: results.length, appended: 0, skipped: 0, failed: 0, results }
      }
      // REQ-37：预算变化 → 跳过并上报 budgetChanged（同 argsChanged 语义）
      if (typeof known.budget === 'number' && known.budget !== args.budget) {
        const results = skipResults().map((r) => ({ ...r, budgetChanged: true }))
        return { total: results.length, imported: 0, alreadyImported: results.length, appended: 0, skipped: 0, failed: 0, results }
      }
      if (stat && stat.version === known.version && stat.size === known.sizeBytes) {
        const count = Object.keys(known.sessions).length
        return { total: count, imported: 0, alreadyImported: count, appended: 0, skipped: 0, failed: 0, results: skipResults() }
      }
    }
  }

  const dbSessions = sessions ?? readHermesDb(path)
  if (dbSessions === null) throw new Error('hermes db 不可用（非 SQLite / 无 sessions 表）: ' + path)
  const items = []
  const preSkipped = []
  for (const s of dbSessions) {
    const out = markTrimmedSource(convertHermesJson(JSON.stringify(s), { ...args, sourcePath: path }), args)
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      preSkipped.push({ path, status: 'skipped', reason: 'no user turns (session ' + s.id + ')' })
      continue
    }
    items.push({ key: s.id, converted: out })
  }
  const decision = await decideMulti(ctx, { known, items, stat, args, fingerprint, persisted: persistedSet, sourcePath: path, subTable: 'sessions', budget: args.budget })
  const missing = known && known.sessions ? Object.keys(known.sessions).filter((k) => !dbSessions.some((s) => s.id === k)) : []
  const result = await runDecision(ctx, decision, registryDir, path, persistedSet)
  return {
    ...result,
    total: dbSessions.length,
    skipped: result.skipped + preSkipped.length,
    results: [...preSkipped, ...result.results],
    ...(missing.length ? { missingFromSource: missing } : {}),
  }
}

// hermes 目录导入：优先定位 state.db（SQLite 恒批量）；db 不可用（readHermesDb
// 返回 null：目录无 state.db / 非 hermes 库）→ 回退递归扫 .jsonl（逐文件单会话）。
async function importHermesDirectory(ctx, dirTarget, args, { registryDir, persisted } = {}) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const dbPath = join(dirPath, 'state.db')
  const dbTarget = await ctx.fs.resolve(dbPath)
  const dbSessions = readHermesDb(dbPath)
  if (dbSessions !== null) {
    return importHermesDbFile(ctx, dbTarget, args, { registryDir, persisted, sessions: dbSessions })
  }
  return importDirectory(ctx, dirTarget, args, { convert: convertHermesJson, sourceLabel: 'Hermes', deriveArgs: (target) => hermesFileArgs(ctx, target), collect: collectJsonlFiles, registryDir })
}

// hermes 单文件入口：.db → SQLite 恒批量；.jsonl/.json → 标准单会话导入。
async function importHermesFile(ctx, target, args, { registryDir } = {}) {
  const path = target.displayPath || ctx.fs.processPath(target)
  if (/\.db$/i.test(String(path))) {
    return importHermesDbFile(ctx, target, args, { registryDir })
  }
  return importTranscript(ctx, target, args, convertHermesJson, { registryDir })
}

// ── REQ-17 导入 dry-run 预览（preview / dryRun 别名）────────────────────────
// preview=true 时照常 resolve / readText / convert（拿到 meta/turns/title/messages/
// toolCalls/skipped 等统计），但绝不 create/append、绝不写 imports registry、绝不
// attachToWorkspace（零副作用）；也不触发增量续写 / 幂等 registry 读写——预览分支
// 完全绕开 loadImports / listPersistedIds / decideSingle / decideMulti / runDecision，
// 只做只读转换 + 统计。返回结构与正式导入同源（同 mode/total/results 骨架），只加
// preview:true 标记、去掉写入态字段（sessionId/status/alreadyImported 等）。
function isPreview(args) {
  return !!(args && (args.preview === true || args.dryRun === true))
}

// 把转换输出压成预览条目：标题 / cwd / 时间 / 规模 / 跳过明细。与正式结果同口径
//（turns/messages/toolCalls/skipped 同 decideItem base 的来源），无值字段不占键。
// 跳过语义对齐 importTranscript：无可导入内容时该文件计 1 次跳过（正式 skipped 结果
// 即 hardcode skipped:1，不看转换层的畸形行计数）。
function previewEntry(out) {
  const noContent = !out.meta || (Array.isArray(out.turns) && out.turns.length === 0 && Array.isArray(out.events) && out.events.length === 0)
  const entry = {
    turns: Array.isArray(out.turns) ? out.turns.length : 0,
    messages: out.messages || 0,
    toolCalls: out.toolCalls || 0,
    skipped: noContent ? 1 : (out.skipped || 0),
  }
  if (out.title) entry.title = out.title
  if (out.meta && typeof out.meta.cwd === 'string' && out.meta.cwd) entry.cwd = out.meta.cwd
  if (out.meta && typeof out.meta.createdAt === 'number') entry.createdAt = out.meta.createdAt
  if (out.skipReason) entry.skipReason = out.skipReason
  return entry
}

// 标准单文件预览：readText + convert（与 importTranscript 同源），零副作用。
async function previewTranscript(ctx, target, args, convert) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const out = markTrimmedSource(convert(await ctx.fs.readText(target), { ...args, sourcePath }), args)
  return previewEntry(out)
}

// 标准目录预览：逐文件 readText + convert（与 importDirectory 同源），零副作用。
async function previewDirectory(ctx, dirTarget, args, { convert, deriveArgs, collect } = {}) {
  const files = []
  const collector = collect || collectJsonlFiles
  await collector(ctx, dirTarget, files, args.recursive !== false)
  const results = []
  for (const target of files) {
    const path = target.displayPath || ctx.fs.processPath(target)
    try {
      const derived = deriveArgs ? await deriveArgs(target) : {}
      const out = markTrimmedSource(convert(await ctx.fs.readText(target), { ...args, ...derived, sourcePath: path }), args)
      results.push({ path, ...previewEntry(out) })
    } catch (err) {
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: files.length, results }
}

// ChatGPT 单文件预览：一个 conversations.json 逐会话预览（与 importChatgptFile 同源）。
async function previewChatgptFile(ctx, target, args) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const { conversations, skipped } = convertChatgptJson(await ctx.fs.readText(target), { sourcePath: path, budget: args.budget })
  const results = conversations.map((conv) => ({ path, ...previewEntry(conv) }))
  if (skipped > 0) {
    // 整文件跳过（无合法会话）或个别会话无可导入内容：跳过明细聚合一条
    results.push({ path, skipped, skipReason: 'no importable conversations (' + skipped + ' skipped)' })
  }
  return { total: conversations.length + skipped, results }
}

async function previewChatgptDirectory(ctx, dirTarget, args) {
  const files = []
  await collectJsonFiles(ctx, dirTarget, files, args.recursive !== false)
  const results = []
  for (const target of files) {
    try {
      results.push(...(await previewChatgptFile(ctx, target, args)).results)
    } catch (err) {
      const path = target.displayPath || ctx.fs.processPath(target)
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: results.length, results }
}

// grokbuild 单会话目录预览：读 summary.json + chat_history.jsonl 转换（与
// importGrokbuildSession 同源），零副作用。
async function previewGrokbuildSession(ctx, target, args) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const summaryTarget = await ctx.fs.resolve(join(sourcePath, 'summary.json'))
  const chatTarget = await ctx.fs.resolve(join(sourcePath, 'chat_history.jsonl'))
  const out = markTrimmedSource(convertGrokbuildJson(await ctx.fs.readText(summaryTarget), await readGrokHistory(ctx, chatTarget), { ...args, sourcePath }), args)
  return previewEntry(out)
}

async function previewGrokbuildDirectory(ctx, dirTarget, args) {
  const sessions = []
  await collectGrokbuildSessions(ctx, dirTarget, sessions, args.recursive !== false)
  const results = []
  for (const target of sessions) {
    const path = target.displayPath || ctx.fs.processPath(target)
    try {
      results.push({ path, ...(await previewGrokbuildSession(ctx, target, args)) })
    } catch (err) {
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: sessions.length, results }
}

// hermes DB 预览：state.db 每会话转换（与 importHermesDbFile 同源），零副作用。
async function previewHermesDbFile(ctx, target, args, { sessions } = {}) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const dbSessions = sessions ?? readHermesDb(path)
  if (dbSessions === null) throw new Error('hermes db 不可用（非 SQLite / 无 sessions 表）: ' + path)
  const results = []
  for (const s of dbSessions) {
    const out = markTrimmedSource(convertHermesJson(JSON.stringify(s), { ...args, sourcePath: path }), args)
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      results.push({ path, skipped: 1, skipReason: 'no user turns (session ' + s.id + ')' })
      continue
    }
    results.push({ path, ...previewEntry(out) })
  }
  return { total: dbSessions.length, results }
}

async function previewHermesFile(ctx, target, args) {
  const path = target.displayPath || ctx.fs.processPath(target)
  if (/\.db$/i.test(String(path))) return previewHermesDbFile(ctx, target, args)
  return previewTranscript(ctx, target, args, convertHermesJson)
}

async function previewHermesDirectory(ctx, dirTarget, args) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const dbPath = join(dirPath, 'state.db')
  const dbTarget = await ctx.fs.resolve(dbPath)
  const dbSessions = readHermesDb(dbPath)
  if (dbSessions !== null) return previewHermesDbFile(ctx, dbTarget, args, { sessions: dbSessions })
  return previewDirectory(ctx, dirTarget, args, { convert: convertHermesJson, deriveArgs: (target) => hermesFileArgs(ctx, target), collect: collectJsonlFiles })
}

// opencode 预览：lib/opencode.mjs 的 importOpencodeFile 编排（registry / decideMulti /
// 落盘）不属于预览分支，这里用同源只读件重演「读库 → 逐会话转换 → 统计」：
// readOpencodeDb 只读 SQLite、convertOpencodeJson 纯函数，两者都零副作用。
async function previewOpencodeFile(ctx, target, args) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const sessions = readOpencodeDb(path, { fullHistory: args.fullHistory === true })
  const wanted = Array.isArray(args.sessionIds) && args.sessionIds.length > 0 ? new Set(args.sessionIds) : null
  const results = []
  for (const s of sessions) {
    if (wanted && !wanted.has(s.id)) continue
    const out = markTrimmedSource(convertOpencodeJson(JSON.stringify(s), { ...args, sourcePath: path }), args)
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      results.push({ path, skipped: 1, skipReason: 'no user turns (session ' + s.id + ')' })
      continue
    }
    results.push({ path, ...previewEntry(out) })
  }
  return { total: sessions.length, results }
}

async function previewOpencodeDirectory(ctx, dirTarget, args) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const dbTarget = await ctx.fs.resolve(join(dirPath, 'opencode.db'))
  return previewOpencodeFile(ctx, dbTarget, args)
}

// zcode 预览：db.sqlite / transcript.jsonl 回退 / zcode://<id> 伪路径，同源只读重演
//（lib/zcode.mjs 编排不可改，预览绕开 registry / decideMulti / 落盘）。
async function previewZcodeFile(ctx, target, args) {
  const rawPath = typeof args.path === 'string' ? args.path : ''
  const isPseudo = rawPath.startsWith('zcode://')
  const path = isPseudo ? rawPath : (target.displayPath || ctx.fs.processPath(target))
  const zcodeId = typeof args.zcodeId === 'string' && args.zcodeId
    ? args.zcodeId
    : isPseudo ? rawPath.slice('zcode://'.length) : undefined
  const sessions = isPseudo ? readZcodeDb(zcodeDefaultDbPath())
    : (/\.jsonl$/i.test(String(path)) ? readZcodeTranscript(path) : readZcodeDb(path))
  const wanted = zcodeId ? new Set([zcodeId])
    : (Array.isArray(args.sessionIds) && args.sessionIds.length > 0 ? new Set(args.sessionIds) : null)
  const results = []
  if (zcodeId && !sessions.some((s) => s.id === zcodeId)) {
    results.push({ path, skipped: 1, skipReason: 'zcode 会话不存在: ' + zcodeId })
  }
  for (const s of sessions) {
    if (wanted && !wanted.has(s.id)) continue
    const out = markTrimmedSource(convertZcodeJson(JSON.stringify(s), { ...args, sourcePath: path }), args)
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      results.push({ path, skipped: 1, skipReason: 'no user turns (session ' + s.id + ')' })
      continue
    }
    results.push({ path, ...previewEntry(out) })
  }
  return { total: sessions.length, results }
}

async function previewZcodeDirectory(ctx, dirTarget, args) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const dbTarget = await ctx.fs.resolve(join(dirPath, 'db.sqlite'))
  return previewZcodeFile(ctx, dbTarget, args)
}

// 两个导入工具共享的 schema / render / execute 骨架，只差名称、描述、转换器与导入函数。
// registryDir 由 apply 传入（$DSH_HOME/dsh-chat-import）；fingerprintKeys 决定哪些
// 工具参数计入 imports registry 的 args 指纹（opencode 的 fullHistory 等）。
// previewFile / previewDir 提供 REQ-17 dry-run 预览实现（缺省走标准单文件/目录预览）。
function makeImportTool(ctx, { toolName, sourceLabel, convert, description, importFile, importDir, alwaysBatch, deriveArgs, collect, extraParameters, pathDescription, dropParameters, batchUnit = '文件', skippedNote, registryDir, fingerprintKeys = [], dirSingle, fileBatch, previewFile, previewDir }) {
  const derive = deriveArgs || (async () => ({}))
  const importSingle = importFile || ((c, t, a) => importTranscript(c, t, a, convert, { registryDir, fingerprintKeys }))
  const importBatch = importDir || ((c, d, a) => importDirectory(c, d, a, { convert, sourceLabel, deriveArgs: derive, collect, registryDir, fingerprintKeys }))
  const previewSingle = previewFile || ((c, t, a) => previewTranscript(c, t, a, convert))
  const previewBatch = previewDir || ((c, d, a) => previewDirectory(c, d, a, { convert, deriveArgs: derive, collect }))
  // 增量续写语义（REQ-24）：与各工具 description 里的「幂等跳过」表述互补
  const descriptionSuffix = ' 重复导入已导入的源文件会增量续写新增轮次（源文件未变则跳过）；force:true 以新 id 另存完整副本。'
  return defineTool({
    name: toolName,
    description: description + descriptionSuffix,
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: pathDescription || (alwaysBatch
          ? 'ChatGPT 导出 conversations.json 的文件路径，或包含多个 .json 的目录路径。'
          : sourceLabel + ' transcript (.jsonl) 的文件路径，或包含多个 .jsonl 的目录路径。'),
      },
      force: {
        type: 'boolean',
        description: '可选：true 时即使已导入也以新 id（import-<src>-<n>）另存一份完整副本，旧会话原样保留。',
      },
      budget: {
        type: 'integer',
        description: '可选：上下文预算（token 数），超长会话按三层保护裁剪。优先级：本参数 > 环境变量 DSH_IMPORT_CONTEXT_BUDGET > 动态模型窗口（agentDefaultModel + llm）> 静态默认 550k。',
      },
      preview: {
        type: 'boolean',
        description: '可选：true 时 dry-run 预览——不落盘、不写 imports registry、不归组，仅返回将导入会话清单（标题 / cwd / 时间 / 规模 / 跳过明细），确认后再正式导入（去掉 preview 再调一次即可）。',
      },
      dryRun: {
        type: 'boolean',
        description: '可选：preview 的兼容别名（语义相同：不落盘、仅返回将导入会话清单）。',
      },
      ...((dropParameters || []).includes('sessionId') ? {} : {
        sessionId: {
          type: 'string',
          description: '可选：目标 DSH 会话 id（仅单文件导入时生效，默认 import-<源sessionId>；目录模式忽略）。',
        },
      }),
      ...((dropParameters || []).includes('recursive') ? {} : {
        recursive: {
          type: 'boolean',
          description: '可选：目录模式是否递归子目录（默认 true）。',
        },
      }),
      ...extraParameters,
    },
    output: {
      schema: {
        oneOf: [
          // 单文件 dry-run 预览（REQ-17）：无写入态字段（sessionId/status/alreadyImported 等）
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', enum: ['single'], required: true },
              preview: { type: 'boolean', const: true, required: true },
              title: { type: 'string' },
              cwd: { type: 'string' },
              createdAt: { type: 'integer' },
              turns: { type: 'integer', required: true },
              messages: { type: 'integer', required: true },
              toolCalls: { type: 'integer', required: true },
              skipped: { type: 'integer', required: true },
              skipReason: { type: 'string' },
            },
          },
          // 目录（批量）dry-run 预览（REQ-17）：同 total/results 骨架，无写入态计数
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', enum: ['batch'], required: true },
              preview: { type: 'boolean', const: true, required: true },
              total: { type: 'integer', required: true },
              results: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    title: { type: 'string' },
                    cwd: { type: 'string' },
                    createdAt: { type: 'integer' },
                    turns: { type: 'integer' },
                    messages: { type: 'integer' },
                    toolCalls: { type: 'integer' },
                    skipped: { type: 'integer' },
                    skipReason: { type: 'string' },
                    status: { type: 'string', enum: ['failed'] },
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
          // 单文件模式
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', enum: ['single'], required: true },
              sessionId: { type: 'string', required: true },
              turns: { type: 'integer', required: true },
              messages: { type: 'integer', required: true },
              toolCalls: { type: 'integer', required: true },
              skipped: { type: 'integer' },
              skippedLines: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    line: { type: 'integer', required: true },
                    error: { type: 'string', required: true },
                  },
                },
              },
              secrets: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    line: { type: 'integer', required: true },
                    kind: { type: 'string', required: true },
                  },
                },
              },
              permissionCount: { type: 'integer' },
              skipReason: { type: 'string' },
              alreadyImported: { type: 'boolean', required: true },
              status: { type: 'string', required: true, enum: ['imported', 'already-imported', 'appended', 'skipped'] },
              appendedTurns: { type: 'integer' },
              appendedEvents: { type: 'integer' },
              appendedSkipped: { type: 'string' },
              sourceShrunk: { type: 'boolean' },
              changedInPlace: { type: 'boolean' },
              argsChanged: { type: 'boolean' },
              budgetChanged: { type: 'boolean' },
              backfilled: { type: 'boolean' },
              droppedBoundaryResults: { type: 'integer' },
              trimmed: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  budget: { type: 'integer', required: true },
                  source: { type: 'string', enum: ['param', 'env', 'dynamic', 'default'], required: true },
                  originalTokens: { type: 'integer', required: true },
                  estimatedTokens: { type: 'integer', required: true },
                  croppedBlocks: { type: 'integer', required: true },
                  droppedTurns: { type: 'integer', required: true },
                  droppedMessages: { type: 'integer', required: true },
                  droppedToolCalls: { type: 'integer', required: true },
                  droppedToolResults: { type: 'integer', required: true },
                  droppedOversized: { type: 'integer', required: true },
                  summaryInserted: { type: 'boolean', required: true },
                },
              },
              forceImported: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  previous: { type: 'string', required: true },
                  current: { type: 'string', required: true },
                },
              },
            },
          },
          // 目录（批量）模式
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', enum: ['batch'], required: true },
              total: { type: 'integer', required: true },
              imported: { type: 'integer', required: true },
              alreadyImported: { type: 'integer', required: true },
              appended: { type: 'integer', required: true },
              skipped: { type: 'integer', required: true },
              failed: { type: 'integer', required: true },
              missingFromSource: { type: 'array', items: { type: 'string' } },
              results: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    status: {
                      type: 'string',
                      required: true,
                      enum: ['imported', 'already-imported', 'appended', 'skipped', 'failed'],
                    },
                    sessionId: { type: 'string' },
                    turns: { type: 'integer' },
                    messages: { type: 'integer' },
                    toolCalls: { type: 'integer' },
                    skipped: { type: 'integer' },
                    skippedLines: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          line: { type: 'integer', required: true },
                          error: { type: 'string', required: true },
                        },
                      },
                    },
                    secrets: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          line: { type: 'integer', required: true },
                          kind: { type: 'string', required: true },
                        },
                      },
                    },
                    permissionCount: { type: 'integer' },
                    alreadyImported: { type: 'boolean' },
                    reason: { type: 'string' },
                    error: { type: 'string' },
                    appendedTurns: { type: 'integer' },
                    appendedEvents: { type: 'integer' },
                    appendedSkipped: { type: 'string' },
                    sourceShrunk: { type: 'boolean' },
                    changedInPlace: { type: 'boolean' },
                    argsChanged: { type: 'boolean' },
                    budgetChanged: { type: 'boolean' },
                    backfilled: { type: 'boolean' },
                    droppedBoundaryResults: { type: 'integer' },
                    trimmed: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        budget: { type: 'integer', required: true },
                        source: { type: 'string', enum: ['param', 'env', 'dynamic', 'default'], required: true },
                        originalTokens: { type: 'integer', required: true },
                        estimatedTokens: { type: 'integer', required: true },
                        croppedBlocks: { type: 'integer', required: true },
                        droppedTurns: { type: 'integer', required: true },
                        droppedMessages: { type: 'integer', required: true },
                        droppedToolCalls: { type: 'integer', required: true },
                        droppedToolResults: { type: 'integer', required: true },
                        droppedOversized: { type: 'integer', required: true },
                        summaryInserted: { type: 'boolean', required: true },
                      },
                    },
                    forceImported: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        previous: { type: 'string', required: true },
                        current: { type: 'string', required: true },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
      render: (args, value) => {
        // REQ-17 dry-run 预览：人类可读清单（未落盘提示 + 逐条明细摘要）
        if (value.preview === true) {
          if (value.mode === 'batch') {
            const detail = (value.results || []).slice(0, 5).map((r) => '  - ' + r.path
              + (r.title ? '：' + r.title : '')
              + (r.skipReason ? '：' + r.skipReason : '')
              + (r.status === 'failed' && r.error ? '：' + r.error : ''))
            return [{
              type: 'text',
              text: '预览（dry-run，未落盘）：共 ' + value.total + ' 个' + batchUnit
                + (detail.length ? '\n' + detail.join('\n') : ''),
            }]
          }
          return [{
            type: 'text',
            text: '预览（dry-run，未落盘）：'
              + (value.title ? '《' + value.title + '》' : '')
              + (value.turns > 0 ? value.turns + ' 轮对话' : '无可导入内容')
              + '（' + value.messages + ' 条消息、' + value.toolCalls + ' 次工具调用'
              + (value.skipped ? '、跳过 ' + value.skipped : '') + '）'
              + (value.skipReason ? '\n跳过原因：' + value.skipReason : ''),
          }]
        }
        // REQ-37 裁剪上报摘要（trimmed 存在时追加一行人类可读说明）
        const trimmedNote = (v) => {
          const t = v && v.trimmed
          if (!t) return ''
          const bits = []
          if (t.droppedTurns > 0) bits.push('裁剪 ' + t.droppedTurns + ' 轮')
          if (t.croppedBlocks > 0) bits.push('裁剪 ' + t.croppedBlocks + ' 条超长内容')
          if (t.droppedOversized > 0) bits.push('丢弃 ' + t.droppedOversized + ' 条超半消息')
          if (t.summaryInserted) bits.push('已插入摘要')
          return bits.length > 0 ? '（' + bits.join('，') + '，估算 ' + t.estimatedTokens + '/' + t.budget + ' tokens，来源 ' + t.source + '）' : ''
        }
        // REQ-26 畸形行明细 + secrets/permission 计数：只含行号与 kind，绝不拼入内容
        const req26Note = (v) => {
          const skippedLines = v.skippedLines || []
          const counts = []
          if (v.secrets && v.secrets.length > 0) counts.push('secrets 命中 ' + v.secrets.length + ' 处')
          if (v.permissionCount) counts.push('permission ' + v.permissionCount + ' 条')
          if (skippedLines.length === 0) return counts.join('、')
          const lines = skippedLines.slice(0, 20).map((s) => 'L' + s.line).join('/')
          const more = skippedLines.length > 20 ? ' …' : ''
          return '畸形行明细：' + lines + more + (counts.length ? '（' + counts.join('、') + '）' : '')
        }
        if (value.mode === 'batch') {
          const bits = []
          bits.push('共扫描 ' + value.total + ' 个' + batchUnit)
          if (value.imported) bits.push('新增 ' + value.imported + ' 个会话')
          if (value.appended) bits.push('续写 ' + value.appended + ' 个会话')
          if (value.alreadyImported) bits.push('已存在 ' + value.alreadyImported + ' 个')
          if (value.skipped) bits.push('跳过 ' + value.skipped + ' 个（' + (skippedNote || '非 ' + sourceLabel + ' transcript') + '）')
          if (value.failed) bits.push('失败 ' + value.failed + ' 个')
          const trimmedItems = (value.results || []).filter((r) => r.trimmed).length
          if (trimmedItems) bits.push(trimmedItems + ' 个会话触发预算裁剪')
          // 错误处理打磨：失败/跳过原因要可见，不只计数（最多展示 5 条）
          const problems = (value.results || []).filter((r) => r.status === 'failed' || r.status === 'skipped').slice(0, 5)
          const detail = problems.map((r) => '  - ' + r.path + (r.error ? '：' + r.error : r.reason ? '：' + r.reason : ''))
          return [{
            type: 'text',
            text: '批量导入完成：' + bits.join('，') + (detail.length ? '\n' + detail.join('\n') : ''),
          }]
        }
        if (value.status === 'skipped' && value.sessionId === 'none') {
          return [{
            type: 'text',
            text: '跳过导入：' + (value.skipReason || '非 ' + sourceLabel + ' transcript')
              + (req26Note(value) ? '\n' + req26Note(value) : ''),
          }]
        }
        if (value.status === 'appended') {
          return [{
            type: 'text',
            text: '会话 ' + value.sessionId + ' 已续写 ' + value.appendedTurns + ' 轮、' + value.appendedEvents + ' 条事件（源文件新增轮次）。' + trimmedNote(value),
          }]
        }
        if (value.status === 'imported' && value.forceImported) {
          return [{
            type: 'text',
            text: '已强制导入完整副本 → 会话 ' + value.forceImported.current + '（前身 ' + value.forceImported.previous + ' 原样保留）。' + trimmedNote(value),
          }]
        }
        if (value.alreadyImported) {
          const why = value.sourceShrunk
            ? '源文件轮次减少（sourceShrunk），跳过；需要完整副本请用 force:true'
            : value.changedInPlace
              ? '源文件在既有轮次内变化（append-only 无法改写），跳过'
              : value.argsChanged
                ? '导入参数已变化（args-changed），跳过；需要按新参数导入请用 force:true'
                : value.budgetChanged
                  ? '上下文预算已变化（budget-changed），跳过；需要按新预算导入请用 force:true'
                  : value.appendedSkipped
                  ? '源文件已增长但无法确定已存日志长度，跳过增量续写'
                  : value.backfilled
                    ? '已回填导入记录（旧版本导入的会话）'
                    : '源文件未变化'
          return [{
            type: 'text',
            text: '会话 ' + value.sessionId + ' 已存在，跳过导入：' + why + '。',
          }]
        }
        return [{
          type: 'text',
          text: '已导入 ' + value.turns + ' 轮对话（' + value.messages + ' 条消息、' + value.toolCalls + ' 次工具调用）→ 会话 ' + value.sessionId + (value.skipped ? '（跳过 ' + value.skipped + ' 行畸形记录）' : '') + trimmedNote(value) + (req26Note(value) ? '\n' + req26Note(value) : ''),
        }]
      },
    },
    async execute(args) {
      // REQ-37：解析上下文预算（参数 > env > 动态模型窗口 > 静态默认），盖写进
      // args.budget（token 数，转换层裁剪消费、registry 记录）与 args.budgetSource
      // （裁剪上报标注来源）；预算变化经 registry 比对 → budgetChanged 跳过。
      const budgetInfo = await resolveImportBudget(ctx, args)
      const effective = { ...args, budget: budgetInfo.budget, budgetSource: budgetInfo.source }
      // REQ-17：preview/dryRun=true 走预览分支（照常 resolve/stat/readText/convert，
      // 但零副作用——不落盘、不写 registry、不归组；见 preview* 实现）
      const preview = isPreview(args)
      const flag = preview ? { preview: true } : {}
      const target = await ctx.fs.resolve(effective.path)
      const info = await ctx.fs.stat(target)
      if (info && info.type === 'directory') {
        // grokbuild：会话目录（含 summary.json）视作单源 → 单会话导入；其余目录批量
        if (dirSingle && await dirSingle(ctx, target)) {
          const fileArgs = { ...effective, ...(await derive(target)) }
          const single = preview ? await previewSingle(ctx, target, fileArgs) : await importSingle(ctx, target, fileArgs)
          return { mode: 'single', ...flag, ...single }
        }
        const batch = preview ? await previewBatch(ctx, target, effective) : await importBatch(ctx, target, effective)
        return { mode: 'batch', ...flag, ...batch }
      }
      // 单文件：合并按文件派生的转换参数（可 async；Cursor 的 composer id、Reasonix 的 meta）
      const fileArgs = { ...effective, ...(await derive(target)) }
      // hermes：.db 单文件恒返回批量形态（SQLite 一库多会话）
      if (alwaysBatch || (fileBatch && await fileBatch(ctx, target))) {
        const batch = preview ? await previewSingle(ctx, target, fileArgs) : await importSingle(ctx, target, fileArgs)
        return { mode: 'batch', ...flag, ...batch }
      }
      const single = preview ? await previewSingle(ctx, target, fileArgs) : await importSingle(ctx, target, fileArgs)
      return { mode: 'single', ...flag, ...single }
    },
  })
}

// 反向导出（REQ-16）：把 DSH 会话日志只读序列化为 Claude Code JSONL。
// 只消费 sessionPersistence（list + readFrom）+ fs（resolve + writeText），
// 绝不 load/prepare、绝不改写会话日志（append-only 只读来源）。文件写到
// <outputDir>/<slug>/<uuid>.jsonl（新 uuid v4 铸键 + createIfAbsent 不覆盖双保险；
// dryRun 不写盘）。uuid 工厂可注入（测试确定性），默认 randomUUID。
// 导入会话（日志带 session/imported 标记）导出成功后把 mapping 落进 imports
// registry（record.exports = [mapping]），供 REQ-36 sync_to_claude 的 target:'copy'
// 定位写回副本；原生会话无 sourcePath 键，不落库（mapping 仍在返回值里）。
async function exportClaudeSession(ctx, args, { uuid = randomUUID, registryDir } = {}) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.list !== 'function' || typeof sp.readFrom !== 'function') {
    throw new Error('sessionPersistence 不可用（需要 list + readFrom）')
  }
  const headers = await sp.list()
  const header = headers.find((h) => h.id === args.sessionId)
  if (!header) throw new Error('会话不存在: ' + args.sessionId)
  const { meta, events } = await sp.readFrom(args.sessionId, 0)
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : header.cwd
  if (typeof cwd !== 'string' || !cwd) {
    throw new Error('导出需要 cwd：会话 header 无 cwd 且未提供 cwd 参数')
  }
  const sessionUuid = uuid()
  const slug = slugifyClaudeCwd(cwd)
  const out = serializeClaudeJsonl({ meta, events, sessionUuid, cwd, version: args.version, gitBranch: args.gitBranch }, { uuid })
  const filePath = join(args.outputDir || join(homedir(), '.claude', 'projects'), slug, sessionUuid + '.jsonl')
  if (args.dryRun !== true) {
    const target = await ctx.fs.resolve(filePath)
    await ctx.fs.writeText(target, out.jsonl, { kind: 'createIfAbsent', displayPath: filePath })
  }
  const mapping = {
    sourceSessionId: args.sessionId,
    sessionUuid,
    slug,
    filePath,
    turns: (events ?? []).filter((e) => e && e.type === 'turn/start').length,
    messages: (events ?? []).filter((e) => e && (e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result')).length,
    toolCalls: out.toolCalls,
    toolResults: out.toolResults,
    droppedToolResults: out.droppedToolResults,
    skippedInjections: out.skippedInjections,
  }
  // 导入会话（带 session/imported 标记）导出成功后把 mapping 落进 registry
  // （exports[0] 即 REQ-36 写回副本映射）；原生会话无 sourcePath 键，跳过
  if (registryDir && args.dryRun !== true) {
    const first = Array.isArray(events) && events.length > 0 ? events[0] : undefined
    if (first && first.type === 'session/imported' && first.data && typeof first.data.sourcePath === 'string') {
      const reg = await loadImports(registryDir)
      const record = unwrapRecord(reg.imports[first.data.sourcePath])
      if (record) await rememberImport(registryDir, first.data.sourcePath, { ...record, exports: [mapping] })
    }
  }
  return {
    mode: 'single',
    sessionId: sessionUuid,
    sourceSessionId: args.sessionId,
    filePath,
    slug,
    cwd,
    recordCount: out.recordCount,
    ...(out.title ? { title: out.title } : {}),
    dryRun: args.dryRun === true,
    mapping,
  }
}

// ── REQ-33 导入识别 / 撤回（只读）────────────────────────────────
// 上游缺口：平台 sessionPersistence 无 delete 面（create / append / locate /
// readRaw / prepare / load / inspect / readFrom / list / listSnapshots，无
// remove），fs 亦无 removeFile——「撤回」= 识别 + 引导手动删工件 + 移除 imports
// registry 记录（removeImport），绝不调用任何删除。
//
// list_imported_sessions：只读枚举 list() 的每个会话，读日志首事件判断
// session/imported 标记（REQ-32，权威信号）；日志读不到时用 imports registry 的
// dshId 集合兜底（标记读失败 ≠ 无标记；标记读成功且无标记才排除——无标记会话
// 不出现）。命中会话用 locate() 取工件路径、同一份事件里取 session/title 标题。
//
// retract_import：按 sessionId（日志标记 sourcePath 优先、registry 子表兜底）或
// sourcePath 定位 registry 键 → removeImport 移除记录 → 返回手动删除引导。幂等：
// 标记留在日志里，记录移除后再次撤回仍能定位、removeImport 空转。

// 读会话日志一次：{ marker, events }。marker 为 session/imported 首事件或 null；
// readFrom 不可用 / 读失败返回 null → 调用方用 registry 兜底（单会话读失败不
// 打断识别枚举，也不视为无标记）。
async function readSessionLog(sp, id) {
  if (!sp || typeof sp.readFrom !== 'function') return null
  try {
    const { events } = await sp.readFrom(id, 0)
    const list = Array.isArray(events) ? events : []
    const first = list.length > 0 ? list[0] : undefined
    return { marker: first && first.type === 'session/imported' ? first : null, events: list }
  } catch {
    // 日志读不到（损坏 / 后端瞬断）：交给 registry 兜底识别
    return null
  }
}

// imports registry 的 dshId 索引：dshId → { sourcePath, importedAt }。single 记录
// 取 dshId；multi 记录取 conversations/sessions 子表全部 dshId（同一 sourcePath
// 可对应多个会话）；旧版纯字符串记录（无 dshId）跳过。
function registryDshIdMap(imports) {
  const map = new Map()
  for (const [sourcePath, raw] of Object.entries(imports || {})) {
    const record = unwrapRecord(raw)
    if (!record || typeof record !== 'object') continue
    if (record.kind === 'multi') {
      const sub = record.conversations || record.sessions
      if (sub && typeof sub === 'object') {
        for (const s of Object.values(sub)) {
          if (s && typeof s.dshId === 'string') {
            map.set(s.dshId, { sourcePath, importedAt: typeof record.importedAt === 'number' ? record.importedAt : undefined })
          }
        }
      }
    } else if (typeof record.dshId === 'string') {
      map.set(record.dshId, { sourcePath, importedAt: typeof record.importedAt === 'number' ? record.importedAt : undefined })
    }
  }
  return map
}

// 会话标题：session/title 事件 data.title（日志末尾，倒扫）。无显式标题源
//（codex/cursor/gemini 等首问兜底）返回 undefined，DSH UI 自动回退首条 user 文本。
function sessionTitleFromEvents(events) {
  if (!Array.isArray(events)) return undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev && ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string' && ev.data.title) {
      return ev.data.title
    }
  }
  return undefined
}

// 会话工件路径：sessionPersistence.locate(header)（同步、不落盘不物化）。SQLite
// 等无单会话工件的后端返回 undefined → null；locate 抛错按无工件处理。
function sessionArtifactPath(sp, header) {
  try {
    const loc = sp && typeof sp.locate === 'function' ? sp.locate(header) : undefined
    return loc && typeof loc.path === 'string' ? loc.path : null
  } catch {
    // 异常 header：locate 抛错按无工件处理，不打断识别枚举
    return null
  }
}

async function listImportedSessions(ctx, registryDir) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.list !== 'function' || typeof sp.readFrom !== 'function') {
    throw new Error('sessionPersistence 不可用（需要 list + readFrom + locate）')
  }
  const headers = await sp.list()
  const byDshId = registryDshIdMap((await loadImports(registryDir)).imports)
  const sessions = []
  for (const header of headers) {
    const info = await readSessionLog(sp, header.id)
    if (info && info.marker) {
      // 标记是权威信号：首事件是 session/imported → 命中
      const data = info.marker.data || {}
      const title = sessionTitleFromEvents(info.events)
      const entry = {
        sessionId: header.id,
        sourcePath: typeof data.sourcePath === 'string' && data.sourcePath
          ? data.sourcePath
          : (byDshId.get(header.id) || {}).sourcePath || null,
        artifactPath: sessionArtifactPath(sp, header),
      }
      if (title) entry.title = title
      if (typeof data.importedAt === 'number') entry.importedAt = data.importedAt
      sessions.push(entry)
    } else if (info === null && byDshId.has(header.id)) {
      // 日志读不到 → registry 兜底识别（读成功但无标记的会话不出现）
      const rec = byDshId.get(header.id)
      const entry = { sessionId: header.id, sourcePath: rec.sourcePath, artifactPath: sessionArtifactPath(sp, header) }
      if (typeof rec.importedAt === 'number') entry.importedAt = rec.importedAt
      sessions.push(entry)
    }
  }
  return { total: sessions.length, sessions }
}

// 定位 sessionId 对应的 registry 键（sourcePath）：先读日志标记 data.sourcePath
//（权威；registry 记录被撤回后标记仍在日志里 → 二次撤回幂等），读不到再扫
// registry（dshId → 键）。都不是本插件导入的会话返回 null。
async function findSourcePathForSession(sp, sessionId, registry) {
  const info = sp ? await readSessionLog(sp, sessionId) : null
  if (info && info.marker && info.marker.data && typeof info.marker.data.sourcePath === 'string' && info.marker.data.sourcePath) {
    return info.marker.data.sourcePath
  }
  for (const [key, raw] of Object.entries(registry.imports || {})) {
    const record = unwrapRecord(raw)
    if (!record || typeof record !== 'object') continue
    if (record.kind === 'multi') {
      const sub = record.conversations || record.sessions
      if (sub && typeof sub === 'object' && Object.values(sub).some((s) => s && s.dshId === sessionId)) return key
    } else if (record.dshId === sessionId) {
      return key
    }
  }
  return null
}

// 记录关联的全部 DSH 会话 id（single: [dshId]；multi: 子表全部）。
function recordDshIds(record) {
  if (!record || typeof record !== 'object') return []
  if (record.kind === 'multi') {
    const sub = record.conversations || record.sessions
    return sub && typeof sub === 'object'
      ? Object.values(sub).map((s) => s && s.dshId).filter((id) => typeof id === 'string')
      : []
  }
  return typeof record.dshId === 'string' ? [record.dshId] : []
}

async function findHeader(sp, id) {
  if (!sp || typeof sp.list !== 'function') return null
  try {
    const headers = await sp.list()
    return headers.find((h) => h.id === id) || null
  } catch {
    // list 失败（后端不可用）：按找不到 header 处理，工件路径留 null
    return null
  }
}

async function retractImport(ctx, args, registryDir) {
  const sp = ctx.get('sessionPersistence')
  const sessionId = typeof args.sessionId === 'string' && args.sessionId ? args.sessionId : null
  const sourcePath = typeof args.sourcePath === 'string' && args.sourcePath ? args.sourcePath : null
  if (!sessionId && !sourcePath) throw new Error('retract_import 需要 sessionId 或 sourcePath（二选一）')
  const registry = await loadImports(registryDir)
  const key = sourcePath || await findSourcePathForSession(sp, sessionId, registry)
  if (!key) {
    throw new Error('会话无导入标记且不在 imports registry: ' + sessionId + '（不是本插件导入的会话）')
  }
  const wasRegistered = Object.prototype.hasOwnProperty.call(registry.imports, key)
  const record = unwrapRecord(registry.imports[key])
  const ids = recordDshIds(record)
  await removeImport(registryDir, key)

  // 工件路径：仅 sessionId 时用该会话 header；仅 sourcePath 且记录只关联一个会话
  // 时用它（multi 多会话 → 逐个用 sessionId 撤回才能拿到各自工件路径）
  let artifactPath = null
  if (sessionId) {
    const header = await findHeader(sp, sessionId)
    artifactPath = header ? sessionArtifactPath(sp, header) : null
  } else if (ids.length === 1) {
    const header = await findHeader(sp, ids[0])
    artifactPath = header ? sessionArtifactPath(sp, header) : null
  }
  const manualDelete = artifactPath
    ? '请手动删除工件目录 ' + artifactPath + '（本插件不删会话，DSH 无 delete 面）'
    : ids.length > 1
      ? '该源文件导入了 ' + ids.length + ' 个会话，请用 list_imported_sessions 按 sessionId 逐个撤回以获取各工件路径（本插件不删会话，DSH 无 delete 面）'
      : '会话工件不存在（可能已手动删除）；registry 记录已移除（本插件不删会话，DSH 无 delete 面）'
  return { removed: true, sourcePath: key, artifactPath, manualDelete, wasRegistered }
}

// ── REQ-25/REQ-40 会话发现（scan_discover 只读工具）────────────────────────
// 发现核心在 lib/discovery.mjs（纯函数，host 注入）。这里把 ctx.fs 与 SQLite 读取器
// 适配成 host：stat/readHead/readText/readDir + readSessions（复用 readOpencodeDb /
// readZcodeDb / readHermesDb，不重写 SQL）。readHead 优先走 streamText 有界读头
//（大 transcript 不整读）；无 streamText（如测试 mock）回退 readText 截断。

// SQLite 会话摘要（发现用）：每会话 id/title/directory/createdAt/lastActiveAt/
// messageCount。读不到（缺失/锁定/非 SQLite）返回 null，发现层按该格式无会话处理。
function dbSessionSummaries(kind, dbPath) {
  try {
    if (kind === 'opencode') {
      return readOpencodeDb(dbPath).map((s) => dbSummary(s, 'createdAt'))
    }
    if (kind === 'zcode') {
      return readZcodeDb(dbPath).map((s) => dbSummary(s, 'createdAt'))
    }
    if (kind === 'hermes') {
      const rows = readHermesDb(dbPath)
      return rows === null ? null : rows.map((s) => ({
        id: s.id, title: s.title, directory: s.cwd,
        createdAt: s.createdAt, lastActiveAt: lastMsgTime(s.messages, 'ts'),
        messageCount: s.messages.length,
      }))
    }
  } catch {
    // 读不到 / 锁定 / 非 SQLite：按无该格式会话处理（发现是预览，不抛）
  }
  return null
}

function dbSummary(s, timeKey) {
  return {
    id: s.id, title: s.title, directory: s.directory,
    createdAt: s.createdAt, lastActiveAt: lastMsgTime(s.messages, timeKey),
    messageCount: s.messages.length,
  }
}

// 最后一条消息时间（最近活跃近似）；无消息/无时间 → undefined。
function lastMsgTime(messages, key) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const v = messages[i] && messages[i][key]
    if (typeof v === 'number') return v
  }
  return undefined
}

function makeDiscoveryHost(ctx) {
  const fs = ctx.fs
  const resolve = (p) => fs.resolve(p)
  return {
    async stat(path) {
      try {
        const info = await fs.stat(await resolve(path))
        return info ? { type: info.type, size: info.size, mtimeMs: info.mtimeMs } : null
      } catch {
        // 缺失 / 无权限：按不存在处理，发现层跳过该路径
        return null
      }
    },
    async readHead(path, maxBytes) {
      try {
        const target = await resolve(path)
        if (typeof fs.streamText === 'function') {
          // 有界读头：取到 maxBytes 即停（for-await break 自动 close 迭代器）
          const iter = await fs.streamText(target)
          let out = ''
          for await (const chunk of iter) {
            out += chunk
            if (out.length >= maxBytes) break
          }
          return out.slice(0, maxBytes)
        }
        const text = await fs.readText(target)
        return text.slice(0, maxBytes)
      } catch {
        return null
      }
    },
    async readText(path) {
      try {
        return await fs.readText(await resolve(path))
      } catch {
        // 缺失/非文本：null，发现层跳过该文件
        return null
      }
    },
    async readDir(path) {
      try {
        const entries = await fs.listDir(await resolve(path))
        return entries.map((e) => ({
          name: e.name,
          type: e.type,
          path: (e.target && (e.target.displayPath || e.target.targetKey)) || join(path, e.name),
        }))
      } catch {
        return null
      }
    },
    async readSessions(kind, dbPath) {
      return dbSessionSummaries(kind, dbPath)
    },
  }
}

// scan_discover 执行：registry 只读 loadImports（importStatus 标注），发现层零副作用
//（不写库、不 create/append、不 touch 任何会话）。30s TTL 缓存由 discovery 模块持有；
// REQ-40 持久化 mtime/size 书签落 $DSH_HOME/dsh-chat-import/scan-cache.json（与 imports
// registry 同目录），跨进程未变文件免重扫（写盘原子写，失败不影响扫描结果）。
async function runScanDiscover(ctx, args, registryDir) {
  const registry = await loadImports(registryDir)
  return discoverSessions({
    path: args.path,
    format: args.format,
    query: args.query,
    host: makeDiscoveryHost(ctx),
    imports: registry.imports,
    cacheDir: registryDir,
  })
}

// ── REQ-41 被动会话发现（Browser 侧面板数据源）──────────────────────────
// lib/client.js 的侧边栏面板按「来源」下拉请求 POST /api-import/sessions；与
// scan_discover 共用同一套 discovery（lib/discovery.mjs discoverSessions +
// makeDiscoveryHost + imports registry 标注 + 30s TTL / 持久化书签），只读零副作用。
// 客户端来源 id（claude-code 等 11 个）→ discovery format 短名（FORMATS）。
const SOURCE_FORMAT = {
  'claude-code': 'claude',
  codex: 'codex',
  chatgpt: 'chatgpt',
  cursor: 'cursor',
  gemini: 'gemini',
  reasonix: 'reasonix',
  opencode: 'opencode',
  zcode: 'zcode',
  grokbuild: 'grokbuild',
  openclaw: 'openclaw',
  hermes: 'hermes',
}

// 读请求 body 的 JSON（空 body 按 {}；畸形 JSON 抛错由路由 catch 兜底）。
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(String(chunk))
  return JSON.parse(chunks.join('') || '{}')
}

function apply(ctx) {
  // REQ-24 imports registry 目录：$DSH_HOME/dsh-chat-import（$DSH_HOME 缺省 ~/.dsh）
  const registryDir = resolveRegistryDir()
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_claude',
    sourceLabel: 'Claude Code',
    convert: convertClaudeJsonl,
    registryDir,
    // 文件名 stem 传给转换器做「主 transcript」判定：subagent/workflow 辅助 transcript
    // 记录携带父 sessionId，按它建会话会与主 transcript 撞 id 导致主内容被跳过
    deriveArgs: (target) => {
      const p = target.displayPath || ctx.fs.processPath(target)
      const base = String(p).split(/[\\/]/).pop() || ''
      return { fileStem: base.replace(/\.jsonl$/i, '') }
    },
    description:
      '从 Claude Code 的 JSONL transcript 导入历史对话为可继续的 DSH 会话。' +
      'path 可以是单个 .jsonl 文件，也可以是包含多个 .jsonl 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/assistant/tool 消息、合成会话事件并持久化；重复导入同一会话会幂等跳过。' +
      '返回新会话 id（或批量统计）与明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_codex',
    sourceLabel: 'Codex/ChatGPT',
    convert: convertCodexJsonl,
    registryDir,
    description:
      '从 Codex / ChatGPT CLI 的 rollout JSONL 导入历史对话为可继续的 DSH 会话（' +
      '~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl）。' +
      'path 可以是单个 .jsonl 文件，也可以是包含多个 .jsonl 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/assistant/function_call/custom_tool_call 消息、合成会话事件并持久化；重复导入同一会话会幂等跳过。' +
      '返回新会话 id（或批量统计）与明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_chatgpt',
    sourceLabel: 'ChatGPT',
    convert: convertChatgptJson,
    importFile: (c, t, a) => importChatgptFile(c, t, a, { registryDir }),
    importDir: (c, d, a) => importChatgptDirectory(c, d, a, { registryDir }),
    previewFile: (c, t, a) => previewChatgptFile(c, t, a),
    previewDir: (c, d, a) => previewChatgptDirectory(c, d, a),
    alwaysBatch: true,
    registryDir,
    description:
      '从 ChatGPT 网页导出的 conversations.json 导入历史对话为可继续的 DSH 会话。' +
      '导出 ZIP 解压后得到 conversations.json（JSON 数组，一个文件含全部会话）；' +
      'path 可以是该 .json 文件，也可以是包含多个 .json 的目录（目录模式递归扫描）。' +
      '解析 mapping 主线程（占位节点/系统消息跳过）、合成会话事件并持久化；重复导入同一会话会幂等跳过。' +
      '返回批量统计与逐会话明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_cursor',
    sourceLabel: 'Cursor',
    convert: convertCursorJsonl,
    registryDir,
    // Cursor 行内无会话 id：用文件名（composer uuid）作稳定 id，保证幂等
    deriveArgs: (target) => {
      const p = target.displayPath || ctx.fs.processPath(target)
      const base = String(p).split(/[\\/]/).pop() || ''
      return { cursorId: base.replace(/\.jsonl$/i, '') }
    },
    description:
      '从 Cursor 的 agent transcript JSONL 导入历史对话为可继续的 DSH 会话（' +
      '~/.cursor/projects/<slug>/agent-transcripts/<composer-id>/<composer-id>.jsonl）。' +
      'path 可以是单个 .jsonl 文件，也可以是包含多个 .jsonl 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/assistant 文本与 tool_use 调用（transcript 不含 tool_result，仅导入调用历史）；' +
      '过滤 [REDACTED] 哨兵；重复导入同一会话会幂等跳过。返回新会话 id（或批量统计）与明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_gemini',
    sourceLabel: 'Gemini CLI',
    convert: convertGeminiJson,
    collect: collectJsonFiles, // Gemini 是单会话 .json（非 JSONL）
    registryDir,
    description:
      '从 Gemini CLI 的会话 JSON 导入历史对话为可继续的 DSH 会话（' +
      '~/.gemini/history/<slot>/chats/session-*.json）。' +
      'path 可以是单个 .json 文件，也可以是包含多个 .json 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/gemini 消息、thoughts→reasoning、内联 toolCalls（结果同对象）并持久化；' +
      'info 系统通知跳过；重复导入同一会话会幂等跳过。返回新会话 id（或批量统计）与明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_reasonix',
    sourceLabel: 'Reasonix',
    convert: convertReasonixJsonl,
    registryDir,
    // 会话 id 用文件名 stem（幂等）；cwd/createdAt 从同目录 <stem>.meta.json 派生
    deriveArgs: async (target) => {
      const p = target.displayPath || ctx.fs.processPath(target)
      const base = String(p).split(/[\\/]/).pop() || ''
      const stem = base.replace(/\.jsonl$/i, '')
      const derived = { reasonixId: stem }
      try {
        // meta 与 transcript 同目录：<stem>.meta.json
        const metaPath = String(p).replace(/[\\/][^\\/]*\.jsonl$/i, '') + '\\' + stem + '.meta.json'
        const metaTarget = await ctx.fs.resolve(metaPath)
        const raw = await ctx.fs.readText(metaTarget)
        const meta = JSON.parse(raw)
        if (meta && typeof meta.workspace === 'string' && meta.workspace) derived.cwd = meta.workspace
        if (meta && typeof meta.summary === 'string' && meta.summary.trim()) derived.title = meta.summary.trim()
      } catch {
        // meta 缺失（子代理或旧文件）不致命：仍按 stem 导入，仅无 cwd/标题
      }
      return derived
    },
    description:
      '从 Reasonix 的会话 JSONL 导入历史对话为可继续的 DSH 会话（' +
      '~/.reasonix/sessions/desktop-*.jsonl 与 subagent-sub-*.jsonl）。' +
      'path 可以是单个 .jsonl 文件，也可以是包含多个 .jsonl 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/assistant/tool 消息（兼容 v1 嵌套与 v2 扁平 tool_calls）、reasoning_content→reasoning、' +
      'tool_call_id 配对结果；会话 id 取文件名 stem，cwd/标题从同目录 .meta.json 派生；' +
      '重复导入同一会话会幂等跳过。返回新会话 id（或批量统计）与明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_opencode',
    sourceLabel: 'opencode',
    convert: convertOpencodeJson,
    // 一库多会话：单 .db 文件也恒返回批量形态；目录模式自动定位 opencode.db（无递归）
    importFile: (c, t, a) => importOpencodeFile(c, t, a, { registryDir, runDecision, markTrimmedSource }),
    importDir: (c, d, a) => importOpencodeDirectory(c, d, a, { registryDir, runDecision, markTrimmedSource }),
    previewFile: (c, t, a) => previewOpencodeFile(c, t, a),
    previewDir: (c, d, a) => previewOpencodeDirectory(c, d, a),
    alwaysBatch: true,
    registryDir,
    // opencode 无单会话 id 覆盖、无递归（目录里就是 opencode.db）
    dropParameters: ['sessionId', 'recursive'],
    pathDescription: 'opencode 历史数据库（opencode.db）的文件路径，或包含 opencode.db 的数据目录路径。',
    batchUnit: '会话',
    skippedNote: '无用户回合',
    extraParameters: {
      sessionIds: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：只导入指定源会话 id（缺省导入全部会话）。',
      },
      fullHistory: {
        type: 'boolean',
        description: '可选：true 时导入全量历史（忽略 opencode 的对话压缩）；默认 false（尊重压缩：只导最后一次摘要 + 尾巴）。',
      },
    },
    description:
      '从 opencode 的 SQLite 历史库 opencode.db 导入历史会话为可继续的 DSH 会话（默认位置 ~/.local/share/opencode/opencode.db）。' +
      'path 可以是 .db 文件，也可以是包含 opencode.db 的数据目录（目录模式自动定位，无递归）。' +
      '读取 session/message/part 表重建对话（event 表是部分镜像、session_message/session_input 为空，忽略）；' +
      '文本/reasoning/工具调用（tool/call + tool/result，含错误标记与 sourceEventSeqs 关联）/图片附件/补丁/子任务完整保留；' +
      '默认尊重对话压缩（compaction，只导最后一次摘要+尾巴，摘要作 reasoning 块前置），可选 fullHistory 导全量；' +
      '可选 sessionIds 只导指定源会话；重复导入同一会话会幂等跳过。返回批量统计与逐会话明细。',
  }))
  // REQ-38 zcode 源（第 8 个导入源）：z.ai 官方 CLI（zcode.z.ai）会话存储
  // ~/.zcode/cli/db/db.sqlite（SQLite 权威索引）+ 旧版 transcript.jsonl 回退。
  // 一库多会话：单 .db / 单 transcript.jsonl 也恒返回批量形态；目录模式自动定位
  // db.sqlite（无递归）；zcode://<id> 伪路径走默认库只导该会话。
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_zcode',
    sourceLabel: 'zcode',
    convert: convertZcodeJson,
    importFile: (c, t, a) => importZcodeFile(c, t, a, { registryDir, runDecision, markTrimmedSource }),
    importDir: (c, d, a) => importZcodeDirectory(c, d, a, { registryDir, runDecision, markTrimmedSource }),
    previewFile: (c, t, a) => previewZcodeFile(c, t, a),
    previewDir: (c, d, a) => previewZcodeDirectory(c, d, a),
    alwaysBatch: true,
    registryDir,
    // zcode 无单会话 id 覆盖、无递归（目录里就是 db.sqlite）；伪路径的会话 id
    // 由 deriveArgs 从 zcode://<id> 取出（fs.resolve 归一化后 importZcodeFile 还会
    // 从原始 args.path 兜底再取一次，见 lib/zcode.mjs）
    dropParameters: ['sessionId', 'recursive'],
    deriveArgs: (target) => {
      const p = target.displayPath || ctx.fs.processPath(target)
      if (typeof p === 'string' && p.startsWith('zcode://')) {
        return { zcodeId: p.slice('zcode://'.length) }
      }
      return {}
    },
    pathDescription: 'zcode 会话数据库（db.sqlite）的文件路径、包含 db.sqlite 的数据目录路径，或 zcode://<sessionId> 伪路径（走默认 ~/.zcode/cli/db/db.sqlite）。',
    batchUnit: '会话',
    skippedNote: '无用户回合',
    extraParameters: {
      sessionIds: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：只导入指定源会话 id（缺省导入全部会话）。',
      },
    },
    description:
      '从 z.ai 官方 CLI（zcode）的 SQLite 历史库 db.sqlite 导入历史会话为可继续的 DSH 会话（默认位置 ~/.zcode/cli/db/db.sqlite）。' +
      'path 可以是 .db 文件、包含 db.sqlite 的数据目录（目录模式自动定位，无递归），或 zcode://<sessionId> 伪路径（走默认库，只导该会话）。' +
      '读取 session/message/part 表重建对话（message/part 无 sequence 列，按 time_created, id 升序；主会话 parent_id IS NULL）；' +
      '文本/工具调用（tool/call + tool/result 成对输出，含错误标记与 sourceEventSeqs 关联）完整保留；' +
      'compaction 自动压缩摘要（part.type === "compaction" 的 data.summary.body）还原为前置上下文 reasoning 块；' +
      '含 <system-reminder> 的系统注入 user 消息过滤；db 不可用时回退读旧版 transcript.jsonl；' +
      '可选 sessionIds 只导指定源会话；重复导入同一会话会幂等跳过。返回批量统计与逐会话明细。',
  }))
  // grokbuild 源（第 9 个导入源）：Grok Build 本地 CLI 会话存储
  // ~/.grok/sessions/<project>/<session_id>/（及 ~/.grok/archived_sessions/），
  // 每会话目录含 summary.json + chat_history.jsonl。path 可指向单个会话目录
  // （mode single）或 sessions/archived_sessions 根（递归扫 summary.json，批量）。
  // 转换器 convertGrokbuildJson 需读两个文件再转换，编排见文件头的
  // importGrokbuildSession / importGrokbuildDirectory。
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_grokbuild',
    sourceLabel: 'Grok Build',
    convert: convertGrokbuildJson,
    importFile: (c, t, a) => importGrokbuildSession(c, t, a, { registryDir }),
    importDir: (c, d, a) => importGrokbuildDirectory(c, d, a, { registryDir }),
    previewFile: (c, t, a) => previewGrokbuildSession(c, t, a),
    previewDir: (c, d, a) => previewGrokbuildDirectory(c, d, a),
    // 会话目录（含 summary.json）视作单源走单会话导入；其余目录走批量扫描
    dirSingle: async (ctx, target) => {
      const dirPath = target.displayPath || ctx.fs.processPath(target)
      const sumTarget = await ctx.fs.resolve(join(dirPath, 'summary.json'))
      const sumStat = await ctx.fs.stat(sumTarget)
      return !!(sumStat && sumStat.type === 'file')
    },
    registryDir,
    pathDescription: 'Grok Build 会话目录（含 summary.json + chat_history.jsonl）的路径（单会话导入），或 ~/.grok/sessions / archived_sessions 根目录路径（递归扫 summary.json，批量导入）。',
    batchUnit: '会话',
    skippedNote: '无用户回合',
    description:
      '从 Grok Build 的本地会话目录导入历史对话为可继续的 DSH 会话（' +
      '~/.grok/sessions/<project>/<session_id>/，每会话目录含 summary.json + chat_history.jsonl）。' +
      'path 可指向单个会话目录（单文件导入），或 sessions/archived_sessions 根（递归扫 summary.json，批量导入）。' +
      '解析 user/assistant/tool/system/reasoning 记录（reasoning 加密内部状态与 system 注入过滤）、' +
      'Claude 风格 content block（tool_use/tool_result 配对挂回所属 step）并持久化；' +
      '标题取 generated_title > session_summary；重复导入同一会话会幂等跳过。' +
      '返回新会话 id（或批量统计）与明细；provider=grokbuild，可用 grok --resume <id> 续聊。',
  }))
  // openclaw 源（第 10 个导入源）：OpenClaw 会话 JSONL
  // ~/.openclaw/agents/<agent>/sessions/*.jsonl（同目录 sessions.json 索引提供
  // displayName 作会话标题）。标准单文件/目录批量形态；deriveArgs 按文件 stem 从
  // sessions.json 查 displayName（openclawDisplayNames 纯函数）。
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_openclaw',
    sourceLabel: 'OpenClaw',
    convert: convertOpenclawJson,
    registryDir,
    deriveArgs: async (target) => {
      const p = target.displayPath || ctx.fs.processPath(target)
      const base = String(p).split(/[\\/]/).pop() || ''
      const stem = base.replace(/\.jsonl$/i, '')
      const derived = { openclawId: stem }
      try {
        // sessions.json 与 transcript 同目录：<dir>/sessions.json（displayName 索引）
        const dirPath = String(p).replace(/[\\/][^\\/]*\.jsonl$/i, '')
        const indexTarget = await ctx.fs.resolve(join(dirPath, 'sessions.json'))
        const name = openclawDisplayNames(await ctx.fs.readText(indexTarget)).get(stem)
        if (name) derived.displayName = name
      } catch {
        // sessions.json 缺失/损坏不致命：仍按 stem 导入，仅无 displayName（标题回退首问）
      }
      return derived
    },
    description:
      '从 OpenClaw 的会话 JSONL 导入历史对话为可继续的 DSH 会话（' +
      '~/.openclaw/agents/<agent>/sessions/*.jsonl，同目录 sessions.json 索引提供 displayName 作标题）。' +
      'path 可以是单个 .jsonl 文件，也可以是包含多个 .jsonl 的 sessions 目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/assistant/toolResult 事件（tool_use/tool_result 配对挂回所属 step、剥 message_id 尾缀）并持久化；' +
      '重复导入同一会话会幂等跳过。返回新会话 id（或批量统计）与明细。',
  }))
  // hermes 源（第 11 个导入源）：Hermes（本地 AI 编码 CLI）会话存储
  // ~/.hermes/state.db（SQLite 权威索引，恒批量）+ ~/.hermes/sessions/*.jsonl 回退
  // （db 不可用 readHermesDb 返回 null 时）。.db 单文件恒批量（对齐 import_opencode）；
  // 单 .jsonl = 单会话（mode single）；目录优先 state.db、不可用则递归扫 .jsonl。
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_hermes',
    sourceLabel: 'Hermes',
    convert: convertHermesJson,
    importFile: (c, t, a) => importHermesFile(c, t, a, { registryDir }),
    importDir: (c, d, a) => importHermesDirectory(c, d, a, { registryDir }),
    previewFile: (c, t, a) => previewHermesFile(c, t, a),
    previewDir: (c, d, a) => previewHermesDirectory(c, d, a),
    deriveArgs: (target) => hermesFileArgs(ctx, target),
    // .db 单文件恒返回批量形态（SQLite 一库多会话）；.jsonl 走单会话导入
    fileBatch: (ctx, target) => /\.db$/i.test(String(target.displayPath || ctx.fs.processPath(target))),
    registryDir,
    pathDescription: 'Hermes 历史库（state.db）的文件路径、包含 state.db 的目录路径（SQLite 恒批量），或 sessions/*.jsonl 单文件/目录路径（db 不可用时回退）。',
    batchUnit: '会话',
    skippedNote: '无用户回合',
    description:
      '从 Hermes（本地 AI 编码 CLI）的会话存储导入历史对话为可继续的 DSH 会话（' +
      '~/.hermes/state.db SQLite 权威索引 + sessions/*.jsonl 回退）。' +
      'path 可指向 state.db 文件或包含 state.db 的目录（恒批量，一库多会话）；' +
      'db 不可用（readHermesDb 返回 null）时回退递归扫描 sessions/*.jsonl，单文件 = 单会话。' +
      '解析 flat/nested 双形态 JSONL 或 DB 中间 JSON（thinking→reasoning、tool_use/tool_result 成对）并持久化；' +
      '重复导入同一会话会幂等跳过。返回批量统计与逐会话明细。',
  }))
  // Pi Coding Agent 源（第 12 个导入源）：Pi Coding Agent 会话 JSONL
  // ~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl（树形条目，id/parentId
  // 链接）。活动分支（叶→根）重建、compaction 默认尊重（fullHistory 入参数指纹）；
  // 头行缺失时用文件名 stem 作稳定源 id（幂等）。
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_pi',
    sourceLabel: 'Pi Coding Agent',
    convert: convertPiJsonl,
    registryDir,
    // 头行缺失时用文件名 stem 作稳定源 id（幂等）；正常路径取会话头 id（uuid）
    deriveArgs: (target) => {
      const p = target.displayPath || ctx.fs.processPath(target)
      const base = String(p).split(/[\\/]/).pop() || ''
      return { piId: base.replace(/\.jsonl$/i, '') }
    },
    // fullHistory 计入导入参数指纹：换值重导 → argsChanged（同 opencode 语义）
    fingerprintKeys: ['fullHistory'],
    extraParameters: {
      fullHistory: {
        type: 'boolean',
        description: '可选：true 时导入全量历史（忽略 Pi 的上下文压缩）；默认 false（尊重压缩：只导最后一次摘要 + 尾巴）。',
      },
    },
    description:
      '从 Pi Coding Agent 的会话 JSONL 导入历史对话为可继续的 DSH 会话（' +
      '~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl）。' +
      'path 可以是单个 .jsonl 文件，也可以是包含多个 .jsonl 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析活动分支（叶→根树遍历）的 user/assistant/toolResult 消息、thinking→reasoning、' +
      'branch_summary/compaction 摘要→reasoning、bashExecution/custom 注入→文本块，合成会话事件并持久化；' +
      '默认尊重上下文压缩（只导最后一次摘要+尾巴），可选 fullHistory 导全量；' +
      '重复导入同一会话会幂等跳过。返回新会话 id（或批量统计）与明细。',
  }))
  // REQ-16 反向导出：第 13 个工具，独立注册（导出流程与导入状态机完全不同）。
  ctx.tools.register(defineTool({
    name: 'export_claude',
    description:
      '把 DSH 会话日志（只读，不 load/prepare、不改写历史事件）序列化为 Claude Code JSONL 并写入 ' +
      '<outputDir>/<slug>/<uuid>.jsonl，可被真实 Claude Code --resume 续聊。' +
      '参数：sessionId 必填；cwd 可选（默认取会话 header.cwd，两者皆无则报错）；' +
      'outputDir 可选（默认 ~/.claude/projects）；dryRun 可选（只序列化不写盘）。' +
      'user/assistant/tool_result 按 seq 顺序映射，tool_result 挂在声明其 tool_use 的 assistant 上（' +
      '并行结果扇出同一 assistant）；中断会话末尾补发空 tool_result；孤儿结果丢弃并计数；' +
      '非人类注入跳过计数。返回目标文件路径、记录数与 mapping（sourceSessionId → 新 uuid，imports registry 预留）。',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: '要导出的 DSH 会话 id（必填）。',
      },
      cwd: {
        type: 'string',
        description: '可选：覆盖导出记录的 cwd（默认取会话 header.cwd；两者皆无则报错）。',
      },
      outputDir: {
        type: 'string',
        description: '可选：Claude Code projects 根目录（默认 ~/.claude/projects），文件写到 <outputDir>/<slug>/<uuid>.jsonl。',
      },
      dryRun: {
        type: 'boolean',
        description: '可选：true 时不写盘，只序列化并返回目标路径与统计。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['single'], required: true },
          sessionId: { type: 'string', required: true },
          sourceSessionId: { type: 'string', required: true },
          filePath: { type: 'string', required: true },
          slug: { type: 'string', required: true },
          cwd: { type: 'string', required: true },
          recordCount: { type: 'integer', required: true },
          title: { type: 'string' },
          dryRun: { type: 'boolean', required: true },
          mapping: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              sourceSessionId: { type: 'string', required: true },
              sessionUuid: { type: 'string', required: true },
              slug: { type: 'string', required: true },
              filePath: { type: 'string', required: true },
              turns: { type: 'integer', required: true },
              messages: { type: 'integer', required: true },
              toolCalls: { type: 'integer', required: true },
              toolResults: { type: 'integer', required: true },
              droppedToolResults: { type: 'integer', required: true },
              skippedInjections: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: (value.dryRun ? '导出预览（dryRun，未写盘）：' : '已导出：')
          + '会话 ' + value.sourceSessionId + ' → ' + value.filePath
          + '（' + value.recordCount + ' 条记录、' + value.mapping.toolCalls + ' 次工具调用）',
      }],
    },
    async execute(args) {
      return exportClaudeSession(ctx, args, { registryDir })
    },
  }))
  // REQ-36 反向同步（双向同步桥 B 第一步）：第 14 个工具，把 DSH 会话新增轮次
  // 增量写回 Claude Code JSONL（目标 = 导入源文件或 export_claude 副本）。写回
  // 核心在 lib/backfill.mjs（纯逻辑 + ctx 注入，零 DSH 依赖）；uuid 工厂经
  // syncClaudeSession 的 args.uuid 注入（测试确定性），工具 schema 不暴露它。
  ctx.tools.register(defineTool({
    name: 'sync_to_claude',
    description:
      '反向同步（REQ-36）：把 DSH 会话新增完整轮次增量写回 Claude Code JSONL，' +
      '供真实 Claude Code --resume 续聊。目标 target:"source"（默认）写回导入源文件，' +
      'target:"copy" 写回上次 export_claude 导出的副本（需先导出）。' +
      '守卫不静默覆盖：源文件缩小（sourceShrunk）、被外部修改（source-modified-externally）、' +
      '文件尾 uuid 与写回水印失配（tail-mismatch）、并发写者（write-version-mismatch）一律跳过并上报；' +
      'force:true 跳过三闸并以当前文件重锚定（水印 + 链尾）。' +
      '只写由 turn/end 闭合的完整轮（半开进行中轮次不写，报 incompleteFinalTurn）；' +
      'dryRun 只计算不写盘。返回 status: synced | no-new-turns | skipped 与写回水印。',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: '要写回的 DSH 会话 id（必须是由本插件导入的会话，带 session/imported 标记）。',
      },
      target: {
        type: 'string',
        description: "可选：写回目标 'source'（默认，导入源文件）| 'copy'（export_claude 导出的副本，需先导出）。",
      },
      force: {
        type: 'boolean',
        description: '可选：true 时跳过三闸守卫并以当前文件重锚定（水印 + 链尾），可能覆盖外部修改；默认 false。',
      },
      dryRun: {
        type: 'boolean',
        description: '可选：true 时完整计算（含格式预检）但不写盘、不更新 registry。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['single'], required: true },
          status: { type: 'string', required: true, enum: ['synced', 'no-new-turns', 'skipped'] },
          sessionId: { type: 'string', required: true },
          sourcePath: { type: 'string', required: true },
          target: { type: 'string', required: true, enum: ['source', 'copy'] },
          filePath: { type: 'string', required: true },
          appendedTurns: { type: 'integer' },
          appendedEvents: { type: 'integer' },
          appendedRecords: { type: 'integer' },
          conflictDetected: { type: 'string', enum: ['source-modified-externally', 'tail-mismatch', 'write-version-mismatch'] },
          sourceShrunk: { type: 'boolean' },
          storedShrunk: { type: 'boolean' },
          incompleteFinalTurn: { type: 'boolean' },
          precheckFailed: { type: 'boolean' },
          rollbackError: { type: 'string' },
          reason: { type: 'string' },
          precheck: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              recordCount: { type: 'integer' },
              lastUuid: { type: 'string' },
              errors: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    line: { type: 'integer', required: true },
                    error: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          dryRun: { type: 'boolean', required: true },
          writeback: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionUuid: { type: 'string', required: true },
              filePath: { type: 'string', required: true },
              lastWrittenSeq: { type: 'integer', required: true },
              lastWrittenTurn: { type: 'integer' },
              prevUuid: { type: 'string' },
              lastSize: { type: 'integer', required: true },
              lastVersion: { type: 'string', required: true },
              writtenAt: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (args, value) => {
        const where = value.target === 'copy' ? '导出副本' : '源文件'
        if (value.status === 'skipped') {
          let why
          if (value.sourceShrunk) why = '源文件缩小（sourceShrunk），跳过写回'
          else if (value.conflictDetected === 'source-modified-externally') why = '源文件被外部修改（size/version 变化），跳过写回'
          else if (value.conflictDetected === 'tail-mismatch') why = '文件尾 uuid 与写回水印失配（tail-mismatch），跳过写回'
          else if (value.conflictDetected === 'write-version-mismatch') why = '并发写者已改动文件（write-version-mismatch），跳过写回'
          else if (value.storedShrunk) why = 'DSH 会话日志比写回水印短（storedShrunk），跳过写回'
          else if (value.precheckFailed) why = '写回预检失败（格式校验不通过），已回滚'
          else why = value.reason || '跳过写回'
          return [{ type: 'text', text: '会话 ' + value.sessionId + ' ' + why + '（' + where + '）。' }]
        }
        if (value.status === 'no-new-turns') {
          return [{ type: 'text', text: '会话 ' + value.sessionId + ' 无新增完整轮次'
            + (value.incompleteFinalTurn ? '（存在进行中的半开轮次，闭合后再同步）' : '')
            + '（' + where + '）。' }]
        }
        return [{ type: 'text', text: (value.dryRun ? '写回预览（dryRun，未写盘）：' : '已写回：')
          + '会话 ' + value.sessionId + ' → ' + value.filePath
          + '（' + value.appendedTurns + ' 轮、' + value.appendedEvents + ' 条事件、' + value.appendedRecords + ' 条记录'
          + (value.conflictDetected || value.sourceShrunk ? '，force 覆盖守卫：' + (value.conflictDetected || 'sourceShrunk') : '')
          + '）。' }]
      },
    },
    async execute(args) {
      return syncClaudeSession(ctx, args, { registryDir })
    },
  }))
  // REQ-33 导入识别 / 撤回（只读）：第 15/16 个工具。平台无 delete 面
  //（sessionPersistence.remove / fs.removeFile 未提供，见文件头 REQ-33 段落）——
  // list_imported_sessions 只读识别（标记权威 + registry 兜底），retract_import
  // 移除 registry 记录 + 引导手动删工件，绝不调用任何删除。
  ctx.tools.register(defineTool({
    name: 'list_imported_sessions',
    description:
      '只读列出本插件导入的全部 DSH 会话（REQ-33）：按会话日志首事件 session/imported 标记筛选' +
      '（标记是权威信号；日志读不到时用 imports registry 的 dshId 集合兜底），无标记会话不出现。' +
      '每个命中会话返回 sessionId / title（session/title 事件，无显式标题则省略）/ sourcePath / ' +
      'artifactPath（sessionPersistence.locate 报工件路径）/ importedAt。' +
      '零副作用：不落盘、不写 registry、不调用任何删除。返回 { total, sessions }。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                title: { type: 'string' },
                sourcePath: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                artifactPath: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                importedAt: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: '已识别导入会话 ' + value.total + ' 个' + (value.total === 0 ? '' : '\n' + value.sessions.map((s) =>
          '  - ' + s.sessionId + (s.title ? '《' + s.title + '》' : '') + ' ← ' + s.sourcePath
          + '\n    工件路径：' + (s.artifactPath || '无（后端无单会话工件）')).join('\n')),
      }],
    },
    async execute() {
      return listImportedSessions(ctx, registryDir)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'retract_import',
    description:
      '撤回（只读引导，REQ-33）：识别导入会话并移除其 imports registry 记录，输出手动删除工件路径。' +
      '绝不删除会话或工件（平台 sessionPersistence 无 delete 面，本插件不调用任何删除）。' +
      '入参 sessionId 或 sourcePath 二选一：sessionId 从会话日志 session/imported 标记定位源文件' +
      '（标记留在日志，重复撤回幂等）；sourcePath 直接按 registry 幂等键移除。' +
      'registry 记录移除后，按引导删除工件副本再重导即全新导入（副本仍在时重导按 legacy 回填基线幂等跳过）。' +
      '返回 removed:true 与 manualDelete 引导' +
      '（工件路径由 sessionPersistence.locate 给出）。',
    parameters: {
      sessionId: {
        type: 'string',
        description: '要撤回的 DSH 会话 id（与 sourcePath 二选一；从日志标记 / registry 定位源文件）。',
      },
      sourcePath: {
        type: 'string',
        description: '要撤回的源文件路径（与 sessionId 二选一；直接按 registry 幂等键移除记录）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'boolean', required: true, const: true },
          sourcePath: { type: 'string', required: true },
          artifactPath: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          wasRegistered: { type: 'boolean', required: true },
          manualDelete: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: '已撤回：registry 记录 ' + value.sourcePath + ' 已移除'
          + (value.wasRegistered ? '' : '（此前已移除，幂等）') + '。\n' + value.manualDelete,
      }],
    },
    async execute(args) {
      return retractImport(ctx, args, registryDir)
    },
  }))
  // REQ-25/REQ-40 会话发现：第 17 个工具，只读扫描（发现核心在 lib/discovery.mjs，
  // host 适配见 makeDiscoveryHost；30s TTL 缓存进程内共享 + 持久化 mtime 书签跨进程
  // 免重扫）。零副作用：不写库、不 create/append，registry 只读 loadImports 供
  // importStatus 标注（书签文件是缓存元数据，非会话数据）。
  ctx.tools.register(defineTool({
    name: 'scan_discover',
    description:
      '只读扫描本机 12 种外部聊天记录格式的已知数据根（Claude Code / Codex / Cursor / ' +
      'Gemini CLI / Reasonix / opencode / zcode / Grok Build / OpenClaw / Pi Coding Agent / ' +
      'Hermes / ChatGPT 导出），返回结构化会话索引（format / sessionId / title / project / ' +
      'createdAt / lastActiveAt / messageCount / sourcePath / importStatus），供批导入前预览。' +
      'path 可选：给定时在该根下按格式探测（目录或单文件）；缺省扫全部格式的默认数据根。' +
      'format 可选：只扫指定格式（chatgpt 无自动根，需 path 显式指向 conversations.json）。' +
      'query 可选：按标题 / 项目 / 路径子串过滤（忽略大小写）。' +
      '进程内 30s TTL 缓存：同 key 30 秒内重复扫描直接命中，不重读源文件。' +
      '持久化 mtime/size 书签（scan-cache.json）：跨进程重启后未变文件免重扫。' +
      '只读工具：不写库、不 create/append、不修改任何会话或 registry。返回 { sessions, total }。',
    parameters: {
      path: {
        type: 'string',
        description: '可选：扫描根（目录或单文件，如 ~/.claude/projects、某个 .jsonl 或 conversations.json）。缺省扫全部格式的默认数据根。',
      },
      format: {
        type: 'string',
        enum: FORMATS,
        description: '可选：只扫指定格式；缺省按路径探测全部格式。',
      },
      query: {
        type: 'string',
        description: '可选：按标题 / 项目 / 路径子串过滤（忽略大小写）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                format: { type: 'string', enum: FORMATS, required: true },
                sessionId: { type: 'string', required: true },
                title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                project: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                createdAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                lastActiveAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                messageCount: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                sourcePath: { type: 'string', required: true },
                importStatus: { type: 'string', enum: ['imported', 'partial', 'not-imported'], required: true },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const byFormat = {}
        for (const s of value.sessions) byFormat[s.format] = (byFormat[s.format] || 0) + 1
        const formatBits = Object.entries(byFormat).map(([f, n]) => f + ' ' + n)
        const imported = value.sessions.filter((s) => s.importStatus === 'imported').length
        const partial = value.sessions.filter((s) => s.importStatus === 'partial').length
        const pending = value.sessions.filter((s) => s.importStatus === 'not-imported').length
        const statusBits = ['已导入 ' + imported]
        if (partial) statusBits.push('部分 ' + partial)
        statusBits.push('未导入 ' + pending)
        return [{
          type: 'text',
          text: '扫描完成：共发现 ' + value.total + ' 个会话（' + formatBits.join('、') + '；'
            + statusBits.join('、') + '）' + (args.query ? '（query=' + args.query + '）' : ''),
        }]
      },
    },
    async execute(args) {
      return runScanDiscover(ctx, args, registryDir)
    },
  }))
  // REQ-41 被动发现路由：POST /api-import/sessions（Browser 面板数据源，不新增工具）。
  // body: { source, query?, path? }——source 是客户端来源 id（SOURCE_FORMAT 映射到
  // discovery format）；query 按标题/项目/路径过滤；path 可选（客户端不发，调用方可
  // 钉扫描根，缺省扫该格式默认数据根）。返回 discoverSessions 结果（{ok, sessions}），
  // 错误返回 {ok:false, error}。webServer 在 inject 里（硬依赖），apply 时必可用。
  ctx.webServer.register({
    kind: 'exact',
    path: '/api-import/sessions',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const source = typeof body.source === 'string' && body.source ? body.source : ''
        const format = SOURCE_FORMAT[source]
        if (!format) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '未知来源: ' + source }))
          return
        }
        const registry = await loadImports(registryDir)
        const found = await discoverSessions({
          path: typeof body.path === 'string' && body.path ? body.path : undefined,
          format,
          query: typeof body.query === 'string' ? body.query : '',
          host: makeDiscoveryHost(ctx),
          imports: registry.imports,
          cacheDir: registryDir,
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, sessions: found.sessions }))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
    },
  })
}

export { apply, inject, name, readOpencodeDb, readZcodeDb, exportClaudeSession }
