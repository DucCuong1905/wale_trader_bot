#!/bin/bash

# 1. Kéo code mới nhất từ GitHub
echo "🚀 Đang kéo code mới từ GitHub..."
git pull origin main

# 2. Cài đặt các thư viện mới (nếu có)
echo "📦 Đang cài đặt dependencies..."
npm install

# 3. Build lại ứng dụng (nếu bạn sử dụng Vite/Frontend)
echo "🏗️ Đang build ứng dụng..."
npm run build

# 4. Khởi động lại service bằng PM2
echo "🔄 Đang khởi động lại PM2..."
pm2 restart whale-bot --update-env

# 5. Lưu trạng thái PM2
pm2 save

echo "✅ Đã cập nhật xong và Bot đang chạy!"
