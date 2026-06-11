import MetaTrader5 as mt5
import pandas as pd
from datetime import datetime
import os
import time

# ==========================================================
# Cấu hình Symbol và Thư mục dữ liệu. 
# Bạn có thể đổi sang "XAUUSD" nếu MT5 của bạn đặt tên như vậy.
# ==========================================================
SYMBOL = "XAUUSDc"
OUTPUT_DIR = "C:/xau_data"

# ==========================================================
# CẤU HÌNH THỜI GIAN TẢI DỮ LIỆU TÙY CHỈNH (Cực kỳ linh hoạt)
# ==========================================================
# Mặc định đặt True để tải theo khối từng năm (2018 -> Hiện tại).
# Đổi thành False nếu bạn chỉ muốn tải một khoảng thời gian ngắn cụ thể (Ví dụ: Tháng 5 và Tháng 6 năm 2026)
CHE_DO_TAI_NAM = False  

# Điền mốc thời gian nếu CHE_DO_TAI_NAM = False:
NGAY_BAT_DAU = datetime(2026, 1, 1)    # Định dạng: datetime(Năm, Tháng, Ngày) (Tải từ đầu năm 2026)
NGAY_KET_THUC = datetime(2027, 1, 1)   # Định dạng: datetime(Năm, Tháng, Ngày) (Hoặc lấy đến hết năm)
FILE_TEN_TUY_CHINH = "2026.csv"  # Tên file lưu trữ dữ liệu năm 2026 hoàn chỉnh

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

    # Đảm bảo Symbol được active trong Market Watch
    if not mt5.symbol_select(SYMBOL, True):
        print(f"⚠️ Không thể hiển thị Symbol '{SYMBOL}' trong Market Watch. Vui lòng kiểm tra lại tên Symbol chính xác trên sàn.")

    if not CHE_DO_TAI_NAM:
        # CHẾ ĐỘ 1: TẢI THEO PHẠM VI NGÀY TÙY CHỈNH CHỈ ĐỊNH (Ví dụ: chỉ lấy Tháng 5, Tháng 6 năm 2026)
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
        # CHẾ ĐỘ 2: TẢI THEO KHỐI TỪNG NĂM (2018 -> HIỆN TẠI)
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
            file_path = os.path.join(OUTPUT_DIR, f"{year}.csv")
            df.to_csv(file_path, index=False)
            print(f"✅ ĐÃ LƯU THÀNH CÔNG: {len(df):,} nến chuẩn vào: {file_path}")

    mt5.shutdown()
    print("\n🎉 HOÀN THÀNH TẢI DỮ LIỆU LỊCH SỬ VÀNG CHẤT LƯỢNG CAO!")

if __name__ == "__main__":
    download_data()
