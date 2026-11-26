# Prints the path of a Node.js 22 or newer for QA Studio. When the computer has none, downloads
# the current Node.js 24 release into .runtime\node, checks its SHA-256 and uses that copy.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$minimumMajor = 22
$release = 'latest-v24.x'
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root '.runtime'
$privateNode = Join-Path $runtime 'node\node.exe'

function Test-Node([string]$path) {
    try {
        $version = & $path --version 2>$null
        return ($version -match '^v(\d+)\.') -and ([int]$Matches[1] -ge $minimumMajor)
    } catch {
        return $false
    }
}

$systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($systemNode -and (Test-Node $systemNode.Source)) { return $systemNode.Source }
if ((Test-Path -LiteralPath $privateNode) -and (Test-Node $privateNode)) { return $privateNode }

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$base = "https://nodejs.org/dist/$release"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

Write-Host "Node.js $minimumMajor or newer is not installed. Downloading a private copy for QA Studio..."
$sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content -split "`n"
$line = $sums | ForEach-Object { $_.Trim() } | Where-Object { $_ -match "^([0-9a-f]{64})\s+(node-v[\d.]+-win-$arch\.zip)$" } | Select-Object -First 1
if (-not $line) { throw "No Node.js download for Windows $arch was found at $base." }
$null = $line -match "^([0-9a-f]{64})\s+(\S+)$"
$expectedHash = $Matches[1]
$zipName = $Matches[2]

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$zip = Join-Path $runtime $zipName
$unpacked = Join-Path $runtime 'unpack'
try {
    Invoke-WebRequest -UseBasicParsing "$base/$zipName" -OutFile $zip
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -ne $expectedHash) {
        throw 'The downloaded Node.js file does not match its published checksum.'
    }
    if (Test-Path -LiteralPath $unpacked) { Remove-Item -Recurse -Force -LiteralPath $unpacked }
    New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
    # tar.exe ships with Windows 10 and 11 and unpacks far faster than Expand-Archive.
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path -LiteralPath $tar) {
        & $tar -xf $zip -C $unpacked
        if ($LASTEXITCODE -ne 0) { throw 'The Node.js download could not be unpacked.' }
    } else {
        Expand-Archive -LiteralPath $zip -DestinationPath $unpacked
    }
    $target = Join-Path $runtime 'node'
    if (Test-Path -LiteralPath $target) { Remove-Item -Recurse -Force -LiteralPath $target }
    Move-Item -LiteralPath (Join-Path $unpacked ([IO.Path]::GetFileNameWithoutExtension($zipName))) -Destination $target
} finally {
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $zip
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $unpacked
}

if (-not (Test-Node $privateNode)) { throw 'The downloaded Node.js does not start.' }
Write-Host "Node.js is ready in $(Split-Path -Parent $privateNode)."
return $privateNode
