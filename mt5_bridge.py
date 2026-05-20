import MetaTrader5 as mt5
from flask import Flask, request, jsonify
import sys

app = Flask(__name__)

# Cấu hình tài khoản (Nếu không để trống thì nó tự lấy terminal đang mở)
def initialize_mt5():
    if not mt5.initialize():
        print("initialize() failed, error code =", mt5.last_error())
        sys.exit(1)
    print("MT5 Initialized Successfully")

@app.route('/webhook', methods=['POST'])
def webhook():
    data = request.json
    print(f"📥 Nhận tín hiệu từ webhook: {data}")
    
    symbol = data.get('symbol', 'XAUUSD')
    mt5.symbol_select(symbol, True)
    signal_type = data.get('type')  # LONG/SHORT
    entry = data.get('entry')
    sl = data.get('sl')
    tp = data.get('tp')
    volume = data.get('volume', 0.01) # Khối lượng mặc định

    # Chuyển đổi LONG/SHORT sang lệnh MT5
    order_type = mt5.ORDER_TYPE_BUY if signal_type == "LONG" else mt5.ORDER_TYPE_SELL
    
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        print(f"❌ Không lấy được giá chi tiết (tick) cho {symbol}")
        return jsonify({"status": "error", "message": f"Symbol {symbol} not found on MT5"}), 400
        
    price = tick.ask if signal_type == "LONG" else tick.bid

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

@app.route('/order', methods=['POST'])
def order_action():
    # Thêm hỗ trợ cho /order API gửi từ server.ts chính
    data = request.json
    print(f"📥 Nhận tin từ API /order: {data}")
    
    symbol = data.get('symbol', 'XAUUSD')
    mt5.symbol_select(symbol, True)
    type_str = data.get('type') # 'buy' hoặc 'sell'
    sl = data.get('sl')
    tp = data.get('tp')
    lot = data.get('lot', 0.01)
    comment = data.get('comment', 'Whale Bot Order')

    order_type = mt5.ORDER_TYPE_BUY if type_str == "buy" else mt5.ORDER_TYPE_SELL
    
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return jsonify({"status": "error", "message": f"Symbol {symbol} not found"}), 400
        
    price = tick.ask if type_str == "buy" else tick.bid

    request_dict = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": float(lot),
        "type": order_type,
        "price": price,
        "sl": float(sl),
        "tp": float(tp),
        "deviation": 20,
        "magic": 123456,
        "comment": comment,
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request_dict)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        print(f"❌ Lỗi vào lệnh qua /order: {result.comment}")
        return jsonify({"status": "error", "message": result.comment}), 400

    print(f"✅ Lệnh {type_str} {symbol} thành công qua /order!")
    return jsonify({"status": "success", "order": result.order}), 200

@app.route('/candles', methods=['GET'])
def get_candles():
    try:
        symbol = request.args.get('symbol', 'XAUUSD')
        mt5.symbol_select(symbol, True)
        timeframe_str = request.args.get('timeframe', '1m')
        limit = int(request.args.get('limit', 1000))

        tf_map = {
            '1m': mt5.TIMEFRAME_M1,
            '5m': mt5.TIMEFRAME_M5,
            '1d': mt5.TIMEFRAME_D1,
            '1D': mt5.TIMEFRAME_D1
        }
        tf = tf_map.get(timeframe_str, mt5.TIMEFRAME_M1)

        rates = mt5.copy_rates_from_pos(symbol, tf, 0, limit)
        if rates is None or len(rates) == 0:
            return jsonify({
                "status": "error",
                "message": f"Không thể lấy nến cho {symbol}. Hãy kiểm tra xem symbol này đã được thêm vào bảng Market Watch (Bảng giá) trong phần mềm MT5 trên VPS chưa!"
            }), 400

        ohlcv = []
        # Kiểm tra xem rates có cột thuộc tính theo tên không
        has_names = False
        if hasattr(rates, 'dtype') and rates.dtype.names:
            has_names = True

        for r in rates:
            if has_names:
                time_val = r['time']
                open_val = r['open']
                high_val = r['high']
                low_val = r['low']
                close_val = r['close']
                vol_val = r['tick_volume']
            else:
                time_val = r[0]
                open_val = r[1]
                high_val = r[2]
                low_val = r[3]
                close_val = r[4]
                vol_val = r[5]

            timestamp_ms = int(time_val) * 1000
            ohlcv.append([
                timestamp_ms,
                float(open_val), # open
                float(high_val), # high
                float(low_val), # low
                float(close_val), # close
                float(vol_val)  # volume / tick_volume
            ])

        return jsonify({"status": "success", "data": ohlcv})
    except Exception as e:
        import traceback
        print("❌ Lỗi trong /candles API:", traceback.format_exc())
        return jsonify({"status": "error", "message": f"Lỗi exception tại mt5_bridge.py: {str(e)}"}), 500

@app.route('/account', methods=['GET'])
def get_account_info():
    try:
        account_info = mt5.account_info()
        if account_info is None:
            return jsonify({"status": "error", "message": "Failed to get account info. Hãy đảm bảo bạn đã đăng nhập tài khoản Exness MT5 thành công"}), 400
        
        return jsonify({
            "status": "success",
            "balance": account_info.balance,
            "equity": account_info.equity,
            "margin": account_info.margin,
            "free_margin": account_info.margin_free,
            "profit": account_info.profit
        })
    except Exception as e:
        return jsonify({"status": "error", "message": f"Lỗi exception khi lấy tài khoản: {str(e)}"}), 500

@app.route('/positions', methods=['GET'])
def get_positions():
    try:
        symbol = request.args.get('symbol', 'XAUUSD')
        mt5.symbol_select(symbol, True)
        positions = mt5.positions_get(symbol=symbol)
        if positions is None:
            return jsonify({"status": "success", "positions": []})
        
        pos_list = []
        for p in positions:
            pos_list.append({
                "ticket": p.ticket,
                "symbol": p.symbol,
                "volume": p.volume,
                "type": "buy" if p.type == mt5.POSITION_TYPE_BUY else "sell",
                "price_open": p.price_open,
                "sl": p.sl,
                "tp": p.tp,
                "profit": p.profit
            })
        return jsonify({"status": "success", "positions": pos_list})
    except Exception as e:
        return jsonify({"status": "error", "message": f"Lỗi exception khi lấy vị thế: {str(e)}"}), 500

if __name__ == "__main__":
    initialize_mt5()
    app.run(host='0.0.0.0', port=5000)
