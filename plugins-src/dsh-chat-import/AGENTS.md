# AGENTS.md

`dsh-chat-import` 是 DeepSeek Harness 的 Host 插件：把 Claude Code / Codex / ChatGPT 的外部聊天记录 **全保真**导入为**可继续（resume）**的 DSH 会话。DSH 的哲学是 **everything is a plugin**——本仓库只做插件，不碰引擎。改代码前先读 `README.md`（对外契约）与 `test/`（现有行为）。

## 仓库布局：发布面 / 本地工程面

根目录只放发布到 GitHub / npm 的文件；本地工程文件一律收进 `dev/`（gitignore，永不提交）。

```
index.mjs        插件入口（唯一 host 面）：注册 8 个导入工具（import_claude / import_codex / import_chatgpt /
                 import_cursor / import_gemini / import_reasonix / import_opencode / import_zcode）+
                 export_claude + sync_to_claude
lib/             导入/同步驱动：imports.mjs（幂等 registry）、backfill.mjs（sync_to_claude 写回）、
                 opencode.mjs / zcode.mjs（SQLite 读取，node:sqlite）、convert/（转换核心按源拆分）
convert.mjs      转换核心 re-export shim（已按源拆到 lib/convert/{core,claude,codex,chatgpt,cursor,gemini,reasonix,opencode,zcode}.mjs，纯函数、零 DSH 依赖、可独立单测）
export.mjs       反向导出序列化器（DSH 会话日志 → Claude Code JSONL，纯函数、零 DSH 依赖）
cordis.patch.yml bundle 声明（insert import-claude）
.github/         GitHub Actions CI（npm test，不进 npm 包）
package.json     npm 包元数据；files 白名单 = 发布内容
README.md        对外契约（英文，GitHub/npm 默认）；README.zh-CN.md 中文版——行为变更必须同步两版
CHANGELOG.md     变更日志（进 npm 包）
LICENSE          MIT
assets/          LOGO（import.svg，README 双语顶部引用，进 npm 包）
test/            convert 单测 + export 单测 + index mock 集成 + zcode 自包含（进 GitHub，不进 npm 包）
dev/             ❌ 本地工程面：HANDOFF.md、GROWTH.md、脚本（bin/）、夹具——永不提交；sessions/ 为遗留目录（协议已切 dsh-file-claim，可忽略）
```

- `package.json` 的 `files` 白名单就是 npm 发布面：`index.mjs`、`convert.mjs`、`export.mjs`、`lib/imports.mjs`、`lib/backfill.mjs`、`lib/convert`、`lib/opencode.mjs`、`lib/zcode.mjs`、`cordis.patch.yml`、`README.md`、`README.zh-CN.md`、`CHANGELOG.md`、`assets/import.svg`、`LICENSE`。新增被 `index.mjs` import 或 README 引用的文件必须同步加进 `files`。
- **永不提交**：`dev/`、`node_modules/`、`.prev-session*.jsonl`、真实用户 transcript（含敏感内容）、任何凭据/密钥。

## 命令

```sh
npm test        # node --test 跑 test/*.test.mjs（convert 单测 + export 单测 + index mock 集成 + zcode 自包含）
```

无构建步骤：纯 ESM，`index.mjs` / `convert.mjs` / `export.mjs` / `lib/` 即发布产物。DSH 手工验证：`dsh plugin --profile web add -w link:<本仓库路径>` 后重启 dsh，在会话里调 `import_claude` / `import_codex` / `import_chatgpt` / `import_cursor` / `import_gemini` / `import_reasonix` / `import_opencode` / `import_zcode` / `export_claude` / `sync_to_claude`。

## 提交纪律（保持仓库干净）

- **conventional commit 前缀**：`feat:` / `fix:` / `refactor:` / `chore:` / `docs:` / `test:`，中文描述，沿用现有历史风格（如 `feat: batch import (#7) — directory scan, per-file sessions, summary`）。
- **一个逻辑变更一个 commit**：不混改（重构不带新功能，修 bug 不带 docs），不提交 WIP / 中间态。
- **提交前必过**：
  1. `npm test` 全绿；
  2. `git status` 无杂物（`dev/`、`node_modules/`、快照不得出现在待提交里）；
  3. `git diff --cached --check` 无空白错误。
- **行为变更同 commit 更新 README 与测试**：README 是对外契约，测试描述现有行为；改行为必须连测试一起改，并在 commit 信息里说明为什么。
- 提交信息说明「为什么」而非复述代码；指向关联 issue/PR 编号。
- push 前自查：`git log --oneline` 每一条都是一个完整、可读的逻辑单元；工作树干净。
- 重写已推送历史时只用 `--force-with-lease`，远程有变动立即中止——本仓库是单人直推 `main`，尽量不重写。

## 多会话并发开发（并行 Agent 协调）

同一台机器可能并行开多个 Agent 会话操作**同一个工作目录**。会话间靠 **dsh-file-claim 插件**（DSH 系统工具，非本仓库代码）协调文件占用，避免互相覆盖、避免共享文档（HANDOFF / GROWTH）被并发改写。

| 时机 | 动作 |
| --- | --- |
| 动手改文件之前 | `claim_files({ paths: [...] })` 认领独占路径（他人活跃占用 → 拒绝） |
| 改完 | `release_files({ paths: [...] })`（或 `release_files({ all: true })`）释放认领 |
| 占用冲突时 | `who_claims({ paths: [...] })` / `claim_status()` 看谁在用；等对方 `release_files`，或对方 **stale**（心跳过期）后 `claim_files({ paths, force: true })` 接管 |
| **想改的文件被活跃会话占用，又不愿干等** | `pending_write({ path, content })` 把「改好的新内容」写进**待合并区**（自动记录写入时 git HEAD base），不阻塞任何会话 |
| 对方 release 之后 | `pending_apply({ path })` 做三路合并（current × base × pending）落盘——**无冲突自动落盘并清除条目，有冲突写入冲突标记、保留条目**（手动解决后 `pending_drop` 清理） |
| push 之前 | `git pull --rebase origin main` |

规则：

1. **先 claim 再动手**：要改的文件必须先认领到自己名下；他人活跃认领的文件不得修改。`dev/HANDOFF.md`、`dev/GROWTH.md` 等共享文档同样要 claim。
2. **最小认领粒度**：只认领本次要碰的文件/目录；目录认领覆盖其下所有路径。
3. **stale 接管**：`force: true` 只能接管 stale 会话的认领，永远抢不了活跃会话的文件；被接管者丢的只是认领记录，文件内容不受影响。
4. **push 前 `git pull --rebase origin main`**：小步提交（一个逻辑变更一个 commit）可把 rebase 冲突降到最低。本协议覆盖同一工作目录的并行会话；跨机器并行靠 git 纪律，registry 不跨机器同步。
5. **pending 待合并区（简单会话的异步写作）**：`pending_write` 存「改好的新内容」+ 写入时 git HEAD 版本（base）；`pending_apply` 做三路合并（current × base × pending），无冲突自动落盘并清除条目，有冲突写入冲突标记、保留条目；`base` 缺失时拒绝盲合。`apply` 要求路径无活跃占用（防止与在改会话打架）。`pending_show` / `pending_drop` 查看 / 丢弃条目。

## DSH 插件约束

- **只消费 host 公开服务**：`sessionPersistence`（create + append 落盘；list + readFrom 供 `export_claude` / `sync_to_claude` 只读）、`fs`、`tools`、`workspaceRegistry`；`agentDefaultModel` / `llm`（REQ-37 预算自适应）可选，经 `ctx.get` 读取、缺失或抛错即回退。opencode / zcode 用 `node:sqlite`（`DatabaseSync`，host 面）。不发布服务 → 无需 isolate realm；**无 Browser 侧**（当前仍纯 host；REQ-41 若选 Browser 入口再同步本文件）。
- **插件，不是引擎改动**：新行为走公开扩展点（工具注册）；绝不修改 DSH 引擎 / apiproxy / 官方 UI 包。
- **会话日志 append-only、deep-frozen**：只 `create` + `append`，绝不改写历史事件。
- **模型可见 ⟺ 落盘**：进入模型上下文的任何内容必须能从会话日志重建；新模型可见输入必须对应会话事件。
- **事件纪律**：`seq` 从 0 连续；surface 事件（`user/message` / `assistant/message` / `tool/result`）必须带 `surfaceOp: 'append'`；`tool/result` 用 `sourceEventSeqs` 关联其 `tool/call`；`SessionHeader` version 保持 `0`，只做结构性变更才 bump。
- **幂等**：目标会话已存在时跳过（`sessionPersistence.list()` 判重），不重复写入。
- **归组**：`workspaceRegistry.resolveByPath(cwd)` → `workspace.attachSession(id)`，否则会话显示「未分组」。
- **失败要大声**：畸形 JSONL 行计数上报（`skipped`），绝不静默吞掉；读取工作区外的 transcript 需会话沙箱允许。

## 质量约定

- 文件以**恰好一个**换行结尾；空 `catch` 必须说明吞掉什么且 `try` 只包一条语句；不注释代码里显而易见的事实。
- 保持 `lib/convert/*`（含 `convert.mjs` re-export shim）零依赖纯函数：任何 DSH 依赖只允许出现在 `index.mjs` 与 `lib/{imports,backfill,opencode,zcode}.mjs`。
- 测试描述行为而非背书正确性；fixtures 用合成数据，永不掺真实 transcript。
- 不写行内文档废话：注释写契约与上下文，不叙述控制流。

## 编辑本文件

规则保持自包含；改完须与仓库现状一致（目录、命令、约束过时了要同步更新）。
