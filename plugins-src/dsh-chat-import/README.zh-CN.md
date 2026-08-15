<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="assets/import.svg" width="120" alt="dsh-chat-import">
</p>

# DSH Chat Import

> **一个插件，12 种来源** —— 全保真导入 DeepSeek Harness，无缝续聊，并可导出 / 同步回 Claude Code。

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-chat-import"><img src="https://img.shields.io/npm/v/dsh-chat-import" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-chat-import"><img src="https://img.shields.io/npm/dm/dsh-chat-import" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license: MIT"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white" alt="Node.js >= 22.13"></a>
  <a href="https://github.com/Nwflower/dsh-chat-import/actions/workflows/ci.yml"><img src="https://github.com/Nwflower/dsh-chat-import/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Nwflower/dsh-chat-import"><img src="https://img.shields.io/github/stars/Nwflower/dsh-chat-import" alt="GitHub stars"></a>
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="Awesome DSH Plugin"></a>
</p>

<p align="center">
  <b>已收录于：</b> <a href="https://github.com/0xsline/awesome-deepseek-harness">Awesome DeepSeek Harness</a> · <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin">Awesome DSH Plugin</a> · <a href="https://github.com/Dominic789654/awesome-deepseek-harness">Awesome DSH Plugins</a> · <a href="https://www.npmjs.com/package/dsh-chat-import">npm</a>
  &nbsp;&nbsp;·&nbsp;&nbsp; <b>更新日志（英文）：</b> <a href="CHANGELOG.md">CHANGELOG.md</a>
</p>

`dsh-chat-import` 从 **Claude Code、Codex、ChatGPT、Cursor、Gemini、Reasonix、opencode、ZCode、Grok Build、OpenClaw、Pi Coding Agent 与 Hermes** 导入聊天历史——工具调用、思考过程一应俱全——成为**全保真、可继续（resume）的 DeepSeek Harness 会话**。源文件**只读**读取（绝不改写），不碰 DSH 引擎；每次导入都成为一条全新会话，并按源 `cwd` 归入对应工作区。

反向方向同样覆盖：`export_claude` 把 DSH 会话序列化回 Claude Code JSONL（只读——绝不修改你的 DSH 日志），Claude Code 可用 `--resume` 加载续聊；`sync_to_claude` 再把会话新增轮次增量写回 Claude Code 文件——带守卫、绝不静默覆盖。

## ✨ 功能特性

**📥 导入**

- **12 种来源，一个插件** — 每种来源一条命令，从 Claude Code JSONL、Codex rollout 到 SQLite 数据库与会话目录。
- **🔍 全保真** — 工具调用与结果、思考块、标题、模型与时间戳，源有记录就原样保留。
- **📦 批量导入** — 指向一个目录（或整个数据库），每个文件 / 每段对话都成为独立会话，并返回逐文件汇总。

**▶️ 续聊**

- **可无缝续聊** — 打开导入的会话，从源记录停下的地方继续对话。
- **🗂 自动归组工作区** — 会话按源 `cwd` 挂进对应工作区——不再「未分组」。

**🔄 反向**

- **📤 导出回 Claude Code** — `export_claude` 把任意 DSH 会话（导入的或原生的）写到 `<outputDir>/<slug>/<uuid>.jsonl`，可直接 `--resume`。
- **🔄 反向同步** — `sync_to_claude` 把会话新增完整轮次追加回 Claude Code 文件——带守卫、绝不覆盖。

**🛡️ 保护**

- **🔁 幂等 + 增量** — 重复导入未变化的源直接跳过；增长的源只追加新增轮次。
- **🧮 上下文预算保护** — 超长会话按安全上下文预算裁剪，裁剪结果显式上报。

## 🗂 支持的来源

| 来源 | 存储位置 | 导入工具 |
| --- | --- | --- |
| **Claude Code** | `~/.claude/projects/<slug>/<sessionId>.jsonl` | `import_claude` |
| **Codex / ChatGPT CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `import_codex` |
| **ChatGPT**（网页导出） | 导出压缩包（任意路径）——`conversations.json` | `import_chatgpt` |
| **Cursor** | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` | `import_cursor` |
| **Gemini CLI** | `~/.gemini/history/<slot>/chats/session-*.json` | `import_gemini` |
| **Reasonix** | `~/.reasonix/sessions/desktop-*.jsonl` | `import_reasonix` |
| **opencode** | `~/.local/share/opencode/opencode.db` | `import_opencode` |
| **ZCode**（z.ai CLI） | `~/.zcode/cli/db/db.sqlite` | `import_zcode` |
| **Grok Build** | `~/.grok/sessions/<project>/<session_id>/` | `import_grokbuild` |
| **OpenClaw** | `~/.openclaw/agents/<agent>/sessions/*.jsonl` | `import_openclaw` |
| **Pi Coding Agent** | `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl` | `import_pi` |
| **Hermes** | `~/.hermes/`（Windows `%LOCALAPPDATA%\hermes`） | `import_hermes` |

每次导入都会保留源实际记录的内容——sessionId、`cwd`、标题、模型、时间戳、工具调用与结果、思考过程。数据较少的源导入其已有的内容；源格式无法保留的部分，会在导入报告里显式标注。

## 🚀 快速开始

**1. 安装** — 把插件加进 profile：

```bash
dsh plugin --profile web add dsh-chat-import                    # npm 包
dsh plugin --profile web add -w link:/path/to/dsh-chat-import   # 本地源码（符号链接）
```

**2. 导入** — 在任意 DSH 会话里导入单个文件或整个目录（11 个导入工具调用方式一致——见上方来源表）：

```
import_claude({ path: "~/.claude/projects" })
```

**3. 续聊** — 刷新一次会话列表，打开导入的会话，继续对话——它会从源记录停下的地方无缝接上。

## 🛠 使用

> **注意**：导入会即时落盘，但 DSH 的会话列表不会自动刷新——导入后请刷新页面（或会话列表）才能看到新会话。

**导入——单个文件或目录。** 每个 `import_*` 工具都接受 `path`；目录递归扫描，每个文件 / 每段对话成为独立会话：

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
import_codex({ path: "C:\Users\<you>\.codex\sessions\2026\05\18\rollout-2026-05-18T21-14-16-xxxx.jsonl" })
import_chatgpt({ path: "C:\Users\<you>\Downloads\chatgpt-export\conversations.json" })
import_opencode({ path: "C:\Users\<you>\.local\share\opencode\opencode.db" })
```

`import_chatgpt` / `import_opencode` / `import_zcode` / `import_hermes` 恒返回批量结果——一个文件 / 数据库包含全部会话，一次调用即可让每段对话成为独立会话。

- `preview: true`（别名 `dryRun: true`）— **只读**运行：照常解析 / 读取 / 转换，但**零副作用**、不落盘。去掉该参数再调一次即正式导入。
- `force: true` — 即使已导入，也以新 id（`import-<sessionId>-<n>`）另存一份**完整副本**；旧会话绝不修改。
- `sessionId`（可选）— 覆盖目标 DSH 会话 id（默认 `import-<源sessionId>`）。
- **增量续写（重导）** — 重导同一源路径绝不改写已导入历史：未变文件跳过（`already-imported`，不重读）；增长文件只把**新增轮次** append 进同一会话（`appended`）；截断文件检测并上报（`sourceShrunk`）——需要完整新副本时用 `force: true`：

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
// 未变化 → "already-imported" · 增长 → "appended"（只追加新轮次）
```

每次导入结果都会上报 `status` 与任何异常——畸形行、疑似敏感信息、逐源丢弃——绝不静默吞掉。

### scan_discover — 只读会话发现

`scan_discover` 扫描全部 12 种格式的已知数据根，返回结构化会话索引（标题、项目、路径、导入状态），供批导入前预览。零副作用：

```
scan_discover()
scan_discover({ path: "~/.codex/sessions", format: "codex", query: "import" })
```

### list_imported_sessions & retract_import — 识别与撤回

`list_imported_sessions()` 枚举本插件已导入的全部 DSH 会话；`retract_import({ sessionId })`（或 `sourcePath`）移除其 registry 记录并返回手动删除引导。**只识别 + 引导手动删，绝不执行任何删除**：

```
list_imported_sessions()
retract_import({ sessionId: "import-019f5f27-…" })
```

### export_claude — DSH → Claude Code JSONL

`export_claude({ sessionId })` 把现有 DSH 会话（导入的或原生的）序列化为 Claude Code JSONL transcript，可直接 `--resume`。文件写到 `<outputDir>/<slug>/<uuid>.jsonl`（默认 `~/.claude/projects`），文件名是全新 UUID v4——绝不覆盖已有文件：

```
export_claude({ sessionId: "import-019f5f27-…" })
export_claude({ sessionId: "…", outputDir: "D:\backup\claude-projects", dryRun: true })
```

### sync_to_claude — 增量写回

`sync_to_claude({ sessionId })` 把会话的**新增完整轮次**追加回其 Claude Code 文件——`target: "source"`（默认，写回导入源文件）或 `"copy"`（最近一次 `export_claude` 副本）。文件被外部修改或缩小时一律上报、绝不覆盖；`force: true` 越过外部修改重锚定（被覆盖的守卫仍会上报）：

```
sync_to_claude({ sessionId: "import-019f5f27-…" })
sync_to_claude({ sessionId: "…", target: "copy", dryRun: true })
```

## 🔑 关键行为

- **只读导入** — 源转录与数据库绝不改写；导入的 DSH 历史 append-only（既有事件绝不修改）。
- **幂等 + 增量** — 未变源不重读直接跳过；增长只追加新增轮次；截断检测并上报。
- **自动归组工作区** — 会话按源 `cwd` 归入对应工作区。
- **上下文预算保护** — 导入会话没有 provider 配置，dsh 不会自动压缩它们；超长会话按上下文预算裁剪（单条内容上限，中间段压缩，保留最早提问、一条摘要与尾部）。预算可在调用时指定，或通过环境变量 `DSH_IMPORT_CONTEXT_BUDGET` 设置；裁剪结果总是上报。
- **失败要大声，绝不静默** — 畸形行与疑似敏感信息按位置计数上报（行号 / kind——绝不输出内容）；源格式无法保留的部分在导入报告里显式标注。
- **沙箱** — 读取工作区之外的源文件或写工作区之外的导出目标，需要会话沙箱放行该路径。

## ⚙️ 兼容性

面向 `dsh 0.1.x` 线（`dsh-tools ^0.1.0-rc.6`，实测 `dsh 0.1.0-rc.6`），需要 **Node.js >= 22.13**（`node:sqlite` 免 flag 的首个版本）。`npm test` — 335 个用例。

## 📦 安装与卸载

```bash
dsh plugin --profile web add dsh-chat-import        # npm 包
dsh plugin --profile web add -w link:/path/to/dsh-chat-import   # 本地源码（符号链接）
```

`dsh plugin` 把插件的 bundle 声明收编进 profile；重启 dsh 后插件生效。卸载：从 profile 的 bundles 移除 `import-claude` insert 行并重启 dsh。已导入的会话保留在 DSH 数据目录，不受影响。

## 📄 许可证

MIT — 见 [LICENSE](LICENSE)。
