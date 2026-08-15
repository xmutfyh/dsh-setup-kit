# dsh-start.ps1 - DSH 启动管理器（隧道外置版 v2）
# 解决 autoTunnel 域名随 dsh 重启变化导致 --trusted-host 失效、/api 403 的问题。
# v2 修正：接管/重建 cloudflared（不留插件遗留进程）、必须解析到 URL 才启动 dsh、
#         无条件移除 autoTunnel 配置、patch 幂等。
$ErrorActionPreference = "SilentlyContinue"
$log = "$env:USERPROFILE\.dsh-restart.log"
$tunnelLog = "$env:USERPROFILE\.dsh-tunnel.log"
$tunnelState = "$env:USERPROFILE\.dsh-tunnel.url"
$patchFile = "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml"
$cloudflared = "$env:USERPROFILE\.dsh\profiles\web\node_modules\cloudflared\bin\cloudflared.exe"
$dshBin = "C:\Users\fyh\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh\lib\bin.js"
$env:PATH = "$env:USERPROFILE\Downloads\Everything-Portable;" + $env:PATH

function Say($m) { $m | Out-File $log -Append }

# 1b. 互斥锁：另一个 dsh-start 在跑就退出（watcher 与 launcher 可能同时触发）
$lock = "$env:USERPROFILE\.dsh-start.lock"
if (Test-Path $lock) {
  $lp = Get-Content $lock -Raw
  if ($lp -match '^\d+$' -and (Get-Process -Id ([int]$lp) -ErrorAction SilentlyContinue)) {
    Say "dsh-start: another instance running (pid $lp), skip"
    exit 0
  }
}
"$PID" | Out-File $lock -Force

# 1. 已在监听？直接退出
if (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue) {
  Say "dsh-start: already listening, skip"; exit 0
}

# 2. 接管隧道：杀掉一切 cloudflared（含插件遗留），由我们统一拉起
Say "dsh-start: taking over cloudflared $(Get-Date -Format o)"
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Remove-Item $tunnelLog, "$tunnelLog.err", $tunnelState -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $cloudflared -ArgumentList "tunnel --url http://127.0.0.1:3080 --no-autoupdate" `
  -WindowStyle Hidden -RedirectStandardOutput $tunnelLog -RedirectStandardError "$tunnelLog.err"

# 3. 等 trycloudflare URL（最多 90s；banner 可能输出到 stdout 或 stderr）
$url = ""
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Seconds 1
  $m = Select-String -Path @($tunnelLog, "$tunnelLog.err") -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($m) { $url = $m.Matches[0].Value; break }
}
if ($url -eq "") {
  Say "dsh-start: FATAL no tunnel URL within 90s; launching dsh without trusted-host"
} else {
  $url | Out-File $tunnelState -Force
  Say "dsh-start: tunnel URL = $url"
}

# 4. 更新 cordis.patch.yml：remote-web-ui 移除 autoTunnel，写入 publicBaseUrl
#    （一律 UTF-8 无 BOM 读写，避免 PowerShell 默认编码把中文写坏）
$utf8 = New-Object System.Text.UTF8Encoding($false)
if (Test-Path $patchFile) {
  $c = [IO.File]::ReadAllText($patchFile, $utf8)
  $c = $c -replace '(?m)^(\s*)autoTunnel: true\s*$', ''
  if ($c -match "publicBaseUrl:") {
    if ($url -ne "") { $c = $c -replace '(?m)^(\s*)publicBaseUrl: .*$', "`$1publicBaseUrl: $url" }
  } else {
    if ($url -ne "") {
      if ($c -match '(?m)^- id: remote-web-ui\s*$') {
        $c = $c -replace '(?m)^- id: remote-web-ui\s*$', "- id: remote-web-ui`n  config:`n    publicBaseUrl: $url"
      }
    }
  }
  [IO.File]::WriteAllText($patchFile, $c, $utf8)
  Say "dsh-start: patch updated (autoTunnel removed, publicBaseUrl=$url)"
}

# 4b. 同步写 settings.yaml（设置卡片持久层优先级高于 patch——publicBaseUrl 必须写这里）
#     精确删除旧的 remote-web-ui 块（含相关注释），再追加干净块，全程 UTF-8 无 BOM。
if ($url -ne "") {
  $settingsFile = "$env:USERPROFILE\.dsh\settings.yaml"
  $sc = [IO.File]::ReadAllText($settingsFile, $utf8)
  $sc = [regex]::Replace($sc, '(?m)^\s*#.*remote-web-ui.*\r?\n', '')
  $sc = [regex]::Replace($sc, '(?ms)^remote-web-ui:.*?(?=^[A-Za-z0-9_-]+:|\z)', '')
  $sc = $sc.TrimEnd() + "`r`n`r`nremote-web-ui:`r`n  autoTunnel: false`r`n  publicBaseUrl: $url`r`n"
  [IO.File]::WriteAllText($settingsFile, $sc, $utf8)
  Say "dsh-start: settings.yaml updated (publicBaseUrl=$url)"
}

# 5. 启动 dsh web（带 --trusted-host）
$trusted = ""
if ($url -ne "") { $trusted = ($url -replace '^https://','') }
Say "dsh-start: launching dsh trustedHost=$trusted $(Get-Date -Format o)"
$args = '"' + $dshBin + '" web --host 127.0.0.1 --port 3080'
if ($trusted -ne "") { $args += " --trusted-host $trusted" }
Start-Process -FilePath "node.exe" -ArgumentList $args `
  -WindowStyle Hidden `
  -RedirectStandardOutput "$env:USERPROFILE\.dsh-web.log" `
  -RedirectStandardError "$env:USERPROFILE\.dsh-web.err.log"
Remove-Item $lock -Force -ErrorAction SilentlyContinue
Say "dsh-start: done $(Get-Date -Format o)"
