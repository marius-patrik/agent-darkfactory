$ErrorActionPreference = "Stop"

try {
    $memoryRoot = Join-Path $env:USERPROFILE ".codex\memories"
    $handoffPath = Join-Path $memoryRoot "handoff.md"
    $cachePath = Join-Path $memoryRoot "cache.md"
    $shortPath = Join-Path $memoryRoot "SHORT.md"

    if (-not (Test-Path -LiteralPath $memoryRoot)) {
        New-Item -ItemType Directory -Path $memoryRoot -Force | Out-Null
    }

    if (-not (Test-Path -LiteralPath $handoffPath)) {
        @"
# Handoff

Update this file when work is finished or paused so the next session can resume without reconstructing the whole thread.
"@ | Set-Content -LiteralPath $handoffPath -Encoding UTF8
    }

    $hookInput = ""
    if ([Console]::IsInputRedirected) {
        $hookInput = [Console]::In.ReadToEnd()
    }

    $eventName = "Stop"
    if (-not [string]::IsNullOrWhiteSpace($hookInput)) {
        try {
            $inputJson = $hookInput | ConvertFrom-Json
            if ($inputJson.hook_event_name) {
                $eventName = [string]$inputJson.hook_event_name
            } elseif ($inputJson.hookEventName) {
                $eventName = [string]$inputJson.hookEventName
            }
        } catch {
            $eventName = "Stop"
        }
    }

    function Get-MemoryStateLine {
        param(
            [Parameter(Mandatory=$true)][string]$Path,
            [Parameter(Mandatory=$true)][string]$Label
        )

        $sep = [char]58
        if (-not (Test-Path -LiteralPath $Path)) {
            return ("- " + $Label + $sep + " file missing.")
        }

        $text = Get-Content -LiteralPath $Path -Raw
        if ($text -match "(?m)^-\s+None\.\s*$") {
            return ("- " + $Label + $sep + " no active entries.")
        }

        $lines = $text -split "`r?`n" |
            Where-Object {
                $trimmed = $_.Trim()
                $trimmed.Length -gt 0 -and
                $trimmed -notmatch "^#" -and
                $trimmed -notmatch '^```'
            } |
            Select-Object -First 3

        if (-not $lines -or $lines.Count -eq 0) {
            return ("- " + $Label + $sep + " present but no summary lines found.")
        }

        $summary = (($lines -join " ") -replace "\s+", " ")
        return ("- " + $Label + $sep + " active content begins with" + $sep + " " + $summary)
    }

    $now = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    $cwd = (Get-Location).Path
    $cacheLine = Get-MemoryStateLine -Path $cachePath -Label "cache.md"
    $shortLine = Get-MemoryStateLine -Path $shortPath -Label "SHORT.md"
    $receivedInput = if ([string]::IsNullOrWhiteSpace($hookInput)) { "no" } else { "yes" }
    $begin = "<!-- experience:stop-handoff:start -->"
    $end = "<!-- experience:stop-handoff:end -->"

    $section = @"
$begin
## Automatic Stop Hook - latest
Updated: $now
Event: $eventName
CWD: ``$cwd``

Status:
- A Codex turn stopped. Review the thread transcript for the exact final response and decisions.
$cacheLine
$shortLine
- Hook input received: $receivedInput.
$end
"@

    $existing = Get-Content -LiteralPath $handoffPath -Raw
    $pattern = "(?s)<!-- (?:memory-plugin|context-engine|experience):stop-handoff:start -->.*?<!-- (?:memory-plugin|context-engine|experience):stop-handoff:end -->"

    if ($existing -match $pattern) {
        $updated = [regex]::Replace($existing, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $section })
    } else {
        $updated = $existing.TrimEnd() + "`r`n`r`n" + $section + "`r`n"
    }

    Set-Content -LiteralPath $handoffPath -Value $updated -Encoding UTF8
} catch {
    $logPath = Join-Path $env:USERPROFILE ".codex\hooks\stop_memory_handoff.error.log"
    "[$(Get-Date -Format o)] $($_.Exception.Message)" | Add-Content -LiteralPath $logPath -Encoding UTF8
}
