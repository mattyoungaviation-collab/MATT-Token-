param(
  [switch]$SkipInstall,
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not (Test-Path ".\package.json")) {
  throw "Extract this ZIP directly into the root of MATT-Token-live before running INSTALL-SLOTS.ps1."
}

Write-Host "Applying the isolated MATT Slots V1 integration..." -ForegroundColor Cyan
node .\scripts\apply-slots-integration.js
if ($LASTEXITCODE -ne 0) { throw "Slots integration failed." }

if (-not $SkipInstall) {
  Write-Host "Installing repository dependencies..." -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
}

if (-not $SkipTests) {
  Write-Host "Compiling and testing MATT Slots..." -ForegroundColor Cyan
  npm run test:slots
  if ($LASTEXITCODE -ne 0) { throw "Slots tests failed. Do not deploy." }
  npm run simulate:slots -- 1000000
  if ($LASTEXITCODE -ne 0) { throw "Slots simulation failed. Do not deploy." }
}

Write-Host "MATT Slots V1 is installed in the repository and remains deployment-locked." -ForegroundColor Green
Write-Host "Open website/public/slots.html or run npm start to review /slots." -ForegroundColor Green
