import MetaTrader5 as mt5
import pandas as pd
from datetime import datetime
import os

# ==========================================================
# Cấu hình Symbol. Bạn có thể đổi sang "XAUUSD" nếu MT5 của bạn đặt tên như vậy.
# ==========================================================
SYMBOL = "XAUUSDc"
OUTPUT_DIR = "C:/xau_data"

def download_data():
    print("=== MT5 DATA DOWNLOADER FOR BACKTEST ===")
    print(f"Pair: {SYMBOL}")
    print(f"Thư mục lưu: {OUTPUT_DIR}")

    # Tạo thư mục lưu trữ nếu chưa tồn tại
    if not os.path.exists(OUTPUT_DIR):
        try:
            os.makedirs(OUTPUT_DIR)
            print(f"🟢 Đã tạo thư mục: {OUTPUT_DIR}")
        except Exception as e:
            print(f"❌ Không thể tạo thư mục {OUTPUT_DIR}: {e}")
            return

    # Kết nối tới MT5
    if not mt5.initialize():
        print("❌ Kết nối MT5 thất bại! Vui lòng đảm bảo phần mềm MetaTrader 5 đã được mở và chạy trên VPS.")
        return

    print("🟢 Đã kết nối thành công tới MetaTrader 5!")

    # Duyệt tải dữ liệu từ 2018 đến 2026
    for year in range(2018, 2027):
        print(f"\n⏳ Đang tải dữ liệu nến M1 năm {year}...")
        
        start_date = datetime(year, 1, 1)
        end_date = datetime(year + 1, 1, 1)

        # Trích xuất dữ liệu nến M1 từ MT5
        rates = mt5.copy_rates_range(
            SYMBOL,
            mt5.TIMEFRAME_M1,
            start_date,
            end_date
        )

        if rates is None or len(rates) == 0:
            print(f"⚠️ Không có dữ liệu nến cho năm {year} (có thể MT5 chưa load kịp nến hoặc sai Symbol '{SYMBOL}').")
            continue

        # Chuyển đổi thành DataFrame để xử lý
        df = pd.DataFrame(rates)

        # Chuyển đổi cột thời gian UTC Epoch giây sang Date_time chuẩn
        df['time'] = pd.to_datetime(df['time'], unit='s')

        # Xác định đường dẫn file lưu trữ
        file_path = os.path.join(OUTPUT_DIR, f"{year}.csv")

        # Lưu DataFrame ra CSV (bao gồm đầy đủ: time, open, high, low, close, tick_volume, spread, real_volume)
        df.to_csv(file_path, index=False)
        print(f"✅ Đã lưu thành công {len(df):,} nến nạp chuẩn vào: {file_path}")

    mt5.shutdown()
    print("\n🎉 HOÀN THÀNH TẢI DỮ LIỆU LỊCH SỬ VÀNG!")

if __name__ == "__main__":
    download_data()
