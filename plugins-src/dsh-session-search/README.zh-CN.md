# @dsh-external/dsh-session-search

跨工具会话搜索插件（DeepSeek Harness 外部插件）——不创建派生数据库，直接扫描本机 dsh、Codex、Claude Code、pi、OpenCode 的历史会话。

[English](README.md)

## 能力

| 工具 | 说明 |
|---|---|
| `agent_session_search` | 对当前源文件执行大小写不敏感的字面搜索：命中会话 + 最强消息 + snippet + 消息窗口；支持 `sources`/`cwd`/`sort`/`limit` 过滤 |
| `agent_session_read` | 读取单个已发现会话的元数据与消息窗口（`aroundSeq` 定位） |

每次搜索都会观察当前源文件，并执行大小写不敏感的字面子串匹配。英文、中文、标点和短查询使用同一规则。相关度刻意保持基础：每个会话由命中次数最多的消息代表，次数相同时按时间决胜。

## 支持的会话源

| 源 | 位置（默认） | 读取方式 |
|---|---|---|
| dsh | `~/.dsh/sessions/**/session.jsonl.zstd` | 多帧 zstd 按帧解压（node:zlib 原生） |
| codex | `~/.codex/sessions/**` + `archived_sessions/` | JSONL |
| claude | `~/.claude/projects/**` | JSONL |
| pi | `~/.pi/agent/sessions/**` | JSONL |
| opencode | `~/.local/share/opencode/opencode.db` | SQLite 只读（`readOnly`） |

所有源**只读**：不修改任何会话文件，插件也不创建数据库、索引或持久缓存。OpenCode 自身的数据库只作为源文件以只读方式打开。

## 安装（marisa / dshx）

```sh
git clone https://github.com/dsh-external/dsh-session-search.git
dshx install dsh-session-search ./dsh-session-search
```

或直接按 git-url 安装。安装后插件自动挂载进 `~/.dsh/config.yaml`，`dsh web`/TUI 下次启动生效（Web 面 HMR 启用时热生效）。

### 手动挂载（无 dshx）

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

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `sources` | 全部启用 | 每源布尔开关（`dsh`/`codex`/`claude`/`pi`/`opencode`） |
| `roots` | 各源默认主目录 | 每源根目录覆盖 |
| `maxResults` | 10 | 单次搜索返回的最大会话数 |
| `readWindow` | 10 | `agent_session_read` 默认窗口大小 |

## 模型提示

安装后注入系统提示：

> Use agent_session_search to find relevant work from prior sessions across dsh,
> Codex, Claude Code, pi, and OpenCode, then agent_session_read to view a full
> message window of one hit...

## 开发

```sh
./scripts/build.sh   # 用 dsh checkout 的 tsc 编译 src → lib（lib/ 提交进 git）
node tests/smoke.mjs # 冒烟测试：扫描真实会话并搜索
```

peerDependencies 由宿主 dsh 的 node_modules 提供（`cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-system-prompt` 等），构建脚本会建立符号链接。

## 实现要点

- 解析器防御式处理：超大、损坏或不可读文件会跳过，单文件失败不影响整次扫描。
- dsh 会话日志是**拼接帧 zstd 流**（每批事件一个独立帧）：先结构化扫描帧边界再逐帧解压；撕裂的末帧（写入中断）在本次调用中跳过。
- `sources` 在文件发现前生效。对于规范的普通 JSONL 源，安全的单行查询只用 `rg --fixed-strings --ignore-case` 筛选候选文件；含转义字符的查询跳过该优化。所有候选都会再次经过 parser 和正文匹配，原始元数据不会直接成为结果。
- 搜索每次只处理一个已解析 Session，并且只保留有界 Top-K。DSH 拼接 Zstd 帧逐帧解压和消费，不再物化完整解压日志。
- `agent_session_read` 优先使用来源原生的 artifact id 直达文件，仅在外部格式无法直接映射时执行单来源回退扫描；OpenCode 会精确选择源数据库中的目标行。
- 每次调用都会观察当前源状态，不存在索引生命周期或过期派生状态；广泛的 DSH 搜索仍必须解压完整 DSH 语料。
- 匹配采用大小写不敏感的字面规则；结果按会话分组，以单条消息的命中次数排序，并用时间戳稳定决胜。

## License

BSD-3-Clause
