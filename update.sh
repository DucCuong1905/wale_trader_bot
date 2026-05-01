#!/bin/bash

# --- CẤU HÌNH ---
APP_NAME="whale"

echo "------------------------------------------------"
echo "🚀 ĐANG CẬP NHẬT WHALE BOT..."
echo "------------------------------------------------"

# 1. Dừng Bot cũ (nếu có)
echo "🛑 Đang dừng Bot hiện tại..."
pm2 stop $APP_NAME 2>/dev/null || true
pm2 delete $APP_NAME 2>/dev/null || true
pm2 delete "whale-bot" 2>/dev/null || true # Dọn dẹp tên cũ nếu còn sót

# 2. Cập nhật code từ GitHub
echo "📂 Đang kéo code mới nhất..."
git reset --hard HEAD
git pull origin main

# 3. Cài đặt thư viện
echo "📦 Cài đặt dependencies (npm install)..."
npm install

# 4. Build Frontend (Vite)
echo "🏗️ Đang build lại Frontend..."
npm run build

# 5. Kiểm tra file server.ts
if [ ! -f "server.ts" ]; then
    echo "❌ LỖI: Không tìm thấy file server.ts!"
    exit 1
fi

# 6. Khởi động lại Bot bằng PM2 (Dùng npx tsx để chạy TypeScript trực tiếp)
echo "🔄 Đang khởi động lại Bot bằng PM2..."
pm2 flush
pm2 start "npx tsx server.ts" --name "$APP_NAME"

# 7. Lưu cấu hình PM2
pm2 save

echo "------------------------------------------------"
echo "✅ CẬP NHẬT HOÀN TẤT!"
echo "------------------------------------------------"
echo "👉 Xem log Bot bằng lệnh: pm2 logs $APP_NAME"
echo "------------------------------------------------"
