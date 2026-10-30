# Installs the Copilotz computer program on Windows, and connects this machine to an app. In
# PowerShell (Windows PowerShell 5.1 or PowerShell 7):
#
#   & ([scriptblock]::Create((irm https://app.example.com/computer/download/install.ps1))) https://app.example.com -Code K7Q-4MZ
#
# (-Folder <name>: the folder its spaces go in, under ~\Copilotz, as the app's command says.)
#
# It downloads the binary from the app's /computer/download/ (or -From <base>, where the release
# is), checks its SHA-256 against the release's manifest, puts it in %LOCALAPPDATA%\Copilotz\bin
# (and that on your PATH), then runs `computer install <app> --code <code>`: connected, the
# computer runs in the background, and starts when you log in. `computer uninstall` stops that.
# Run it again to update.
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$App,
  [Parameter(Mandatory = $true)][string]$Code,
  [string]$From,
  [string]$Folder
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 may not offer TLS 1.2 unless asked.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor
  [Net.SecurityProtocolType]::Tls12

# The app's own release is on its origin.
$base = if ($From) { $From } else { ([Uri]$App).GetLeftPart('Authority') + '/computer/download/' }
if (-not $base.EndsWith('/')) { $base += '/' }
# x64, which Windows on Arm runs too.
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne 'AMD64' -and $arch -ne 'ARM64') { throw "No build for $arch yet" }
$file = 'copilotz-computer-windows-x64.exe'

$manifest = Invoke-RestMethod -UseBasicParsing -Uri ($base + 'manifest.json')
# Served as text (or bytes, as releases serve files), it's still JSON.
if ($manifest -is [string]) { $manifest = $manifest | ConvertFrom-Json }
$binary = $manifest.binaries | Where-Object { $_.file -eq $file } | Select-Object -First 1
if (-not $binary) { throw "The release at $base has no $file" }

$dir = Join-Path $env:LOCALAPPDATA 'Copilotz\bin'
$exe = Join-Path $dir 'computer.exe'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Host "Copilotz computer $($manifest.version) for Windows (x64)"

$sha = { param($path) (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }
if ((Test-Path -LiteralPath $exe) -and ((& $sha $exe) -eq $binary.sha256)) {
  Write-Host '  already installed: %LOCALAPPDATA%\Copilotz\bin\computer.exe'
} else {
  Write-Host "  downloading $file..."
  $next = Join-Path $dir ".computer-$([guid]::NewGuid().ToString('N').Substring(0, 8)).exe"
  try {
    Invoke-WebRequest -UseBasicParsing -Uri ($base + $file) -OutFile $next
    if ((& $sha $next) -ne $binary.sha256) { throw "$file's SHA-256 isn't the release's: not installed" }
    Write-Host "  checked: its SHA-256 is the release's"
    # A running computer.exe can't be replaced, but it can be renamed aside (it removes those).
    if (Test-Path -LiteralPath $exe) {
      Rename-Item -LiteralPath $exe -NewName "computer.exe.old-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    }
    Rename-Item -LiteralPath $next -NewName 'computer.exe'
  } finally {
    if (Test-Path -LiteralPath $next) { Remove-Item -LiteralPath $next -Force }
  }
  Write-Host '  installed: %LOCALAPPDATA%\Copilotz\bin\computer.exe'
}

$userPath = "$([Environment]::GetEnvironmentVariable('Path', 'User'))"
if (-not (($userPath -split ';') -contains $dir)) {
  $parts = @($userPath.TrimEnd(';'), $dir) | Where-Object { $_ }
  [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
  Write-Host '  added it to your PATH: new terminals have `computer`'
}
$env:Path = "$dir;$env:Path"

Write-Host ''
if ($Folder) { & $exe install $App --code $Code --folder $Folder } else { & $exe install $App --code $Code }
if ($LASTEXITCODE) { Write-Error "The computer program couldn't connect (exit code $LASTEXITCODE)" }
