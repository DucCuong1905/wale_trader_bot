# --- FIX FONT CHỮ TIẾNG VIỆT TRÊN POWERSHELL ---
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

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
Write-Host "📂 Đang kéo code mới nhất..." -ForegroundColor Cyan
git reset --hard HEAD
git pull origin main

# 3. Cài đặt thư viện
Write-Host "📦 Cài đặt dependencies (npm install)..." -ForegroundColor Cyan
npm install

# 4. Build dự án
Write-Host "🏗️ Đang build dự án..." -ForegroundColor Cyan
npm run build

# 5. Kiểm tra file server.ts
if (!(Test-Path "server.ts")) {
    Write-Host "❌ LỖI: Không tìm thấy file server.ts!" -ForegroundColor Red
    exit 1
}

# 6. Khởi động lại Bot bằng PM2
Write-Host "🔄 Đang khởi động lại Bot bằng PM2..." -ForegroundColor Cyan
pm2 flush
pm2 start "npm start" --name "$APP_NAME"

# 7. Lưu cấu hình PM2
pm2 save

Write-Host "------------------------------------------------" -ForegroundColor White
Write-Host "✅ CẬP NHẬT HOÀN TẤT!" -ForegroundColor Green
Write-Host "------------------------------------------------" -ForegroundColor White
Write-Host "👉 Xem log Bot bằng lệnh: pm2 logs $APP_NAME" -ForegroundColor Yellow
Write-Host "------------------------------------------------" -ForegroundColor White
