param(
    [Parameter(Mandatory=$true)][string]$Objective,
    [Parameter(Mandatory=$true)][string]$State,
    [Parameter(Mandatory=$true)][string]$Next,
    [string]$Validation = "Not recorded.",
    [string]$Blockers = "None.",
    [string]$Repos = "Not recorded.",
    [string]$AgentsCommand = "agents",
    [string]$UserHome = $HOME,
    [string]$CompatibilityRoot = "",
    [switch]$ClearCache
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-AgentsJson {
    param([Parameter(Mandatory=$true)][string[]]$Arguments)

    $global:LASTEXITCODE = 0
    $output = & $AgentsCommand @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "agents command failed ($LASTEXITCODE): agents $($Arguments -join ' ')"
    }
    $text = ($output | Out-String).Trim()
    if (-not $text) {
        throw "agents command returned no JSON: agents $($Arguments -join ' ')"
    }
    try {
        return $text | ConvertFrom-Json
    } catch {
        throw "agents command returned invalid JSON: agents $($Arguments -join ' ')"
    }
}

function Assert-PhysicalDirectoryChain {
    param(
        [Parameter(Mandatory=$true)][string]$Root,
        [Parameter(Mandatory=$true)][string]$Target
    )

    $rootPath = [System.IO.Path]::GetFullPath($Root)
    $targetPath = [System.IO.Path]::GetFullPath($Target)
    $relative = [System.IO.Path]::GetRelativePath($rootPath, $targetPath)
    if (
        [System.IO.Path]::IsPathRooted($relative) -or
        $relative -eq ".." -or
        $relative.StartsWith("..$([System.IO.Path]::DirectorySeparatorChar)") -or
        $relative.StartsWith("..$([System.IO.Path]::AltDirectorySeparatorChar)")
    ) {
        throw "Canonical write directory must remain under AGENTS_HOME: $targetPath"
    }

    $pathsToInspect = @($rootPath)
    $current = $rootPath
    foreach ($segment in ($relative -split '[\\/]')) {
        if (-not $segment -or $segment -eq ".") { continue }
        $current = Join-Path $current $segment
        $pathsToInspect += $current
    }
    foreach ($pathToInspect in $pathsToInspect) {
        $item = Get-Item -LiteralPath $pathToInspect -Force -ErrorAction SilentlyContinue
        if ($null -eq $item) { continue }
        if (-not $item.PSIsContainer) {
            throw "Canonical write directory chain contains a non-directory: $pathToInspect"
        }
        $isReparsePoint = (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
        $hasLinkType = (
            $item.PSObject.Properties.Name -contains "LinkType" -and
            -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)
        )
        $hasTarget = (
            $item.PSObject.Properties.Name -contains "Target" -and
            $null -ne $item.Target -and
            @($item.Target).Count -gt 0 -and
            -not [string]::IsNullOrWhiteSpace([string](@($item.Target) -join ""))
        )
        if ($isReparsePoint -or $hasLinkType -or $hasTarget) {
            throw "Canonical authority paths must be physical directories, not links or reparse points: $pathToInspect"
        }
    }
}

function Assert-PhysicalFileDestination {
    param([Parameter(Mandatory=$true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $parent = Split-Path -Parent $fullPath
    $anchor = [System.IO.Path]::GetPathRoot($parent)
    Assert-PhysicalDirectoryChain -Root $anchor -Target $parent

    $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return }
    $isReparsePoint = (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    $hasLinkType = (
        $item.PSObject.Properties.Name -contains "LinkType" -and
        -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)
    )
    $hasTarget = (
        $item.PSObject.Properties.Name -contains "Target" -and
        $null -ne $item.Target -and
        @($item.Target).Count -gt 0 -and
        -not [string]::IsNullOrWhiteSpace([string](@($item.Target) -join ""))
    )
    if ($item.PSIsContainer -or $isReparsePoint -or $hasLinkType -or $hasTarget) {
        throw "Projection destination must be a physical file, not a directory, link, or reparse point: $fullPath"
    }
}

function Resolve-AgentEnvironment {
    $global:LASTEXITCODE = 0
    $lines = & $AgentsCommand state env
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to resolve canonical Agent OS environment."
    }

    $values = @{}
    foreach ($line in $lines) {
        $text = [string]$line
        $separator = $text.IndexOf("=")
        if ($separator -le 0) { continue }
        $values[$text.Substring(0, $separator)] = $text.Substring($separator + 1)
    }

    if (-not $values.AGENTS_HOME) {
        throw "agents state env did not provide AGENTS_HOME."
    }
    $agentsHome = [System.IO.Path]::GetFullPath($values.AGENTS_HOME)
    $memoryRoot = if ($values.AGENTS_MEMORY) {
        [System.IO.Path]::GetFullPath($values.AGENTS_MEMORY)
    } else {
        [System.IO.Path]::GetFullPath((Join-Path $agentsHome "memory"))
    }

    $relative = [System.IO.Path]::GetRelativePath($agentsHome, $memoryRoot)
    if (
        [System.IO.Path]::IsPathRooted($relative) -or
        $relative -eq ".." -or
        $relative.StartsWith("..$([System.IO.Path]::DirectorySeparatorChar)") -or
        $relative.StartsWith("..$([System.IO.Path]::AltDirectorySeparatorChar)")
    ) {
        throw "Canonical memory root must remain under AGENTS_HOME: $memoryRoot"
    }
    if (-not (Test-Path -LiteralPath $agentsHome -PathType Container)) {
        throw "AGENTS_HOME does not exist: $agentsHome"
    }
    if (-not (Test-Path -LiteralPath $memoryRoot -PathType Container)) {
        throw "Canonical memory root does not exist: $memoryRoot"
    }

    Assert-PhysicalDirectoryChain -Root $agentsHome -Target $memoryRoot

    return [ordered]@{ AgentsHome = $agentsHome; MemoryRoot = $memoryRoot }
}

function Write-Utf8NoBom {
    param([Parameter(Mandatory=$true)][string]$Path, [Parameter(Mandatory=$true)][string]$Content)
    Assert-PhysicalFileDestination -Path $Path
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Assert-ProjectionBlockShape {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$Start,
        [Parameter(Mandatory=$true)][string]$End
    )

    Assert-PhysicalFileDestination -Path $Path
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $content = Get-Content -LiteralPath $Path -Raw
    $startCount = [regex]::Matches($content, [regex]::Escape($Start)).Count
    $endCount = [regex]::Matches($content, [regex]::Escape($End)).Count
    if ($startCount -ne $endCount -or $startCount -gt 1) {
        throw "Compatibility projection contains malformed or duplicate compact markers: $Path"
    }
    if ($startCount -eq 1) {
        $blockPattern = "(?s)" + [regex]::Escape($Start) + ".*?" + [regex]::Escape($End)
        if (-not [regex]::IsMatch($content, $blockPattern)) {
            throw "Compatibility projection contains out-of-order compact markers: $Path"
        }
    }
}

function Update-ProjectionBlock {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$Start,
        [Parameter(Mandatory=$true)][string]$End,
        [Parameter(Mandatory=$true)][string]$Section
    )

    Assert-ProjectionBlockShape -Path $Path -Start $Start -End $End
    Assert-PhysicalFileDestination -Path $Path
    $existing = if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path -Raw } else { "" }
    $pattern = "(?s)" + [regex]::Escape($Start) + ".*?" + [regex]::Escape($End)
    $updated = if ($existing -match $pattern) {
        [regex]::Replace($existing, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $Section })
    } elseif ($existing.Trim()) {
        $existing.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + $Section + [Environment]::NewLine
    } else {
        $Section + [Environment]::NewLine
    }
    Write-Utf8NoBom -Path $Path -Content $updated

    $written = Get-Content -LiteralPath $Path -Raw
    $writtenStartCount = [regex]::Matches($written, [regex]::Escape($Start)).Count
    $writtenEndCount = [regex]::Matches($written, [regex]::Escape($End)).Count
    if ($writtenStartCount -ne 1 -or $writtenEndCount -ne 1 -or -not $written.Contains($Section)) {
        throw "Compatibility projection failed structural read-back validation: $Path"
    }
}

function Assert-StateSyncSucceeded {
    param([Parameter(Mandatory=$true)]$Result)

    $propertyNames = @($Result.PSObject.Properties.Name)
    if (-not ($propertyNames -contains "pushed") -or $Result.pushed -ne $true) {
        throw "agents state sync did not confirm a successful push."
    }
    if (-not ($propertyNames -contains "restored") -or $null -eq $Result.restored) {
        throw "agents state sync did not return restore evidence."
    }
    if (-not ($propertyNames -contains "backup") -or $null -eq $Result.backup) {
        throw "agents state sync did not return backup evidence."
    }

    $restoreProperties = @($Result.restored.PSObject.Properties.Name)
    foreach ($required in @("bundles", "imported", "skipped", "projectionHash")) {
        if (-not ($restoreProperties -contains $required)) {
            throw "agents state sync restore evidence is missing $required."
        }
    }
    foreach ($count in @($Result.restored.bundles, $Result.restored.imported, $Result.restored.skipped)) {
        if ($count -isnot [ValueType] -or [int64]$count -lt 0) {
            throw "agents state sync restore evidence contains an invalid count."
        }
    }

    $backupProperties = @($Result.backup.PSObject.Properties.Name)
    foreach ($required in @("bundle", "payloadHash", "entries", "committed")) {
        if (-not ($backupProperties -contains $required)) {
            throw "agents state sync backup evidence is missing $required."
        }
    }
    if (
        [string]::IsNullOrWhiteSpace([string]$Result.backup.bundle) -or
        [string]$Result.backup.payloadHash -notmatch '^[a-fA-F0-9]{64}$' -or
        $Result.backup.entries -isnot [ValueType] -or
        [int64]$Result.backup.entries -lt 0 -or
        $Result.backup.committed -isnot [bool]
    ) {
        throw "agents state sync backup evidence is invalid."
    }
}

function Save-ProjectionState {
    param([Parameter(Mandatory=$true)][string]$Path)
    Assert-PhysicalFileDestination -Path $Path
    return [ordered]@{
        Path = $Path
        Existed = Test-Path -LiteralPath $Path
        Content = if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path -Raw } else { "" }
    }
}

function Restore-ProjectionState {
    param([Parameter(Mandatory=$true)]$Saved)
    Assert-PhysicalFileDestination -Path $Saved.Path
    if ($Saved.Existed) {
        Write-Utf8NoBom -Path $Saved.Path -Content $Saved.Content
    } elseif (Test-Path -LiteralPath $Saved.Path) {
        Remove-Item -LiteralPath $Saved.Path -Force
    }
}

$authority = Resolve-AgentEnvironment
$compactLockPath = Join-Path $authority.MemoryRoot ".compact.lock"
try {
    $compactLock = [System.IO.File]::Open(
        $compactLockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
} catch {
    throw "Another compaction operation owns the canonical memory lock: $compactLockPath"
}

try {
$resolvedCompatibilityRoot = $null
if ([string]::IsNullOrWhiteSpace($CompatibilityRoot)) {
    if ([string]::IsNullOrWhiteSpace($UserHome)) {
        throw "Unable to resolve a user home for compatibility projections."
    }
    $CompatibilityRoot = Join-Path (Join-Path $UserHome ".codex") "memories"
}
$resolvedCompatibilityRoot = [System.IO.Path]::GetFullPath($CompatibilityRoot)
$canonicalRootPath = [System.IO.Path]::GetFullPath($authority.MemoryRoot)
if ($resolvedCompatibilityRoot -eq $canonicalRootPath) {
    throw "Compatibility projection root must not equal canonical memory root."
}
$compatibilityAnchor = [System.IO.Path]::GetPathRoot($resolvedCompatibilityRoot)
Assert-PhysicalDirectoryChain -Root $compatibilityAnchor -Target $resolvedCompatibilityRoot
$handoffPath = Join-Path $resolvedCompatibilityRoot "handoff.md"
$shortPath = Join-Path $resolvedCompatibilityRoot "SHORT.md"
Assert-ProjectionBlockShape -Path $handoffPath -Start "<!-- rommie:compact:start -->" -End "<!-- rommie:compact:end -->"
Assert-ProjectionBlockShape -Path $shortPath -Start "<!-- rommie:compact-short:start -->" -End "<!-- rommie:compact-short:end -->"

$activeResult = Invoke-AgentsJson -Arguments @(
    "memory", "list",
    "--scope", "session",
    "--subject", "compaction",
    "--predicate", "current",
    "--status", "active",
    "--json"
)
$active = @($activeResult)
if ($active.Count -gt 1) {
    throw "Canonical memory contains multiple active compaction records; refusing to guess."
}

$snapshotDirectory = Join-Path (Join-Path $authority.MemoryRoot "snapshots") "compaction"
Assert-PhysicalDirectoryChain -Root $authority.AgentsHome -Target $snapshotDirectory

# Prove repository health and remote reachability before changing canonical memory.
$preflightSync = Invoke-AgentsJson -Arguments @("state", "sync", "--json")
Assert-StateSyncSucceeded -Result $preflightSync

$now = Get-Date -Format o
$capsuleId = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), ([guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $snapshotDirectory -Force | Out-Null
Assert-PhysicalDirectoryChain -Root $authority.AgentsHome -Target $snapshotDirectory
$snapshotPath = Join-Path $snapshotDirectory "$capsuleId.json"

$payload = [ordered]@{
    schemaVersion = 2
    capsuleId = $capsuleId
    createdAt = $now
    objective = $Objective
    state = $State
    next = $Next
    validation = $Validation
    blockers = $Blockers
    repos = $Repos
    authority = [ordered]@{
        agentsHome = $authority.AgentsHome
        memoryRoot = $authority.MemoryRoot
        record = "session:compaction.current"
    }
}
$snapshotJson = $payload | ConvertTo-Json -Depth 5
Write-Utf8NoBom -Path $snapshotPath -Content ($snapshotJson + [Environment]::NewLine)
$snapshotHash = (Get-FileHash -LiteralPath $snapshotPath -Algorithm SHA256).Hash.ToLowerInvariant()
$snapshotUri = ([System.Uri]::new($snapshotPath)).AbsoluteUri
$memoryValue = ($payload | ConvertTo-Json -Depth 5 -Compress)

$evidenceArgs = @(
    "--value", $memoryValue,
    "--source", $snapshotUri,
    "--hash", $snapshotHash,
    "--source-class", "verified",
    "--confidence", "1",
    "--sensitivity", "internal",
    "--observed-at", $now,
    "--json"
)
$record = $null
$render = $null
$memoryStatus = $null
$sync = $null
$statePath = Join-Path $authority.MemoryRoot ".compact-state.json"
$compatibilityStatePath = Join-Path $resolvedCompatibilityRoot ".compact-state.json"
$cachePath = Join-Path $resolvedCompatibilityRoot "cache.md"
$handoffSaved = Save-ProjectionState -Path $handoffPath
$shortSaved = Save-ProjectionState -Path $shortPath
$stateSaved = Save-ProjectionState -Path $statePath
$compatibilityStateSaved = Save-ProjectionState -Path $compatibilityStatePath
$cacheSaved = Save-ProjectionState -Path $cachePath

try {
    # remember/supersede also revalidates the scalar under the manager's memory
    # lock; this outer lock serializes the complete compaction publication flow.
    $record = if ($active.Count -eq 1) {
        Invoke-AgentsJson -Arguments (@("memory", "supersede", [string]$active[0].id) + $evidenceArgs)
    } else {
        Invoke-AgentsJson -Arguments (@(
            "memory", "remember",
            "--scope", "session",
            "--subject", "compaction",
            "--predicate", "current"
        ) + $evidenceArgs)
    }

    $render = Invoke-AgentsJson -Arguments @("memory", "render", "--json")
    $memoryStatus = Invoke-AgentsJson -Arguments @("memory", "status", "--json")
    if (-not $memoryStatus.ok) {
        throw "Canonical memory integrity failed after writing the compaction capsule."
    }

    New-Item -ItemType Directory -Path $resolvedCompatibilityRoot -Force | Out-Null
    Assert-PhysicalDirectoryChain -Root $compatibilityAnchor -Target $resolvedCompatibilityRoot

    $handoffSection = @"
<!-- rommie:compact:start -->
## Agent OS Compaction Projection
Generated: $now
Authority: `$($authority.MemoryRoot)` immutable memory events
Record: `$($record.id)`
Snapshot: `$snapshotPath`

Objective:
- $Objective

State:
- $State

Next:
- $Next

Validation:
- $Validation

Blockers:
- $Blockers

Repos:
- $Repos
<!-- rommie:compact:end -->
"@
    Update-ProjectionBlock -Path $handoffPath -Start "<!-- rommie:compact:start -->" -End "<!-- rommie:compact:end -->" -Section $handoffSection

    $shortSection = @"
<!-- rommie:compact-short:start -->
## Agent OS Compaction Active-Work Projection
Generated: $now
Authority record: `$($record.id)`
Current objective: $Objective
Status: $State
Next actions: $Next
Blockers: $Blockers
Last validation: $Validation
<!-- rommie:compact-short:end -->
"@
    Update-ProjectionBlock -Path $shortPath -Start "<!-- rommie:compact-short:start -->" -End "<!-- rommie:compact-short:end -->" -Section $shortSection

    $sync = Invoke-AgentsJson -Arguments @("state", "sync", "--json")
    Assert-StateSyncSucceeded -Result $sync

    # Final sync may import concurrent remote events. Rebuild from those events
    # and prove this capsule is still the one active scalar before reporting success.
    $render = Invoke-AgentsJson -Arguments @("memory", "render", "--json")
    $memoryStatus = Invoke-AgentsJson -Arguments @("memory", "status", "--json")
    if (-not $memoryStatus.ok) {
        throw "Canonical memory integrity failed after final repository synchronization."
    }
    $publishedActiveResult = Invoke-AgentsJson -Arguments @(
        "memory", "list",
        "--scope", "session",
        "--subject", "compaction",
        "--predicate", "current",
        "--status", "active",
        "--json"
    )
    $publishedActive = @($publishedActiveResult)
    if ($publishedActive.Count -ne 1 -or [string]$publishedActive[0].id -ne [string]$record.id) {
        throw "Final synchronization changed the active compaction record; refusing stale success."
    }

    $statePayload = [ordered]@{
        schemaVersion = 2
        lastCompact = $now
        authority = "agents-memory-events"
        recordId = $record.id
        snapshot = $snapshotPath
        snapshotSha256 = $snapshotHash
        projection = $render.filePath
        projectionHash = $memoryStatus.projectionHash
        repositorySync = $sync
    }
    Write-Utf8NoBom -Path $statePath -Content (($statePayload | ConvertTo-Json -Depth 8) + [Environment]::NewLine)

    $compatibilityState = [ordered]@{
        schemaVersion = 2
        generatedProjection = $true
        canonicalMemoryRoot = $authority.MemoryRoot
        recordId = $record.id
        snapshot = $snapshotPath
    }
    Write-Utf8NoBom -Path $compatibilityStatePath -Content (($compatibilityState | ConvertTo-Json -Depth 4) + [Environment]::NewLine)

    if ($ClearCache) {
        Write-Utf8NoBom -Path $cachePath -Content ("# Immediate Task Cache`n`nGenerated compatibility cache. Canonical authority is under `$($authority.MemoryRoot)`.`n`nCurrent cache:`n- None.`n")
    }
} catch {
    $failureMessage = $_.Exception.Message
    $recoveryIssues = @()

    foreach ($savedProjection in @($handoffSaved, $shortSaved, $stateSaved, $compatibilityStateSaved, $cacheSaved)) {
        try {
            Restore-ProjectionState -Saved $savedProjection
        } catch {
            $recoveryIssues += "projection restore failed: $($_.Exception.Message)"
        }
    }

    if ($null -ne $record) {
        try {
            $recoveryPath = Join-Path $snapshotDirectory "$capsuleId-rollback.json"
            $recoveryPayload = [ordered]@{
                schemaVersion = 1
                failedRecordId = $record.id
                failedAt = Get-Date -Format o
                reason = $failureMessage
                priorRecordId = if ($active.Count -eq 1) { $active[0].id } else { $null }
                priorValue = if ($active.Count -eq 1) { $active[0].value } else { $null }
            }
            Write-Utf8NoBom -Path $recoveryPath -Content (($recoveryPayload | ConvertTo-Json -Depth 5) + [Environment]::NewLine)
            $recoveryHash = (Get-FileHash -LiteralPath $recoveryPath -Algorithm SHA256).Hash.ToLowerInvariant()
            $recoveryUri = ([System.Uri]::new($recoveryPath)).AbsoluteUri
            $recoveryEvidence = @(
                "--source", $recoveryUri,
                "--hash", $recoveryHash,
                "--source-class", "verified",
                "--confidence", "1",
                "--json"
            )
            if ($active.Count -eq 1) {
                Invoke-AgentsJson -Arguments (@(
                    "memory", "supersede", [string]$record.id,
                    "--value", [string]$active[0].value,
                    "--sensitivity", [string]$active[0].sensitivity,
                    "--observed-at", (Get-Date -Format o)
                ) + $recoveryEvidence) | Out-Null
            } else {
                Invoke-AgentsJson -Arguments (@(
                    "memory", "retract", [string]$record.id,
                    "--reason", "compaction publication failed"
                ) + $recoveryEvidence) | Out-Null
            }
            Invoke-AgentsJson -Arguments @("memory", "render", "--json") | Out-Null
            $recoveredStatus = Invoke-AgentsJson -Arguments @("memory", "status", "--json")
            if (-not $recoveredStatus.ok) {
                throw "canonical memory integrity remained unhealthy after rollback"
            }
            $recoverySync = Invoke-AgentsJson -Arguments @("state", "sync", "--json")
            Assert-StateSyncSucceeded -Result $recoverySync
        } catch {
            $recoveryIssues += "canonical rollback failed: $($_.Exception.Message)"
        }
    }

    $recoverySummary = if ($recoveryIssues.Count -eq 0) { "rollback completed" } else { $recoveryIssues -join "; " }
    throw "Compaction publication failed: $failureMessage. Recovery: $recoverySummary."
}

[ordered]@{
    ok = $true
    authority = $authority.MemoryRoot
    recordId = $record.id
    snapshot = $snapshotPath
    projection = $render.filePath
    projectionHash = $memoryStatus.projectionHash
    repositorySynced = $true
} | ConvertTo-Json -Depth 4
} finally {
    $compactLock.Dispose()
}
