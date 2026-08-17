# SETUP-CODEX.md — 在新电脑上用 Codex 完美复刻 DSH 环境

> 给目标电脑上的 **Codex** 看。你（Codex）负责按本文件逐步执行，把
> `dsh-setup-kit` 里的插件/技能/配置/脚本完整安装到这台新电脑，复刻源机器的 DSH 环境。
> 执行中遇到任何报错：先读 `%~USERPROFILE%\.dsh-restart.log` / `.dsh-web.err.log`，
> 判断是"配置写坏"还是"插件缺依赖"，不要盲改源码。

## 0. 前置检查

- Windows 10/11 + Node.js 22+（`node --version` 确认）
- `dsh-setup-kit` 文件夹完整（含 plugins-src / skills / launcher / everything-portable / scripts / templates）
- **记录 kit 的绝对路径** `$Kit`（本文件假设 `C:\Users\<用户名>\Downloads\dsh-setup-kit`，实际以机器为准；**装完后 kit 文件夹不能移动/删除**——本地插件是 link: 指向它的）

## 1. 安装 DSH 本体

```powershell
npx -y @deepseek-ai/dsh web
```
看到 `dsh web: http://127.0.0.1:3080` 后 **Ctrl+C 退出**（这一步创建 `~\.dsh\profiles\web`）。

## 2. 准备 pnpm

```powershell
$gp = npm prefix -g
corepack enable --install-directory $gp
$env:PATH = "$gp;" + $env:PATH
pnpm --version   # 应输出版本号
```

## 3. 安装 npm / GitHub 插件（dsh-web-ui 全家桶 + dshmarket + dsh-cost-meter）

```powershell
dsh plugin --profile web add @linxin666/dsh-web-ui-all@0.1.15
dsh plugin --profile web add dshmarket@1.8.0
dsh plugin --profile web add github:Han-1413141/dsh-cost-meter
```
若报 `ERR_PNPM_IGNORED_BUILDS`：编辑 `~\.dsh\profiles\web\pnpm-workspace.yaml`，
把 `allowBuilds` 下的 `cloudflared / cpu-features / ssh2` 都设为 `true`，重跑上面命令。

## 4. 安装 8 个 link 本地插件 + 手动挂载 dsh-session-search

逐个执行（路径用 `$Kit\plugins-src\<名>`）：

```powershell
$Kit = "C:\Users\<用户名>\Downloads\dsh-setup-kit"
dsh plugin --profile web add "$Kit\plugins-src\dsh-drag-and-drop"
dsh plugin --profile web add "$Kit\plugins-src\dsh-drop-to-path"
dsh plugin --profile web add "$Kit\plugins-src\dsh-chat-import"
dsh plugin --profile web add "$Kit\plugins-src\dsh-file-claim"
dsh plugin --profile web add "$Kit\plugins-src\dsh-file-mentions"
dsh plugin --profile web add "$Kit\plugins-src\dsh-plugin-anydoc"
dsh plugin --profile web add "$Kit\plugins-src\dsh-plugin-ocr"
dsh plugin --profile web add "$Kit\plugins-src\dsh-plugin-writing-guard"
```
> 这些包已带好补丁：drag-and-drop（-whole-filename + GBK 中文路径 + pasteBegin 输入框修复）、writing-guard（Config 兼容 cordis 4 修复）。
> **不要**对它们执行 `dsh plugin update`，也不要重编译（会覆盖补丁）。
> 提示：dsh-drag-and-drop 与 dsh-drop-to-path 功能相近，二选一或都用（drop-to-path 在发送时转路径，不碰输入框草稿）。

`dsh-session-search` 不是 bundle 插件，不需要（也不能用）`dsh plugin add` 安装；
它通过 `cordis.patch.yml` 手动挂载到 `plugins-src\dsh-session-search\lib\index.js`。
第 8 步应用模板时会自动写入；如果手动改，参考 `templates/cordis.patch.yml.template` 里的
`dsh-session-search` 块，并把 `name` 改成 `file:///C:/Users/<用户名>/Downloads/dsh-setup-kit/plugins-src/dsh-session-search/lib/index.js`。

## 5. 修复 link 插件的运行时依赖（junction，关键！）

link: 插件的源码在 kit 里，Node 从那里解析 `@deepseek-ai/dsh-tools` 等 peer 依赖会失败
（症状：`plugin tree failed to load / ERR_MODULE_NOT_FOUND`）。修法：

```powershell
$src = "$Kit\plugins-src"
Push-Location $src
npm install --prefix "$src\.dsh-runtime-deps" --no-audit --no-fund `
  "@deepseek-ai/dsh-tools@0.1.0-rc.6" `
  "@deepseek-ai/dsh-client-locale@0.1.0-rc.6" `
  "@deepseek-ai/cordis@^4.0.1" `
  "react@18.2.0" `
  "@firecrawl/anydoc@^0.1.8"
Pop-Location
# 建 junction：plugins-src\node_modules -> .dsh-runtime-deps\node_modules
New-Item -ItemType Junction -Path "$src\node_modules" -Target "$src\.dsh-runtime-deps\node_modules" -ErrorAction SilentlyContinue
```
验证：`Test-Path "$src\node_modules\@deepseek-ai\dsh-tools"` 应为 True。

## 6. 复制技能

```powershell
Copy-Item "$Kit\skills\*" "$env:USERPROFILE\.dsh\skills\" -Recurse -Force
```
（21 个技能：nature-* 系列、web-access 浏览器控制等）

## 7. 复制管理器脚本 + 修改机器相关路径

```powershell
Copy-Item "$Kit\scripts\dsh-start.ps1","$Kit\scripts\dsh-restart.ps1","$Kit\scripts\dsh-stop.ps1","$Kit\scripts\dsh-patch-dragdrop.ps1" "$env:USERPROFILE\Downloads\"
```
**关键**：`dsh-start.ps1` 里的 `$dshBin` 是源机器的 npx 缓存绝对路径，**本机不同**。
用下面命令解析本机实际路径并替换（打开 `%USERPROFILE%\Downloads\dsh-start.ps1` 编辑）：

```powershell
# 找本机 dsh bin.js 路径：
Get-ChildItem "$env:LOCALAPPDATA\npm-cache\_npx" -Directory -ErrorAction SilentlyContinue |
  ForEach-Object { $p = Join-Path $_.FullName "node_modules\@deepseek-ai\dsh\lib\bin.js"; if (Test-Path $p) { $p } } |
  Select-Object -First 1
```
把脚本里 `$dshBin = "C:\Users\fyh\..."` 换成上面的输出（同样检查 `dsh-restart.ps1` 内对 dsh-start.ps1 的引用路径）。

顺手创建桌面「退出DSH」快捷键（调用本机 Downloads 下的 dsh-stop.ps1）：

```powershell
$stop = "$env:USERPROFILE\Downloads\dsh-stop.ps1"
[System.IO.File]::WriteAllText("$env:USERPROFILE\Desktop\退出DSH.cmd",
  "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$stop`"`r`n",
  (New-Object System.Text.UTF8Encoding($false)))
```

## 8. 应用配置模板

```powershell
# cordis.patch.yml：把 <USERPROFILE> 替换成本机用户目录、<USERPROFILE_URL> 替换成 file:/// 格式后复制
$patch = Get-Content "$Kit\templates\cordis.patch.yml.template" -Raw -Encoding UTF8
$patch = $patch -replace '<USERPROFILE>', $env:USERPROFILE
$patch = $patch -replace '<USERPROFILE_URL>', ($env:USERPROFILE -replace '\\','/')
[System.IO.File]::WriteAllText("$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml", $patch, (New-Object System.Text.UTF8Encoding($false)))
# settings.yaml：复制模板（首次 dsh web 已生成默认文件，覆盖它）
[System.IO.File]::WriteAllText("$env:USERPROFILE\.dsh\settings.yaml",
  (Get-Content "$Kit\templates\settings.yaml.template" -Raw -Encoding UTF8),
  (New-Object System.Text.UTF8Encoding($false)))
```
> ⚠️ 编码纪律：配置必须 **UTF-8 无 BOM** 读写，绝不用 PowerShell 默认编码（会把中文写坏）。
> settings.yaml 的 API 中转用 `OPENAI_API_KEY` 环境变量——**本机需自行设置该环境变量**（或改用自带 provider）。

## 9. 安装 Everything + dsh-launcher

```powershell
# Everything（拖拽路径索引）
$ev = "$env:USERPROFILE\Everything-Portable"
if (-not (Test-Path $ev)) { Copy-Item "$Kit\everything-portable" $ev -Recurse -Force }
# 加入用户 PATH（User 级）
$up = [Environment]::GetEnvironmentVariable("Path","User")
if ($up -notmatch [regex]::Escape($ev)) { [Environment]::SetEnvironmentVariable("Path", $up.TrimEnd(';') + ";" + $ev, "User") }
# 以管理员启动（UAC 确认，NTFS 索引需要）
Start-Process "$ev\everything.exe" -Verb RunAs

# dsh-launcher
Start-Process msiexec.exe -ArgumentList "/i `"$Kit\launcher\dsh-launcher-0.1.6.msi`" /qb /norestart" -Wait
```

## 10. 启动 + 验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\dsh-start.ps1"
```
- 应自动：起 cloudflared → 解析公网 URL → 写入 settings.yaml 的 publicBaseUrl → 以 `--trusted-host <url>` 启动 dsh
- 验证：`netstat -ano | findstr 3080` 有 LISTENING；日志 `%USERPROFILE%\.dsh-restart.log` 无 FATAL；
  `Test-Path "$env:USERPROFILE\.dsh-tunnel.url"` 有内容
- 打开 dsh-launcher（或 `npx -y @deepseek-ai/dsh web`），Ctrl+F5 刷新：侧边栏应有任务看板/Git图谱/SSH/手机图标等

## 11. 手机远控（可选）

1. 桌面配对面板（侧边栏底部手机图标）→ 公网地址应显示第 10 步生成的 trycloudflare URL
2. 手机浏览器开**桌面版网站**模式 → 扫码 → 桌面完整 UI + 实时
3. 每次重启 DSH 后隧道域名会变，需重新扫码（dsh-start.ps1 自动同步配置）

## 故障速查

| 症状 | 原因 | 处理 |
|---|---|---|
| `plugin tree failed to load / ERR_MODULE_NOT_FOUND` | junction 没建好或缺 peer 包 | 重做第 5 步，验证 dsh-tools 可解析 |
| `Cannot read properties of undefined (reading 'validate')` | 某插件 Config 是普通对象 | 照 writing-guard 的修法：`export const Config` → `const DEFAULT_CONFIG` 不导出 |
| 启动报 YAML 错误（BLOCK_AS_IMPLICIT_KEY） | settings.yaml 被写坏 | 用模板重写（UTF-8 无 BOM）；检查是否有重复块/乱码 |
| 手机 /api 403 | --trusted-host 缺失或域名不匹配 | 确认 dsh-start.ps1 的 $dshBin 已改、重启走 dsh-start |
| 手机被送到精简界面 | 浏览器 UA 是移动端 | 开「桌面版网站」再扫码 |

## 禁止事项

- 不要 `dsh plugin update` 本地 link 插件（补丁会被覆盖）；要升级需重打补丁（scripts\dsh-patch-dragdrop.ps1 只管 drag-and-drop）
- 不要重编译 dsh-plugin-writing-guard / dsh-plugin-ocr（lib 是修好的产物）
- 不要移动/删除 kit 文件夹；不要用 PowerShell 默认编码写 settings.yaml / cordis.patch.yml
- 不复制任何凭据文件（`.credentials.yaml`）；目标机自己配 API key
