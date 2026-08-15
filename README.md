# dsh-setup-kit — DSH 完美复刻包

把源机器的 DSH 环境（插件 / 技能 / 启动器 / 手机远控 / 全部补丁）完整搬到新电脑。

## 两种安装方式

- **目标机器有 Codex**（推荐）：把整个文件夹拷过去，让 Codex 读 [SETUP-CODEX.md](SETUP-CODEX.md) 逐步执行——装插件、补依赖、应用配置模板、启动隧道全流程它都能做
- **无 Codex**：按 [SETUP-CODEX.md](SETUP-CODEX.md) 的步骤手动执行（或跑旧版 setup.ps1 再补手机远控部分）

## 快速开始（Codex 模式）

1. 把 `dsh-setup-kit` 整个文件夹拷到新电脑 `C:\Users\<用户名>\Downloads\`（**装完别移动/删除**）
2. 新电脑打开 Codex，告诉它：
   > 按 `C:\Users\<用户名>\Downloads\dsh-setup-kit\SETUP-CODEX.md` 逐步安装里面的 DSH 环境
3. Codex 会：装 DSH → pnpm → web-ui 全家桶 → 7 个本地插件 → junction 修依赖 → 复制技能 → 部署管理器脚本 → 应用配置模板（替换占位符）→ Everything + launcher → 启动并验证

## 前置

- Windows 10/11 + Node.js 22+
- 新电脑自己的 API 凭据（模板用 `OPENAI_API_KEY` 环境变量）
- MCP 学术检索需 `uv`（SETUP-CODEX.md 第 8 步说明）

## 包内容

见 [MANIFEST.md](MANIFEST.md)。核心组件：

```
dsh-setup-kit/
├── SETUP-CODEX.md        ← 给 Codex 的逐步安装指令（主入口）
├── MANIFEST.md           ← 组件清单与关键修复说明
├── plugins-src/          ← 7 个本地插件（drag-and-drop / writing-guard 已带补丁）
├── skills/               ← 21 个技能
├── scripts/              ← dsh-start / dsh-restart / dsh-patch-dragdrop
├── templates/            ← cordis.patch.yml / settings.yaml（占位符模板）
├── launcher/             ← dsh-launcher 0.1.6
└── everything-portable/  ← Everything + es.exe
```

## 注意

- **不要** `dsh plugin update` 本地插件、不要重编译（补丁会被覆盖）
- **不要**用 PowerShell 默认编码写配置文件（用 UTF-8 无 BOM）
- 手机远控：每次重启后隧道域名变化，需重新扫码（dsh-start.ps1 自动同步配置）
- 源机器遗留脚本：`Downloads\dsh-start.ps1`、`dsh-restart.ps1`、`dsh-patch-dragdrop.ps1` 与此包 scripts/ 一致
