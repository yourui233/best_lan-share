# Build lan-share.exe: a single-file, no-install Windows executable.
#
#   powershell -ExecutionPolicy Bypass -File tools\build-exe.ps1
#
# It copies the running node.exe, injects share-server.js as a Node SEA blob,
# and writes dist\best_lan-share-<version>-win-x64.exe.
#
# Requirements: Node.js >= 20 (SEA is used), and network access once so
# `npx postject` can fetch the injector (build-time only; the exe itself has
# no dependencies). Keep this file ASCII-only: Windows PowerShell reads .ps1
# with the ANSI code page, and non-ASCII here breaks parsing.

param(
  [string]$OutDir = 'dist',
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

# Windows PowerShell 5.1 turns a native command's stderr into error records, which must not
# abort the build (node and postject both write progress to stderr). Real failures are
# detected through $LASTEXITCODE instead.
# NOTE: never name the second parameter $Args - that is a PowerShell automatic variable and
# it silently swallows the arguments (node then runs with no arguments at all).
function Invoke-Native([string]$Exe, [string[]]$CmdArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Exe @CmdArgs } finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { throw "$Exe exited with code $LASTEXITCODE" }
}

# PowerShell's Remove-Item and even Copy-Item can fail on files in this environment
# ("Access is denied" / "Could not find file" on a name node can write fine), so the
# cleanup and the base-node copy both go through node.
$rmViaNode = @('-e', "try{require('fs').unlinkSync(process.argv[1])}catch(e){if(e.code!=='ENOENT')console.error(e.code)}")
$cpViaNode = @('-e', "require('fs').copyFileSync(process.argv[1], process.argv[2])")

try {
  if (-not $Version) {
    $pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
    $Version = $pkg.version
  }

  $node = (Get-Command node).Source
  Write-Host ("[build] node {0}" -f (& node --version).Trim())
  Write-Host "[build] source    : $root"
  Write-Host "[build] output dir: $OutDir"

  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  $blob = Join-Path $OutDir 'sea-prep.blob'
  $exe = Join-Path $OutDir "best_lan-share-$Version-win-x64.exe"
  $fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

  # 1. syntax check first - never ship a broken blob
  Invoke-Native 'node' @('--check', 'share-server.js')

  # 2. generate the SEA blob
  Write-Host '[build] generating SEA blob...'
  Invoke-Native 'node' @('--experimental-sea-config', 'sea-config.json')
  if (-not (Test-Path $blob)) { throw "blob not produced: $blob" }

  # 3. copy node.exe, drop its Authenticode signature, inject the blob.
  # Retried: security software may briefly hold a freshly written .exe, which makes the
  # injection fail with "Couldn't write executable". Each attempt starts from a clean copy.
  $ok = $false
  for ($attempt = 1; $attempt -le 5 -and -not $ok; $attempt++) {
    if ($attempt -gt 1) {
      Write-Host "[build] attempt $attempt after a short wait..."
      Start-Sleep -Seconds 8
    }
    if (Test-Path $exe) { Invoke-Native 'node' ($rmViaNode + @($exe)) }
    Invoke-Native 'node' ($cpViaNode + @($node, $exe))
    if ($attempt -eq 1) { Write-Host ("[build] base exe  : {0:N1} MB" -f ((Get-Item $exe).Length / 1MB)) }

    Invoke-Native 'node' @('tools\strip-signature.js', $exe)

    Write-Host '[build] injecting blob (npx postject)...'
    try {
      Invoke-Native 'npx' @('--yes', 'postject', $exe, 'NODE_SEA_BLOB', $blob, '--sentinel-fuse', $fuse)
      $ok = $true
    } catch {
      Write-Host ("[build] attempt {0} failed: {1}" -f $attempt, $_.Exception.Message)
    }
  }
  if (-not $ok) { throw 'postject could not write the executable (is security software holding it?)' }

  $info = Get-Item $exe
  $hash = (Get-FileHash $exe -Algorithm SHA256).Hash
  Write-Host ''
  Write-Host ("[build] OK     {0}" -f $exe)
  Write-Host ("[build] size   {0:N1} MB" -f ($info.Length / 1MB))
  Write-Host ("[build] sha256 {0}" -f $hash)
  exit 0
} catch {
  Write-Host ''
  Write-Host ("[build] FAILED: {0}" -f $_.Exception.Message)
  exit 1
}
