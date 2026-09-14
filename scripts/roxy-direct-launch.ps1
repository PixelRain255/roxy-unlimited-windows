# ============================================================
#  RoxyBrowser - Direct Core Launcher (launcher bypass)
#
#  Starts Roxy's patched Chromium directly, mirroring the official
#  genChromeLaunchCLIArgs() recipe, so a direct window behaves like
#  an official one (fingerprint + proxy from lumi.conf, extensions,
#  workbench tab, window layout) WITHOUT the server account quota.
#
#  Examples:
#    pwsh -File roxy-direct-launch.ps1 -DryRun
#    pwsh -File roxy-direct-launch.ps1 -DirId <DIR_ID> -Headless
#    pwsh -File roxy-direct-launch.ps1 -Workbench -WindowSize 1600,900
#    pwsh -File roxy-direct-launch.ps1 -Extensions "C:\ext\a","C:\ext\b"
# ============================================================
[CmdletBinding()]
param(
  [string[]] $DirId,
  [int]      $Limit = 0,               # 0 = launch every resolved profile
  [int]      $DebugPortBase = 9300,
  [string]   $StartUrl = 'about:blank',
  [switch]   $Headless,
  [switch]   $Workbench,               # open the local 工作台 tab, like the official launcher
  [int]      $AppPort = 45535,
  [string[]] $Extensions,              # paths -> --load-extension=a,b,c
  [string]   $WindowSize,              # "1600,900"
  [string]   $WindowPosition,          # "0,0"
  [switch]   $Maximized,
  [switch]   $NoGpu,
  [string[]] $ExtraArgs,               # raw passthrough (official startupParam equivalent)
  [switch]   $DryRun
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---- 路径自动发现：复用 Node 解析器，不重复实现 ----
$P = (node "$Here\paths-cli.mjs" --json) | ConvertFrom-Json
if (-not $P.ok) {
  node "$Here\paths-cli.mjs"
  throw "环境不满足，无法启动（可用 --data-dir 或 ROXY_HOME 指定数据目录）"
}
$CacheDir = $P.browserCacheDir
$BinDir   = $P.coreBinDir

function Get-CoreExe { return $P.coreExe }

# ---- base args: mirrors gp[] from browser-manager/constants.ts ----
$BaseArgs = @(
  '--disable-background-mode'
  '--disable-popup-blocking'
  '--no-first-run'
  '--no-default-browser-check'
  '--use-mock-keychain'
  '--no-sandbox'
  '--disable-setuid-sandbox'
  '--password-store=basic'
  '--disable-backgrounding-occluded-windows'
)

$exe = Get-CoreExe
Write-Host "[core] $exe" -ForegroundColor Cyan

# ---- resolve profiles ----
$profiles =
  if ($DirId) { $DirId | ForEach-Object { [pscustomobject]@{ Id = $_; Path = (Join-Path $CacheDir $_) } } }
  else {
    Get-ChildItem $CacheDir -Directory |
      Where-Object { Test-Path (Join-Path $_.FullName 'lumi.conf') } |
      ForEach-Object { [pscustomobject]@{ Id = $_.Name; Path = $_.FullName } }
  }
$profiles = @($profiles | Where-Object { Test-Path $_.Path })
if (-not $profiles) { throw "no profiles resolved (looked in $CacheDir)" }
if ($Limit -gt 0 -and $profiles.Count -gt $Limit) { $profiles = $profiles[0..($Limit - 1)] }

$extPaths = @()
if ($Extensions) { $extPaths = $Extensions | Where-Object { Test-Path $_ } }

Write-Host "[plan] launching $($profiles.Count) instance(s)$(if($extPaths.Count){" with $($extPaths.Count) extension(s)"})" -ForegroundColor Cyan

# ---- launch ----
$i = 0
foreach ($p in $profiles) {
  $a = [System.Collections.Generic.List[string]]::new()
  $a.AddRange([string[]]$BaseArgs)
  $a.Add("--user-data-dir=$($p.Path)")
  $a.Add("--remote-debugging-port=$($DebugPortBase + $i)")

  if ($Workbench) {
    $a.Add("http://127.0.0.1:$AppPort/dashboard.html?id=$($p.Id)&workspaceType=0")
  }
  if ($extPaths.Count) { $a.Add("--load-extension=$($extPaths -join ',')") }
  if ($ExtraArgs)      { $a.AddRange([string[]]$ExtraArgs) }

  if ($Maximized) { $a.Add('--start-maximized') }
  elseif ($WindowSize) {
    $a.Add("--window-size=$WindowSize")
    if ($WindowPosition) { $a.Add("--window-position=$WindowPosition") }
  }
  if ($NoGpu) { $a.Add('--disable-gpu') }
  if ($Headless) { $a.Add('--headless=new') }
  $a.Add($StartUrl)

  Write-Host ("[{0}] {1}  ->  debug port {2}" -f $i, $p.Id, ($DebugPortBase + $i)) -ForegroundColor Green
  if ($DryRun) {
    Write-Host ("      {0} {1}" -f $exe, ($a -join ' ')) -ForegroundColor DarkGray
  } else {
    Start-Process -FilePath $exe -ArgumentList $a -WorkingDirectory (Split-Path $exe -Parent) | Out-Null
    Start-Sleep -Milliseconds 400
  }
  $i++
}

if ($DryRun) { Write-Host "[dry-run] nothing was started" -ForegroundColor Yellow }
else { Write-Host "[done] $i core process(es) started" -ForegroundColor Cyan }
