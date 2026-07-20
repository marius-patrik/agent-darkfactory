$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $repoRoot
try {
    $agentPackage = Get-Content -LiteralPath "agent.package.json" -Raw | ConvertFrom-Json
    if ($agentPackage.schemaVersion -ne 1) { throw "agent.package.json schemaVersion must be 1." }
    if ($agentPackage.id -ne "dream") { throw "agent.package.json id must be dream." }
    if ($agentPackage.kind -ne "plugin") { throw "agent.package.json kind must be plugin." }

    $pluginPackage = Get-Content -LiteralPath ".codex-plugin/plugin.json" -Raw | ConvertFrom-Json
    if ($pluginPackage.name -ne "dream") { throw ".codex-plugin/plugin.json name must be dream." }

    $skill = Get-Content -LiteralPath "skills/dream/SKILL.md" -Raw
    if ($skill -notmatch '(?s)^---\s*\r?\nname:\s*dream\r?\n') {
        throw "skills/dream/SKILL.md must have dream frontmatter."
    }

    $agentConfig = Get-Content -LiteralPath "skills/dream/agents/openai.yaml" -Raw
    foreach ($required in @("interface:", "display_name:", "short_description:", "default_prompt:")) {
        if ($agentConfig -notmatch "(?m)^\s*$([regex]::Escape($required))") {
            throw "skills/dream/agents/openai.yaml missing $required"
        }
    }

    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        (Resolve-Path "skills/dream/scripts/run_dream.ps1"),
        [ref]$null,
        [ref]$parseErrors
    ) | Out-Null
    if ($parseErrors.Count -gt 0) {
        throw "PowerShell parser errors in run_dream.ps1: $($parseErrors[0].Message)"
    }

    Write-Output "Dream plugin validation passed."
} finally {
    Pop-Location
}
