param(
    [Parameter(Mandatory = $true)][string]$BridgePath,
    [Parameter(Mandatory = $true)][string]$HarnessUrl,
    [Parameter(Mandatory = $true)][string]$CredentialFile,
    [string]$CodexHome = '',
    [switch]$ApproveConfigMutation,
    [switch]$ApproveDisableConflictingPlugin,
    [string]$TransactionFile,
    [string]$RollbackTransaction
)
$ErrorActionPreference = 'Stop'


function Resolve-CodexHome([string]$ExplicitHome) {
    if ($ExplicitHome) {
        return [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($ExplicitHome))
    }
    if ($env:CODEX_HOME) {
        return [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($env:CODEX_HOME))
    }
    $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if (-not $userProfile) { $userProfile = $env:USERPROFILE }
    if ($userProfile) { return [IO.Path]::GetFullPath((Join-Path $userProfile '.codex')) }
    if ($HOME) { return [IO.Path]::GetFullPath((Join-Path $HOME '.codex')) }
    throw 'Cannot resolve Codex home. Pass -CodexHome or set CODEX_HOME explicitly.'
}

$script:CodexCliLastExitCode = $null
function Invoke-CodexWithHome([string]$CommandPath, [string]$ResolvedHome, [string[]]$Arguments) {
    $hadCodexHome = Test-Path Env:CODEX_HOME
    $previousCodexHome = $env:CODEX_HOME
    try {
        $env:CODEX_HOME = $ResolvedHome
        & $CommandPath @Arguments
        $script:CodexCliLastExitCode = $LASTEXITCODE
    } finally {
        if ($hadCodexHome) { $env:CODEX_HOME = $previousCodexHome }
        else { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue }
    }
}


function Ensure-McpToolTimeout([string]$ConfigFile, [string]$ServerName, [double]$MinimumSeconds) {
    if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) { throw 'Codex config missing after MCP registration.' }
    $text = [System.IO.File]::ReadAllText($ConfigFile)
    $escaped = [regex]::Escape($ServerName)
    $pattern = "(?ms)(^\[mcp_servers\.(?:`"$escaped`"|$escaped)\]\r?\n)(.*?)(?=^\[|\z)"
    $match = [regex]::Match($text, $pattern)
    if (-not $match.Success) { throw "Cannot locate MCP server section for $ServerName after registration." }
    $body = $match.Groups[2].Value
    $timeoutPattern = '(?m)^[ \t]*tool_timeout_sec[ \t]*=[ \t]*([0-9]+(?:\.[0-9]+)?)[ \t]*$'
    $timeoutMatch = [regex]::Match($body, $timeoutPattern)
    if ($timeoutMatch.Success) {
        $current = [double]::Parse($timeoutMatch.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
        if ($current -ge $MinimumSeconds) { return $current }
        $replacement = 'tool_timeout_sec = ' + $MinimumSeconds.ToString([Globalization.CultureInfo]::InvariantCulture)
        $body = [regex]::Replace($body, $timeoutPattern, $replacement, 1)
    } else {
        if ($body.Length -gt 0 -and -not $body.EndsWith("`n")) { $body += "`r`n" }
        $body += 'tool_timeout_sec = ' + $MinimumSeconds.ToString([Globalization.CultureInfo]::InvariantCulture) + "`r`n"
    }
    $newSection = $match.Groups[1].Value + $body
    $updated = $text.Substring(0, $match.Index) + $newSection + $text.Substring($match.Index + $match.Length)
    [System.IO.File]::WriteAllText($ConfigFile, $updated, [System.Text.UTF8Encoding]::new($false))
    return $MinimumSeconds
}

function Restore-Transaction([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Rollback transaction not found: $Path" }
    $tx = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $configFile = [string]$tx.configFile
    if ([bool]$tx.hadConfig) {
        if (-not (Test-Path -LiteralPath ([string]$tx.backupFile) -PathType Leaf)) { throw 'Rollback backup is missing.' }
        Copy-Item -LiteralPath ([string]$tx.backupFile) -Destination $configFile -Force
    } elseif (Test-Path -LiteralPath $configFile) {
        Remove-Item -LiteralPath $configFile -Force
    }
    Write-Output ([ordered]@{ status='ROLLED_BACK'; configFile=$configFile; transaction=$Path } | ConvertTo-Json -Compress)
}

if ($RollbackTransaction) {
    Restore-Transaction $RollbackTransaction
    return
}
if (-not $ApproveConfigMutation) {
    throw 'CONFIG_MUTATION_APPROVAL_REQUIRED: pass -ApproveConfigMutation only after the config change is authorized.'
}

$resolvedBridge = (Resolve-Path -LiteralPath $BridgePath).Path
$bridgeEntry = Join-Path $resolvedBridge 'dist\bin.mjs'
if (-not (Test-Path -LiteralPath $bridgeEntry -PathType Leaf)) { throw 'Bridge entry is missing.' }
$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$codexCommand = (Get-Command codex -ErrorAction Stop).Source
$nodeMajor = [int]((& $nodeCommand --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw 'Bridge requires Node.js >=22.' }

$targetUrl = [Uri]$HarnessUrl
if ($targetUrl.Scheme -ne 'http' -or $targetUrl.Host -notin @('localhost','127.0.0.1','[::1]') -or
    $targetUrl.UserInfo -or $targetUrl.Query -or $targetUrl.Fragment -or $targetUrl.AbsolutePath -ne '/') {
    throw 'HarnessUrl must be a clean local loopback HTTP origin.'
}
if (-not (Test-Path -LiteralPath $CredentialFile -PathType Leaf)) { throw 'AUTH_REQUIRED: Harness credential file not found.' }
$credentialResolved = (Resolve-Path -LiteralPath $CredentialFile).Path

$codexDirectory = Resolve-CodexHome $CodexHome
New-Item -ItemType Directory -Path $codexDirectory -Force | Out-Null
$configFile = Join-Path $codexDirectory 'config.toml'
$hadConfig = Test-Path -LiteralPath $configFile -PathType Leaf
$configTextBefore = if ($hadConfig) { [System.IO.File]::ReadAllText($configFile) } else { '' }
$pluginPattern = '(?ms)(^\[plugins\."deepseek-harness@deepseek-harness-for-codex"\]\r?\n)(.*?)(?=^\[|\z)'
$pluginMatch = [regex]::Match($configTextBefore, $pluginPattern)
$pluginEnabled = $pluginMatch.Success -and ($pluginMatch.Groups[2].Value -match '(?m)^enabled[ \t]*=[ \t]*true[ \t]*$')
if ($pluginEnabled -and -not $ApproveDisableConflictingPlugin) {
    throw 'CONFLICT_APPROVAL_REQUIRED: the upstream deepseek-harness plugin is enabled. Re-run with -ApproveDisableConflictingPlugin or keep the upstream plugin and do not register the local adapter.'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
$backupFile = Join-Path $codexDirectory ("config.toharness-$stamp.bak")
if ($hadConfig) { Copy-Item -LiteralPath $configFile -Destination $backupFile -Force }
if (-not $TransactionFile) { $TransactionFile = Join-Path $codexDirectory ("toharness-config-transaction-$stamp.json") }

$tx = [ordered]@{
    schemaVersion = 1
    createdAt = (Get-Date).ToString('o')
    configFile = $configFile
    hadConfig = $hadConfig
    backupFile = $(if ($hadConfig) { $backupFile } else { $null })
    harnessUrl = $targetUrl.GetLeftPart([System.UriPartial]::Authority)
    bridgeEntry = $bridgeEntry
    requiredToolTimeoutSec = 3700
}
$tx | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $TransactionFile -Encoding UTF8

try {
    # Replace only the named MCP registration. The config backup is the rollback source.
    Invoke-CodexWithHome -CommandPath $codexCommand -ResolvedHome $codexDirectory -Arguments @('mcp','get','deepseek-harness','--json') *> $null
    if ($script:CodexCliLastExitCode -eq 0) {
        Invoke-CodexWithHome -CommandPath $codexCommand -ResolvedHome $codexDirectory -Arguments @('mcp','remove','deepseek-harness') *> $null
        if ($script:CodexCliLastExitCode -ne 0) { throw 'Failed to remove the previous deepseek-harness MCP registration before replacement.' }
    }

    $addArgs = @(
        'mcp','add','deepseek-harness',
        '--env', ('DSH_MCP_EXISTING_URL=' + $targetUrl.GetLeftPart([System.UriPartial]::Authority)),
        '--env', ('DSH_MCP_EXISTING_CREDENTIAL_FILE=' + $credentialResolved),
        '--', $nodeCommand, $bridgeEntry
    )
    Invoke-CodexWithHome -CommandPath $codexCommand -ResolvedHome $codexDirectory -Arguments $addArgs
    if ($script:CodexCliLastExitCode -ne 0) { throw 'MCP registration failed.' }

    # Codex defaults MCP tool_timeout_sec to 60 seconds. The local Bridge may long-wait
    # for up to 3600 seconds, so keep the host deadline above that window. Otherwise the
    # host can re-enter the model while Harness is still running and recreate wait loops.
    $effectiveToolTimeout = Ensure-McpToolTimeout -ConfigFile $configFile -ServerName 'deepseek-harness' -MinimumSeconds 3700

    if ($pluginEnabled -and $ApproveDisableConflictingPlugin) {
        $configText = [System.IO.File]::ReadAllText($configFile)
        $configText = [regex]::Replace($configText, $pluginPattern, {
            param($match)
            $match.Groups[1].Value + [regex]::Replace($match.Groups[2].Value, '(?m)^enabled[ \t]*=[ \t]*true[ \t]*\r?$', 'enabled = false')
        })
        [System.IO.File]::WriteAllText($configFile, $configText, [System.Text.UTF8Encoding]::new($false))
    }

    Write-Output ([ordered]@{
        status='CONFIGURED'
        harnessUrl=$targetUrl.GetLeftPart([System.UriPartial]::Authority)
        bridgeEntry=$bridgeEntry
        transaction=$TransactionFile
        codexHome=$codexDirectory
        toolTimeoutSec=$effectiveToolTimeout
        restartRequired=$true
    } | ConvertTo-Json -Compress)
} catch {
    try { Restore-Transaction $TransactionFile | Out-Null } catch {}
    throw
}
