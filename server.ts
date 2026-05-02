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
const PAIR = "BTC/USDT:USDT"; // Cặp giao dịch (BTC Futures trên Bitget)
const SYMBOL_ID = "BTCUSDT"; // ID Symbol cho WebSocket
const RISK_PER_TRADE = 0.01; // Rủi ro 1% tổng tài sản cho mỗi lệnh (Stop Loss sẽ mất 1%)
const RR = 2.5; // Tỷ lệ Lợi nhuận/Rủi ro (Take Profit gấp 2.5 lần Stop Loss)
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
  aiReasoning: "Đang chờ phân tích...", // Phân tích gần nhất từ AI
  isWsConnected: false // Trạng thái kết nối WebSocket
};

// --- LOGIC PHÂN TÍCH AI (AI ANALYSIS) ---
async function getAIAnalysis(signal: string, lastPrice: number, obRatio: number, bars: any[]) {
  // Chỉ dùng duy nhất model trả phí và không retry để log sạch
  try {
    const context = bars.slice(-20).map((b) => {
      const time = new Date(b[0]).toLocaleTimeString();
      return `[${time}] O:${b[1]} H:${b[2]} L:${b[3]} C:${b[4]} V:${b[5]}`;
    }).join("\n");

    const prompt = `Bạn là một nhà giao dịch cá voi (whale trader) chuyên nghiệp, quyết đoán. Mục tiêu là bắt các cú quét thanh khoản (liquidity sweeps) và động lượng thị trường.
TÍN HIỆU CẦN ĐÁNH GIÁ: ${signal}
GIÁ HIỆN TẠI: ${lastPrice}
TỶ LỆ ORDERBOOK BID/ASK: ${obRatio}

BỐI CẢNH THỊ TRƯỜNG (20 nến gần nhất):
${context}

HƯỚNG DẪN PHÂN TÍCH:
- Quyết đoán. Nếu cấu trúc thị trường khớp hoặc hỗ trợ tín hiệu ${signal}, hãy CONFIRM.
- Tìm kiếm các dấu hiệu đảo chiều sớm sau khi quét thanh khoản.
- Chấp nhận rủi ro vừa phải nếu tỷ lệ Bid/Ask ủng hộ xu hướng.
- Chúng ta đánh RR 2.5, nên có thể chấp nhận một số lệnh stop out nếu bắt được các cú quét lớn thành công.

QUYẾT ĐỊNH CUỐI CÙNG:
- "CONFIRM" nếu tín hiệu có ít nhất 60% xác suất thắng theo kinh nghiệm của bạn.
- "REJECT" chỉ khi có khối lượng ngược xu hướng cực lớn hoặc tín hiệu giả mạo (fakeout) rõ ràng.

Trả về DUY NHẤT một đối tượng JSON (Lý do bằng TIẾNG VIỆT):
{
  "decision": "CONFIRM" | "REJECT",
  "reason": "Giải thích kỹ thuật ngắn gọn bằng tiếng Việt (tối đa 2 câu)",
  "confidence": 0-100
}`;

    console.log(`[AI] Đang phân tích bằng ${modelName}...`);
    
    const model = genAI.getGenerativeModel(
      { model: modelName },
      { apiVersion: 'v1beta' }
    );
    
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
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg,
        parse_mode: "Markdown"
      })
    });
    if (!response.ok) {
        console.error(`❌ Telegram API error: ${response.status}`);
    }
  } catch (e) {
    console.error("Telegram Error:", e);
  }
}

// Exchange Init (Lazy)
let exchange: ccxt.bitget | null = null;
function getExchange() {
  if (!exchange) {
    const apiKey = getEnv("BG_API_KEY");
    const secret = getEnv("BG_SECRET_KEY");
    const password = getEnv("BG_PASSPHRASE");

    if (!apiKey || !secret) {
      console.warn("⚠️ Thiếu API Key. Bot sẽ chạy ở chế độ chỉ giám sát.");
      return null;
    }

    exchange = new ccxt.bitget({
      apiKey,
      secret,
      password,
      enableRateLimit: true,
      options: { 
        defaultType: 'future',
        // Force one-way mode for Bitget if needed via options if possible
      }
    });
    
    // Ép chế độ One-way (Unilateral) để tránh lỗi 40774
    (async () => {
      try {
        console.log(`[INIT] Cấu hình tài khoản cho ${PAIR}...`);
        
        // 1. Thiết lập Đòn bẩy (Ví dụ: 10x - bạn có thể điều chỉnh)
        try {
          await (exchange as ccxt.bitget).setLeverage(10, PAIR);
          console.log(`✅ Đòn bẩy thiết lập: 10x`);
        } catch (e) {}

        // 2. Thiết lập Margin Mode là Isolated để quản lý rủi ro tốt hơn
        try {
          await (exchange as ccxt.bitget).setMarginMode('isolated', PAIR);
          console.log(`✅ Chế độ ký quỹ: Isolated`);
        } catch (e) {}

        // 3. Thiết lập chế độ One-way
        await (exchange as any).setPositionMode(false, PAIR); 
        console.log(`✅ Chế độ vị thế: One-way (Unilateral)`);
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
    
    // Tính toán Volume và Displacement
    const maxVol = Math.max(...prevPeriod.map(b => b[5]));
    const volRatio = v / maxVol;
    const isClimaxVol = volRatio >= 0.8; 
    
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
        console.log(`📊 Vol/MaxVol: ${(volRatio * 100).toFixed(1)}% | Thân/Nến: ${(bodyRatio * 100).toFixed(1)}%`);
        console.log(`🕯️ Đỉnh cũ: ${prevHigh} | Đáy cũ: ${prevLow} | Low nến: ${l} | High nến: ${h}`);
        console.log(`⚓ Râu dưới: ${(lowerWickRatio * 100).toFixed(1)}% | Râu trên: ${(upperWickRatio * 100).toFixed(1)}%`);
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
  const ratio = botState.bid / botState.ask;
  if (ratio > 1.2) return "BULL";
  if (ratio < 0.83) return "BEAR";
  return null;
}

function startWS() {
  const ws = new WebSocket("wss://ws.bitget.com/v2/ws/public");
  let pingInterval: any;

  ws.on('open', () => {
    console.log("🔌 Connected to Bitget WS");
    botState.isWsConnected = true;
    ws.send(JSON.stringify({
      op: "subscribe",
      args: [
        { instType: "USDT-FUTURES", channel: "books5", instId: SYMBOL_ID },
        { instType: "USDT-FUTURES", channel: "ticker", instId: SYMBOL_ID }
      ]
    }));

    // Heartbeat
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send("ping");
      }
    }, 20000);
  });

  ws.on('message', (data) => {
    try {
      const msg = data.toString();
      if (msg === "pong") return;
      
      const parsed = JSON.parse(msg);
      if (parsed.action === 'snapshot' || parsed.action === 'update') {
        const d = parsed.data[0];
        if (d.bids) {
          botState.bid = d.bids.reduce((sum: number, x: any) => sum + parseFloat(x[1]), 0);
          botState.ask = d.asks.reduce((sum: number, x: any) => sum + parseFloat(x[1]), 0);
          // Fallback: If lastPrice is 0, use top of book
          if (botState.lastPrice === 0 && d.bids.length > 0) {
            botState.lastPrice = parseFloat(d.bids[0][0]);
          }
        }
        if (d.lastPr) {
          botState.lastPrice = parseFloat(d.lastPr);
        }
      }
    } catch (e) { }
  });

  ws.on('error', (e) => {
    console.error("WS Error:", e);
    botState.isWsConnected = false;
  });
  ws.on('close', () => {
    botState.isWsConnected = false;
    if (pingInterval) clearInterval(pingInterval);
    setTimeout(startWS, 5000);
  });
}

function getAvgRange(ohlcv: any[], period: number = 14) {
  const slice = ohlcv.slice(-period);
  const sum = slice.reduce((acc, bar: any) => acc + (bar[2] - bar[3]), 0);
  return sum / period;
}

function calcADX(ohlcv: any[], period: number = 14) {
  if (ohlcv.length < period * 2) return 0;
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
  for (let i = 0; i < str.length; i++) {
    const pDI = 100 * (sdmP[i] / str[i]);
    const mDI = 100 * (sdmM[i] / str[i]);
    dx.push(100 * Math.abs(pDI - mDI) / (pDI + mDI || 1));
  }
  const adxList = smooth(dx);
  return adxList[adxList.length - 1];
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
    const balanceInfo = await ex.fetchBalance();
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
    if (!bars || bars.length < 30) {
      console.log(`⚠️ Không đủ dữ liệu nến (${bars?.length || 0}). Đang chờ...`);
      setTimeout(traderLoop, 10000);
      return;
    }

    // --- TELEGRAM ALERTS FOR SWEEPS ---
    const sweepResult = detectWhaleSweep(bars);
    const sweepLow = sweepResult.sweepLow;
    const sweepHigh = sweepResult.sweepHigh;
    const candleIndex = (sweepResult as any).candleIndex;

    if ((sweepLow || sweepHigh) && candleIndex !== botState.lastNotifiedCandle) {
        const type = sweepLow ? "🟢 QUÉT ĐÁY (SWEEP LOW)" : "🔴 QUÉT ĐỈNH (SWEEP HIGH)";
        const currentPrice = bars[bars.length - 1][4];
        const msg = `🐋 *PHÁT HIỆN WHALE SWEEP*\n\n` +
                   `🔍 Loại: ${type}\n` +
                   `💰 Giá hiện tại: ${currentPrice}\n` +
                   `📊 P/S: Đây là tín hiệu tiềm năng. Bot sẽ tự động đánh giá nến này 10s trước khi đóng để quyết định vào lệnh.`;
        sendTelegram(msg);
        botState.lastNotifiedCandle = candleIndex;
    }

    // --- KIỂM TRA THỜI GIAN ĐÓNG NẾN (CANDLE CLOSE CONSTRAINT) ---
    const timeframeMs = 15 * 60 * 1000; // 15 phút
    const now = Date.now();
    const nextClose = Math.ceil(now / timeframeMs) * timeframeMs;
    const timeToClose = nextClose - now;
    const secondsToClose = Math.floor(timeToClose / 1000);

    if (secondsToClose > 10) {
      if (now % 60000 < 10000) { // Log mỗi phút một lần
        console.log(`⏳ Đang chờ nến đóng... (Còn ${secondsToClose}s nữa)`);
      }
      setTimeout(traderLoop, 5000);
      return;
    }

    console.log(`🎯 [ENTRY WINDOW] Chỉ còn ${secondsToClose}s trước khi đóng nến. Tiến hành kiểm tra tín hiệu cuối cùng...`);

    const adx = calcADX(bars, 14);
    const sweepResult = detectWhaleSweep(bars);
    const sweepLow = sweepResult.sweepLow;
    const sweepHigh = sweepResult.sweepHigh;
    const obSignal = getOrderbookSignal();
    const obRatio = botState.ask !== 0 ? (botState.bid / botState.ask).toFixed(2) : "1.00";

    // Log chi tiết để theo dõi cú quét mới
    if (sweepLow || sweepHigh) {
      console.log(`[!] PHÁT HIỆN WHALE SWEEP: ${sweepLow ? "LONG/BUY" : "SHORT/SELL"} | Volume & Rejection đạt chuẩn.`);
    }

    console.log(`[PHÂN TÍCH] Giá: ${botState.lastPrice} | ADX: ${adx.toFixed(1)} (Min 25) | Quét Whale: ${sweepLow ? "LOW" : sweepHigh ? "HIGH" : "KHÔNG"} | Tỷ lệ OB: ${obRatio}`);

    let signal: 'LONG' | 'SHORT' | null = null;
    if (sweepLow && obSignal === "BULL" && adx >= 25) signal = "LONG";
    if (sweepHigh && obSignal === "BEAR" && adx >= 25) signal = "SHORT";

    if (signal) {
      const entry = botState.lastPrice;
      const rangeAvg = getAvgRange(bars, 14);
      const sl = signal === "LONG" ? entry - rangeAvg : entry + rangeAvg;
      const tp = signal === "LONG" ? entry + (entry - sl) * RR : entry - (sl - entry) * RR;

      const riskAmt = botState.balance * RISK_PER_TRADE;
      const stopDist = Math.abs(entry - sl);

      if (stopDist > 0) {
        let size = riskAmt / stopDist;
        const maxNotional = (botState.balance * 0.1) / entry;
        size = Math.min(size, maxNotional);

        if (size > 0) {
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
            sendTelegram(`✅ *ĐẶT LỆNH THÀNH CÔNG*\nBot đã thực thi lệnh ${signal} trên Bitget.`);
          } catch (e: any) {
            console.error("❌ Order Execution Error:", e);
            sendTelegram(`❌ *LỖI ĐẶT LỆNH SÀN*\nKhông thể thực thi lệnh trên Bitget.\nLỗi: ${e.message}`);
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
      console.log(`[API] Serving status request at ${new Date().toLocaleTimeString()}`);
      res.json({
        status: botState.isRunning ? "running" : "idle",
        symbol: PAIR,
        last_price: botState.lastPrice || 0,
        bid_ratio: botState.ask !== 0 ? (botState.bid / botState.ask).toFixed(2) : "1.00",
        in_position: botState.inPosition,
        signals: (botState.signals || []).slice(0, 10),
        balance: botState.balance || 0,
        ai_reasoning: botState.aiReasoning || "Đang chờ phân tích..."
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

  // Start background processes
  startWS();
  traderLoop();

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

  // --- BÁO CÁO ĐỊNH KỲ (4 GIỜ) ---
  setInterval(() => {
    const wsStatus = botState.isWsConnected ? "✅ Đang kết nối" : "❌ Mất kết nối";
    const statusMsg = `📊 *BÁO CÁO TRẠNG THÁI*
🌐 WebSocket: ${wsStatus}
💰 Giá BTC: $${botState.lastPrice.toFixed(2)}
⚖️ Bid/Ask: ${(botState.bid / (botState.ask || 1)).toFixed(2)}
💼 Vị thế: ${botState.inPosition ? "Đang giữ lệnh" : "Trống"}
💵 Số dư: $${botState.balance.toFixed(2)}`;
    sendTelegram(statusMsg);
  }, 14400000); // 4 giờ = 14,400,000ms

  sendTelegram("🐳 *Whale Bot Đã Khởi Chạy*\nBot đã đồng bộ và bắt đầu hoạt động...");

  // Vite middleware or static serving
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ 
      server: { middlewareMode: true }, 
      appType: "spa" 
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
    }
  }

  // Error handling middleware
  app.use((err: any, req: any, res: any, next: any) => {
    console.error("Express Error Handler:", err);
    res.status(500).send("Something broke!");
  });

  // Listen on PORT - Moved to the end
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Trading Server running on http://localhost:${PORT}`);
  });
}

startServer();
