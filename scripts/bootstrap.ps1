param(
    [string]$Workspace = (Get-Location).Path,
    [string]$HarnessUrl = '',
    [string]$CredentialFile = '',
    [string]$RuntimeDirectory,
    [string]$ManagedHarnessHome,
    [string]$CodexHome = '',
    [switch]$CheckOnly,
    [switch]$ApproveSystemInstall,
    [switch]$ApproveNetworkInstall,
    [switch]$ApproveConfigMutation,
    [switch]$ApproveDisableConflictingPlugin
)
$ErrorActionPreference = 'Stop'


function Resolve-CodexHome([string]$ExplicitHome) {
    if ($ExplicitHome) {
        return [pscustomobject]@{ Path = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($ExplicitHome)); Source = 'PARAMETER' }
    }
    if ($env:CODEX_HOME) {
        return [pscustomobject]@{ Path = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($env:CODEX_HOME)); Source = 'ENV_CODEX_HOME' }
    }

    # Windows bootstrap default: use the actual current-user profile, not the caller's HOME semantics.
    $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if (-not $userProfile) { $userProfile = $env:USERPROFILE }
    if ($userProfile) {
        return [pscustomobject]@{ Path = [IO.Path]::GetFullPath((Join-Path $userProfile '.codex')); Source = 'WINDOWS_USER_PROFILE_DEFAULT' }
    }
    if ($HOME) {
        return [pscustomobject]@{ Path = [IO.Path]::GetFullPath((Join-Path $HOME '.codex')); Source = 'HOME_DEFAULT' }
    }
    throw 'BRIDGE_BLOCKED: cannot resolve Codex home. Pass -CodexHome or set CODEX_HOME explicitly.'
}

$script:CodexCliLastExitCode = $null
function Invoke-CodexWithHome([string]$CommandPath, [string]$ResolvedHome, [string[]]$Arguments) {
    $hadCodexHome = Test-Path Env:CODEX_HOME
    $previousCodexHome = $env:CODEX_HOME
    try {
        # Process-local only: make Codex CLI inspect the same home that this bootstrap resolved.
        $env:CODEX_HOME = $ResolvedHome
        & $CommandPath @Arguments
        $script:CodexCliLastExitCode = $LASTEXITCODE
    } finally {
        if ($hadCodexHome) { $env:CODEX_HOME = $previousCodexHome }
        else { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue }
    }
}


function Get-McpToolTimeout([string]$ConfigFile, [string]$ServerName) {
    if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) { return $null }
    $text = [System.IO.File]::ReadAllText($ConfigFile)
    $escaped = [regex]::Escape($ServerName)
    $pattern = "(?ms)(^\[mcp_servers\.(?:`"$escaped`"|$escaped)\]\r?\n)(.*?)(?=^\[|\z)"
    $match = [regex]::Match($text, $pattern)
    if (-not $match.Success) { return $null }
    $timeoutMatch = [regex]::Match($match.Groups[2].Value, '(?m)^[ \t]*tool_timeout_sec[ \t]*=[ \t]*([0-9]+(?:\.[0-9]+)?)[ \t]*$')
    if (-not $timeoutMatch.Success) { return $null }
    return [double]::Parse($timeoutMatch.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
}

function Get-BridgeAdapterVersion([string]$BridgeEntry) {
    if (-not $BridgeEntry) { return $null }
    try {
        $distDir = Split-Path -Parent $BridgeEntry
        $bridgeRoot = Split-Path -Parent $distDir
        $packageJson = Join-Path $bridgeRoot 'package.json'
        if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) { return $null }
        return [string]((Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json).version)
    } catch { return $null }
}

function Get-FreeLoopbackPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}
function Test-LocalService([string]$Url) {
    if (-not $Url) { return $false }
    try {
        $response = Invoke-WebRequest -Uri $Url -TimeoutSec 3
        return $response.StatusCode -eq 200
    } catch {
        try { return $_.Exception.Response.StatusCode.value__ -eq 401 } catch { return $false }
    }
}
function Assert-LoopbackOrigin([string]$Url) {
    $u = [Uri]$Url
    if ($u.Scheme -ne 'http' -or $u.Host -notin @('localhost','127.0.0.1','[::1]') -or
        $u.UserInfo -or $u.Query -or $u.Fragment -or $u.AbsolutePath -ne '/') {
        throw 'HarnessUrl must be a clean local loopback HTTP origin.'
    }
    return $u
}

$skillRoot = Split-Path -Parent $PSScriptRoot
$compatibilityPath = Join-Path $skillRoot 'references\compatibility.json'
if (-not (Test-Path -LiteralPath $compatibilityPath -PathType Leaf)) { throw 'Compatibility manifest missing.' }
$compatibility = Get-Content -LiteralPath $compatibilityPath -Raw | ConvertFrom-Json
$harnessPackage = [string]$compatibility.harness.defaultProvisionPackage
if (-not $harnessPackage) { throw 'Compatibility manifest has no defaultProvisionPackage.' }

$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
$codexHomeResolution = Resolve-CodexHome $CodexHome
$codexDirectory = [string]$codexHomeResolution.Path
$codexHomeSource = [string]$codexHomeResolution.Source
$codexConfigFile = Join-Path $codexDirectory 'config.toml'
if (-not $RuntimeDirectory) {
    $newRuntimeDirectory = Join-Path $codexDirectory 'runtimes\toharness-bridge'
    $legacyRuntimeDirectory = Join-Path $codexDirectory 'runtimes\model-router-bridge'
    $RuntimeDirectory = if (Test-Path -LiteralPath $legacyRuntimeDirectory) { $legacyRuntimeDirectory } else { $newRuntimeDirectory }
}
if (-not $ManagedHarnessHome) {
    $newManagedHarnessHome = Join-Path $codexDirectory 'runtimes\toharness-harness-home'
    $legacyManagedHarnessHome = Join-Path $codexDirectory 'runtimes\model-router-harness-home'
    $ManagedHarnessHome = if (Test-Path -LiteralPath $legacyManagedHarnessHome) { $legacyManagedHarnessHome } else { $newManagedHarnessHome }
}
$canonicalBundle = Join-Path $skillRoot 'vendor\deepseek-harness-for-codex'
$legacyBundle = Join-Path $skillRoot 'assets\bridge'
$bundle = if (Test-Path -LiteralPath (Join-Path $canonicalBundle 'VENDOR_MANIFEST.json')) { $canonicalBundle } else { $legacyBundle }
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeSupported = $false
if ($nodeCommand) { $nodeSupported = [int]((& $nodeCommand.Source --version).TrimStart('v').Split('.')[0]) -ge [int]$compatibility.bridge.nodeMinMajor }
$codexCommand = Get-Command codex -ErrorAction SilentlyContinue

# Discover current formal registration before using any defaults.
$currentRegistration = $null
if ($codexCommand) {
    try {
        $raw = Invoke-CodexWithHome -CommandPath $codexCommand.Source -ResolvedHome $codexDirectory -Arguments @('mcp','get','deepseek-harness','--json') 2>$null
        if ($script:CodexCliLastExitCode -eq 0 -and $raw) { $currentRegistration = ($raw | Out-String | ConvertFrom-Json) }
    } catch {}
}
if ($currentRegistration -and $currentRegistration.transport -and $currentRegistration.transport.env) {
    if (-not $HarnessUrl -and $currentRegistration.transport.env.DSH_MCP_EXISTING_URL) {
        $HarnessUrl = [string]$currentRegistration.transport.env.DSH_MCP_EXISTING_URL
    }
    if (-not $CredentialFile -and $currentRegistration.transport.env.DSH_MCP_EXISTING_CREDENTIAL_FILE) {
        $CredentialFile = [string]$currentRegistration.transport.env.DSH_MCP_EXISTING_CREDENTIAL_FILE
    }
}
if (-not $HarnessUrl -and $env:DSH_MCP_EXISTING_URL) { $HarnessUrl = $env:DSH_MCP_EXISTING_URL }
if (-not $CredentialFile -and $env:DSH_MCP_EXISTING_CREDENTIAL_FILE) { $CredentialFile = $env:DSH_MCP_EXISTING_CREDENTIAL_FILE }

$targetUrl = $null
if ($HarnessUrl) { $targetUrl = Assert-LoopbackOrigin $HarnessUrl }
$serviceOnline = if ($targetUrl) { Test-LocalService $targetUrl.GetLeftPart([System.UriPartial]::Authority) } else { $false }
$credentialExists = $CredentialFile -and (Test-Path -LiteralPath $CredentialFile -PathType Leaf)
$bridgeBundled = (Test-Path -LiteralPath (Join-Path $bundle 'dist\bin.mjs')) -and (Test-Path -LiteralPath (Join-Path $bundle 'package.json'))
$vendorManifestPath = Join-Path $canonicalBundle 'VENDOR_MANIFEST.json'
$usingCanonicalVendoredRuntime = Test-Path -LiteralPath $vendorManifestPath
$registeredBridgeEntry = $null
if ($currentRegistration -and $currentRegistration.transport) {
    $candidateArgs = @($currentRegistration.transport.args)
    foreach ($arg in $candidateArgs) {
        if ($arg -and ([string]$arg -match 'bin\.mjs$') -and (Test-Path -LiteralPath ([string]$arg) -PathType Leaf)) {
            $registeredBridgeEntry = [string]$arg
            break
        }
    }
}
$bridgeReadyOnDisk = (Test-Path -LiteralPath (Join-Path $RuntimeDirectory 'dist\bin.mjs')) -or [bool]$registeredBridgeEntry
$registeredAdapterVersion = Get-BridgeAdapterVersion $registeredBridgeEntry
$expectedAdapterVersion = [string]$compatibility.bridge.adapterVersion
$bridgeAdapterCurrent = $registeredBridgeEntry -and $registeredAdapterVersion -eq $expectedAdapterVersion
$codexToolTimeoutSec = Get-McpToolTimeout -ConfigFile $codexConfigFile -ServerName 'deepseek-harness'
$requiredToolTimeoutSec = [double]$compatibility.bridge.recommendedCodexToolTimeoutSec
if (-not $requiredToolTimeoutSec) { $requiredToolTimeoutSec = 3700 }
$toolTimeoutReady = $codexToolTimeoutSec -and $codexToolTimeoutSec -ge $requiredToolTimeoutSec

$missing = @()
if (-not $nodeSupported) { $missing += 'NODE_22_PLUS' }
if (-not $codexCommand) { $missing += 'CODEX_CLI' }
if (-not $bridgeBundled) { $missing += 'BUNDLED_BRIDGE' }
if (-not $bridgeReadyOnDisk) { $missing += 'BRIDGE_RUNTIME' }
if ($currentRegistration -and -not $bridgeAdapterCurrent) { $missing += 'BRIDGE_ADAPTER_OUTDATED' }
if ($currentRegistration -and -not $toolTimeoutReady) { $missing += 'MCP_TOOL_TIMEOUT' }
if (-not $serviceOnline) { $missing += 'HARNESS_SERVICE' }
if ($serviceOnline -and -not $credentialExists) { $missing += 'HARNESS_AUTHENTICATION' }
if (-not $currentRegistration) { $missing += 'MCP_REGISTRATION' }

$requiredApprovals = @()
if (-not $nodeSupported) { $requiredApprovals += 'SYSTEM_INSTALL'; $requiredApprovals += 'NETWORK_INSTALL' }
if (-not $bridgeReadyOnDisk) { $requiredApprovals += 'NETWORK_INSTALL' }
if (-not $serviceOnline) { $requiredApprovals += 'NETWORK_INSTALL' }
if (-not $currentRegistration -or ($currentRegistration -and (-not $bridgeAdapterCurrent -or -not $toolTimeoutReady))) { $requiredApprovals += 'CONFIG_MUTATION' }
$requiredApprovals = @($requiredApprovals | Select-Object -Unique)

Write-Output ([ordered]@{
    stage='PRECHECK'
    workspace=$workspacePath
    bridgeAdapterVersion=[string]$compatibility.bridge.adapterVersion
    bundledBridgeSource=$bundle
    usingCanonicalVendoredRuntime=[bool]$usingCanonicalVendoredRuntime
    harnessProvisionPackage=$harnessPackage
    resolvedCodexHome=$codexDirectory
    codexHomeSource=$codexHomeSource
    discoveredHarnessUrl=$(if($targetUrl){$targetUrl.GetLeftPart([System.UriPartial]::Authority)}else{$null})
    currentRegistrationFound=[bool]$currentRegistration
    registeredBridgeAdapterVersion=$registeredAdapterVersion
    expectedBridgeAdapterVersion=$expectedAdapterVersion
    codexToolTimeoutSec=$codexToolTimeoutSec
    requiredCodexToolTimeoutSec=$requiredToolTimeoutSec
    recommendedAction=$(if($missing.Count -eq 0){'REUSE_EXISTING_CONFIGURATION'}else{'REVIEW_MISSING_ITEMS'})
    missing=$missing
    requiredApprovals=$requiredApprovals
} | ConvertTo-Json -Compress)
if ($CheckOnly) { return }

if (-not $codexCommand) { throw 'BRIDGE_BLOCKED: CODEX_CLI missing. Locate the current Codex app CLI; do not reinstall the user app blindly.' }
if (-not $bridgeBundled) { throw 'BRIDGE_BROKEN: bundled Bridge missing. Reinstall the complete Skill package.' }

if (-not $nodeSupported) {
    if (-not $ApproveSystemInstall -or -not $ApproveNetworkInstall) {
        throw 'BRIDGE_BLOCKED: Node >=22 missing. System + network installation requires -ApproveSystemInstall and -ApproveNetworkInstall.'
    }
    $wingetCommand = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $wingetCommand) { throw 'BRIDGE_BLOCKED: Node >=22 missing and winget unavailable. Use the platform official Node installer, then retry.' }
    & $wingetCommand.Source install --id OpenJS.NodeJS.LTS --exact
    if ($LASTEXITCODE -ne 0) { throw 'BRIDGE_BLOCKED: Node installation incomplete.' }
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        $candidate = Join-Path $env:ProgramFiles 'nodejs\node.exe'
        if (Test-Path -LiteralPath $candidate) { $env:PATH = (Split-Path -Parent $candidate) + [IO.Path]::PathSeparator + $env:PATH }
    }
    $nodeCommand = Get-Command node -ErrorAction Stop
    if ([int]((& $nodeCommand.Source --version).TrimStart('v').Split('.')[0]) -lt [int]$compatibility.bridge.nodeMinMajor) { throw 'BRIDGE_BLOCKED: required Node version still unavailable.' }
}
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source

# Prepare Bridge runtime. Prefer offline cache; network fallback requires explicit approval.
$createdRuntime = -not (Test-Path -LiteralPath $RuntimeDirectory)
New-Item -ItemType Directory -Path $RuntimeDirectory -Force | Out-Null
foreach ($bundleFile in @('package.json','package-lock.json','LICENSE','verify.mjs','PROVENANCE.md','VENDOR_MANIFEST.json','UPSTREAM_SOURCE_MANIFEST.json','UPSTREAM.md','PATCHSET.md','README.md')) {
    $sourceFile = Join-Path $bundle $bundleFile
    if (Test-Path -LiteralPath $sourceFile -PathType Leaf) { Copy-Item -LiteralPath $sourceFile -Destination $RuntimeDirectory -Force }
}
Copy-Item -LiteralPath (Join-Path $bundle 'dist') -Destination $RuntimeDirectory -Recurse -Force
Push-Location -LiteralPath $RuntimeDirectory
try {
    & $npmCommand ci --ignore-scripts --no-audit --no-fund --offline
    if ($LASTEXITCODE -ne 0) {
        if (-not $ApproveNetworkInstall) { throw 'NETWORK_INSTALL_APPROVAL_REQUIRED: Bridge dependencies are not fully cached.' }
        & $npmCommand ci --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'BRIDGE_BROKEN: Bridge runtime dependency installation failed.' }
    }
} finally { Pop-Location }

$createdHarnessRuntime = $false
$createdHarnessProcess = $null
$newHarnessRuntime = Join-Path $codexDirectory 'runtimes\toharness-harness'
$legacyHarnessRuntime = Join-Path $codexDirectory 'runtimes\model-router-harness'
$harnessRuntime = if (Test-Path -LiteralPath $legacyHarnessRuntime) { $legacyHarnessRuntime } else { $newHarnessRuntime }
try {
    if (-not $serviceOnline) {
        if (-not $ApproveNetworkInstall) { throw 'NETWORK_INSTALL_APPROVAL_REQUIRED: no existing Harness is ready; provisioning requires network approval.' }
        $expectedVersion = ($harnessPackage -replace '^@deepseek-ai/dsh@','')
        $installedPackageJson = Join-Path $harnessRuntime 'node_modules\@deepseek-ai\dsh\package.json'
        $installedCompatible = $false
        if (Test-Path -LiteralPath $installedPackageJson -PathType Leaf) {
            try { $installedCompatible = ((Get-Content -LiteralPath $installedPackageJson -Raw | ConvertFrom-Json).version -eq $expectedVersion) } catch {}
        }
        if (-not $installedCompatible) {
            $createdHarnessRuntime = -not (Test-Path -LiteralPath $harnessRuntime)
            & $npmCommand install --prefix $harnessRuntime --ignore-scripts --no-audit --no-fund $harnessPackage
            if ($LASTEXITCODE -ne 0) { throw 'BRIDGE_BLOCKED: compatible pinned Harness installation failed.' }
        }
        $harnessEntry = Join-Path $harnessRuntime 'node_modules\@deepseek-ai\dsh\lib\bin.js'
        if (-not (Test-Path -LiteralPath $harnessEntry)) { throw 'BRIDGE_BROKEN: installed Harness entry is missing.' }
        if (-not $targetUrl) {
            $port = Get-FreeLoopbackPort
            $HarnessUrl = "http://127.0.0.1:$port"
            $targetUrl = Assert-LoopbackOrigin $HarnessUrl
        }
        New-Item -ItemType Directory -Path $ManagedHarnessHome -Force | Out-Null
        if (-not $CredentialFile) { $CredentialFile = Join-Path $ManagedHarnessHome '.credentials.yaml' }
        $previousDshHome = $env:DSH_HOME
        try {
            $env:DSH_HOME = $ManagedHarnessHome
            $createdHarnessProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList @(('"' + $harnessEntry + '"'),'web','--port', $targetUrl.Port) `
                -WorkingDirectory $workspacePath -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput (Join-Path $harnessRuntime 'startup.stdout.log') `
                -RedirectStandardError (Join-Path $harnessRuntime 'startup.stderr.log')
        } finally { $env:DSH_HOME = $previousDshHome }
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            $serviceOnline = Test-LocalService $targetUrl.GetLeftPart([System.UriPartial]::Authority)
            if ($serviceOnline) { break }
            if ($createdHarnessProcess.HasExited) { throw 'BRIDGE_BROKEN: Harness exited before readiness; inspect local startup logs without exposing credentials.' }
            Start-Sleep -Seconds 2
        }
        if (-not $serviceOnline) { throw 'BRIDGE_BROKEN: HARNESS_START_TIMEOUT.' }
    }

    if (-not $CredentialFile -or -not (Test-Path -LiteralPath $CredentialFile -PathType Leaf)) {
        Write-Output ([ordered]@{
            status='BRIDGE_AUTH_REQUIRED'
            harnessUrl=$targetUrl.GetLeftPart([System.UriPartial]::Authority)
            credentialFile=$CredentialFile
            action='Complete current-device Harness authentication/model initialization, then rerun bootstrap.'
        } | ConvertTo-Json -Compress)
        return
    }

    $needsConfigUpdate = (-not $currentRegistration) -or (-not $bridgeAdapterCurrent) -or (-not $toolTimeoutReady)
    $transactionFile = $null
    if ($needsConfigUpdate) {
        if (-not $ApproveConfigMutation) { throw 'CONFIG_MUTATION_APPROVAL_REQUIRED: Bridge registration/host-wait policy update requires -ApproveConfigMutation.' }
        $transactionFile = Join-Path $codexDirectory ('toharness-config-transaction-' + (Get-Date -Format 'yyyyMMdd-HHmmssfff') + '.json')
        & (Join-Path $PSScriptRoot 'install-existing-bridge.ps1') `
            -BridgePath $RuntimeDirectory `
            -HarnessUrl $targetUrl.GetLeftPart([System.UriPartial]::Authority) `
            -CredentialFile $CredentialFile `
            -CodexHome $codexDirectory `
            -ApproveConfigMutation `
            -ApproveDisableConflictingPlugin:$ApproveDisableConflictingPlugin `
            -TransactionFile $transactionFile
        if ($LASTEXITCODE -ne 0) { throw 'BRIDGE_BROKEN: MCP registration failed.' }
    }

    $hadToharnessCodexCommand = Test-Path Env:TOHARNESS_CODEX_COMMAND
    $previousToharnessCodexCommand = $env:TOHARNESS_CODEX_COMMAND
    $hadToharnessCodexHome = Test-Path Env:TOHARNESS_CODEX_HOME
    $previousToharnessCodexHome = $env:TOHARNESS_CODEX_HOME
    $hadLegacyRouterCodexCommand = Test-Path Env:MODEL_ROUTER_CODEX_COMMAND
    $previousLegacyRouterCodexCommand = $env:MODEL_ROUTER_CODEX_COMMAND
    $hadLegacyRouterCodexHome = Test-Path Env:MODEL_ROUTER_CODEX_HOME
    $previousLegacyRouterCodexHome = $env:MODEL_ROUTER_CODEX_HOME
    try {
        $env:TOHARNESS_CODEX_COMMAND = $codexCommand.Source
        $env:TOHARNESS_CODEX_HOME = $codexDirectory
        # Legacy aliases are exported only for compatibility with an older verifier/runtime during in-place upgrades.
        $env:MODEL_ROUTER_CODEX_COMMAND = $codexCommand.Source
        $env:MODEL_ROUTER_CODEX_HOME = $codexDirectory
        & $nodeCommand.Source (Join-Path $RuntimeDirectory 'verify.mjs') $workspacePath
        $verifyExitCode = $LASTEXITCODE
    } finally {
        if ($hadToharnessCodexCommand) { $env:TOHARNESS_CODEX_COMMAND = $previousToharnessCodexCommand }
        else { Remove-Item Env:TOHARNESS_CODEX_COMMAND -ErrorAction SilentlyContinue }
        if ($hadToharnessCodexHome) { $env:TOHARNESS_CODEX_HOME = $previousToharnessCodexHome }
        else { Remove-Item Env:TOHARNESS_CODEX_HOME -ErrorAction SilentlyContinue }
        if ($hadLegacyRouterCodexCommand) { $env:MODEL_ROUTER_CODEX_COMMAND = $previousLegacyRouterCodexCommand }
        else { Remove-Item Env:MODEL_ROUTER_CODEX_COMMAND -ErrorAction SilentlyContinue }
        if ($hadLegacyRouterCodexHome) { $env:MODEL_ROUTER_CODEX_HOME = $previousLegacyRouterCodexHome }
        else { Remove-Item Env:MODEL_ROUTER_CODEX_HOME -ErrorAction SilentlyContinue }
    }
    if ($verifyExitCode -ne 0) {
        if ($transactionFile) {
            & (Join-Path $PSScriptRoot 'install-existing-bridge.ps1') -BridgePath $RuntimeDirectory -HarnessUrl $targetUrl.GetLeftPart([System.UriPartial]::Authority) -CredentialFile $CredentialFile -CodexHome $codexDirectory -RollbackTransaction $transactionFile
            throw 'BRIDGE_BROKEN: MCP verification failed; Codex config was rolled back.'
        }
        throw 'BRIDGE_BROKEN: MCP verification failed; no config mutation was performed.'
    }

    Write-Output ([ordered]@{
        status='PASS'
        bridgeState='BRIDGE_RESTART_REQUIRED'
        harnessUrl=$targetUrl.GetLeftPart([System.UriPartial]::Authority)
        workspace=$workspacePath
        harnessPackage=$harnessPackage
        transaction=$transactionFile
        note='Open a new Codex task to load native MCP tools.'
    } | ConvertTo-Json -Compress)
} catch {
    if ($createdHarnessProcess -and -not $createdHarnessProcess.HasExited) {
        try { Stop-Process -Id $createdHarnessProcess.Id -Force } catch {}
    }
    if ($createdHarnessRuntime -and (Test-Path -LiteralPath $harnessRuntime)) {
        try { Remove-Item -LiteralPath $harnessRuntime -Recurse -Force } catch {}
    }
    if ($createdRuntime -and (Test-Path -LiteralPath $RuntimeDirectory)) {
        try { Remove-Item -LiteralPath $RuntimeDirectory -Recurse -Force } catch {}
    }
    throw
}
