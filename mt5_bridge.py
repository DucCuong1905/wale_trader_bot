import MetaTrader5 as mt5
from flask import Flask, request, jsonify
import threading

app = Flask(__name__)

# Cấu hình tài khoản (Nếu không để trống thì nó tự lấy terminal đang mở)
def initialize_mt5():
    if not mt5.initialize():
        print("initialize() failed, error code =", mt5.last_error())
        quit()
    print("MT5 Initialized Successfully")

@app.route('/webhook', methods=['POST'])
def webhook():
    data = request.json
    print(f"📥 Nhận tín hiệu: {data}")
    
    symbol = data.get('symbol', 'XAUUSD')
    signal_type = data.get('type')  # LONG/SHORT
    entry = data.get('entry')
    sl = data.get('sl')
    tp = data.get('tp')
    volume = data.get('volume', 0.01) # Khối lượng mặc định

    # Chuyển đổi LONG/SHORT sang lệnh MT5
    order_type = mt5.ORDER_TYPE_BUY if signal_type == "LONG" else mt5.ORDER_TYPE_SELL
    price = mt5.symbol_info_tick(symbol).ask if signal_type == "LONG" else mt5.symbol_info_tick(symbol).bid

    request_dict = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": float(volume),
        "type": order_type,
        "price": price,
        "sl": float(sl),
        "tp": float(tp),
        "deviation": 20,
        "magic": 123456,
        "comment": "Whale Bot Signal",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request_dict)
    
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        print(f"❌ Lỗi vào lệnh: {result.comment}")
        return jsonify({"status": "error", "message": result.comment}), 400

    print(f"✅ Đã vào lệnh {signal_type} {symbol} thành công!")
    return jsonify({"status": "success", "order": result.order}), 200

if __name__ == "__main__":
    initialize_mt5()
    # Chạy trên tất cả IP (0.0.0.0) để AI Studio có thể gọi tới
    app.run(host='0.0.0.0', port=5000)
