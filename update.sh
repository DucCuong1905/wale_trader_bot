#!/bin/bash

# 1. Kéo code mới nhất từ GitHub
echo "🚀 Đang kéo code mới từ GitHub..."
git pull origin main

# 2. Cài đặt các thư viện mới (nếu có)
echo "📦 Đang cài đặt dependencies..."
npm install

# 3. Build lại ứng dụng
echo "🏗️ Đang build ứng dụng..."
npm run build

# 4. Khởi động lại service bằng PM2
echo "🔄 Dọn dẹp triệt để và khởi động lại Bot..."
# Xóa các process cũ có thể gây xung đột (whale-bot, whale-bo, v.v.)
pm2 delete whale-bot whale-bo 2>/dev/null || true
# Xóa sạch logs cũ
pm2 flush

# Khởi động Bot bằng npx tsx
pm2 start "npx tsx server.ts" --name "whale-bot"

# 5. Lưu trạng thái PM2
pm2 save

echo "✅ Đã cập nhật xong và Bot đang chạy! Dùng lệnh 'pm2 logs whale-bot' để xem log mới."
