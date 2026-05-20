# --- FIX FONT CHỮ TIẾNG VIỆT TRÊN POWERSHELL ---
$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

# --- CẤU HÌNH ---
$APP_NAME = "whale"

Write-Host "------------------------------------------------" -ForegroundColor White
Write-Host "🚀 ĐANG CẬP NHẬT WHALE BOT (WINDOWS)..." -ForegroundColor Yellow
Write-Host "------------------------------------------------" -ForegroundColor White

# 1. Dừng Bot cũ (nếu có)
Write-Host "🛑 Đang dừng Bot hiện tại..." -ForegroundColor Cyan
pm2 stop $APP_NAME 2>$null
pm2 delete $APP_NAME 2>$null

# 2. Cập nhật code từ GitHub
Write-Host "📂 Đang kéo code mới nhất từ GitHub..." -ForegroundColor Cyan
git reset --hard HEAD 2>$null
git pull origin main 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️  Cảnh báo: Không thể kéo code qua Git. Nếu bạn tải file ZIP thủ công, vui lòng bỏ qua cảnh báo này." -ForegroundColor Yellow
}

# 3. Cài đặt thư viện (Bao gồm cả devDependencies để có esbuild, vite)
Write-Host "📦 Cài đặt dependencies (npm install --include=dev)..." -ForegroundColor Cyan
npm install --include=dev
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ LỖI: Cài đặt thư viện (npm install) thất bại!" -ForegroundColor Red
    exit 1
}

# 4. Build dự án
Write-Host "🏗️ Đang build dự án (npm run build)..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ LỖI: Build dự án thất bại! Vui lòng kiểm tra lỗi ở trên." -ForegroundColor Red
    exit 1
}

# 5. Kiểm tra file dist/server.cjs
if (!(Test-Path "dist/server.cjs")) {
    Write-Host "❌ LỖI: Không tìm thấy file dist/server.cjs sau khi build!" -ForegroundColor Red
    exit 1
}

# 6. Khởi động lại Bot bằng PM2
Write-Host "🔄 Đang khởi động lại Bot bằng PM2..." -ForegroundColor Cyan
pm2 flush
pm2 start dist/server.cjs --name "$APP_NAME"
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️  Thử khởi động PM2 ở chế độ trực tiếp (node dist/server.cjs)..." -ForegroundColor Yellow
    pm2 start node --name "$APP_NAME" -- dist/server.cjs
}

# 7. Lưu cấu hình PM2
if ($LASTEXITCODE -eq 0) {
    pm2 save
    Write-Host "------------------------------------------------" -ForegroundColor White
    Write-Host "✅ CẬP NHẬT HOÀN TẤT VÀ KHỞI ĐỘNG THÀNH CÔNG!" -ForegroundColor Green
    Write-Host "------------------------------------------------" -ForegroundColor White
    Write-Host "👉 Xem log Bot bằng lệnh: pm2 logs $APP_NAME" -ForegroundColor Yellow
    Write-Host "------------------------------------------------" -ForegroundColor White
} else {
    Write-Host "❌ LỖI: Không thể khởi động Bot với PM2!" -ForegroundColor Red
    exit 1
}
