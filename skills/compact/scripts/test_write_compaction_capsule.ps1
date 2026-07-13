$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptUnderTest = Join-Path $PSScriptRoot "write_compaction_capsule.ps1"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("rommie-compact-test-" + [guid]::NewGuid().ToString("N"))

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function New-FakeAgents {
    param([string]$Root)
    $path = Join-Path $Root "fake-agents.ps1"
    @'
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$CommandArgs)
$ErrorActionPreference = "Stop"
Add-Content -LiteralPath $env:FAKE_AGENTS_LOG -Value ($CommandArgs -join " ")

if ($CommandArgs[0] -eq "state" -and $CommandArgs[1] -eq "env") {
    "AGENTS_HOME=$env:FAKE_AGENTS_HOME"
    "AGENTS_MEMORY=$env:FAKE_AGENTS_MEMORY"
    exit 0
}
if ($CommandArgs[0] -eq "memory" -and $CommandArgs[1] -eq "list") {
    $listCalls = @((Get-Content -LiteralPath $env:FAKE_AGENTS_LOG) | Where-Object { $_ -match '^memory list ' }).Count
    if ($env:FAKE_POST_ACTIVE_IDS -and $listCalls -ge 2) {
        @($env:FAKE_POST_ACTIVE_IDS.Split(",") | ForEach-Object { @{ id = $_; status = "active"; value = "remote-value"; sensitivity = "internal" } }) | ConvertTo-Json -Compress
    } elseif ($listCalls -ge 2) {
        $publishedId = if ((Get-Content -LiteralPath $env:FAKE_AGENTS_LOG) -match '^memory supersede prior-record ') { "record-superseded" } else { "record-new" }
        @(@{ id = $publishedId; status = "active"; value = "published-value"; sensitivity = "internal" }) | ConvertTo-Json -Compress
    } elseif ($env:FAKE_ACTIVE_IDS) {
        @($env:FAKE_ACTIVE_IDS.Split(",") | ForEach-Object { @{ id = $_; status = "active"; value = "prior-value"; sensitivity = "internal" } }) | ConvertTo-Json -Compress
    } elseif ($env:FAKE_ACTIVE_ID) {
        @(@{ id = $env:FAKE_ACTIVE_ID; status = "active"; value = "prior-value"; sensitivity = "internal" }) | ConvertTo-Json -Compress
    } else {
        "[]"
    }
    exit 0
}
if ($CommandArgs[0] -eq "memory" -and $CommandArgs[1] -eq "remember") {
    @{ id = "record-new"; status = "active" } | ConvertTo-Json -Compress
    exit 0
}
if ($CommandArgs[0] -eq "memory" -and $CommandArgs[1] -eq "supersede") {
    @{ id = "record-superseded"; status = "active" } | ConvertTo-Json -Compress
    exit 0
}
if ($CommandArgs[0] -eq "memory" -and $CommandArgs[1] -eq "retract") {
    @{ id = $CommandArgs[2]; status = "retracted" } | ConvertTo-Json -Compress
    exit 0
}
if ($CommandArgs[0] -eq "memory" -and $CommandArgs[1] -eq "render") {
    @{ filePath = (Join-Path $env:FAKE_AGENTS_MEMORY "views/startup.md"); changed = $true } | ConvertTo-Json -Compress
    exit 0
}
if ($CommandArgs[0] -eq "memory" -and $CommandArgs[1] -eq "status") {
    @{ ok = $true; projectionHash = "projection-hash" } | ConvertTo-Json -Compress
    exit 0
}
if ($CommandArgs[0] -eq "state" -and $CommandArgs[1] -eq "sync") {
    $syncCalls = @((Get-Content -LiteralPath $env:FAKE_AGENTS_LOG) | Where-Object { $_ -eq "state sync --json" }).Count
    $pushed = -not ($env:FAKE_SYNC_FAIL_ON_CALL -and $syncCalls -eq [int]$env:FAKE_SYNC_FAIL_ON_CALL)
    $committed = $env:FAKE_BACKUP_COMMITTED -ne "false"
    $backup = @{ bundle = "backups/events/fake/bundle.json"; payloadHash = ("a" * 64); entries = 1; committed = $committed }
    if ($env:FAKE_SYNC_INVALID_BACKUP -eq "true") { $backup.Remove("payloadHash") }
    @{
        pushed = $pushed
        restored = @{ bundles = 1; imported = 0; skipped = 1; projectionHash = "projection-hash" }
        backup = $backup
    } | ConvertTo-Json -Compress
    exit 0
}
throw "Unexpected fake agents command: $($CommandArgs -join ' ')"
'@ | Set-Content -LiteralPath $path -Encoding UTF8
    return $path
}

function Initialize-Case {
    param([string]$Name)
    $root = Join-Path $testRoot $Name
    $agentsHome = Join-Path $root ".agents"
    $memoryRoot = Join-Path $agentsHome "memory"
    $compatibilityRoot = Join-Path $root ".codex/memories"
    New-Item -ItemType Directory -Path $memoryRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $compatibilityRoot -Force | Out-Null
    $log = Join-Path $root "agents.log"
    New-Item -ItemType File -Path $log -Force | Out-Null
    $fake = New-FakeAgents -Root $root
    return [ordered]@{
        Root = $root
        AgentsHome = $agentsHome
        MemoryRoot = $memoryRoot
        CompatibilityRoot = $compatibilityRoot
        Log = $log
        Fake = $fake
    }
}

try {
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null

    # Primary path: first capsule becomes canonical, renders, syncs, and projects.
    $primary = Initialize-Case -Name "primary"
    $env:FAKE_AGENTS_HOME = $primary.AgentsHome
    $env:FAKE_AGENTS_MEMORY = $primary.MemoryRoot
    $env:FAKE_AGENTS_LOG = $primary.Log
    $env:FAKE_ACTIVE_ID = ""
    $env:FAKE_ACTIVE_IDS = ""
    $env:FAKE_SYNC_FAIL_ON_CALL = ""
    $env:FAKE_SYNC_INVALID_BACKUP = ""
    $env:FAKE_POST_ACTIVE_IDS = ""
    $env:FAKE_BACKUP_COMMITTED = ""
    $result = & $scriptUnderTest -Objective "resume board" -State "ready" -Next "start planned 1" -Validation "green" -Blockers "None" -Repos "repo@abc" -AgentsCommand $primary.Fake -UserHome $primary.Root | ConvertFrom-Json
    Assert-True ($result.ok -eq $true) "primary: expected ok result"
    Assert-True ($result.recordId -eq "record-new") "primary: expected remembered record"
    Assert-True ($result.repositorySynced -eq $true) "primary: expected repository sync"
    Assert-True (Test-Path -LiteralPath $result.snapshot) "primary: expected immutable snapshot"
    Assert-True ([System.IO.Path]::GetFullPath($result.snapshot).StartsWith([System.IO.Path]::GetFullPath($primary.MemoryRoot))) "primary: snapshot escaped canonical memory"
    Assert-True ((Get-Content -Raw (Join-Path $primary.CompatibilityRoot "handoff.md")) -match "Authority:.*memory") "primary: expected authority-marked projection"
    $primaryLog = Get-Content -Raw $primary.Log
    Assert-True ($primaryLog -match "memory remember") "primary: remember was not called"
    Assert-True ($primaryLog -match "state sync --json") "primary: state sync was not called"
    Assert-True (@($primaryLog -split "`r?`n" | Where-Object { $_ -eq "state sync --json" }).Count -eq 2) "primary: expected preflight and publication syncs"
    Assert-True (Test-Path -LiteralPath (Join-Path $primary.MemoryRoot ".compact.lock")) "primary: persistent lock identity was unlinked"

    # Concurrent local publications are serialized across the complete workflow.
    $locked = Initialize-Case -Name "locked"
    $env:FAKE_AGENTS_HOME = $locked.AgentsHome
    $env:FAKE_AGENTS_MEMORY = $locked.MemoryRoot
    $env:FAKE_AGENTS_LOG = $locked.Log
    $heldLockPath = Join-Path $locked.MemoryRoot ".compact.lock"
    $heldLock = [System.IO.File]::Open($heldLockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $lockedMessage = ""
    try {
        & $scriptUnderTest -Objective "must wait" -State "locked" -Next "none" -AgentsCommand $locked.Fake -CompatibilityRoot $locked.CompatibilityRoot | Out-Null
    } catch {
        $lockedMessage = $_.Exception.Message
    } finally {
        $heldLock.Dispose()
    }
    Assert-True ($lockedMessage -match "Another compaction operation owns") "locked: concurrent publication was not rejected"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $locked.MemoryRoot "snapshots/compaction"))) "locked: concurrent publication mutated memory"
    $handoffResult = & $scriptUnderTest -Objective "after handoff" -State "ready" -Next "continue" -AgentsCommand $locked.Fake -CompatibilityRoot $locked.CompatibilityRoot | ConvertFrom-Json
    Assert-True ($handoffResult.ok -eq $true) "locked: persistent lock could not be acquired after owner release"
    Assert-True (Test-Path -LiteralPath $heldLockPath) "locked: lock identity was removed during handoff"

    # Edge path: an existing active capsule is explicitly superseded.
    $edge = Initialize-Case -Name "edge"
    $env:FAKE_AGENTS_HOME = $edge.AgentsHome
    $env:FAKE_AGENTS_MEMORY = $edge.MemoryRoot
    $env:FAKE_AGENTS_LOG = $edge.Log
    $env:FAKE_ACTIVE_ID = "prior-record"
    $env:FAKE_ACTIVE_IDS = ""
    $env:FAKE_BACKUP_COMMITTED = "false"
    $edgeResult = & $scriptUnderTest -Objective "new objective" -State "active" -Next "continue" -AgentsCommand $edge.Fake -CompatibilityRoot $edge.CompatibilityRoot | ConvertFrom-Json
    Assert-True ($edgeResult.recordId -eq "record-superseded") "edge: expected superseding record"
    Assert-True ((Get-Content -Raw $edge.Log) -match "memory supersede prior-record") "edge: prior record was not superseded"
    $env:FAKE_BACKUP_COMMITTED = ""

    # Denied path: memory outside AGENTS_HOME is rejected before a snapshot write.
    $denied = Initialize-Case -Name "denied"
    $outsideMemory = Join-Path $denied.Root "outside-memory"
    New-Item -ItemType Directory -Path $outsideMemory -Force | Out-Null
    $env:FAKE_AGENTS_HOME = $denied.AgentsHome
    $env:FAKE_AGENTS_MEMORY = $outsideMemory
    $env:FAKE_AGENTS_LOG = $denied.Log
    $env:FAKE_ACTIVE_ID = ""
    $env:FAKE_ACTIVE_IDS = ""
    $deniedMessage = ""
    try {
        & $scriptUnderTest -Objective "must fail" -State "invalid" -Next "none" -AgentsCommand $denied.Fake -CompatibilityRoot $denied.CompatibilityRoot | Out-Null
    } catch {
        $deniedMessage = $_.Exception.Message
    }
    Assert-True ($deniedMessage -match "must remain under AGENTS_HOME") "denied: outside authority was not rejected"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $outsideMemory "snapshots/compaction"))) "denied: wrote outside canonical authority"

    # Physical escape: a lexically contained link or junction cannot redirect writes.
    $linked = Initialize-Case -Name "linked"
    $linkedOutside = Join-Path $linked.Root "linked-outside"
    $linkedMemory = Join-Path $linked.AgentsHome "linked-memory"
    New-Item -ItemType Directory -Path $linkedOutside -Force | Out-Null
    if ($env:OS -eq "Windows_NT") {
        New-Item -ItemType Junction -Path $linkedMemory -Target $linkedOutside | Out-Null
    } else {
        New-Item -ItemType SymbolicLink -Path $linkedMemory -Target $linkedOutside | Out-Null
    }
    $env:FAKE_AGENTS_HOME = $linked.AgentsHome
    $env:FAKE_AGENTS_MEMORY = $linkedMemory
    $env:FAKE_AGENTS_LOG = $linked.Log
    $linkedMessage = ""
    try {
        & $scriptUnderTest -Objective "must fail" -State "invalid" -Next "none" -AgentsCommand $linked.Fake -CompatibilityRoot $linked.CompatibilityRoot | Out-Null
    } catch {
        $linkedMessage = $_.Exception.Message
    }
    Assert-True ($linkedMessage -match "physical directories|links|reparse points") "linked: physical authority escape was not rejected"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $linkedOutside "snapshots/compaction"))) "linked: wrote through authority link"

    # Canonical descendants are checked before capsule and rollback writes.
    $linkedSnapshots = Initialize-Case -Name "linked-snapshots"
    $linkedSnapshotsOutside = Join-Path $linkedSnapshots.Root "snapshots-outside"
    $linkedSnapshotsPath = Join-Path $linkedSnapshots.MemoryRoot "snapshots"
    New-Item -ItemType Directory -Path $linkedSnapshotsOutside -Force | Out-Null
    if ($env:OS -eq "Windows_NT") {
        New-Item -ItemType Junction -Path $linkedSnapshotsPath -Target $linkedSnapshotsOutside | Out-Null
    } else {
        New-Item -ItemType SymbolicLink -Path $linkedSnapshotsPath -Target $linkedSnapshotsOutside | Out-Null
    }
    $env:FAKE_AGENTS_HOME = $linkedSnapshots.AgentsHome
    $env:FAKE_AGENTS_MEMORY = $linkedSnapshots.MemoryRoot
    $env:FAKE_AGENTS_LOG = $linkedSnapshots.Log
    $linkedSnapshotsMessage = ""
    try {
        & $scriptUnderTest -Objective "must fail" -State "invalid" -Next "none" -AgentsCommand $linkedSnapshots.Fake -CompatibilityRoot $linkedSnapshots.CompatibilityRoot | Out-Null
    } catch {
        $linkedSnapshotsMessage = $_.Exception.Message
    }
    Assert-True ($linkedSnapshotsMessage -match "physical directories|links|reparse points") "linked-snapshots: descendant escape was not rejected"
    Assert-True (@(Get-ChildItem -LiteralPath $linkedSnapshotsOutside -Force).Count -eq 0) "linked-snapshots: wrote capsule evidence outside authority"
    Assert-True (-not ((Get-Content -Raw $linkedSnapshots.Log) -match "state sync")) "linked-snapshots: repository mutated before descendant validation"

    # Compatibility roots cannot redirect provider-local projections externally.
    $linkedCompatibility = Initialize-Case -Name "linked-compatibility"
    $linkedCompatibilityOutside = Join-Path $linkedCompatibility.Root "compatibility-outside"
    Remove-Item -LiteralPath $linkedCompatibility.CompatibilityRoot -Recurse -Force
    New-Item -ItemType Directory -Path $linkedCompatibilityOutside -Force | Out-Null
    if ($env:OS -eq "Windows_NT") {
        New-Item -ItemType Junction -Path $linkedCompatibility.CompatibilityRoot -Target $linkedCompatibilityOutside | Out-Null
    } else {
        New-Item -ItemType SymbolicLink -Path $linkedCompatibility.CompatibilityRoot -Target $linkedCompatibilityOutside | Out-Null
    }
    $env:FAKE_AGENTS_HOME = $linkedCompatibility.AgentsHome
    $env:FAKE_AGENTS_MEMORY = $linkedCompatibility.MemoryRoot
    $env:FAKE_AGENTS_LOG = $linkedCompatibility.Log
    $linkedCompatibilityMessage = ""
    try {
        & $scriptUnderTest -Objective "must fail" -State "invalid" -Next "none" -AgentsCommand $linkedCompatibility.Fake -CompatibilityRoot $linkedCompatibility.CompatibilityRoot | Out-Null
    } catch {
        $linkedCompatibilityMessage = $_.Exception.Message
    }
    Assert-True ($linkedCompatibilityMessage -match "physical directories|links|reparse points") "linked-compatibility: linked projection root was not rejected"
    Assert-True (@(Get-ChildItem -LiteralPath $linkedCompatibilityOutside -Force).Count -eq 0) "linked-compatibility: projection escaped its root"
    Assert-True (-not ((Get-Content -Raw $linkedCompatibility.Log) -match "state sync")) "linked-compatibility: repository mutated before projection validation"

    # Existing destination entries are checked independently of their directory.
    $linkedDestination = Initialize-Case -Name "linked-destination"
    $linkedDestinationPath = Join-Path $linkedDestination.CompatibilityRoot "handoff.md"
    $linkedDestinationOutside = Join-Path $linkedDestination.Root "destination-outside"
    if ($env:OS -eq "Windows_NT") {
        New-Item -ItemType Directory -Path $linkedDestinationOutside -Force | Out-Null
        New-Item -ItemType Junction -Path $linkedDestinationPath -Target $linkedDestinationOutside | Out-Null
    } else {
        Set-Content -LiteralPath $linkedDestinationOutside -Value "outside must remain" -NoNewline
        New-Item -ItemType SymbolicLink -Path $linkedDestinationPath -Target $linkedDestinationOutside | Out-Null
    }
    $env:FAKE_AGENTS_HOME = $linkedDestination.AgentsHome
    $env:FAKE_AGENTS_MEMORY = $linkedDestination.MemoryRoot
    $env:FAKE_AGENTS_LOG = $linkedDestination.Log
    $linkedDestinationMessage = ""
    try {
        & $scriptUnderTest -Objective "must fail" -State "invalid" -Next "none" -AgentsCommand $linkedDestination.Fake -CompatibilityRoot $linkedDestination.CompatibilityRoot | Out-Null
    } catch {
        $linkedDestinationMessage = $_.Exception.Message
    }
    Assert-True ($linkedDestinationMessage -match "physical file|link|reparse point") "linked-destination: linked projection file was not rejected"
    if ($env:OS -ne "Windows_NT") {
        Assert-True ((Get-Content -Raw $linkedDestinationOutside) -eq "outside must remain") "linked-destination: external file was overwritten"
    }
    Assert-True (-not ((Get-Content -Raw $linkedDestination.Log) -match "state sync")) "linked-destination: repository mutated before destination validation"

    # Ambiguous authority: duplicate active records fail before creating a snapshot.
    $duplicateActive = Initialize-Case -Name "duplicate-active"
    $env:FAKE_AGENTS_HOME = $duplicateActive.AgentsHome
    $env:FAKE_AGENTS_MEMORY = $duplicateActive.MemoryRoot
    $env:FAKE_AGENTS_LOG = $duplicateActive.Log
    $env:FAKE_ACTIVE_ID = ""
    $env:FAKE_ACTIVE_IDS = "record-one,record-two"
    $duplicateActiveMessage = ""
    try {
        & $scriptUnderTest -Objective "must fail" -State "ambiguous" -Next "none" -AgentsCommand $duplicateActive.Fake -CompatibilityRoot $duplicateActive.CompatibilityRoot | Out-Null
    } catch {
        $duplicateActiveMessage = $_.Exception.Message
    }
    Assert-True ($duplicateActiveMessage -match "multiple active compaction records") "duplicate-active: ambiguity was not rejected"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $duplicateActive.MemoryRoot "snapshots/compaction"))) "duplicate-active: orphan snapshot was created"

    # Malformed compatibility state fails before canonical state is changed or synced.
    $duplicateProjection = Initialize-Case -Name "duplicate-projection"
    $duplicateProjectionPath = Join-Path $duplicateProjection.CompatibilityRoot "handoff.md"
    $duplicateBlock = "<!-- rommie:compact:start -->`nold`n<!-- rommie:compact:end -->"
    Set-Content -LiteralPath $duplicateProjectionPath -Value "$duplicateBlock`n$duplicateBlock" -Encoding UTF8
    $env:FAKE_AGENTS_HOME = $duplicateProjection.AgentsHome
    $env:FAKE_AGENTS_MEMORY = $duplicateProjection.MemoryRoot
    $env:FAKE_AGENTS_LOG = $duplicateProjection.Log
    $env:FAKE_ACTIVE_IDS = ""
    $duplicateProjectionMessage = ""
    try {
        & $scriptUnderTest -Objective "must fail" -State "malformed" -Next "none" -AgentsCommand $duplicateProjection.Fake -CompatibilityRoot $duplicateProjection.CompatibilityRoot | Out-Null
    } catch {
        $duplicateProjectionMessage = $_.Exception.Message
    }
    Assert-True ($duplicateProjectionMessage -match "malformed or duplicate compact markers") "duplicate-projection: duplicate markers were not rejected"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $duplicateProjection.MemoryRoot "snapshots/compaction"))) "duplicate-projection: orphan snapshot was created"
    Assert-True (-not ((Get-Content -Raw $duplicateProjection.Log) -match "state sync")) "duplicate-projection: state sync ran after validation failure"

    # Incomplete repository evidence is rejected during preflight before mutation.
    $invalidEvidence = Initialize-Case -Name "invalid-evidence"
    $env:FAKE_AGENTS_HOME = $invalidEvidence.AgentsHome
    $env:FAKE_AGENTS_MEMORY = $invalidEvidence.MemoryRoot
    $env:FAKE_AGENTS_LOG = $invalidEvidence.Log
    $env:FAKE_ACTIVE_IDS = ""
    $env:FAKE_SYNC_INVALID_BACKUP = "true"
    $invalidEvidenceMessage = ""
    try {
        & $scriptUnderTest -Objective "must fail" -State "invalid evidence" -Next "none" -AgentsCommand $invalidEvidence.Fake -CompatibilityRoot $invalidEvidence.CompatibilityRoot | Out-Null
    } catch {
        $invalidEvidenceMessage = $_.Exception.Message
    }
    Assert-True ($invalidEvidenceMessage -match "backup evidence is missing payloadHash") "invalid-evidence: incomplete sync evidence was accepted"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $invalidEvidence.MemoryRoot "snapshots/compaction"))) "invalid-evidence: snapshot was created before healthy preflight"
    $env:FAKE_SYNC_INVALID_BACKUP = ""

    # Concurrent remote convergence cannot turn a stale capsule into success.
    $convergenceRace = Initialize-Case -Name "convergence-race"
    $env:FAKE_AGENTS_HOME = $convergenceRace.AgentsHome
    $env:FAKE_AGENTS_MEMORY = $convergenceRace.MemoryRoot
    $env:FAKE_AGENTS_LOG = $convergenceRace.Log
    $env:FAKE_ACTIVE_ID = ""
    $env:FAKE_ACTIVE_IDS = ""
    $env:FAKE_POST_ACTIVE_IDS = "record-new,remote-record"
    $convergenceRaceMessage = ""
    try {
        & $scriptUnderTest -Objective "must fail" -State "raced" -Next "none" -AgentsCommand $convergenceRace.Fake -CompatibilityRoot $convergenceRace.CompatibilityRoot | Out-Null
    } catch {
        $convergenceRaceMessage = $_.Exception.Message
    }
    Assert-True ($convergenceRaceMessage -match "changed the active compaction record") "convergence-race: stale success was accepted"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $convergenceRace.MemoryRoot ".compact-state.json"))) "convergence-race: success state was written"
    Assert-True ((Get-Content -Raw $convergenceRace.Log) -match "memory retract record-new") "convergence-race: local raced record was not rolled back"
    $env:FAKE_POST_ACTIVE_IDS = ""

    # A successful process exit is insufficient when sync JSON reports no push.
    $syncFailure = Initialize-Case -Name "sync-failure"
    $env:FAKE_AGENTS_HOME = $syncFailure.AgentsHome
    $env:FAKE_AGENTS_MEMORY = $syncFailure.MemoryRoot
    $env:FAKE_AGENTS_LOG = $syncFailure.Log
    $env:FAKE_ACTIVE_IDS = ""
    $env:FAKE_SYNC_FAIL_ON_CALL = "2"
    Set-Content -LiteralPath (Join-Path $syncFailure.CompatibilityRoot "handoff.md") -Value "original handoff" -NoNewline
    $syncFailureMessage = ""
    try {
        & $scriptUnderTest -Objective "must fail" -State "unsynced" -Next "none" -AgentsCommand $syncFailure.Fake -CompatibilityRoot $syncFailure.CompatibilityRoot | Out-Null
    } catch {
        $syncFailureMessage = $_.Exception.Message
    }
    Assert-True ($syncFailureMessage -match "did not confirm a successful push") "sync-failure: unsuccessful payload was accepted"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $syncFailure.MemoryRoot ".compact-state.json"))) "sync-failure: success state was written"
    Assert-True ((Get-Content -Raw (Join-Path $syncFailure.CompatibilityRoot "handoff.md")) -eq "original handoff") "sync-failure: compatibility projection was not rolled back"
    $syncFailureLog = Get-Content -Raw $syncFailure.Log
    Assert-True ($syncFailureLog -match "memory retract record-new") "sync-failure: failed active record was not retracted"
    Assert-True (@($syncFailureLog -split "`r?`n" | Where-Object { $_ -eq "state sync --json" }).Count -eq 3) "sync-failure: rollback was not synchronized"

    # A late failure after supersession restores the prior scalar as a new active record.
    $supersedeFailure = Initialize-Case -Name "supersede-failure"
    $env:FAKE_AGENTS_HOME = $supersedeFailure.AgentsHome
    $env:FAKE_AGENTS_MEMORY = $supersedeFailure.MemoryRoot
    $env:FAKE_AGENTS_LOG = $supersedeFailure.Log
    $env:FAKE_ACTIVE_ID = "prior-record"
    $env:FAKE_ACTIVE_IDS = ""
    $env:FAKE_SYNC_FAIL_ON_CALL = "2"
    $supersedeFailureMessage = ""
    try {
        & $scriptUnderTest -Objective "must fail" -State "unsynced" -Next "none" -AgentsCommand $supersedeFailure.Fake -CompatibilityRoot $supersedeFailure.CompatibilityRoot | Out-Null
    } catch {
        $supersedeFailureMessage = $_.Exception.Message
    }
    Assert-True ($supersedeFailureMessage -match "rollback completed") "supersede-failure: rollback did not complete"
    $supersedeFailureLog = Get-Content -Raw $supersedeFailure.Log
    Assert-True ($supersedeFailureLog -match "memory supersede record-superseded --value prior-value") "supersede-failure: prior scalar was not restored"
    Assert-True (-not ($supersedeFailureLog -match "memory retract record-superseded")) "supersede-failure: prior scalar was replaced with an empty state"

    Write-Output "compact capsule authority regression suite passed"
} finally {
    Remove-Item Env:FAKE_AGENTS_HOME -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_AGENTS_MEMORY -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_AGENTS_LOG -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_ACTIVE_ID -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_ACTIVE_IDS -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_SYNC_FAIL_ON_CALL -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_SYNC_INVALID_BACKUP -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_POST_ACTIVE_IDS -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_BACKUP_COMMITTED -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
