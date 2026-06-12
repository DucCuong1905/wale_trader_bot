import MetaTrader5 as mt5
import pandas as pd
from datetime import datetime
import os
import time

# ==========================================================
# CẤU HÌNH THƯ MỤC DỮ LIỆU VÀ SYMBOLS PHỔ BIẾN
# ==========================================================
# Script sẽ tự động quét danh sách này để tìm Symbol hoạt động trên sàn của bạn.
COMMON_SYMBOLS = ["BTCUSD", "BTCUSDc", "BTCUSDm", "BTCUSD.v", "BTCUSDt", "BTCUSD.e", "BTCUSDT"]
OUTPUT_DIR = "C:/btc_data"

# ==========================================================
# CẤU HÌNH THỜI GIAN TẢI DỮ LIỆU TÙY CHỈNH
# ==========================================================
# Mặc định đặt True để tải sỉ nguyên cả khối lịch sử từng năm (2018 -> Hiện tại)
CHE_DO_TAI_NAM = True  

# Mốc thời gian nếu CHE_DO_TAI_NAM = False:
NGAY_BAT_DAU = datetime(2026, 1, 1)    # Tải từ đầu năm 2026
NGAY_KET_THUC = datetime(2026, 6, 1)   # Đến đầu tháng 6 năm 2026
FILE_TEN_TUY_CHINH = "2026_btc.csv"  # Tên file lưu trữ dữ liệu tùy chỉnh

def download_data():
    global OUTPUT_DIR
    print("=== MT5 BITCOIN DATA DOWNLOADER FOR BACKTEST ===")
    print(f"Thư mục lưu mặc định: {OUTPUT_DIR}")

    # Tạo thư mục lưu trữ nếu chưa tồn tại
    if not os.path.exists(OUTPUT_DIR):
        try:
            os.makedirs(OUTPUT_DIR)
            print(f"🟢 Đã tạo thư mục thành công: {OUTPUT_DIR}")
        except Exception as e:
            # Nếu không tạo được thư mục ổ C (ví dụ do phân quyền / hệ điều hành khác), lưu vào thư mục data của dự án
            project_data_dir = os.path.join(os.getcwd(), 'data')
            if not os.path.exists(project_data_dir):
                os.makedirs(project_data_dir)
            OUTPUT_DIR = project_data_dir
            print(f"⚠️ Không thể tạo thư mục ổ C. Chuyển hướng lưu vào: {OUTPUT_DIR}")

    # Kết nối tới MT5
    if not mt5.initialize():
        print("❌ Kết nối MT5 thất bại! Vui lòng đảm bảo phần mềm MetaTrader 5 đã được mở và chạy trên máy tính/VPS.")
        return

    print("🟢 Đã kết nối thành công tới MetaTrader 5!")

    # Quét dò tìm Symbol hoạt động từ danh sách phổ biến
    SYMBOL = None
    for sym in COMMON_SYMBOLS:
        if mt5.symbol_select(sym, True):
            SYMBOL = sym
            print(f"🎯 Đã tìm thấy và chọn thành công Symbol giao dịch: '{SYMBOL}'")
            break
            
    if SYMBOL is None:
        print("❌ Không tìm thấy Symbol Bitcoin nào hoạt động trong Market Watch!")
        print("Các Symbol đã kiểm tra thử:", COMMON_SYMBOLS)
        print("Vui lòng mở MT5 -> bấm chuột phải vào Market Watch -> chọn 'Show All' rồi chạy lại script này.")
        mt5.shutdown()
        return

    if not CHE_DO_TAI_NAM:
        # CHẾ ĐỘ 1: TẢI THEO PHẠM VI NGÀY TÙY CHỈNH CHỈ ĐỊNH
        print(f"\n⏳ [CHẾ ĐỘ TÙY CHỈNH] Đang yêu cầu tải dữ liệu nến M1 từ {NGAY_BAT_DAU.strftime('%Y-%m-%d')} đến {NGAY_KET_THUC.strftime('%Y-%m-%d')}...")
        rates = None
        max_retries = 15
        
        for attempt in range(1, max_retries + 1):
            rates = mt5.copy_rates_range(
                SYMBOL,
                mt5.TIMEFRAME_M1,
                NGAY_BAT_DAU,
                NGAY_KET_THUC
            )
            count = len(rates) if rates is not None else 0
            if rates is not None and count > 0:
                print(f"   👉 [Lần thử {attempt}] Đã tải thành công {count:,} nến!")
                break
            else:
                print(f"   ⚠️ [Lần thử {attempt}] MT5 phản hồi {count} nến. Đang chờ đồng bộ hóa dữ liệu từ Broker...")
                time.sleep(2.5)

        if rates is None or len(rates) == 0:
            print(f"❌ Không thể lấy dữ liệu nến cho khoảng thời gian tùy chỉnh.")
        else:
            df = pd.DataFrame(rates)
            df['time'] = pd.to_datetime(df['time'], unit='s')
            file_path = os.path.join(OUTPUT_DIR, FILE_TEN_TUY_CHINH)
            df.to_csv(file_path, index=False)
            print(f"✅ ĐÃ LƯU THÀNH CÔNG: {len(df):,} nến vào file: {file_path}")

    else:
        # CHẾ ĐỘ 2: TẢI THEO KHỐI TỪNG NĂM
        current_year = datetime.now().year
        for year in range(2018, current_year + 1):
            print(f"\n⏳ [CHẾ ĐỘ NĂM] Đang yêu cầu tải dữ liệu nến M1 năm {year}...")
            
            start_date = datetime(year, 1, 1)
            end_date = datetime(year + 1, 1, 1)

            rates = None
            max_retries = 12
            
            for attempt in range(1, max_retries + 1):
                rates = mt5.copy_rates_range(
                    SYMBOL,
                    mt5.TIMEFRAME_M1,
                    start_date,
                    end_date
                )
                
                count = len(rates) if rates is not None else 0
                is_insufficient = (year < current_year and count < 10000) or (year == current_year and count == 0)
                
                if not is_insufficient and rates is not None and len(rates) > 0:
                    print(f"   👉 [Lần thử {attempt}] Đã tải thành công {count:,} nến!")
                    break
                else:
                    print(f"   ⚠️ [Lần thử {attempt}] MT5 phản hồi {count} nến. Đang chờ đồng bộ hóa dữ liệu từ Broker...")
                    time.sleep(2.5)

            if rates is None or len(rates) <= 1:
                print(f"❌ Không thể lấy dữ liệu nến thực tế cho năm {year}.")
                continue

            df = pd.DataFrame(rates)
            df['time'] = pd.to_datetime(df['time'], unit='s')
            file_path = os.path.join(OUTPUT_DIR, f"{year}_btc.csv")
            df.to_csv(file_path, index=False)
            print(f"✅ ĐÃ LƯU THÀNH CÔNG: {len(df):,} nến chuẩn vào: {file_path}")

    mt5.shutdown()
    print("\n🎉 HOÀN THÀNH TẢI DỮ LIỆU LỊCH SỬ BITCOIN CHẤT LƯỢNG CAO!")

if __name__ == "__main__":
    download_data()
