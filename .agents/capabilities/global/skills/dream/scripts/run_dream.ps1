param(
    [string]$MemoryRoot = (Join-Path $env:USERPROFILE ".codex\memories"),
    [int]$MaxSessions = 0,
    [switch]$Reset,
    [switch]$DryRun,
    [switch]$VerboseRun
)

$ErrorActionPreference = "Stop"

$statePath = Join-Path $MemoryRoot ".dream-state.json"
$rolloutRoot = Join-Path $MemoryRoot "rollout_summaries"
$cachePath = Join-Path $MemoryRoot "cache.md"
$shortPath = Join-Path $MemoryRoot "SHORT.md"
$handoffPath = Join-Path $MemoryRoot "handoff.md"

function Ensure-Directory {
    param([Parameter(Mandatory=$true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Parse-Sections {
    param([Parameter(Mandatory=$true)][string]$Text)

    $sections = @{}
    $current = "preamble"
    $buffer = New-Object System.Collections.Generic.List[string]
    $lines = $Text -split "`r?`n"

    foreach ($line in $lines) {
        if ($line -match '^(?m)^(#{1,3})\s*(.+?)\s*$') {
            $sections[$current] = ($buffer -join "`n").Trim()
            $current = $matches[2].Trim()
            $buffer.Clear()
            continue
        }

        $buffer.Add($line)
    }

    $sections[$current] = ($buffer -join "`n").Trim()
    return $sections
}

function Extract-SessionFacts {
    param([Parameter(Mandatory=$true)][System.IO.FileInfo]$SummaryFile)

    $raw = Get-Content -LiteralPath $SummaryFile.FullName -Raw
    $sections = Parse-Sections -Text $raw

    $threadId = ""
    if ($raw -match '(?im)^thread_id:\s*(.+)$') {
        $threadId = $Matches[1].Trim()
    }

    $updatedAt = ""
    if ($raw -match '(?im)^updated_at:\s*(.+)$') {
        $updatedAt = $Matches[1].Trim()
    } elseif ($raw -match '(?im)^Cwd:\s*(.+)$') {
        $updatedAt = $Matches[1].Trim()
    } else {
        $updatedAt = $SummaryFile.Name
    }

    $title = if ($sections.Keys -contains "Summary") { $sections["Summary"] -split "`r?`n" | Select-Object -First 1 } else { $SummaryFile.Name }
    $title = if ($title) { $title.Trim() } else { $SummaryFile.Name }

    $tasks = New-Object System.Collections.Generic.List[object]
    $followUps = New-Object System.Collections.Generic.List[string]
    $lessons = New-Object System.Collections.Generic.List[string]
    $open = New-Object System.Collections.Generic.List[string]
    $status = "complete"

    $taskSections = $sections.Keys | Where-Object { $_ -match '^Task\s+\d+:' } | Sort-Object
    foreach ($task in $taskSections) {
        $taskText = $sections[$task]
        $outcome = "in_progress"
        $taskFollowUps = New-Object System.Collections.Generic.List[string]

        if ($taskText -match '(?im)^Outcome:\s*(.+)$') {
            $outcome = $Matches[1].Trim()
        } elseif ($taskText -match '(?im)^Result:\s*(.+)$') {
            $outcome = $Matches[1].Trim()
        } elseif ($taskText -match '(?im)^Status:\s*(.+)$') {
            $outcome = $Matches[1].Trim()
        }

        if ($taskText -match '(?im)^Follow-ups:\s*$') {
            $capture = $true
            $lines = $taskText -split "`r?`n"
            $inFollowUp = $false
            foreach ($line in $lines) {
                if ($line -match '(?im)^Follow-ups:\s*$') { $inFollowUp = $true; continue }
                if (-not $inFollowUp) { continue }
                if ($line -match '^\s*[-*+]\s+') {
                    $taskFollowUps.Add($line.Trim())
                } elseif ($line -match '^\s*$') {
                    continue
                } else {
                    break
                }
            }
        }

        $lower = $outcome.ToLowerInvariant()
        if ($lower -match "fail|blocked|error|crash|todo|to do|pending|unfinished|in progress|attention|needs") {
            $status = "attention_needed"
            $open.Add("$task => $outcome")
            foreach ($fu in $taskFollowUps) { $open.Add("$task follow-up: $fu") }
        }

        if ($taskFollowUps.Count -gt 0) {
            foreach ($fu in $taskFollowUps) { $followUps.Add("$task $fu") }
        }

        $tasks.Add([ordered]@{
            name = $task
            outcome = $outcome
            followUps = $taskFollowUps.ToArray()
        })
    }

    if ($sections.Keys -contains "Reusable knowledge") {
        $lessonText = $sections["Reusable knowledge"]
        $lessonLines = $lessonText -split "`r?`n" | Where-Object {
            $_.Trim().Length -gt 0 -and $_.Trim().StartsWith("-")
        }
        foreach ($line in ($lessonLines | Select-Object -First 2)) {
            $lessons.Add($line.TrimStart("-").Trim())
        }
    }

    if ($sections.Keys -contains "Fail") {
        $failText = $sections["Fail"].Split("`n")[0].Trim()
        if (-not [string]::IsNullOrWhiteSpace($failText)) {
            $status = "attention_needed"
            $open.Add("Session-level fail: $failText")
        }
    }

    if ($sections.Keys -contains "Outcomes") {
        $resultText = $sections["Outcomes"]
        if ($resultText -match '(?im)overall:\s*(.+)$' -and $Matches.Count -gt 1) {
            $ov = $Matches[1].Trim()
            if ($ov -match "open|in progress|todo|pending|needs|fail|blocked") {
                $status = "attention_needed"
                $open.Add("Overall: $ov")
            }
        }
    } elseif (-not $taskSections -and $sections.Keys -contains "Task Status") {
        $statusText = $sections["Task Status"]
        if ($statusText -match '(?im)^-?\s*(.+?)\s*:\s*(.+)$') {
            $entries = [regex]::Matches($statusText, '(?im)^\s*-\s*(.+?)\s*:\s*(.+?)\s*$')
            foreach ($e in $entries) {
                $itemOutcome = $e.Groups[2].Value.ToLowerInvariant()
                if ($itemOutcome -match "fail|blocked|pending|todo|pending") {
                    $status = "attention_needed"
                    $open.Add($e.Value.Trim())
                }
            }
        }
    }

    if ($status -eq "complete" -and $followUps.Count -gt 0) {
        $status = "attention_needed"
    }

    return [pscustomobject]@{
        file = $SummaryFile.Name
        path = $SummaryFile.FullName
        thread_id = $threadId
        title = $title
        updated_at = $updatedAt
        tasks = $tasks.ToArray()
        follow_ups = $followUps.ToArray()
        lessons = $lessons.ToArray()
        status = $status
        open_items = $open.ToArray()
        raw_headings = $sections.Keys | Select-Object -First 8
    }
}

function Update-Block {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$Start,
        [Parameter(Mandatory=$true)][string]$End,
        [Parameter(Mandatory=$true)][string]$Section
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        "# $([System.IO.Path]::GetFileNameWithoutExtension($Path))`r`n" | Set-Content -LiteralPath $Path -Encoding UTF8
    }

    $existing = Get-Content -LiteralPath $Path -Raw
    $pattern = "(?s)" + [regex]::Escape($Start) + ".*?" + [regex]::Escape($End)
    if ($existing -match $pattern) {
        $updated = [regex]::Replace($existing, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $Section })
    } else {
        $updated = $existing.TrimEnd() + "`r`n`r`n" + $Section + "`r`n"
    }

    Set-Content -LiteralPath $Path -Value $updated -Encoding UTF8
}

function Normalize-Items {
    param([Parameter(Mandatory=$true)]$Items)
    $results = New-Object System.Collections.Generic.List[string]
    foreach ($item in $Items) {
        if ([string]::IsNullOrWhiteSpace($item)) { continue }
        $clean = ($item -replace '\s+', ' ').Trim()
        if ($clean.Length -gt 260) { $clean = $clean.Substring(0, 257) + "..." }
        $results.Add($clean)
    }
    return $results.ToArray()
}

function New-EmptyState {
    return [ordered]@{
        version = "1.1"
        last_run = ""
        last_processed_file = ""
        processed_total = 0
        last_session_title = ""
        pending_count = 0
        open_items = @()
        next_work = @()
    }
}

if (-not $DryRun) {
    Ensure-Directory -Path $MemoryRoot
}

if (-not (Test-Path -LiteralPath $rolloutRoot)) {
    throw "Missing rollout summaries folder: $rolloutRoot"
}

$now = Get-Date -Format o
$nowPretty = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"

$storedState = $null
if (-not (Test-Path -LiteralPath $statePath)) {
    $storedState = New-EmptyState
} else {
    try {
        $storedState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    } catch {
        $storedState = New-EmptyState
    }
}

$cursor = if ($Reset) { "" } else { if ($storedState.last_processed_file) { [string]$storedState.last_processed_file } else { "" } }

$allSessions = Get-ChildItem -LiteralPath $rolloutRoot -Filter "*.md" -File | Sort-Object -Property Name
if ($allSessions.Count -eq 0) {
    throw "No rollout summary files found under $rolloutRoot"
}

$pending = if ([string]::IsNullOrWhiteSpace($cursor)) {
    $allSessions
} else {
    $allSessions | Where-Object { $_.Name -gt $cursor }
}

if ($MaxSessions -gt 0 -and $pending.Count -gt $MaxSessions) {
    $toProcess = $pending | Select-Object -First $MaxSessions
    $remaining = $pending.Count - $toProcess.Count
} else {
    $toProcess = $pending
    $remaining = 0
}

if ($VerboseRun) {
    Write-Output "Dream workflow stage: discovery"
    Write-Output "Known state cursor: $(if ([string]::IsNullOrWhiteSpace($cursor)) { "<none>" } else { $cursor })"
    Write-Output "Pending sessions: $($pending.Count)"
    Write-Output "Will process: $($toProcess.Count)"
    Write-Output "Remaining after run: $remaining"
}

if ($toProcess.Count -eq 0) {
    if (-not $DryRun) {
        $storedState.last_run = $now
        $storedState.pending_count = 0
        $storedState.next_work = @()
        $storedState.version = "1.1"
        $storedState | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8

        Update-Block -Path $cachePath -Start "<!-- rommie:dream:cache:start -->" -End "<!-- rommie:dream:cache:end -->" -Section @"
<!-- rommie:dream:cache:start -->
## Dream Cache
Updated: $nowPretty
- No new sessions since last cursor ($cursor).
- Total processed: $($storedState.processed_total)
- Last run: $nowPretty
<!-- rommie:dream:cache:end -->
"@
    }

    Write-Output "No new sessions to process."
    exit 0
}

# Multi-agent style workflow:
# 1) Replay worker: parse each session summary in strict order.
# 2) Retrospective worker: infer unresolved work and lessons.
# 3) Memory worker: write state + update LONG/LONG-running memory files.

$results = New-Object System.Collections.Generic.List[object]
$allOpenItems = New-Object System.Collections.Generic.List[string]
$allLessons = New-Object System.Collections.Generic.List[string]
$completeCount = 0
$attentionCount = 0

foreach ($session in $toProcess) {
    if ($VerboseRun) { Write-Output "Replay worker: analyzing $($session.Name)" }
    $result = Extract-SessionFacts -SummaryFile $session
    if ($result.status -eq "attention_needed") { $attentionCount++ } else { $completeCount++ }

    foreach ($open in $result.open_items) { $allOpenItems.Add("[$($session.Name)] $open") }
    foreach ($lesson in $result.lessons) { $allLessons.Add("[$($session.Name)] $lesson") }
    $results.Add($result)
}

$openItems = Normalize-Items -Items $allOpenItems | Select-Object -Unique
$lessons = Normalize-Items -Items $allLessons | Select-Object -Unique
$nextCursor = $toProcess[-1].Name
$remaining = $pending.Count - $toProcess.Count
$sessionNames = $toProcess | ForEach-Object { $_.Name }
$processedTotal = [int]($storedState.processed_total) + $toProcess.Count

$openPreview = if ($openItems.Count -gt 0) {
    $openItems | Select-Object -First 12 | ForEach-Object { "- $_" }
} else {
    @("- none")
}

$lessonPreview = if ($lessons.Count -gt 0) {
    $lessons | Select-Object -First 10 | ForEach-Object { "- $_" }
} else {
    @("- none")
}
$nextWorkPreview = if ($openItems.Count -gt 0) { 
    $openItems | Select-Object -First 8 | ForEach-Object { "- $_" }
} else { @("- none") }

$statusLabel = if ($openItems.Count -gt 0) { "attention_needed" } else { "coherent" }
$nextWork = if ($openItems.Count -gt 0) { $openItems } else { @("none") }

if ($DryRun) {
    Write-Output "Dry run: no state or memory files written."
    Write-Output ("Dream would process " + $toProcess.Count + " sessions:")
    $sessionNames | ForEach-Object { Write-Output " - $_" }
    Write-Output "Attention_needed sessions: $attentionCount"
    Write-Output "Open follow-ups: $($openItems.Count)"
    if ($openItems.Count -gt 0) {
        $openPreview | ForEach-Object { Write-Output " - $_" }
    }
    exit 0
}

$state = [ordered]@{
    version = "1.1"
    last_run = $now
    last_processed_file = $nextCursor
    processed_total = $processedTotal
    last_session_title = if ($results.Count -gt 0) { $results[-1].title } else { "" }
    pending_count = $remaining
    open_items = $openItems
    next_work = $nextWork
}
$state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8

if ($VerboseRun) {
    Write-Output "Retrospective worker: consolidating open items and lessons"
}

Update-Block -Path $cachePath -Start "<!-- rommie:dream:cache:start -->" -End "<!-- rommie:dream:cache:end -->" -Section @"
<!-- rommie:dream:cache:start -->
## Dream Cache
Updated: $nowPretty
- Sessions evaluated: $($toProcess.Count)
- Processed this run: $($toProcess.Count)
- Attention-needed sessions: $attentionCount
- Complete sessions: $completeCount
- Remaining pending sessions: $remaining
- Cursor advanced to: $nextCursor
- Open follow-ups: $($openItems.Count)

Open follow-ups (top):
$($openPreview -join "`r`n")
<!-- rommie:dream:cache:end -->
"@

Update-Block -Path $shortPath -Start "<!-- rommie:dream:short:start -->" -End "<!-- rommie:dream:short:end -->" -Section @"
<!-- rommie:dream:short:start -->
## Dream Retrospective Snapshot
Updated: $nowPretty
State: $statusLabel
Current objective: Keep unresolved and deferred work visible across sessions.
Last processed: $nextCursor

Important files/paths:
- $statePath
- $handoffPath
- $cachePath
- $shortPath
- $rolloutRoot

Open follow-ups:
$($openPreview -join "`r`n")

Reusable lessons:
$($lessonPreview -join "`r`n")

Next work to do:
$($nextWorkPreview -join "`r`n")
<!-- rommie:dream:short:end -->
"@

Update-Block -Path $handoffPath -Start "<!-- rommie:dream:handoff:start -->" -End "<!-- rommie:dream:handoff:end -->" -Section @"
<!-- rommie:dream:handoff:start -->
## Dream Retrospective
Updated: $nowPretty
Processed this run:
$($sessionNames | ForEach-Object { "- $_" } | Out-String -Width 4096).Trim()

Workflow outcome:
- sessions handled: $($toProcess.Count)
- attention-needed sessions: $attentionCount
- open follow-ups: $($openItems.Count)
- remaining sessions: $remaining
- next cursor: $nextCursor
- status: $statusLabel
<!-- rommie:dream:handoff:end -->
"@

if ($VerboseRun) {
    Write-Output "Memory worker: updated cache.md, SHORT.md, handoff.md and $statePath"
}

Write-Output "Dream workflow complete."
Write-Output ("Processed sessions: " + $toProcess.Count)
Write-Output ("Attention-needed items: " + $openItems.Count)
Write-Output ("Next cursor: " + $nextCursor)
