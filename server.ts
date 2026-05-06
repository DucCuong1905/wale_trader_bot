import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import * as ccxt from "ccxt";
import WebSocket from "ws";
import cors from "cors";
import { runBacktest } from "./backtester.ts";

import { GoogleGenAI } from "@google/genai";

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

const ai = new GoogleGenAI({ apiKey: aiKey });
const modelName = "gemini-2.5-flash"; 

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
const BACKTEST_RESULTS_FILE = path.join(DATA_DIR, "backtest_results.json");

let backtestStatus = {
  isRunning: false,
  progress: 0,
  lastResult: null as any
};

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

function loadTrades() {
  if (fs.existsSync(TRADES_FILE)) {
    try {
      const data = fs.readFileSync(TRADES_FILE, "utf-8");
      let trades = JSON.parse(data);
      
      // Xóa giao dịch test ngày 3/5/2026 16:09:19 (Thử cả UTC và Local)
      const filtered = trades.filter((t: any) => {
        if (!t.time) return true;
        const isTest = t.time.includes('2026-05-03T16:09:19') || t.time.includes('2026-05-03T09:09:19');
        return !isTest;
      });

      if (filtered.length !== trades.length) {
        console.log(`🧹 Đã dọn dẹp ${trades.length - filtered.length} giao dịch test khỏi bộ nhớ.`);
        // Lưu lại file đã lọc sạch
        try {
          fs.writeFileSync(TRADES_FILE, JSON.stringify(filtered, null, 2));
          console.log(`✅ Đã cập nhật file ${TRADES_FILE} (đã xóa bản ghi test).`);
        } catch (err) {
          console.error("Lỗi khi cập nhật file trades sau khi lọc:", err);
        }
      }
      
      return filtered;
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
async function getAIAnalysis(signal: string, lastPrice: number, obRatio: number, bars: any[], touches?: number) {
  const maxRetries = 3;
  const modelsToTry = [modelName, "gemini-2.0-flash", "gemini-3-flash-preview", "gemini-3.1-flash-lite-preview"]; 

  for (let modelToUse of modelsToTry) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const context = bars.slice(-20).map((b) => {
          const time = new Date(b[0]).toLocaleTimeString();
          return `[${time}] O:${b[1]} H:${b[2]} L:${b[3]} C:${b[4]} V:${b[5]}`;
        }).join("\n");

        // Tính toán xu hướng từ Whale Trades khớp thực tế gần đây (Phiên bản chuyên sâu cho AI)
        const fiveMinsAgo = Date.now() - 300000; // 5 phút gần nhất
        const whales30k = botState.recentWhaleTrades.filter(t => t.amount >= 30000 && t.time >= fiveMinsAgo);
        
        const aggressiveBuy = whales30k.filter(t => t.side === 'buy').reduce((sum, t) => sum + t.amount, 0);
        const aggressiveSell = whales30k.filter(t => t.side === 'sell').reduce((sum, t) => sum + t.amount, 0);
        
        const totalWhaleBuy = botState.recentWhaleTrades.filter(t => t.side === 'buy').reduce((sum, t) => sum + t.amount, 0);
        const totalWhaleSell = botState.recentWhaleTrades.filter(t => t.side === 'sell').reduce((sum, t) => sum + t.amount, 0);
        
        const buyIntensity = totalWhaleBuy > 0 ? (aggressiveBuy / totalWhaleBuy) * 100 : 0;
        const sellIntensity = totalWhaleSell > 0 ? (aggressiveSell / totalWhaleSell) * 100 : 0;

        const whaleSummary = `
- TỔNG QUAN (15p): Buy $${(totalWhaleBuy/1000000).toFixed(2)}M / Sell $${(totalWhaleSell/1000000).toFixed(2)}M.
- ÁP LỰC CUỐI NẾN (5p): Buy $${(aggressiveBuy/1000000).toFixed(2)}M (${buyIntensity.toFixed(1)}%) / Sell $${(aggressiveSell/1000000).toFixed(2)}M (${sellIntensity.toFixed(1)}%).`;

        const prompt = `Bạn là một nhà giao dịch cá voi chuyên nghiệp tại Binance Futures. Bạn phân tích hợp lưu giữa Tường lệnh (Orderbook) và Khớp lệnh thực tế (Whale Trades).
TÍN HIỆU CẦN ĐÁNH GIÁ: ${signal}
GIÁ HIỆN TẠI: ${lastPrice}
ĐỘ MẠNH VÙNG THANH KHOẢN: ${touches || 1} lần chạm (Touches). Càng cao thì tín hiệu đảo chiều càng mạnh.
TỶ LỆ ORDERBOOK (Bid/Ask): ${obRatio} (Tường mua/Tường bán)
DÒNG TIỀN THỰC TẾ (Whale Trades): ${whaleSummary}

BỐI CẢNH THỊ TRƯỜNG (20 nến):
${context}

HƯỚNG DẪN RA QUYẾT ĐỊNH CHUYÊN SÂU:
1. Xác định "Bẫy Orderbook" (Hidden Pressure): Nếu Orderbook nghiêng hẳn về một bên (ví dụ Bid/Ask > 1.5) nhưng "ÁP LỰC CUỐI NẾN" (Whale Trades) lại đang ép ngược lại, đó là dấu hiệu của tường ảo để dụ gà. Hãy REJECT.
2. Xác nhận "Aggressive Money": Whale thật thường đẩy giá dồn dập vào 5 phút cuối nến để tạo nến đẹp. Nếu "ÁP LỰC CUỐI NẾN" chiếm tỷ trọng cao (>30% của cả nến 15p) và đồng thuận với tín hiệu, hãy CONFIRM mạnh tay.
3. Độ mạnh vùng thanh khoản: Tín hiệu xảy ra tại vùng có >= 2 lần chạm (Touches) có xác suất đảo chiều cao hơn rất nhiều.
4. Quản trị rủi ro: Nếu Áp lực 5p cuối và Tổng quan 15p trái ngược nhau hoàn toàn, hãy REJECT.

Trả về duy nhất JSON với format: {"decision": "CONFIRM" hoặc "REJECT", "reason": "...", "confidence": 0-100}`;

        console.log(`[AI] Đang phân tích (${modelToUse}) - Lần thử ${i + 1}/${maxRetries}...`);
        
        const response = await ai.models.generateContent({
          model: modelToUse,
          contents: prompt,
        });

        const text = response.text;
        
        if (!text) throw new Error("AI không trả về nội dung.");
        
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        const cleanText = jsonMatch ? jsonMatch[0] : text;
        const parsed = JSON.parse(cleanText);
        
        console.log(`[AI SUCCESS] ${parsed.decision} (${parsed.confidence}%) dùng ${modelToUse}`);
        return parsed;
        
      } catch (e: any) {
        console.warn(`⚠️ [AI RETRY] ${modelToUse} failed (Attempt ${i + 1}): ${e.message}`);
        
        // Nếu lỗi 503 hoặc 429, chờ lâu hơn một chút
        const isTransient = e.message?.includes("503") || e.message?.includes("429") || e.message?.includes("overloaded");
        const waitTime = isTransient ? 3000 : 1000;

        if (i < maxRetries - 1) {
          await new Promise(r => setTimeout(r, waitTime));
          continue;
        }
      }
    }
  }
  return { decision: "REJECT", reason: "AI Service Unavailable", confidence: 0 };
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

/**
 * Tìm các vùng thanh khoản (Liquidity Zones) dựa trên các cụm đỉnh/đáy hội tụ.
 * @param bars Dữ liệu nến
 * @param type 'high' để tìm vùng kháng cự, 'low' để tìm vùng hỗ trợ
 */
function getLiquidityZones(bars: any[], type: 'high' | 'low') {
  const points = bars.slice(-60).map(b => type === 'high' ? b[2] : b[3]);
  const zones: { price: number, touches: number }[] = [];
  
  // Ngưỡng gom nhóm (Threshold): 0.05% giá hiện tại cho BTC
  const avgPrice = points.reduce((a, b) => a + b, 0) / points.length;
  const threshold = avgPrice * 0.0005; 

  for (const p of points) {
    let found = false;
    for (const zone of zones) {
      if (Math.abs(zone.price - p) <= threshold) {
        // Cập nhật giá trung bình của vùng để vùng trở nên chính xác hơn
        zone.price = (zone.price * zone.touches + p) / (zone.touches + 1);
        zone.touches++;
        found = true;
        break;
      }
    }
    if (!found) {
      zones.push({ price: p, touches: 1 });
    }
  }

  // Chỉ lấy các vùng có ít nhất 2 lần chạm (2 touches)
  return zones.filter(z => z.touches >= 2).sort((a, b) => b.touches - a.touches);
}

function detectWhaleSweep(bars: any[]) {
  if (bars.length < 25) return { sweepHigh: false, sweepLow: false };
  
  const highZones = getLiquidityZones(bars.slice(0, -1), 'high');
  const lowZones = getLiquidityZones(bars.slice(0, -1), 'low');

  const currentBar = bars[bars.length - 1];
  const [, o, h, l, c, v] = currentBar;
  
  // Tính toán Volume trung bình 20 nến
  const prevPeriod = bars.slice(-21, -1);
  const avgVol = prevPeriod.reduce((sum, b) => sum + b[5], 0) / prevPeriod.length;
  const volRatio = v / avgVol;
  const isClimaxVol = volRatio >= 1.2; 
  
  const totalSize = h - l;
  if (totalSize === 0) return { sweepHigh: false, sweepLow: false };

  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;
  const lowerWickRatio = lowerWick / totalSize;
  const upperWickRatio = upperWick / totalSize;

  // --- LOGIC QUÉT VÙNG THANH KHOẢN DƯỚI (SUPPORT SWEEP) ---
  // Ưu tiên các vùng Multi-touch (>= 2)
  for (const zone of lowZones) {
    // Giá thấp nhất nến hiện tại phải đâm thủng vùng zone (Liquidity Grab)
    // Nhưng giá đóng nến phải kéo ngược lên trên vùng đó (Rejection)
    if (isClimaxVol && l < zone.price && c > zone.price) {
      if (lowerWickRatio >= 0.4) {
        console.log(`🔥 [LIQUIDITY SWEEP LOW] Quét vùng hỗ trợ $${zone.price.toFixed(1)} (${zone.touches} touches) | Wick: ${(lowerWickRatio*100).toFixed(1)}%`);
        return { sweepLow: true, sweepHigh: false, candleIndex: bars.length - 1, touches: zone.touches };
      }
    }
  }

  // Fallback: Quét đáy Swing Low của 24 nến gần nhất (1-touch)
  const swingLowLookback = 24;
  const swingLow = Math.min(...bars.slice(-swingLowLookback - 1, -1).map(b => b[3]));
  if (isClimaxVol && l < swingLow && c > swingLow) {
    if (lowerWickRatio >= 0.4) {
      console.log(`🧹 [SWING LOW SWEEP] Quét đáy Swing Low $${swingLow.toFixed(1)} (1 touch) | Wick: ${(lowerWickRatio*100).toFixed(1)}%`);
      return { sweepLow: true, sweepHigh: false, candleIndex: bars.length - 1, touches: 1 };
    }
  }

  // --- LOGIC QUÉT VÙNG THANH KHOẢN TRÊN (RESISTANCE SWEEP) ---
  // Ưu tiên các vùng Multi-touch (>= 2)
  for (const zone of highZones) {
    if (isClimaxVol && h > zone.price && c < zone.price) {
      if (upperWickRatio >= 0.4) {
        console.log(`🔥 [LIQUIDITY SWEEP HIGH] Quét vùng kháng cự $${zone.price.toFixed(1)} (${zone.touches} touches) | Wick: ${(upperWickRatio*100).toFixed(1)}%`);
        return { sweepLow: false, sweepHigh: true, candleIndex: bars.length - 1, touches: zone.touches };
      }
    }
  }

  // Fallback: Quét đỉnh Swing High của 24 nến gần nhất (1-touch)
  const swingHighLookback = 24;
  const swingHigh = Math.max(...bars.slice(-swingHighLookback - 1, -1).map(b => b[2]));
  if (isClimaxVol && h > swingHigh && c < swingHigh) {
    if (upperWickRatio >= 0.4) {
      console.log(`🧹 [SWING HIGH SWEEP] Quét đỉnh Swing High $${swingHigh.toFixed(1)} (1 touch) | Wick: ${(upperWickRatio*100).toFixed(1)}%`);
      return { sweepLow: false, sweepHigh: true, candleIndex: bars.length - 1, touches: 1 };
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
  // Binance Combined Streams: Tên stream TRONG URL phải viết thường hoàn toàn
  const streams = `${SYMBOL_ID}@aggtrade/${SYMBOL_ID}@trade/${SYMBOL_ID}@miniticker/${SYMBOL_ID}@depth20`;
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
      
      // LOG ĐỂ KIỂM TRA (Chỉ log 5 lần đầu)
      if ((global as any).wsLogCount === undefined) (global as any).wsLogCount = 0;
      if ((global as any).wsLogCount < 5) {
        console.log(`[WS DEBUG] Nhận stream: ${streamName}`);
        (global as any).wsLogCount++;
      }

      // Cập nhật giá từ TẤT CẢ các luồng có dữ liệu giá
      let incomingPrice = 0;
      if (d.p) incomingPrice = parseFloat(d.p); // aggTrade
      else if (d.c) incomingPrice = parseFloat(d.c); // miniTicker
      else if (d.b && d.b[0]) incomingPrice = parseFloat(d.b[0][0]); // Best bid từ Depth

      if (incomingPrice > 0) {
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

      if (sName.includes('trade')) {
        // aggTrade hoặc trade đều có p (price) và q (quantity)
        const qty = parseFloat(d.q);
        const price = parseFloat(d.p);
        
        if (!isNaN(qty) && !isNaN(price)) {
          const amount = qty * price;
          const side = d.m ? 'sell' : 'buy';

          // Whale Detection: Ngưỡng $30,000 theo yêu cầu mới
          if (amount > 30000) {
            botState.recentWhaleTrades.push({ time: Date.now(), side, amount, price });
            
            // Log whale trades to server console for debugging if > $1M
            if (amount > 1000000) {
              console.log(`🐋 [WHALE DETECTED] ${side.toUpperCase()} $${amount.toFixed(0)} at ${price}`);
            }
            
            const cutoff = Date.now() - 900000; // Quay lại 15 phút
            botState.recentWhaleTrades = botState.recentWhaleTrades.filter(t => t.time > cutoff);
          }
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
    const timeframeMs = 15 * 60 * 1000; // Quay lại 15 phút gốc
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
      const net = (buyVol - sellVol) / 1000000;
      
      // Sweep check ngay tại thời điểm này
      const finalSweep = detectWhaleSweep(bars) as any;
      const touchesStr = finalSweep.touches ? ` (${finalSweep.touches} touches)` : "";
      const sweepIcon = finalSweep.sweepLow ? `🟢 QUÉT ĐÁY${touchesStr}` : (finalSweep.sweepHigh ? `🔴 QUÉT ĐỈNH${touchesStr}` : "❌ KHÔNG (NONE)");
      
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
        `🐋 Whale Net: ${net >= 0 ? '🟢 +' : '🔴 '}${net.toFixed(2)}M (15p - ${whaleCount} lệnh)\n\n` +
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

          sendTelegram(`🚀 *VÀO LỆNH ${signal}*\n💰 Giá: ${entry}\n✋ Touches: ${sweepResult.touches || 1}\n🛑 SL: ${sl.toFixed(1)}\n🎯 TP: ${tp.toFixed(1)}`);
          const aiEval = await getAIAnalysis(signal, entry, currentRatio, bars, sweepResult.touches);
          botState.aiReasoning = aiEval.reason;
          signalInfo.status = aiEval.decision;

          if (aiEval.decision === "REJECT") {
            sendTelegram(`🤖 *AI TỪ CHỐI LỆNH*\nLý do: ${aiEval.reason}`);
            // Không return nữa để code chạy xuống cuối hàm gọi setTimeout
          } else {
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

  // API Backtest
  app.post("/api/backtest/run", async (req, res) => {
    if (backtestStatus.isRunning) return res.status(400).json({ error: "Backtest is already running" });
    
    backtestStatus.isRunning = true;
    backtestStatus.progress = 0;
    
    runBacktest((p) => {
      backtestStatus.progress = p;
    }).then(results => {
      backtestStatus.isRunning = false;
      backtestStatus.lastResult = results;
      backtestStatus.progress = 100;
    }).catch(err => {
      console.error("Backtest error:", err);
      backtestStatus.isRunning = false;
    });

    res.json({ message: "Backtest started" });
  });

  app.get("/api/backtest/status", (req, res) => {
    if (!backtestStatus.lastResult && fs.existsSync(BACKTEST_RESULTS_FILE)) {
      try {
        backtestStatus.lastResult = JSON.parse(fs.readFileSync(BACKTEST_RESULTS_FILE, "utf-8"));
      } catch (e) {}
    }
    res.json(backtestStatus);
  });
  
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
