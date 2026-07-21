param()

$ErrorActionPreference = "Stop"

$runner = Join-Path $PSScriptRoot "run_dream.ps1"

function Assert-True {
    param(
        [Parameter(Mandatory=$true)][bool]$Condition,
        [Parameter(Mandatory=$true)][string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function New-TestMemoryRoot {
    $root = Join-Path ([System.IO.Path]::GetTempPath()) ("dream-test-" + [System.Guid]::NewGuid().ToString("N"))
    $rolloutRoot = Join-Path $root "rollout_summaries"
    New-Item -ItemType Directory -Path $rolloutRoot -Force | Out-Null

    @"
# Summary
Temp dry-run fixture

## Task 1: sample
Outcome: complete

## Reusable knowledge
- Keep dry-run free of memory writes.
"@ | Set-Content -LiteralPath (Join-Path $rolloutRoot "2026-01-01-session.md") -Encoding UTF8

    return $root
}

function Get-RelativeFileSet {
    param([Parameter(Mandatory=$true)][string]$Root)

    if (-not (Test-Path -LiteralPath $Root)) {
        return @()
    }

    return Get-ChildItem -LiteralPath $Root -File -Recurse -Force |
        ForEach-Object { [System.IO.Path]::GetRelativePath($Root, $_.FullName) } |
        Sort-Object
}

function Assert-FileSetEqual {
    param(
        [Parameter(Mandatory=$true)][string[]]$Before,
        [Parameter(Mandatory=$true)][string[]]$After,
        [Parameter(Mandatory=$true)][string]$Message
    )

    $diff = Compare-Object -ReferenceObject $Before -DifferenceObject $After
    if ($diff) {
        $details = ($diff | ForEach-Object { "$($_.SideIndicator) $($_.InputObject)" }) -join "`n"
        throw "$Message`n$details"
    }
}

$roots = New-Object System.Collections.Generic.List[string]

try {
    $dryRoot = New-TestMemoryRoot
    $roots.Add($dryRoot)
    $beforeDryFiles = @(Get-RelativeFileSet -Root $dryRoot)

    & $runner -MemoryRoot $dryRoot -DryRun | Out-Null

    $afterDryFiles = @(Get-RelativeFileSet -Root $dryRoot)
    Assert-FileSetEqual -Before $beforeDryFiles -After $afterDryFiles -Message "Dry-run created, removed, or renamed files."
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $dryRoot ".dream-state.json"))) -Message "Dry-run created .dream-state.json."
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $dryRoot "cache.md"))) -Message "Dry-run created cache.md."
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $dryRoot "SHORT.md"))) -Message "Dry-run created SHORT.md."
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $dryRoot "handoff.md"))) -Message "Dry-run created handoff.md."

    $corruptRoot = New-TestMemoryRoot
    $roots.Add($corruptRoot)
    $corruptStatePath = Join-Path $corruptRoot ".dream-state.json"
    $corruptState = "{ this is not valid json"
    $corruptState | Set-Content -LiteralPath $corruptStatePath -Encoding UTF8
    $beforeCorruptFiles = @(Get-RelativeFileSet -Root $corruptRoot)

    & $runner -MemoryRoot $corruptRoot -DryRun | Out-Null

    $afterCorruptFiles = @(Get-RelativeFileSet -Root $corruptRoot)
    Assert-FileSetEqual -Before $beforeCorruptFiles -After $afterCorruptFiles -Message "Dry-run with corrupt state changed the file set."
    Assert-True -Condition ((Get-Content -LiteralPath $corruptStatePath -Raw) -eq ($corruptState + [Environment]::NewLine)) -Message "Dry-run rewrote corrupt existing state."

    $noPendingRoot = New-TestMemoryRoot
    $roots.Add($noPendingRoot)
    $noPendingStatePath = Join-Path $noPendingRoot ".dream-state.json"
    [ordered]@{
        version = "1.1"
        last_run = "2026-01-01T00:00:00.0000000Z"
        last_processed_file = "2026-01-01-session.md"
        processed_total = 1
        last_session_title = "Temp dry-run fixture"
        pending_count = 0
        open_items = @()
        next_work = @()
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $noPendingStatePath -Encoding UTF8
    $beforeNoPendingFiles = @(Get-RelativeFileSet -Root $noPendingRoot)
    $beforeNoPendingState = Get-Content -LiteralPath $noPendingStatePath -Raw

    & $runner -MemoryRoot $noPendingRoot -DryRun | Out-Null

    $afterNoPendingFiles = @(Get-RelativeFileSet -Root $noPendingRoot)
    Assert-FileSetEqual -Before $beforeNoPendingFiles -After $afterNoPendingFiles -Message "Dry-run with no pending sessions changed the file set."
    Assert-True -Condition ((Get-Content -LiteralPath $noPendingStatePath -Raw) -eq $beforeNoPendingState) -Message "Dry-run with no pending sessions rewrote existing state."

    $normalRoot = New-TestMemoryRoot
    $roots.Add($normalRoot)

    & $runner -MemoryRoot $normalRoot | Out-Null

    foreach ($fileName in @(".dream-state.json", "cache.md", "SHORT.md", "handoff.md")) {
        Assert-True -Condition (Test-Path -LiteralPath (Join-Path $normalRoot $fileName)) -Message "Non-dry run did not create $fileName."
    }

    $state = Get-Content -LiteralPath (Join-Path $normalRoot ".dream-state.json") -Raw | ConvertFrom-Json
    Assert-True -Condition ($state.last_processed_file -eq "2026-01-01-session.md") -Message "Non-dry run did not persist the expected cursor."
    Assert-True -Condition ([int]$state.processed_total -eq 1) -Message "Non-dry run did not persist the expected processed count."

    Write-Output "run_dream.ps1 validation passed."
} finally {
    foreach ($root in $roots) {
        if (Test-Path -LiteralPath $root) {
            Remove-Item -LiteralPath $root -Recurse -Force
        }
    }
}
