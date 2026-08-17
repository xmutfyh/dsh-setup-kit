# @dsh-external/dsh-session-search

Cross-agent session search plugin for DeepSeek Harness — directly scan past conversations from dsh, Codex, Claude Code, pi, and OpenCode without creating a derived database.

[中文](README.zh-CN.md)

## Capabilities

| Tool | Description |
|---|---|
| `agent_session_search` | Case-insensitive literal search across current source artifacts: matching session + strongest message + snippet + message window; supports `sources`/`cwd`/`sort`/`limit` filters |
| `agent_session_read` | Read one discovered session's metadata and a message window (`aroundSeq` targeting) |

Search observes the current source artifacts on each call and uses a case-insensitive literal substring match. English, Chinese, punctuation, and short queries all follow the same rule. Relevance is intentionally basic: the message with the most occurrences represents each session, with recency as the tie-breaker.

## Supported session sources

| Source | Default location | Read mode |
|---|---|---|
| dsh | `~/.dsh/sessions/**/session.jsonl.zstd` | multi-frame zstd, decoded frame by frame (node:zlib native) |
| codex | `~/.codex/sessions/**` + `archived_sessions/` | JSONL |
| claude | `~/.claude/projects/**` | JSONL |
| pi | `~/.pi/agent/sessions/**` | JSONL |
| opencode | `~/.local/share/opencode/opencode.db` | SQLite read-only |

All sources are **read-only**: session files are never modified, and the plugin creates no database, index, or persistent cache. OpenCode's own database is opened read-only as a source artifact.

## Install (marisa / dshx)

```sh
git clone https://github.com/dsh-external/dsh-session-search.git
dshx install dsh-session-search ./dsh-session-search
```

Or install directly from a git URL. The plugin is mounted into `~/.dsh/config.yaml` and takes effect on the next `dsh web`/TUI start (hot with Web HMR).

### Manual mount (without dshx)

```yaml
# ~/.dsh/config.yaml
- insert:
    - id: dsh-session-search
      name: '/absolute/path/to/dsh-session-search/lib/index.js'
      config:
        sources: { dsh: true, codex: true, claude: true, pi: true, opencode: true }
        maxResults: 10
        readWindow: 10
```

## Configuration

| Key | Default | Description |
|---|---|---|
| `sources` | all enabled | Per-source boolean switch (`dsh`/`codex`/`claude`/`pi`/`opencode`) |
| `roots` | per-source home defaults | Per-source root override |
| `maxResults` | 10 | Max sessions per search |
| `readWindow` | 10 | Default window for `agent_session_read` |

## Development

```sh
./scripts/build.sh   # compile src → lib with the dsh checkout's tsc (lib/ committed)
node tests/smoke.mjs # smoke test: scan real sessions and search
```

peerDependencies are provided by the host dsh's node_modules (`cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-system-prompt`, …); the build script creates the symlinks.

## Implementation notes

- Parsers are defensive: oversized, corrupt, or unreadable files are skipped without failing the whole scan.
- dsh session logs are **concatenated-frame zstd streams** (one independent frame per appended event batch): frame boundaries are located with a structural scan, then decoded one frame at a time; a torn final frame (interrupted write) is skipped on that call.
- `sources` is applied before discovery. For canonical plain JSONL sources, safe single-line queries use `rg --fixed-strings --ignore-case` only to select candidate files; escaped queries skip this optimization. Every candidate is parsed and matched again, so raw metadata never becomes a result.
- Search processes one parsed session at a time and retains only bounded Top-K hits. DSH concatenated Zstd frames are decompressed and consumed one frame at a time instead of materializing the complete decoded log.
- `agent_session_read` tries the source-native artifact id first and falls back to a source-scoped scan only when an external format does not expose a direct mapping. OpenCode selects the exact source row.
- Every call observes current source state. There is no index lifecycle or stale derived state; a broad DSH search must still decompress the complete DSH corpus.
- Matching is literal and case-insensitive. Results group by session, rank the strongest message by occurrence count, and use timestamps for stable tie-breaking.

## License

BSD-3-Clause
