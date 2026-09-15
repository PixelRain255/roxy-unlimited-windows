[CmdletBinding()]
param(
  [ValidateRange(1, 65535)][int] $Port = 50000,
  [string] $DataDir,
  [string] $InstallDir,
  [ValidateRange(1, 65535)][int] $AppPort = 45535,
  [string] $Locale,
  [string] $ApiKey,
  [switch] $HeadlessDefault,
  [switch] $WorkbenchDefault,
  [switch] $FullPaths,
  [switch] $NoBrowser,
  [switch] $Background
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ApiScript = Join-Path $Here 'roxy-api.mjs'
$ApiUrl = "http://127.0.0.1:$Port"
$EffectiveApiKey = $ApiKey; if (-not $EffectiveApiKey) { $EffectiveApiKey = $env:ROXY_API_KEY }

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Error '找不到 Node.js。请安装 Node.js 22 或更高版本后重试。'
  exit 1
}
if (-not (Test-Path -LiteralPath $ApiScript)) {
  Write-Error "找不到 API 脚本：$ApiScript"
  exit 1
}

try { $nodeVersion = (& $nodeCommand.Source -p "process.versions.node").Trim() } catch { $nodeVersion = '' }
$nodeMajor = 0
if ($nodeVersion -match '^\d+') { $nodeMajor = [int]$Matches[0] }
if ($nodeMajor -lt 22) {
  Write-Host "[webui] 当前 Node.js 版本为 $nodeVersion，必须使用 Node.js 22 或更高版本。请升级 Node.js 后重新运行 start-webui.bat。" -ForegroundColor Red
  exit 2
}
function Test-Health {
  try {
    $health = Invoke-RestMethod -Uri "$ApiUrl/health" -TimeoutSec 2
    return $health.code -eq 0
  } catch { return $false }
}

function Test-WebUi {
  try {
    $meta = Invoke-RestMethod -Uri "$ApiUrl/meta/info" -TimeoutSec 2
    if ($meta.code -ne 0 -or -not $meta.data.nodeMajor -or [int]$meta.data.nodeMajor -lt 22 -or -not $meta.data.webUiVersion -or [int]$meta.data.webUiVersion -lt 4) { return $false }
    if ([bool]$EffectiveApiKey -ne [bool]$meta.data.apiKeyRequired) { return $false }
    $entry = Invoke-RestMethod -Uri "$ApiUrl/proxy/entry" -TimeoutSec 2
    if ($entry.code -ne 0) { return $false }
    $page = Invoke-WebRequest -Uri "$ApiUrl/" -UseBasicParsing -TimeoutSec 2
    return $page.Content -match 'ROXY LOCAL CONTROL'
  } catch { return $false }
}

# 旧版 API 也有 /health，只有 WebUI 专属接口和页面都正常才复用。
$alreadyRunning = Test-WebUi
if ($alreadyRunning) {
  Write-Host "[webui] 已复用运行中的 WebUI API：$ApiUrl" -ForegroundColor Cyan
} else {
  if (Test-Health) {
    # 仅在确认占用者是本仓库的 roxy-api.mjs 时自动重启，避免影响其它本机服务。
    $scriptName = [IO.Path]::GetFileName($ApiScript)
    $oldApi = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
      $_.CommandLine -match [regex]::Escape($scriptName) -and $_.CommandLine -match "--port\s+$Port(\s|$)"
    })
    if ($oldApi.Count) {
      Write-Host "[webui] 发现旧版本仓库 API，正在重启以加载 WebUI..." -ForegroundColor Yellow
      foreach ($item in $oldApi) { Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Milliseconds 500
    } else {
      Write-Error "端口 $Port 已被其它服务占用，无法启动 WebUI。请换用 -Port 或先关闭该服务。"
      exit 2
    }
  }

  $nodeArgs = @([char]34 + $ApiScript + [char]34, '--port', "$Port", '--app-port', "$AppPort")
  if ($DataDir) { $nodeArgs += @('--data-dir', [char]34 + $DataDir + [char]34) }
  if ($InstallDir) { $nodeArgs += @('--install-dir', [char]34 + $InstallDir + [char]34) }
  if ($Locale) { $nodeArgs += @('--locale', $Locale) }
  if ($EffectiveApiKey) { $nodeArgs += @('--api-key', $EffectiveApiKey) }
  if ($HeadlessDefault) { $nodeArgs += '--headless-default' }
  if ($WorkbenchDefault) { $nodeArgs += '--workbench-default' }
  if ($FullPaths) { $nodeArgs += '--full-paths' }

  $windowStyle = if ($Background) { 'Hidden' } else { 'Normal' }
  try {
    $process = Start-Process -FilePath $nodeCommand.Source -ArgumentList $nodeArgs -WorkingDirectory $Here -WindowStyle $windowStyle -PassThru
  } catch {
    Write-Error "启动 Node API 失败：$($_.Exception.Message)"
    exit 1
  }
  Write-Host "[webui] 正在启动 API，PID=$($process.Id)" -ForegroundColor DarkGray

  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-WebUi) { $ready = $true; break }
  }
  if (-not $ready) {
    try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch { }
    Write-Error "WebUI API 在 15 秒内没有就绪：$ApiUrl"
    exit 1
  }
}

Write-Host "[webui] 已就绪：$ApiUrl/" -ForegroundColor Green
if (-not $NoBrowser) {
  $browserUrl = if ($EffectiveApiKey) { "$ApiUrl/?apiKey=$([uri]::EscapeDataString($EffectiveApiKey))" } else { "$ApiUrl/" }
  Start-Process $browserUrl
}
