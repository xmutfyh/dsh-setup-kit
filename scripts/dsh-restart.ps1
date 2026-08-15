# dsh-restart.ps1 - detached restart helper (tunnel-preserving version).
# Kills ONLY the dsh server processes (cloudflared stays alive so the
# tunnel hostname does NOT change), waits for port 3080 to free, then calls
# dsh-start.ps1 which relaunches dsh web with --trusted-host <current URL>.
$ErrorActionPreference = "SilentlyContinue"
$log = "$env:USERPROFILE\.dsh-restart.log"
"=== watcher start $(Get-Date -Format o) ===" | Out-File $log -Append

Start-Sleep -Seconds 12

"killing dsh $(Get-Date -Format o)" | Out-File $log -Append
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'deepseek-ai[\\/]dsh|@deepseek-ai/dsh' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 500
}

"port free, calling dsh-start $(Get-Date -Format o)" | Out-File $log -Append
& powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\dsh-start.ps1"
"restart sequence done $(Get-Date -Format o)" | Out-File $log -Append
