param([switch]$UpgradeOnly)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$launcher = Join-Path $PSScriptRoot 'launch.mjs'
$mode = if ($UpgradeOnly) { '--upgrade' } else { '--restart' }
$exitCode = 1
$securePassword = $null

# The credentials below live only in this process and are restored afterwards.
$savedEnvironment = @{}
foreach ($name in @('STUDIO_USERNAME', 'STUDIO_PASSWORD', 'STUDIO_SESSION_TOKEN')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
    # A computer without Node.js, the npm packages or a browser gets them here.
    $node = & (Join-Path $PSScriptRoot 'scripts\ensure-node.ps1')
    $env:PATH = "$(Split-Path -Parent $node);$env:PATH"
    & $node (Join-Path $PSScriptRoot 'scripts\prepare.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'QA Studio could not finish setting up this computer.' }

    & $node $launcher $mode --open
    $exitCode = $LASTEXITCODE

    # Exit code 3 means the running server needs an administrator sign-in first.
    if ($exitCode -eq 3) {
        Write-Host 'Sign in with your QA Studio administrator account to check activity and back up the workspace before restarting.'
        Write-Host 'These are the application credentials, not your Windows password.'
        Write-Host 'Enter the login below in this window. Leave the username blank to cancel.'
        $username = Read-Host 'QA Studio administrator username'
        if ([string]::IsNullOrWhiteSpace($username)) {
            Write-Host 'Restart cancelled. The running Studio server was not stopped.'
        } else {
            $securePassword = Read-Host 'QA Studio administrator password' -AsSecureString
            $credential = [System.Management.Automation.PSCredential]::new($username.Trim(), $securePassword)
            [Environment]::SetEnvironmentVariable('STUDIO_SESSION_TOKEN', $null, 'Process')
            [Environment]::SetEnvironmentVariable('STUDIO_USERNAME', $credential.UserName, 'Process')
            [Environment]::SetEnvironmentVariable('STUDIO_PASSWORD', $credential.GetNetworkCredential().Password, 'Process')
            & $node $launcher $mode --open
            $exitCode = $LASTEXITCODE
        }
    }
} catch {
    Write-Host $_.Exception.Message
    $exitCode = 1
} finally {
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
    $credential = $null
    if ($null -ne $securePassword) { $securePassword.Dispose() }
    $securePassword = $null
}

exit $exitCode
