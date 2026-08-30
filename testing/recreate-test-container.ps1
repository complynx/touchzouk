[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$composeFile = Join-Path $PSScriptRoot "docker-compose.yml"
$projectName = "touchzouk-test"
$legacyProjectName = "testing"
$serviceLabel = "label=com.docker.compose.service=touchzouk-demo"
$healthURL = "http://127.0.0.1:8000/healthz"

function Invoke-Docker {
    param([Parameter(Mandatory)][string[]]$Arguments)

    & docker @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "docker $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Get-DemoContainerIDs {
    param([switch]$RunningOnly)

    $ids = foreach ($candidateProject in @($projectName, $legacyProjectName)) {
        $arguments = @("ps")
        if (-not $RunningOnly) {
            $arguments += "--all"
        }
        $arguments += @(
            "--quiet",
            "--filter", $serviceLabel,
            "--filter", "label=com.docker.compose.project=$candidateProject"
        )
        & docker @arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Could not inspect existing local test containers"
        }
    }
    return @($ids | Where-Object { $_ -and $_.Trim() } | Sort-Object -Unique)
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker is not installed or is not available on PATH"
}

Invoke-Docker -Arguments @("version", "--format", "{{.Server.Version}}")
Invoke-Docker -Arguments @("compose", "version")

$existing = @(Get-DemoContainerIDs)
if ($existing.Count) {
    Write-Host "Found $($existing.Count) older local Touchzouk test container(s)."
}

# The stable project name makes current runs predictable. The scoped label cleanup
# also catches the `testing` project created by the older README command without -p.
Invoke-Docker -Arguments @(
    "compose", "--project-name", $projectName,
    "--file", $composeFile,
    "down", "--remove-orphans", "--volumes"
)

$running = @(Get-DemoContainerIDs -RunningOnly)
if ($running.Count) {
    Write-Host "Stopping older local Touchzouk test container(s)..."
    Invoke-Docker -Arguments (@("stop") + $running)
}

$remaining = @(Get-DemoContainerIDs)
if ($remaining.Count) {
    Write-Host "Removing older local Touchzouk test container(s)..."
    Invoke-Docker -Arguments (@("rm", "--force") + $remaining)
}

Write-Host "Building and starting a clean seeded Touchzouk test container..."
Invoke-Docker -Arguments @(
    "compose", "--project-name", $projectName,
    "--file", $composeFile,
    "up", "--build", "--detach", "--force-recreate", "--wait", "--wait-timeout", "120"
)

$response = Invoke-WebRequest -Uri $healthURL -UseBasicParsing
if ($response.StatusCode -ne 200) {
    throw "Touchzouk healthcheck returned HTTP $($response.StatusCode)"
}

Write-Host ""
Write-Host "Touchzouk test container is healthy."
Write-Host "Sound Atlas: http://127.0.0.1:8000/listen"
Write-Host "Admin:       http://127.0.0.1:8000/admin"
Write-Host "Static files are mounted from: $(Resolve-Path (Join-Path $PSScriptRoot '..\site'))"
Write-Host "CSS and JavaScript edits are visible after a browser refresh; no container restart is needed."
