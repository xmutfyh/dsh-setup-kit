# MANIFEST — dsh-setup-kit 完美复刻包内容清单

> 本包是源机器（2026-08-16）DSH 环境的完整快照。目标机器用 Codex 安装请照
> [SETUP-CODEX.md](SETUP-CODEX.md) 逐步执行。

## 插件（plugins-src/，8 个，全部已带补丁，link: 安装）

| 目录 | 版本 | 功能 | 补丁 |
|---|---|---|---|
| dsh-drag-and-drop | 0.1.4 | 拖文件→路径 | ✅ -whole-filename 兼容 + GBK 中文路径解码 + pasteBegin/invalidatePaste 输入框修复 |
| dsh-drop-to-path | - | 图片/文件→发送时转工作区路径（附件栏方块，不碰输入框草稿）| - |
| dsh-chat-import | - | 导入 Codex/Claude/ChatGPT 会话 | - |
| dsh-file-claim | - | 多会话文件锁 | - |
| dsh-file-mentions | - | 回复路径可点击 | - |
| dsh-plugin-anydoc | - | 任意文件→Markdown | - |
| dsh-plugin-ocr | 0.1.0 | 本地 OCR（RapidOCR，需 pip 装 rapidocr_onnxruntime） | - |
| dsh-plugin-writing-guard | 1.2.2 | 确定性 manuscript integrity guard（Revision Integrity + claim-bound + alignment credibility + 自动交付）：Scholarship Lock（全方向含新增）+ Epistemic Lock（因果/证据力+角色排除、hedge、claim-bound 守恒、scope 统一分类、alignment-uncertain、版本差距保护+全局清单、exec.token 自动前后对比、event-level 增量指纹、invariant 恒显）+ findingKind + SKILL.md | ✅ Config 兼容 cordis 4（`export const Config`→`const DEFAULT_CONFIG`） |

npm 插件（第 3 步安装，不在包内）：`@linxin666/dsh-web-ui-all@0.1.12`（任务看板/Git图谱/右侧面板/实时token/皮肤/SSH/宠物/手机远控）

## 技能（skills/，21 个 + 2 资源目录）

nature-* 系列（写作/引用/检索/审稿/回复/数据/图表/PPT/专利等）、academic-research-suite、
ppt-master、web-access（浏览器 CDP 控制）、scientific-image2-visio 等。
> 复制的是源机器的个人技能，含少量源路径引用，目标机器按需删减。

## 脚本（scripts/）

| 文件 | 作用 |
|---|---|
| dsh-start.ps1 | 启动管理器：外置 cloudflared 隧道 + 动态 publicBaseUrl + `--trusted-host` 启动 + UTF-8 无 BOM 安全写配置 |
| dsh-restart.ps1 | 重启助手（保留隧道、域名不变） |
| dsh-stop.ps1 | 完整退出：杀 dsh 后端 + cloudflared + launcher（DshWeb.exe），清启动锁/隧道状态文件 |
| dsh-patch-dragdrop.ps1 | drag-and-drop 补丁重打（升级后执行） |

> ⚠️ 机器相关：dsh-start.ps1 内 `$dshBin` 是源机器 npx 缓存路径，目标机必须按
> SETUP-CODEX.md 第 7 步替换。

## 配置模板（templates/）

| 文件 | 目标 | 说明 |
|---|---|---|
| cordis.patch.yml.template | ~/.dsh/profiles/web/cordis.patch.yml | agent-instructions（只读 AGENTS.md）+ academic-search MCP（`<USERPROFILE>` 占位） |
| settings.yaml.template | ~/.dsh/settings.yaml | provider（nuoda.vip 中转，用 OPENAI_API_KEY 环境变量）+ pet + 默认模型 |

## 配套

| 目录 | 说明 |
|---|---|
| launcher/ | dsh-launcher 0.1.6（MSI + 便携 zip），GitHub: Ruler4396/dsh-launcher |
| everything-portable/ | Everything 1.4.1 + es.exe（拖拽全盘索引，需管理员运行） |
| 桌面「退出DSH.cmd」 | setup.ps1 自动生成，一键退出 DSH（调用 `scripts\dsh-stop.ps1`） |

## 不包含（目标机自行处理）

- API 凭据（`.credentials.yaml`、OPENAI_API_KEY）——各机独立
- DSH 会话记录（sessions/）
- 手机远控的隧道 URL——由 dsh-start.ps1 每次启动动态生成
- uv（MCP 需要）：目标机 `powershell -c "irm https://astral.sh/uv/install.ps1 | iex"` 或官网安装

## 关键修复（已内置于本包，勿覆盖）

1. drag-and-drop：`-whole-filename`（ES 1.1.0.37 不支持）+ GBK 解码（中文路径）
2. writing-guard：Config 普通对象 → cordis 4.0.1 兼容（否则 `plugin tree failed to load`）
3. dsh-start.ps1：UTF-8 无 BOM 读写配置（否则中文乱码 + YAML 坏）
4. link 插件依赖：junction → .dsh-runtime-deps（否则 `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-tools`）
