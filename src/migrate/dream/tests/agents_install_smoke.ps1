$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

function Find-AgentsManagerScript {
    if ($env:AGENTS_MANAGER_SCRIPT -and (Test-Path -LiteralPath $env:AGENTS_MANAGER_SCRIPT)) {
        return (Resolve-Path -LiteralPath $env:AGENTS_MANAGER_SCRIPT).Path
    }

    $agentsCommand = Get-Command agents -ErrorAction SilentlyContinue
    if (-not $agentsCommand -or -not (Test-Path -LiteralPath $agentsCommand.Source)) {
        return $null
    }

    $commandText = Get-Content -LiteralPath $agentsCommand.Source -Raw
    if ($commandText -match '(?m)set\s+"AGENTS_MANAGER_SCRIPT=([^"]+)"') {
        $candidate = $Matches[1]
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    return $null
}

function Invoke-AgentsManager {
    param(
        [Parameter(Mandatory=$true)][string]$Bun,
        [Parameter(Mandatory=$true)][string]$ManagerScript,
        [Parameter(Mandatory=$true)][string[]]$Arguments
    )

    $output = & $Bun $ManagerScript @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "agents manager failed: $($Arguments -join ' ')`n$($output -join "`n")"
    }
    return $output
}

$bun = Get-Command bun -ErrorAction SilentlyContinue
$managerScript = Find-AgentsManagerScript
if (-not $bun -or -not $managerScript) {
    Write-Output "agents install smoke skipped: agents manager is not available."
    exit 0
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("dream-agents-smoke-" + [System.Guid]::NewGuid().ToString("N"))
$oldEnv = @{}
foreach ($name in @(
    "AGENTS_HOME",
    "AGENTS_ROOT",
    "AGENTS_CLIS",
    "AGENTS_HARNESSES",
    "AGENTS_SKILLS",
    "AGENTS_PLUGINS",
    "AGENTS_HOOKS",
    "AGENTS_TEMPLATES",
    "AGENTS_SECRETS",
    "AGENTS_CREDITS",
    "AGENTS_DATA_REPOS"
)) {
    $oldEnv[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

try {
    $agentsHome = Join-Path $tempRoot ".agents"
    New-Item -ItemType Directory -Path $agentsHome -Force | Out-Null

    $env:AGENTS_HOME = $agentsHome
    $env:AGENTS_ROOT = $tempRoot
    $env:AGENTS_CLIS = Join-Path $agentsHome "clis"
    $env:AGENTS_HARNESSES = Join-Path $agentsHome "harnesses"
    $env:AGENTS_SKILLS = Join-Path $agentsHome "skills"
    $env:AGENTS_PLUGINS = Join-Path $agentsHome "plugins"
    $env:AGENTS_HOOKS = Join-Path $agentsHome "hooks"
    $env:AGENTS_TEMPLATES = Join-Path $agentsHome "templates"
    $env:AGENTS_SECRETS = Join-Path $agentsHome "secrets"
    $env:AGENTS_CREDITS = Join-Path $agentsHome "credits.json"
    $env:AGENTS_DATA_REPOS = Join-Path $agentsHome "data-repos.json"

    Push-Location $repoRoot
    try {
        Invoke-AgentsManager -Bun $bun.Source -ManagerScript $managerScript -Arguments @("packages", "register", ".") | Out-Null
        Invoke-AgentsManager -Bun $bun.Source -ManagerScript $managerScript -Arguments @("install", "plugin", "dream", ".") | Out-Null

        $packages = Invoke-AgentsManager -Bun $bun.Source -ManagerScript $managerScript -Arguments @("packages", "list", "--json") |
            Out-String |
            ConvertFrom-Json
        $installs = Invoke-AgentsManager -Bun $bun.Source -ManagerScript $managerScript -Arguments @("installs", "--json") |
            Out-String |
            ConvertFrom-Json

        $dreamPackage = @($packages | Where-Object { $_.id -eq "dream" -and $_.kind -eq "plugin" })
        if ($dreamPackage.Count -ne 1) {
            throw "Expected exactly one isolated Dream package registration."
        }
        if (-not ([string]$dreamPackage[0].path).StartsWith($agentsHome, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Dream package path escaped isolated AGENTS_HOME."
        }

        $dreamInstall = @($installs | Where-Object { $_.name -eq "dream" -and $_.kind -eq "plugin" })
        if ($dreamInstall.Count -ne 1) {
            throw "Expected exactly one isolated Dream plugin install."
        }
        if (-not ([string]$dreamInstall[0].path).StartsWith($agentsHome, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Dream install path escaped isolated AGENTS_HOME."
        }
    } finally {
        Pop-Location
    }

    Write-Output "agents install smoke passed."
} finally {
    foreach ($entry in $oldEnv.GetEnumerator()) {
        if ($null -eq $entry.Value) {
            Remove-Item "Env:$($entry.Key)" -ErrorAction SilentlyContinue
        } else {
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
        }
    }

    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
