<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="assets/import.svg" width="120" alt="dsh-chat-import">
</p>

# DSH Chat Import

> **11 agent sources, one plugin** — full-fidelity import into DeepSeek Harness, seamless resume, and export / sync back to Claude Code.

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
  <b>Listed in:</b> <a href="https://github.com/0xsline/awesome-deepseek-harness">Awesome DeepSeek Harness</a> · <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin">Awesome DSH Plugin</a> · <a href="https://github.com/Dominic789654/awesome-deepseek-harness">Awesome DSH Plugins</a> · <a href="https://www.npmjs.com/package/dsh-chat-import">npm</a>
  &nbsp;&nbsp;·&nbsp;&nbsp; <b>Changelog:</b> <a href="CHANGELOG.md">CHANGELOG.md</a>
</p>

`dsh-chat-import` imports conversation histories from **Claude Code, Codex, ChatGPT, Cursor, Gemini, Reasonix, opencode, ZCode, Grok Build, OpenClaw, Pi Coding Agent and Hermes** — tool calls, reasoning and all — as **full-fidelity, resumable DeepSeek Harness sessions**. Source files are read **read-only** (never rewritten), the DSH engine is never touched, and every import becomes a fresh session grouped into the workspace of its source `cwd`.

The reverse direction is covered too: `export_claude` serializes a DSH session back into a Claude Code JSONL transcript that Claude Code can load with `--resume` (read-only — your DSH log is never modified), and `sync_to_claude` incrementally appends a session's new turns back to a Claude Code file — guarded, never silently overwriting.

## ✨ Features

**📥 Import**

- **12 sources, one plugin** — one tool per source, from Claude Code JSONL and Codex rollouts to SQLite databases and session directories.
- **🔍 Full fidelity** — tool calls & results, thinking blocks, titles, models and timestamps carry over wherever the source records them.
- **📦 Batch import** — point at a directory (or a whole database) and every file / conversation becomes its own session, with a per-file summary.

**▶️ Resume**

- **Seamlessly resumable** — open an imported session and keep chatting exactly where the source left off.
- **🗂 Auto workspace grouping** — sessions land in the workspace of their source `cwd` — no more "ungrouped".

**🔄 Reverse**

- **📤 Export to Claude Code** — `export_claude` writes any DSH session (imported or native) to `<outputDir>/<slug>/<uuid>.jsonl`, ready for `--resume`.
- **🔄 Sync back** — `sync_to_claude` appends a session's new complete turns to its Claude Code file — guarded, never overwriting.

**🛡️ Protection**

- **🔁 Idempotent + incremental** — re-importing an unchanged source skips it; a grown source appends only its new turns.
- **🧮 Context budget protection** — oversized sessions are trimmed to fit a safe context budget, and the trim is reported.

## 🗂 Supported sources

| Source | Storage location | Import tool |
| --- | --- | --- |
| **Claude Code** | `~/.claude/projects/<slug>/<sessionId>.jsonl` | `import_claude` |
| **Codex / ChatGPT CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `import_codex` |
| **ChatGPT** (web export) | anywhere you saved the export — `conversations.json` | `import_chatgpt` |
| **Cursor** | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` | `import_cursor` |
| **Gemini CLI** | `~/.gemini/history/<slot>/chats/session-*.json` | `import_gemini` |
| **Reasonix** | `~/.reasonix/sessions/desktop-*.jsonl` | `import_reasonix` |
| **opencode** | `~/.local/share/opencode/opencode.db` | `import_opencode` |
| **ZCode** (z.ai CLI) | `~/.zcode/cli/db/db.sqlite` | `import_zcode` |
| **Grok Build** | `~/.grok/sessions/<project>/<session_id>/` | `import_grokbuild` |
| **OpenClaw** | `~/.openclaw/agents/<agent>/sessions/*.jsonl` | `import_openclaw` |
| **Pi Coding Agent** | `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl` | `import_pi` |
| **Hermes** | `~/.hermes/` (Windows `%LOCALAPPDATA%\hermes`) | `import_hermes` |

Each import preserves what the source actually records — session id, `cwd`, title, model, timestamps, tool calls & results, reasoning. Sources that record less import what exists; anything a format cannot preserve is explicitly flagged in the import report.

## 🚀 Quick start

**1. Install** — add the plugin to a profile:

```bash
dsh plugin --profile web add dsh-chat-import                    # npm package
dsh plugin --profile web add -w link:/path/to/dsh-chat-import   # local checkout (symlink)
```

**2. Import** — in any DSH session, import a single file or a whole directory (the same call shape works for all 12 import tools — see the table above):

```
import_claude({ path: "~/.claude/projects" })
```

**3. Resume** — refresh the session list once, open the imported session, and continue chatting — it resumes exactly where the source left off.

## 🛠 Usage

> **Note:** imports persist to disk immediately, but the DSH session list does not auto-refresh — refresh the page (or the session list) after importing to see the new sessions.

**Import — a single file or a directory.** Every `import_*` tool takes a `path`; directories are scanned recursively and each file / conversation becomes its own session:

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
import_codex({ path: "C:\Users\<you>\.codex\sessions\2026\05\18\rollout-2026-05-18T21-14-16-xxxx.jsonl" })
import_chatgpt({ path: "C:\Users\<you>\Downloads\chatgpt-export\conversations.json" })
import_opencode({ path: "C:\Users\<you>\.local\share\opencode\opencode.db" })
```

`import_chatgpt` / `import_opencode` / `import_zcode` / `import_hermes` always return a batch result — one file / database holds all conversations, so each conversation becomes its own session in a single call.

- `preview: true` (alias `dryRun: true`) — run the import **read-only**: resolve, read and convert exactly like a real import, but persist nothing (zero side effects). Drop the flag and call again to actually import.
- `force: true` — create a **fresh full copy** under a new id (`import-<sessionId>-<n>`) even when the source was already imported; the old session is never modified.
- `sessionId` (optional) — override the target DSH session id (default `import-<source sessionId>`).
- **Incremental re-import** — re-importing the same source never rewrites imported history. Unchanged files are skipped (`already-imported`) without re-reading; grown files append only their **new turns** to the same session (`appended`); truncated files are detected and reported (`sourceShrunk`) — use `force: true` for a complete fresh copy:

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
// unchanged → "already-imported" · grew → "appended" (new turns only)
```

Every import result reports its `status` and any anomalies — malformed lines, suspected secrets, per-source drops — nothing is silently swallowed.

### scan_discover — read-only session discovery

`scan_discover` scans the known data roots of all 12 formats and returns a structured session index (title, project, path, import status) so you can preview before a batch import. Zero side effects:

```
scan_discover()
scan_discover({ path: "~/.codex/sessions", format: "codex", query: "import" })
```

### list_imported_sessions & retract_import — identify & retract

`list_imported_sessions()` enumerates every DSH session this plugin has imported; `retract_import({ sessionId })` (or `sourcePath`) removes its registry record and returns manual-deletion guidance. **Identification and guided manual deletion only — nothing is ever deleted**:

```
list_imported_sessions()
retract_import({ sessionId: "import-019f5f27-…" })
```

### export_claude — DSH → Claude Code JSONL

`export_claude({ sessionId })` serializes an existing DSH session (imported or native) into a Claude Code JSONL transcript, ready for `--resume`. It is written to `<outputDir>/<slug>/<uuid>.jsonl` (default `~/.claude/projects`), with a fresh UUID v4 file name — an existing file is never overwritten:

```
export_claude({ sessionId: "import-019f5f27-…" })
export_claude({ sessionId: "…", outputDir: "D:\backup\claude-projects", dryRun: true })
```

### sync_to_claude — incremental write-back

`sync_to_claude({ sessionId })` appends a session's **new complete turns** back to its Claude Code file — `target: "source"` by default (the import source) or `"copy"` (the last `export_claude` copy). Guards report an externally modified or shrunken file instead of overwriting it; `force: true` re-anchors past external edits (the overridden guard is still reported):

```
sync_to_claude({ sessionId: "import-019f5f27-…" })
sync_to_claude({ sessionId: "…", target: "copy", dryRun: true })
```

## 🔑 Key behaviors

- **Read-only import** — source transcripts and databases are never rewritten; imported DSH history is append-only (existing events are never modified).
- **Idempotent + incremental** — unchanged sources are skipped without re-reading; growth appends only the new turns; truncation is detected and reported.
- **Auto workspace grouping** — sessions are grouped into the workspace of their source `cwd`.
- **Context budget protection** — imported sessions carry no provider configuration, so dsh never auto-compacts them; oversized sessions are trimmed to fit a context budget (per-message caps, then a compressed middle keeping the earliest prompts, a summary and the tail). The budget can be set per call or via the `DSH_IMPORT_CONTEXT_BUDGET` env var; the trim is always reported in the result.
- **Fail loudly, never silently** — malformed lines and suspected secrets are counted and reported by position (line numbers / kind — content is never output); anything a source format cannot preserve is explicitly flagged in the import report.
- **Sandbox** — reading source files or writing exports outside the workspace requires the session sandbox to allow the path.

## ⚙️ Compatibility

Targets the `dsh 0.1.x` line (`dsh-tools ^0.1.0-rc.6`, tested on `dsh 0.1.0-rc.6`) and requires **Node.js >= 22.13** (the first release where `node:sqlite` is available without a flag). `npm test` — 335 cases.

## 📦 Install & uninstall

```bash
dsh plugin --profile web add dsh-chat-import        # npm package
dsh plugin --profile web add -w link:/path/to/dsh-chat-import   # local checkout (symlink)
```

`dsh plugin` folds the plugin's bundle declaration into the profile; the plugin becomes active after restarting dsh. To uninstall, remove the `import-claude` insert line from the profile's bundles and restart dsh. Already-imported sessions stay in the DSH data directory and are unaffected.

## 📄 License

MIT — see [LICENSE](LICENSE).
