# dsh-stop.ps1 - 完整退出 DSH（launcher + dsh 后端 + cloudflared 隧道 + 启动锁清理）
# 对应源机器桌面「退出DSH.cmd」的逻辑；下次打开 dsh-launcher / 跑 dsh-start.ps1 会干净地重新拉起。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File dsh-stop.ps1
$ErrorActionPreference = "SilentlyContinue"
$log = "$env:USERPROFILE\.dsh-restart.log"
function Say($m) { $m | Out-File $log -Append }

Say "dsh-stop: begin $(Get-Date -Format o)"

# 1. 杀 dsh 后端（node 进程，命令行含 deepseek-ai/dsh）
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -match 'deepseek-ai[\\/]dsh|@deepseek-ai/dsh'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# 2. 杀 cloudflared 隧道（dsh-start.ps1 每次启动都会接管重建）
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force

# 3. 关 dsh-launcher 窗口
Get-Process DshWeb -ErrorAction SilentlyContinue | Stop-Process -Force

# 4. 清启动锁 / 隧道状态文件（下次启动重新生成）
Remove-Item "$env:USERPROFILE\.dsh-start.lock" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.dsh-tunnel.url" -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 2
Say "dsh-stop: done $(Get-Date -Format o)"
Write-Host "DSH 已退出：后端 / 隧道 / launcher 已关闭，启动锁已清理。"
Write-Host "下次打开 dsh-launcher 会自动干净地重新拉起。"
