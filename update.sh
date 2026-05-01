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
echo "🔄 Đang kiểm tra và khởi động lại PM2..."
# Xóa process cũ nếu có
pm2 delete whale-bot 2>/dev/null || true
# Khởi động mới bằng npm (Khuyên dùng cho script dev/start phức tạp)
pm2 start npm --name "whale-bot" -- run dev

# 5. Lưu trạng thái PM2
pm2 save

echo "✅ Đã cập nhật xong và Bot đang chạy!"
