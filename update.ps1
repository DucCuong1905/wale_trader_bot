# =========================================================
#             WHALE BOT UPDATE SCRIPT (WINDOWS)
# =========================================================

# Disable formatting warning
$ErrorActionPreference = "Stop"

# --- CONFIGURATION ---
$APP_NAME = "whale"

Write-Host "------------------------------------------------" -ForegroundColor White
Write-Host ">>> RUNNING UPDATE WHALE BOT (WINDOWS) <<<" -ForegroundColor Yellow
Write-Host "------------------------------------------------" -ForegroundColor White

# 1. Stop old bot process under PM2 and clean hanging processes on Windows
Write-Host "[1/6] Stopping existing PM2 process for app: $APP_NAME..." -ForegroundColor Cyan
try {
    pm2 stop $APP_NAME 2>$null
    pm2 delete $APP_NAME 2>$null
} catch {
    # Non-blocking if pm2 is not managed yet
}

# Kill any lingering node/esbuild processes to release file locks and prevent "The service was stopped" errors
Write-Host "Cleaning up lingering node/esbuild processes to release Windows file locks..." -ForegroundColor Cyan
Stop-Process -Name "node" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "esbuild" -Force -ErrorAction SilentlyContinue

# Clear Vite the build caches and old dist to ensure a clean build
Write-Host "Clearing cache directories..." -ForegroundColor Cyan
Remove-Item -Recurse -Force "node_modules/.vite" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "dist" -ErrorAction SilentlyContinue

# 2. Reset and Pull code from GitHub
Write-Host "[2/6] Pulling latest code from GitHub..." -ForegroundColor Cyan
git reset --hard HEAD
if ($LASTEXITCODE -ne 0) {
    Write-Host "[WARNING] git reset failed." -ForegroundColor Yellow
}
git pull origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host "[WARNING] git pull failed. If you downloaded manual ZIP, please ignore this warn." -ForegroundColor Yellow
}

# 3. Install packages (both standard and devDependencies)
Write-Host "[3/6] Installing dependencies (npm install)..." -ForegroundColor Cyan
npm install --include=dev
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] npm install failed!" -ForegroundColor Red
    exit 1
}

# Rebuild esbuild to ensure the correct Windows binary is compiled/refreshed
Write-Host "Refreshing native esbuild binary..." -ForegroundColor Cyan
npm rebuild esbuild
if ($LASTEXITCODE -ne 0) {
    Write-Host "[WARNING] npm rebuild esbuild failed, proceeding anyway..." -ForegroundColor Yellow
}

# 4. Build the application (runs Vite build and bundles server.ts)
Write-Host "[4/6] Building project (npm run build)..." -ForegroundColor Cyan
try {
    npm run build
} catch {
    Write-Host "[WARNING] Build threw an exception. Trying secondary build trigger..." -ForegroundColor Yellow
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "" -ForegroundColor Red
    Write-Host "================================================================" -ForegroundColor Yellow
    Write-Host "❌ BUILD FAILED: 'The service was stopped' error occurred." -ForegroundColor Red
    Write-Host "This is a common Windows issue caused by Antivirus/Windows Defender" -ForegroundColor Cyan
    Write-Host "blocking or killing the 'esbuild.exe' or 'esbuild-windows-64.exe' binary." -ForegroundColor Cyan
    Write-Host "" -ForegroundColor White
    Write-Host "👉 HOW TO FIX:" -ForegroundColor Green
    Write-Host "1. Temporarily disable 'Real-time protection' in Windows Defender/Antivirus." -ForegroundColor White
    Write-Host "2. Or allow/exclude your whale bot folder in your Antivirus settings." -ForegroundColor White
    Write-Host "3. Run this script again." -ForegroundColor White
    Write-Host "================================================================" -ForegroundColor Yellow
    exit 1
}

# 5. Verify build file exists
if (!(Test-Path "dist/server.cjs")) {
    Write-Host "[ERROR] Target output file dist/server.cjs was not found!" -ForegroundColor Red
    exit 1
}

# 6. Start the bot via PM2
Write-Host "[5/6] Starting bot via PM2..." -ForegroundColor Cyan
pm2 flush
pm2 start dist/server.cjs --name "$APP_NAME"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[WARNING] Direct PM2 start failed, trying node wrapper..." -ForegroundColor Yellow
    pm2 start node --name "$APP_NAME" -- dist/server.cjs
}

# 7. Save PM2 state
if ($LASTEXITCODE -eq 0) {
    pm2 save
    Write-Host "------------------------------------------------" -ForegroundColor White
    Write-Host ">>> UPDATE COMPLETED SUCCESSFULLY! <<<" -ForegroundColor Green
    Write-Host "------------------------------------------------" -ForegroundColor White
    Write-Host "To view real-time logs, run: pm2 logs $APP_NAME" -ForegroundColor Yellow
    Write-Host "------------------------------------------------" -ForegroundColor White
} else {
    Write-Host "[ERROR] PM2 failed to start the bot!" -ForegroundColor Red
    exit 1
}
