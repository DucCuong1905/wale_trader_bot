import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import * as ccxt from "ccxt";
import WebSocket from "ws";
import cors from "cors";

import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- AI CONFIG ---
const getEnv = (key: string) => {
  // Thử đọc trực tiếp từ file .env để chắc chắn không bị cache/override
  try {
    const envPath = path.join(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, "utf-8");
      const lines = envContent.split("\n");
      for (const line of lines) {
        if (line.trim().startsWith(`${key}=`)) {
          let val = line.split("=").slice(1).join("=").trim();
          val = val.replace(/^["']|["']$/g, "").trim();
          if (val) return val;
        }
      }
    }
  } catch (e) {
    console.warn(`⚠️ Error reading .env directly for ${key}:`, e);
  }

  const val = process.env[key];
  if (!val) return "";
  
  let cleaned = val.trim();
  
  // Bỏ ngoặc kép hoặc đơn bao quanh
  cleaned = cleaned.replace(/^["']|["']$/g, '').trim();
  return cleaned;
};

// Ưu tiên dùng GEMINI_API_KEY từ hệ thống nếu có
const aiKey = getEnv("GEMINI_API_KEY");
console.log("-----------------------------------------");
if (!aiKey) {
  console.error("❌ CRITICAL: GEMINI_API_KEY IS MISSING!");
} else {
  console.log(`🚀 AI KEY DETECTED! (Prefix: ${aiKey.substring(0, 6)}...)`);
  console.log(`🚀 Length: ${aiKey.length} characters`);
}
console.log("-----------------------------------------");

const genAI = new GoogleGenerativeAI(aiKey);
const modelName = "gemini-3-flash-preview"; 

// --- CẤU HÌNH GIAO DỊCH (TRADING CONSTANTS) ---
const PAIR = "BTC/USDT:USDT"; // Cặp giao dịch (BTC Futures trên Binance)
const SYMBOL_ID = "btcusdt"; // ID Symbol cho WebSocket (lowercase cho Binance)
const RISK_PER_TRADE = 0.01; // Rủi ro 1% tổng tài sản cho mỗi lệnh
const RR = 2.0; // Tỷ lệ Lợi nhuận/Rủi ro mới 1:2
const COOLDOWN_MS = 30000; // Thời gian nghỉ giữa các lệnh (30 giây) để tránh vào lệnh liên tục
const MAX_DAILY_LOSS = 0.03; // Giới hạn lỗ tối đa trong ngày (3%). Nếu chạm mốc này, Bot sẽ dừng giao dịch.

// --- PERSISTENCE ---
const DATA_DIR = path.join(process.cwd(), "data");
const TRADES_FILE = path.join(DATA_DIR, "trades.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

function loadTrades() {
  if (fs.existsSync(TRADES_FILE)) {
    try {
      const data = fs.readFileSync(TRADES_FILE, "utf-8");
      return JSON.parse(data);
    } catch (e) {
      console.error("Error loading trades:", e);
      return [];
    }
  }
  return [];
}

function saveTrade(trade: any) {
  const trades = loadTrades();
  trades.unshift(trade);
  // Keep only last 1000 trades
  const limited = trades.slice(0, 1000);
  try {
    fs.writeFileSync(TRADES_FILE, JSON.stringify(limited, null, 2));
  } catch (e) {
    console.error("Error saving trade:", e);
  }
}

// Trạng thái hệ thống (System State) để theo dõi dữ liệu thời gian thực
interface WhaleTrade {
  time: number;
  side: 'buy' | 'sell';
  amount: number; // USDT
  price: number;
}

let botState = {
  isRunning: true, // Trạng thái hoạt động của Bot
  lastPrice: 0, // Giá thị trường hiện tại
  bid: 0, // Tổng khối lượng mua trong Orderbook
  ask: 0, // Tổng khối lượng bán trong Orderbook
  inPosition: false, // Kiểm tra xem Bot có đang giữ lệnh nào không
  lastPositionCheck: false,
  lastTradeTime: 0, // Thời điểm vào lệnh gần nhất
  balance: 0, // Số dư hiện tại (USDT)
  dailyStartingBalance: 0, // Số dư lúc bắt đầu ngày mới (để tính lãi/lỗ ngày)
  lastResetDate: "", // Ngày reset số dư gần nhất
  trades: loadTrades() as any[], // Lịch sử giao dịch
  signals: [] as any[], // Các tín hiệu đã phát hiện
  lastNotifiedCandle: -1, // Lưu index nến cuối cùng đã báo telegram
  obRatioEMA: 1.0, // Tỷ lệ Bid/Ask đã được làm mượt (EMA)
  adx: 0, // Chỉ số ADX hiện tại
  plusDI: 0, // Chỉ số +DI
  minusDI: 0, // Chỉ số -DI
  aiReasoning: "Đang chờ phân tích...", // Phân tích gần nhất từ AI
  isWsConnected: false, // Trạng thái kết nối WebSocket
  apiError: "" as string, // Lưu lỗi API nếu có
  recentWhaleTrades: [] as WhaleTrade[], // Lịch sử Whale Trades khớp thực tế
  lastReportKey: "", // Khóa duy nhất để chặn trùng lặp báo cáo
  latestSweepStatus: "None" as "None" | "Low" | "High", // Trạng thái quét thanh khoản
  latestSweepCandle: -1, // Index của nến cuối cùng phát hiện sweep
};

// --- LOGIC PHÂN TÍCH AI (AI ANALYSIS) ---
async function getAIAnalysis(signal: string, lastPrice: number, obRatio: number, bars: any[]) {
  try {
    const context = bars.slice(-20).map((b) => {
      const time = new Date(b[0]).toLocaleTimeString();
      return `[${time}] O:${b[1]} H:${b[2]} L:${b[3]} C:${b[4]} V:${b[5]}`;
    }).join("\n");

    // Tính toán xu hướng từ Whale Trades khớp thực tế gần đây
    const totalWhaleBuy = botState.recentWhaleTrades.filter(t => t.side === 'buy').reduce((sum, t) => sum + t.amount, 0);
    const totalWhaleSell = botState.recentWhaleTrades.filter(t => t.side === 'sell').reduce((sum, t) => sum + t.amount, 0);
    const whaleSummary = `Gần đây (15p): Whale Buy khớp thực tế $${(totalWhaleBuy/1000).toFixed(1)}k, Whale Sell khớp thực tế $${(totalWhaleSell/1000).toFixed(1)}k.`;

    const prompt = `Bạn là một nhà giao dịch cá voi chuyên nghiệp tại Binance Futures. Bạn phân tích hợp lưu giữa Tường lệnh (Orderbook) và Khớp lệnh thực tế (Whale Trades).
TÍN HIỆU CẦN ĐÁNH GIÁ: ${signal}
GIÁ HIỆN TẠI: ${lastPrice}
TỶ LỆ ORDERBOOK (Bid/Ask): ${obRatio} (Tường mua/Tường bán)
KHỚP LỆNH THỰC TẾ (Whale Trades): ${whaleSummary}

BỐI CẢNH THỊ TRƯỜNG (20 nến):
${context}

HƯỚNG DẪN RA QUYẾT ĐỊNH CHUYÊN SÂU:
1. Xác định "Hidden Pressure": Nếu Orderbook nghiêng về Bid (.ratio > 1) nhưng Whale Trades đang xả hàng thực tế (Sell > Buy), đây là tín hiệu dụ mua (Bull Trap). Hãy REJECT.
2. Dòng tiền thật: Ưu tiên dữ liệu Whale Trades khớp thực tế. Nếu tỷ lệ Orderbook (OB Ratio) yếu nhưng Whale Trades khớp cực mạnh cùng chiều tín hiệu, hãy CONFIRM.
3. Động lượng: Nếu cú quét thanh khoản đi kèm với Whale Trades cùng chiều lớn (> $100k net), đây là thiết lập High-Probability.
4. Quản trị rủi ro: Đánh giá độ dài của nến (Volatility). Nếu thị trường đang biến động quá hỗn loạn hoặc nến quét thanh khoản có râu quá dài so với thân nến (dấu hiệu rút chân không dứt khoát), hãy cân nhắc REJECT.

Trả về duy nhất JSON:
{
  "decision": "CONFIRM" hoặc "REJECT",
  "reason": "Giải thích ngắn gọn (tối đa 2 câu) tập trung vào sự hợp lưu giữa OB và Whale Trades",
  "confidence": 0-100
}`;

    console.log(`[AI] Đang phân tích chuyên sâu bằng ${modelName}...`);
    
    // Sử dụng model preview với apiVersion v1beta nếu cần, 
    // nhưng thư viện @google/generative-ai thường tự xử lý model name.
    const model = genAI.getGenerativeModel({ model: modelName });
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    if (!text) throw new Error("AI không trả về nội dung.");
    
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const cleanText = jsonMatch ? jsonMatch[0] : text;
    const parsed = JSON.parse(cleanText);
    
    console.log(`[AI SUCCESS] ${parsed.decision} (${parsed.confidence}%)`);
    return parsed;
    
  } catch (e: any) {
    console.error(`❌ [AI ERROR] ${modelName}:`, e.message);
    return { 
      decision: "REJECT", 
      reason: `AI Error: ${e.message}`, 
      confidence: 0 
    };
  }
}

// --- TELEGRAM HELPER ---
async function sendTelegram(msg: string) {
  const token = getEnv("TELEGRAM_BOT_TOKEN");
  const chatId = getEnv("TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    console.warn("⚠️ Telegram credentials missing.");
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    console.log(`[TELEGRAM] Sending message to ${chatId}...`);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg,
        parse_mode: "Markdown"
      })
    });
    const result = await response.json();
    if (!response.ok) {
        console.error(`❌ Telegram API error: ${response.status}`, result);
    } else {
        console.log(`✅ Telegram message sent successfully.`);
    }
  } catch (e) {
    console.error("Telegram Error:", e);
  }
}

// Exchange Init (Lazy)
let exchange: ccxt.binance | null = null;
function getExchange() {
  if (!exchange) {
    const apiKey = getEnv("BINANCE_API_KEY");
    const secret = getEnv("BINANCE_API_SECRET");

    if (!apiKey || !secret) {
      botState.apiError = "Thiếu BINANCE_API_KEY hoặc BINANCE_API_SECRET trong cài đặt.";
      return null;
    }

    exchange = new ccxt.binance({
      apiKey,
      secret,
      enableRateLimit: true,
      options: { 
        defaultType: 'future',
      }
    });
    
    // Cấu hình tài khoản cho Binance
    (async () => {
      try {
        console.log(`[INIT] Cấu hình tài khoản Binance cho ${PAIR}...`);
        
        // 1. Thiết lập Đòn bẩy
        try {
          await (exchange as ccxt.binance).setLeverage(10, PAIR);
          console.log(`✅ Đòn bẩy thiết lập: 10x`);
        } catch (e) {}

        // 2. Thiết lập Margin Mode là Isolated
        try {
          await (exchange as ccxt.binance).setMarginMode('isolated', PAIR);
          console.log(`✅ Chế độ ký quỹ: Isolated`);
        } catch (e) {}

        // 3. Binance cũng cần thiết lập Hedge Mode hay One-way
        // Mặc định thường là One-way, nhưng ta thử cấu hình
        try {
          await (exchange as any).setPositionMode(false, PAIR); // false = One-way
          console.log(`✅ Chế độ vị thế: One-way`);
        } catch (e) {}
      } catch (e: any) {
        console.log(`ℹ️ Cấu hình tài khoản: ${e.message || 'Done'}`);
      }
    })();
  }
  return exchange;
}

function detectWhaleSweep(bars: any[]) {
  if (bars.length < 25) return { sweepHigh: false, sweepLow: false };
  
  // Chúng ta chỉ quan tâm đến 3 nến gần nhất (đặc biệt là nến vừa đóng/đang đóng)
  for (let i = bars.length - 1; i >= bars.length - 3; i--) {
    const currentBar = bars[i];
    const prevPeriod = bars.slice(i - 20, i); // Nhìn lại 20 nến trước đó
    if (prevPeriod.length < 20) continue;
    
    const [, o, h, l, c, v] = currentBar;
    
    // Tìm mốc Liquidity (Đỉnh/Đáy rõ ràng nhất trong vùng)
    const prevHigh = Math.max(...prevPeriod.map(b => b[2]));
    const prevLow = Math.min(...prevPeriod.map(b => b[3]));
    
    // Tính toán Volume và Displacement (Logic mới: >= 1.2 lần trung bình 20 nến)
    const avgVol = prevPeriod.reduce((sum, b) => sum + b[5], 0) / prevPeriod.length;
    const volRatio = v / avgVol;
    const isClimaxVol = volRatio >= 1.2; 
    
    const body = Math.abs(c - o);
    const totalSize = h - l;
    if (totalSize === 0) continue;

    const bodyRatio = body / totalSize;
    const hasDisplacement = bodyRatio > 0.25; 

    const upperWick = h - Math.max(o, c);
    const lowerWick = Math.min(o, c) - l;
    const lowerWickRatio = lowerWick / totalSize;
    const upperWickRatio = upperWick / totalSize;

    // --- AUDIT LOG CHO MỖI NẾN CÓ VOLUME LỚN ---
    if (isClimaxVol || l < prevLow || h > prevHigh) {
        console.log(`--- [AUDIT NẾN ${i}] ---`);
        console.log(`📊 Vol/AvgVol: ${(volRatio * 100).toFixed(1)}% | Thân/Nến: ${(bodyRatio * 100).toFixed(1)}%`);
        console.log(`🕯️ Đỉnh cũ: ${prevHigh} | Đáy cũ: ${prevLow} | Low nến: ${l} | High nến: ${h}`);
    }

    // --- LOGIC SWEEP LOW (Quét Đáy - Bullish) ---
    if (isClimaxVol && l < prevLow && c > prevLow) {
      if (lowerWickRatio >= 0.5 && lowerWick > upperWick && hasDisplacement) {
        console.log(`✅ [SWEEP LOW MATCHED] Nến ${i} thỏa mãn tất cả điều kiện Bullish.`);
        return { sweepLow: true, sweepHigh: false, candleIndex: i };
      } else {
        console.log(`❌ [SWEEP LOW FAILED] Không thỏa mãn: Wick (${(lowerWickRatio*100).toFixed(1)}% >= 50%) hoặc Displacement.`);
      }
    }
    
    // --- LOGIC SWEEP HIGH (Quét Đỉnh - Bearish) ---
    if (isClimaxVol && h > prevHigh && c < prevHigh) {
      if (upperWickRatio >= 0.5 && upperWick > lowerWick && hasDisplacement) {
        console.log(`✅ [SWEEP HIGH MATCHED] Nến ${i} thỏa mãn tất cả điều kiện Bearish.`);
        return { sweepLow: false, sweepHigh: true, candleIndex: i };
      } else {
        console.log(`❌ [SWEEP HIGH FAILED] Không thỏa mãn: Wick (${(upperWickRatio*100).toFixed(1)}% >= 50%) hoặc Displacement.`);
      }
    }
  }
  
  return { sweepHigh: false, sweepLow: false };
}

function getOrderbookSignal() {
  if (botState.bid === 0 || botState.ask === 0) return null;
  // Sử dụng EMA để tránh nhiễu từ lệnh ảo (Spoofing)
  const ratio = botState.obRatioEMA;
  if (ratio > 1.25) return "BULL";
  if (ratio < 0.8) return "BEAR";
  return null;
}

function startWS() {
  // Binance Combined Streams: https://binance-docs.github.io/apidocs/futures/en/#combined-streams
  // @depth20: Whale Ratio, @miniTicker: Giá liên tục, @aggTrade: Khớp lệnh thực tế
  const streams = `${SYMBOL_ID}@depth20@100ms/${SYMBOL_ID}@miniticker/${SYMBOL_ID}@aggtrade`;
  const wsUrl = `wss://fstream.binance.com/stream?streams=${streams}`;
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log("🔌 Connected to Binance WS (Depth, Ticker, AggTrade)");
    botState.isWsConnected = true;
  });

  ws.on('message', (data) => {
    try {
      const msg = data.toString();
      const payload = JSON.parse(msg);
      
      const streamName = payload.stream || "";
      const d = payload.data;

      if (!d) return;

      const sName = streamName.toLowerCase();

      // Cập nhật giá từ TẤT CẢ các luồng có dữ liệu giá
      let incomingPrice = 0;
      if (d.p) incomingPrice = parseFloat(d.p); // aggTrade
      else if (d.c) incomingPrice = parseFloat(d.c); // miniTicker
      else if (d.b && d.b[0]) incomingPrice = parseFloat(d.b[0][0]); // Best bid từ Depth

      if (incomingPrice > 0) {
        if (Math.abs(botState.lastPrice - incomingPrice) > 0.01) {
           // console.log(`[PRICE] ${botState.lastPrice} -> ${incomingPrice}`);
        }
        botState.lastPrice = incomingPrice;
      }

      if (sName.includes('@depth')) {
        const bids = d.b || d.bids;
        const asks = d.a || d.asks;

        if (bids && Array.isArray(bids) && asks && Array.isArray(asks)) {
          botState.bid = bids.reduce((sum: number, x: any) => sum + parseFloat(x[1]), 0);
          botState.ask = asks.reduce((sum: number, x: any) => sum + parseFloat(x[1]), 0);
          
          const currentRatio = botState.ask !== 0 ? botState.bid / botState.ask : 1.0;
          botState.obRatioEMA = (currentRatio * 0.1) + (botState.obRatioEMA * 0.9);
        }
      } 

      if (sName.includes('@aggtrade')) {
        const qty = parseFloat(d.q);
        const price = parseFloat(d.p);
        const amount = qty * price;
        const side = d.m ? 'sell' : 'buy';

        // Hạ ngưỡng Whale xuống $1000 để bắt được nhiều dòng tiền hơn, giúp Whale Net nhạy hơn
        if (amount > 1000) {
          botState.recentWhaleTrades.push({ time: Date.now(), side, amount, price });
          // console.log(`[WHALE] Detect ${side} order: $${amount.toFixed(0)}`);
          // Tăng thời gian lưu trữ lên 15 phút (900,000 ms) để khớp với khung nến 15M
          const cutoff = Date.now() - 900000;
          botState.recentWhaleTrades = botState.recentWhaleTrades.filter(t => t.time > cutoff);
        }
      }
    } catch (e) { }
  });

  ws.on('error', (err) => {
    console.error("❌ Binance WS Error:", err.message);
    botState.isWsConnected = false;
  });

  ws.on('close', () => {
    console.log("🔌 Binance WS Closed. Reconnecting in 5s...");
    botState.isWsConnected = false;
    setTimeout(startWS, 5000);
  });
}

function getAvgRange(ohlcv: any[], period: number = 14) {
  const slice = ohlcv.slice(-period);
  const sum = slice.reduce((acc, bar: any) => acc + (bar[2] - bar[3]), 0);
  return sum / period;
}

function calcADX(ohlcv: any[], period: number = 14) {
  if (ohlcv.length < period * 2) return { adx: 0, pDI: 0, mDI: 0 };
  let tr: number[] = [];
  let plusDM: number[] = [];
  let minusDM: number[] = [];

  for (let i = 1; i < ohlcv.length; i++) {
    const prevC = ohlcv[i - 1][4];
    const [ts, o, h, l, c] = ohlcv[i];
    const prevH = ohlcv[i - 1][2];
    const prevL = ohlcv[i - 1][3];

    tr.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
    const upMove = h - prevH;
    const downMove = prevL - l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const smooth = (arr: number[]) => {
    let result = [arr.slice(0, period).reduce((a, b) => a + b, 0) / period];
    for (let i = period; i < arr.length; i++) {
      result.push((result[result.length - 1] * (period - 1) + arr[i]) / period);
    }
    return result;
  };

  const str = smooth(tr);
  const sdmP = smooth(plusDM);
  const sdmM = smooth(minusDM);

  const dx: number[] = [];
  const pDIs: number[] = [];
  const mDIs: number[] = [];

  for (let i = 0; i < str.length; i++) {
    const pDI = 100 * (sdmP[i] / str[i]);
    const mDI = 100 * (sdmM[i] / str[i]);
    pDIs.push(pDI);
    mDIs.push(mDI);
    dx.push(100 * Math.abs(pDI - mDI) / (pDI + mDI || 1));
  }
  const adxList = smooth(dx);
  
  return {
    adx: adxList[adxList.length - 1],
    pDI: pDIs[pDIs.length - 1],
    mDI: mDIs[mDIs.length - 1]
  };
}

async function traderLoop() {
  const ex = getExchange();
  if (!ex) {
    if (botState.isRunning) console.log("🔍 Đang quét thị trường (Chế độ giám sát)...");
    setTimeout(traderLoop, 10000);
    return;
  }

  try {
    console.log("🔄 Vòng lặp giao dịch đang chạy...");
    let balanceInfo;
    try {
      balanceInfo = await ex.fetchBalance();
      botState.apiError = ""; // Clear error on success
    } catch (e: any) {
      if (e instanceof ccxt.AuthenticationError) {
        botState.apiError = "Lỗi xác thực Binance: API Key hoặc Secret không hợp lệ / Thiếu quyền Futures.";
        console.error("❌ " + botState.apiError);
      } else {
        botState.apiError = `Lỗi kết nối sàn: ${e.message}`;
      }
      setTimeout(traderLoop, 15000);
      return;
    }

    const currentBalance = balanceInfo.USDT ? (balanceInfo.USDT as any).total : 0;
    botState.balance = currentBalance;

    const today = new Date().toISOString().split('T')[0];
    if (botState.lastResetDate !== today) {
      botState.dailyStartingBalance = currentBalance;
      botState.lastResetDate = today;
    }

    const dailyPnL = currentBalance - botState.dailyStartingBalance;
    const dailyLossPercent = botState.dailyStartingBalance > 0 ? (dailyPnL / botState.dailyStartingBalance) : 0;

    if (dailyLossPercent <= -MAX_DAILY_LOSS) {
      console.log(`🛑 Đã chạm giới hạn lỗ ngày (${(dailyLossPercent*100).toFixed(2)}%). Dừng giao dịch trong 30 phút.`);
      setTimeout(traderLoop, 60000 * 30);
      return;
    }

    const positions = await ex.fetchPositions([PAIR]);
    const isNowInPosition = positions.some(p => Math.abs(parseFloat(p.info.size || (p as any).contracts || 0)) > 0);

    if (botState.inPosition && !isNowInPosition) {
      const pnlPercent = (dailyPnL / botState.dailyStartingBalance * 100).toFixed(2);
      const tradeResult = { type: 'CLOSE', balance: currentBalance, pnl: dailyPnL, time: new Date().toISOString(), status: 'CLOSED' };
      botState.trades.unshift(tradeResult);
      saveTrade(tradeResult);
      sendTelegram(`🔔 *VỊ THẾ ĐÃ ĐÓNG*\n💰 Số dư: $${botState.balance.toFixed(2)}\n📊 PnL: ${dailyPnL >= 0 ? '+' : ''}$${dailyPnL.toFixed(2)} (${pnlPercent}%)`);
    }

    botState.inPosition = isNowInPosition;
    if (botState.inPosition) {
      // Monitor position for TP/SL is handled by Exchange or our Stop Loss orders
      setTimeout(traderLoop, 10000);
      return;
    }

    if (Date.now() - botState.lastTradeTime < COOLDOWN_MS) {
      setTimeout(traderLoop, 5000);
      return;
    }

    if (botState.lastPrice === 0) {
      console.log("⏳ Đang chờ dữ liệu giá từ WebSocket...");
      setTimeout(traderLoop, 5000);
      return;
    }

    console.log(`🎯 [MONITORING] Đang kiểm tra tín hiệu Whale Sweep...`);
    const bars = await ex.fetchOHLCV(PAIR, '15m', undefined, 100);
    if (!bars || bars.length < 25) {
      console.log(`⚠️ Không đủ dữ liệu nến (${bars?.length || 0}). Đang chờ...`);
      setTimeout(traderLoop, 10000);
      return;
    }

    // --- QUÉT TÍN HIỆU SWEEP (CHỈ DÙNG ĐỂ THEO DÕI TRONG LOG) ---
    const sweepResult = detectWhaleSweep(bars);
    const sweepLow = sweepResult.sweepLow;
    const sweepHigh = sweepResult.sweepHigh;
    const currentCandleIndex = bars.length - 1;

    // Cập nhật trạng thái hiển thị trên UI (vẫn giữ để người dùng xem Realtime)
    botState.latestSweepStatus = sweepLow ? "Low" : (sweepHigh ? "High" : "None");
    if (sweepLow || sweepHigh) {
        botState.latestSweepCandle = currentCandleIndex;
    } else if (currentCandleIndex > botState.latestSweepCandle + 2) {
        botState.latestSweepStatus = "None";
    }

    // --- KIỂM TRA THỜI GIAN ĐÓNG NẾN (CANDLE CLOSE CONSTRAINT) ---
    const timeframeMs = 15 * 60 * 1000; // 15 phút
    const now = Date.now();
    const nextClose = Math.ceil(now / timeframeMs) * timeframeMs;
    const timeToClose = nextClose - now;
    const secondsToClose = Math.floor(timeToClose / 1000);

    if (secondsToClose > 15) {
      if (now % 60000 < 5000) { 
        console.log(`⏳ Đang chờ nến đóng... (Còn ${secondsToClose}s nữa)`);
      }
      setTimeout(traderLoop, 5000);
      return;
    }

    // --- GỬI BẢN TIN INTEL (CHỈ GỬI 1 LẦN KHI CÒN 10-15S ĐÓNG NẾN) ---
    const reportKey = `REPORT-${nextClose}`; // Key duy nhất theo timestamp đóng nến
    if (botState.lastReportKey !== reportKey && secondsToClose <= 12) {
      botState.lastReportKey = reportKey;
      
      const buyVol = botState.recentWhaleTrades.filter(t => t.side === 'buy').reduce((s, t) => s + t.amount, 0);
      const sellVol = botState.recentWhaleTrades.filter(t => t.side === 'sell').reduce((s, t) => s + t.amount, 0);
      const net = (buyVol - sellVol) / 1000;
      
      // Sweep check ngay tại thời điểm này
      const finalSweep = detectWhaleSweep(bars);
      const sweepIcon = finalSweep.sweepLow ? "🟢 QUÉT ĐÁY (LOW)" : (finalSweep.sweepHigh ? "🔴 QUÉT ĐỈNH (HIGH)" : "❌ KHÔNG (NONE)");
      
      const wsStatus = botState.isWsConnected ? "✅ STREAMING" : "❌ OFFLINE";
      const envTag = process.env.NODE_ENV === "production" ? "🏷️ *PROD*" : "🏷️ *DEV*";
      
      const whaleCount = botState.recentWhaleTrades.length;
      
      const intelMsg = `📝 *BẢN TIN INTEL (15M)*\n` +
        `⏰ Đóng nến: ${new Date(nextClose).toLocaleTimeString()}\n` +
        `${envTag} | PID: ${process.pid}\n\n` +
        `🌐 WS Binance: ${wsStatus}\n` +
        `💰 BTC Price: *$${botState.lastPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}*\n` +
        `🧹 Sweep: *${sweepIcon}*\n` +
        `⚖️ OB Ratio: *${botState.obRatioEMA.toFixed(2)}*\n` +
        `📈 ADX: *${botState.adx.toFixed(1)}* (Trends: ${botState.plusDI.toFixed(1)} / ${botState.minusDI.toFixed(1)})\n` +
        `🐋 Whale Net: ${net >= 0 ? '🟢 +' : '🔴 '}${net.toFixed(1)}k (${whaleCount} lệnh)\n\n` +
        `_Đang phân tích chiến lược vào lệnh..._`;
      
      sendTelegram(intelMsg);
    }

    console.log(`🎯 [ENTRY WINDOW] Chỉ còn ${secondsToClose}s trước khi đóng nến. Tiến hành kiểm tra tín hiệu cuối cùng...`);

    const adxData = calcADX(bars, 14);
    botState.adx = adxData.adx;
    botState.plusDI = adxData.pDI;
    botState.minusDI = adxData.mDI;
    
    const adx = adxData.adx;
    const obRatio = botState.obRatioEMA;
    
    // Tín hiệu OB linh hoạt: 
    // Nếu Whale Net mạnh (> 50k), chỉ cần OB Ratio > 1.1 (cho Long) hoặc < 0.9 (cho Short)
    const buyVol = botState.recentWhaleTrades.filter(t => t.side === 'buy').reduce((s, t) => s + t.amount, 0);
    const sellVol = botState.recentWhaleTrades.filter(t => t.side === 'sell').reduce((s, t) => s + t.amount, 0);
    const whaleNet = buyVol - sellVol;

    let obSignal: "BULL" | "BEAR" | null = null;
    if (obRatio > 1.25 || (obRatio > 1.1 && whaleNet > 50000)) obSignal = "BULL";
    if (obRatio < 0.8 || (obRatio < 0.9 && whaleNet < -50000)) obSignal = "BEAR";

    console.log(`[PHÂN TÍCH] Giá: ${botState.lastPrice} | ADX: ${adx.toFixed(1)} (Min 20) | Quét Whale: ${sweepLow ? "LOW" : sweepHigh ? "HIGH" : "KHÔNG"} | Tỷ lệ OB: ${obRatio.toFixed(2)} | Whale Net: ${(whaleNet/1000).toFixed(1)}k`);

    let signal: 'LONG' | 'SHORT' | null = null;
    if (sweepLow && obSignal === "BULL" && adx >= 20) signal = "LONG";
    if (sweepHigh && obSignal === "BEAR" && adx >= 20) signal = "SHORT";

    if (signal) {
      console.log(`🚀 [SIGNAL FOUND] Phát hiện tín hiệu ${signal}. Đang gửi cho AI phân tích...`);
      const entry = botState.lastPrice;
      
      // Stop Loss động: Sử dụng khoảng cách biến động trung bình (ATR-like) để tránh quét râu
      const rangeAvg = getAvgRange(bars, 14);
      const sl = signal === "LONG" ? entry - rangeAvg : entry + rangeAvg;
      
      const tp = signal === "LONG" ? entry + (entry - sl) * RR : entry - (sl - entry) * RR;

      const riskAmt = botState.balance * RISK_PER_TRADE;
      const stopDist = Math.abs(entry - sl);

      if (stopDist > 0) {
        let size = riskAmt / stopDist;
        
        // Đảm bảo khối lượng tối thiểu là 0.001 BTC (Binance Futures limit)
        // Và giới hạn tối đa không vượt quá 50% vốn (để an toàn) nếu tính theo Margin x10
        const minBTC = 0.001; 
        const maxNotionalValue = botState.balance * 5; // Cho phép vị thế tối đa gấp 5 lần vốn (Leverage x5 thực tế)
        const maxSize = maxNotionalValue / entry;

        size = Math.max(size, minBTC);
        size = Math.min(size, maxSize);

        if (size >= minBTC) {
          const currentRatio = botState.ask !== 0 ? botState.bid / botState.ask : 1.0;
          
          // Lưu tín hiệu vào danh sách signals
          const signalInfo = {
            time: new Date().toISOString(),
            type: signal,
            price: entry,
            obRatio: currentRatio.toFixed(2),
            adx: adx.toFixed(1),
            sweep: sweepLow ? "LOW" : "HIGH",
            status: "PENDING"
          };
          botState.signals.unshift(signalInfo);
          if (botState.signals.length > 50) botState.signals.pop();

          sendTelegram(`🚀 *VÀO LỆNH ${signal}*\n💰 Giá: ${entry}\n🛑 SL: ${sl.toFixed(1)}\n🎯 TP: ${tp.toFixed(1)}`);
          const aiEval = await getAIAnalysis(signal, entry, currentRatio, bars);
          botState.aiReasoning = aiEval.reason;
          signalInfo.status = aiEval.decision;

          if (aiEval.decision === "REJECT") {
            sendTelegram(`🤖 *AI TỪ CHỐI LỆNH*\nLý do: ${aiEval.reason}`);
            return;
          }

          sendTelegram(`🤖 *AI XÁC NHẬN LỆNH* (${aiEval.confidence}%)\nLý do: ${aiEval.reason}`);
          try {
            const amount = ex.amountToPrecision(PAIR, size);
            console.log(`[ORDER] Placing ${signal} order. Size: ${amount}`);
            
            // Mở vị thế (Market Order)
            await ex.createMarketOrder(PAIR, signal === 'LONG' ? 'buy' : 'sell', parseFloat(amount));
            
            // Đợi một chút để lệnh Market khớp hoàn toàn trước khi đặt TP/SL
            await new Promise(r => setTimeout(r, 1000));

            // Set TP và SL sử dụng reduceOnly: true cho chế độ One-way
            try {
              // Chốt lời (Limit Order)
              const tpPrice = ex.priceToPrecision(PAIR, tp);
              await ex.createOrder(PAIR, 'limit', signal === 'LONG' ? 'sell' : 'buy', parseFloat(amount), parseFloat(tpPrice), { 'reduceOnly': true });
              
              // Cắt lỗ (Stop Market Order)
              const slPrice = ex.priceToPrecision(PAIR, sl);
              await ex.createOrder(PAIR, 'stop_market', signal === 'LONG' ? 'sell' : 'buy', parseFloat(amount), undefined, { 
                'stopPrice': parseFloat(slPrice), 
                'reduceOnly': true 
              });
              
              console.log(`[ORDER] TP/SL set successfully.`);
            } catch (tpslErr: any) {
              console.error("⚠️ TP/SL Order Error:", tpslErr.message);
              sendTelegram(`⚠️ *CẢNH BÁO*: Lệnh đã khớp nhưng không đặt được TP/SL tự động. Vui lòng kiểm tra sàn!\nLỗi: ${tpslErr.message}`);
            }

            botState.lastTradeTime = Date.now();
            botState.inPosition = true;
            sendTelegram(`✅ *ĐẶT LỆNH THÀNH CÔNG*\nBot đã thực thi lệnh ${signal} trên Binance.`);
          } catch (e: any) {
            console.error("❌ Order Execution Error:", e);
            sendTelegram(`❌ *LỖI ĐẶT LỆNH SÀN*\nKhông thể thực thi lệnh trên Binance.\nLỗi: ${e.message}`);
          }
        }
      }
    }
  } catch (e) {
    console.error("Trader Loop Error:", e);
  }
  setTimeout(traderLoop, 5000);
}

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  app.use(cors());
  app.use(express.json());

  // Logging middleware
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });

  // API routes defined BEFORE Vite middleware and other routes
  app.get("/api/health", (req, res) => res.json({ status: "ok" }));
  
  app.get("/api/trading/status", (req, res) => {
    try {
      // Tính Whale Pressure
      const buyVol = botState.recentWhaleTrades.filter(t => t.side === 'buy').reduce((s, t) => s + t.amount, 0);
      const sellVol = botState.recentWhaleTrades.filter(t => t.side === 'sell').reduce((s, t) => s + t.amount, 0);

      res.json({
        status: botState.isRunning ? "running" : "idle",
        symbol: PAIR,
        last_price: botState.lastPrice || 0,
        is_ws_connected: botState.isWsConnected,
        api_error: botState.apiError,
        bid_ratio: botState.obRatioEMA.toFixed(2),
        in_position: botState.inPosition,
        signals: (botState.signals || []).slice(0, 10),
        balance: botState.balance || 0,
        ai_reasoning: botState.aiReasoning || "Đang chờ phân tích...",
        adx: botState.adx.toFixed(1),
        plus_di: botState.plusDI.toFixed(1),
        minus_di: botState.minusDI.toFixed(1),
        whale_trades: {
          buy: buyVol.toFixed(0),
          sell: sellVol.toFixed(0),
          count: botState.recentWhaleTrades.length
        }
      });
    } catch (err) {
      console.error("Error in /api/trading/status:", err);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.get("/api/trading/history", (req, res) => {
    try {
      res.json(botState.trades || []);
    } catch (err) {
      console.error("Error in /api/trading/history:", err);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // API Catch-all: Ensure any unknown /api route returns JSON, not HTML
  app.all("/api/*", (req, res) => {
    res.status(404).json({ error: `API Route ${req.method} ${req.url} not found` });
  });

  // Vite middleware or static serving
  if (process.env.NODE_ENV !== "production") {
    try {
      console.log("🛠️ Initializing Vite middleware...");
      const vite = await createViteServer({ 
        server: { middlewareMode: true }, 
        appType: "spa" 
      });
      app.use(vite.middlewares);
      console.log("✅ Vite middleware loaded");
    } catch (ve) {
      console.error("❌ Failed to load Vite middleware:", ve);
    }
  } else {
    const distPath = path.join(process.cwd(), "dist");
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
    }
  }

  // --- START SERVER ---
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Trading Server running on http://localhost:${PORT}`);
  });

  // Start background processes AFTER server is listening
  console.log("🔄 Starting Background Processes...");
  startWS();
  traderLoop();
  
  console.log("✅ Background Processes Initialized.");

  // --- KIỂM TRA KẾT NỐI AI (Background) ---
  (async () => {
    console.log("-----------------------------------------");
    console.log(`🤖 Đang kiểm tra kết nối AI (${modelName})...`);
    try {
      const dummyBars = [[Date.now(), 70000, 71000, 69000, 70500, 100]];
      const testEval = await getAIAnalysis("TEST_STARTUP", 70500, 1.2, dummyBars);
      
      if (testEval && testEval.decision && !testEval.reason.includes("AI Error")) {
        console.log(`✅ Kết nối AI thành công!`);
        botState.aiReasoning = testEval.reason;
      } else {
        console.error("❌ AI chưa hoạt động ổn định. Lý do:", testEval.reason);
      }
    } catch (err: any) {
      console.error("❌ Lỗi nghiêm trọng khi khởi tạo AI:", err.message);
    }
  })();

  sendTelegram(`🐳 *Whale Bot Đã Sẵn Sàng*\n🚀 Server PID: ${process.pid}`);

  // Error handling middleware
  app.use((err: any, req: any, res: any, next: any) => {
    console.error("Express Error Handler:", err);
    if (!res.headersSent) {
      res.status(500).send("Internal Server Error");
    }
  });
}

startServer().catch(err => {
  console.error("❌ CRITICAL: startServer failed to launch:", err);
});
