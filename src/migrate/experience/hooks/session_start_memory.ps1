$ErrorActionPreference = "Stop"

$memoryRoot = Join-Path $env:USERPROFILE ".codex\memories"
$files = New-Object System.Collections.Generic.List[object]

$layeredFiles = @(
    @{ Title = "Long-term general operating rules"; Path = "LONG.md"; Tag = "[long-term]" },
    @{ Title = "Short-term multi-session memory"; Path = "SHORT.md"; Tag = "[short-term]" },
    @{ Title = "Immediate task cache"; Path = "cache.md"; Tag = "[task-cache]" },
    @{ Title = "Latest handoff"; Path = "handoff.md"; Tag = "[handoff]" },
    @{ Title = "Memory summary"; Path = "memory_summary.md"; Tag = "" },
    @{ Title = "Memory registry"; Path = "MEMORY.md"; Tag = "" },
    @{ Title = "Parked memory"; Path = "PARK.md"; Tag = "[parked]" },
    @{ Title = "Distilled archive"; Path = "ARCHIVE.md"; Tag = "[archive]" }
)

foreach ($layer in $layeredFiles) {
    $files.Add([pscustomobject]@{
        Title = $layer.Title
        Path = Join-Path $memoryRoot $layer.Path
        Tag = $layer.Tag
    })
}

$notesDir = Join-Path $memoryRoot "extensions\ad_hoc\notes"
if (Test-Path -LiteralPath $notesDir) {
    Get-ChildItem -LiteralPath $notesDir -Filter "*.md" -File |
        Sort-Object Name |
        ForEach-Object {
            $files.Add([pscustomobject]@{
                Title = "Ad-hoc memory note: $($_.BaseName)"
                Path = $_.FullName
                Tag = "[ad-hoc note]"
            })
        }
}

$sections = New-Object System.Collections.Generic.List[string]
$sections.Add("Startup memory enforcement: before acting, use this layered memory context. Treat current repo files, live tool outputs, and explicit user instructions as higher priority than stale memory.")

foreach ($file in $files) {
    if (Test-Path -LiteralPath $file.Path) {
        $content = Get-Content -LiteralPath $file.Path -Raw
        $tag = if ([string]::IsNullOrWhiteSpace($file.Tag)) { "" } else { " $($file.Tag)" }
        $sections.Add("## $($file.Title)$tag`nSource: $($file.Path)`n$content")
    } else {
        $sections.Add("## Missing memory file`nSource not found: $($file.Path)")
    }
}

$output = @{
    continue = $true
    hookSpecificOutput = @{
        hookEventName = "SessionStart"
        additionalContext = ($sections -join "`n`n---`n`n")
    }
}

$output | ConvertTo-Json -Depth 5 -Compress
