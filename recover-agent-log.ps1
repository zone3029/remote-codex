$ErrorActionPreference = 'Stop'
$userData = Join-Path $env:APPDATA 'remote-codex-agent'
$log = Join-Path $userData 'agent.log'
$quarantine = Join-Path $userData 'agent.log.oversized-20260812'
$startup = Get-CimInstance Win32_StartupCommand |
  Where-Object { $_.Name -match 'Remote Codex' -or $_.Command -match 'Remote Codex' } |
  Select-Object -First 1
if (-not $startup -or $startup.Command -notmatch '^"([^"]+\.exe)"') { throw '未找到 Remote Codex 启动程序' }
$exe = $matches[1]

Get-Process 'Remote Codex Agent' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $exe -and $_.CommandLine -notmatch 'worker\.js' } |
  Stop-Process -Force -ErrorAction SilentlyContinue
if (Test-Path $quarantine) { Remove-Item $quarantine -Force }
if (Test-Path $log) { Move-Item $log $quarantine -Force }

$process = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 20
$alive = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
$newLog = Get-Item $log -ErrorAction SilentlyContinue
[pscustomobject]@{
  Pid = $process.Id
  AliveAfter20Seconds = [bool]$alive
  NewLogBytes = if ($newLog) { $newLog.Length } else { 0 }
  QuarantinedLogBytes = (Get-Item $quarantine).Length
  QuarantinePath = $quarantine
} | Format-List
