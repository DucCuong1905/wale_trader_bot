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
  
  // Xử lý trường hợp người dùng paste "KEY=VALUE" vào giá trị
  if (cleaned.includes('=') && (cleaned.startsWith(key) || cleaned.includes('_AI_'))) {
    const parts = cleaned.split('=');
    cleaned = parts.slice(1).join('=').trim();
  }
  
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
const modelName = "gemini-2.5-flash"; 

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
  aiReasoning: "Awaiting analysis...", // Phân tích gần nhất từ AI
  isWsConnected: false // Trạng thái kết nối WebSocket
};

// --- LOGIC PHÂN TÍCH AI (AI ANALYSIS) ---
async function getAIAnalysis(signal: string, lastPrice: number, obRatio: number, bars: any[]) {
  const maxRetries = 3;
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
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

      const modelNames = [
        modelName,
        "gemini-2.0-flash-exp", 
        "gemini-1.5-flash", 
        "gemini-1.5-pro"
      ];
      let text = "";
      let lastError = null;
      
      for (const currentModelName of modelNames) {
        try {
          if (currentModelName === modelName) {
            console.log(`[AI] Analyzing with ${currentModelName}...`);
          } else {
            console.log(`[AI] Falling back to ${currentModelName}...`);
          }

          const model = genAI.getGenerativeModel(
            { model: currentModelName },
            { apiVersion: 'v1' }
          );
          
          const result = await model.generateContent(prompt);
          const response = await result.response;
          text = response.text();
          if (text) {
            if (currentModelName !== modelName) {
              console.log(`[AI] Success with fallback model: ${currentModelName}`);
            }
            break;
          }
        } catch (err: any) {
          lastError = err;
          // Silent failure for default model if we have fallbacks
          if (currentModelName !== modelNames[modelNames.length - 1]) {
             // Only log 404s if they happen on the first model to show why we are switching
             if (err.message.includes("404")) {
               console.warn(`[AI] ${currentModelName} not found, trying next...`);
             }
             continue;
          }
          console.error(`[AI] Final model ${currentModelName} failed:`, err.message);
          break; 
        }
      }
      
      if (!text) {
        // TRƯỜNG HỢP CUỐI CÙNG: Thử bằng Fetch trực tiếp nếu SDK bị lỗi endpoint
        try {
          console.log("[AI] Trying direct FETCH (v1beta) as fallback...");
          const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${aiKey}`;
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
          });
          const data: any = await resp.json();
          if (data.candidates && data.candidates[0].content) {
            text = data.candidates[0].content.parts[0].text;
            console.log("[AI] Direct FETCH Success!");
          } else if (data.error) {
            throw new Error(`Direct Fetch Error: ${data.error.message} (Code: ${data.error.code})`);
          }
        } catch (fetchErr: any) {
          console.error("[AI] Direct FETCH failed:", fetchErr.message);
          throw lastError || fetchErr;
        }
      }
      
      if (!text) throw new Error("Could not get any response from AI");
      
      // Xử lý text để lấy JSON (đôi khi AI bao quanh bởi ```json ... ```)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        text = jsonMatch[0];
      }
      
      const parsed = JSON.parse(text);
      console.log(`[AI SUCCESS] Decision: ${parsed.decision} | Confidence: ${parsed.confidence}%`);
      return parsed;
    } catch (e: any) {
      lastError = e;
      console.error(`[AI ERROR] Attempting with key prefix ${aiKey.substring(0, 4)}...`);
      console.error(`[AI ATTEMPT ${attempt}/${maxRetries}] Error:`, e.message);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Wait before retry
      }
    }
  }

  const errorMsg = lastError?.message || "Unknown AI error";
  return { 
    decision: "REJECT", 
    reason: `AI Service Error: ${errorMsg}`, 
    confidence: 0 
  };
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
      console.warn("⚠️ API keys missing. Bot will run in monitoring mode.");
      return null;
    }

    exchange = new ccxt.bitget({
      apiKey,
      secret,
      password,
      enableRateLimit: true,
      options: { defaultType: 'future' }
    });
  }
  return exchange;
}

function getLiquidity(ohlcv: any[]) {
  const slice = ohlcv.slice(-6, -1);
  const highs = slice.map(b => b[2]);
  const lows = slice.map(b => b[3]);
  return {
    eqHigh: Math.max(...highs),
    eqLow: Math.min(...lows)
  };
}

function detectSweep(lastBar: any[], eqHigh: number, eqLow: number) {
  const [, , h, l, c] = lastBar;
  const sweepHigh = h > eqHigh && c < eqHigh;
  const sweepLow = l < eqLow && c > eqLow;
  return { sweepHigh, sweepLow };
}

function checkAbsorption(lastBar: any[]) {
  const [, o, h, l, c] = lastBar;
  const body = Math.abs(c - o);
  const wick = (h - l) - body;
  // Relaxed absorption: wick must be greater than body (previously body * 2)
  return wick > body;
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
    if (botState.isRunning) console.log("🔍 Scanning (Monitoring Mode)...");
    setTimeout(traderLoop, 10000);
    return;
  }

  try {
    console.log("🔄 Trader Loop tick...");
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
      console.log(`🛑 Daily loss limit reached (${(dailyLossPercent*100).toFixed(2)}%). Stopping trades for 30m.`);
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
      console.log("⏳ Waiting for WebSocket price data...");
      setTimeout(traderLoop, 5000);
      return;
    }

    console.log(`📊 Fetching candles for ${PAIR}...`);
    const bars = await ex.fetchOHLCV(PAIR, '15m', undefined, 100);
    if (!bars || bars.length < 30) {
      console.log(`⚠️ Not enough candles (${bars?.length || 0}). Waiting...`);
      setTimeout(traderLoop, 10000);
      return;
    }

    const adx = calcADX(bars, 14);
    const { eqHigh, eqLow } = getLiquidity(bars);
    const lastBar = bars[bars.length - 1];
    const { sweepHigh, sweepLow } = detectSweep(lastBar, eqHigh, eqLow);
    const absorb = checkAbsorption(lastBar);
    const obSignal = getOrderbookSignal();
    const obRatio = botState.ask !== 0 ? (botState.bid / botState.ask).toFixed(2) : "1.00";

    // Detailed Log for debugging why no trades are happening
    console.log(`[ANALYSIS] Price: ${botState.lastPrice} | ADX: ${adx.toFixed(1)} (Min 25) | Sweep: ${sweepLow ? "LOW" : sweepHigh ? "HIGH" : "NONE"} | Absorb: ${absorb} | OB Ratio: ${obRatio}`);

    let signal: 'LONG' | 'SHORT' | null = null;
    // Adjusted ADX to 25
    if (sweepLow && obSignal === "BULL" && absorb && adx >= 25) signal = "LONG";
    if (sweepHigh && obSignal === "BEAR" && absorb && adx >= 25) signal = "SHORT";

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
          sendTelegram(`🚀 *VÀO LỆNH ${signal}*\n💰 Giá: ${entry}\n🛑 SL: ${sl.toFixed(1)}\n🎯 TP: ${tp.toFixed(1)}`);
          const currentRatio = botState.ask !== 0 ? botState.bid / botState.ask : 1.0;
          const aiEval = await getAIAnalysis(signal, entry, currentRatio, bars);
          botState.aiReasoning = aiEval.reason;

          if (aiEval.decision === "REJECT") {
            sendTelegram(`🤖 *AI TỪ CHỐI LỆNH*\nLý do: ${aiEval.reason}`);
            return;
          }

          sendTelegram(`🤖 *AI XÁC NHẬN LỆNH* (${aiEval.confidence}%)\nLý do: ${aiEval.reason}`);
          try {
            await ex.createMarketOrder(PAIR, signal === 'LONG' ? 'buy' : 'sell', size);
            await ex.createOrder(PAIR, 'limit', signal === 'LONG' ? 'sell' : 'buy', size, tp);
            await ex.createOrder(PAIR, 'stop_market', signal === 'LONG' ? 'sell' : 'buy', size, undefined, { 'stopPrice': sl, 'reduceOnly': true });
            botState.lastTradeTime = Date.now();
            botState.inPosition = true;
          } catch (e) {
            console.error("❌ Order Error:", e);
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

  app.get("/api/health", (req, res) => res.json({ status: "ok" }));
  app.get("/api/trading/status", (req, res) => {
    console.log("Serving /api/trading/status");
    res.json({
      status: botState.isRunning ? "running" : "idle",
      symbol: PAIR,
      last_price: botState.lastPrice || 0,
      bid_ratio: botState.ask !== 0 ? (botState.bid / botState.ask).toFixed(2) : "1.00",
      in_position: botState.inPosition,
      signals: botState.signals.slice(0, 10),
      balance: botState.balance || 0,
      ai_reasoning: botState.aiReasoning
    });
  });

  app.get("/api/trading/history", (req, res) => res.json(botState.trades));

  startWS();
  traderLoop();

  // --- KIỂM TRA KẾT NỐI AI ---
  (async () => {
    console.log("-----------------------------------------");
    console.log("🤖 Đang kiểm tra kết nối AI...");
    try {
      console.log(`🔑 Key Prefix: ${aiKey.substring(0, 6)}...`);
      
      // Thử liệt kê models
      try {
        const urlV1 = `https://generativelanguage.googleapis.com/v1/models?key=${aiKey}`;
        const urlV1Beta = `https://generativelanguage.googleapis.com/v1beta/models?key=${aiKey}`;
        
        console.log(`📂 Kiểm tra models available (v1)...`);
        const resp1 = await fetch(urlV1);
        const data1: any = await resp1.json();
        
        if (data1.models) {
          console.log("✅ Models (v1):", data1.models.map((m: any) => m.name.split("/models/")[1]).join(", "));
        } else if (data1.error) {
          console.log(`⚠️ v1 check error: ${data1.error.message}`);
        }

        console.log(`📂 Kiểm tra models available (v1beta)...`);
        const resp2 = await fetch(urlV1Beta);
        const data2: any = await resp2.json();
        
        if (data2.models) {
          console.log("✅ Models (v1beta):", data2.models.map((m: any) => m.name.split("/models/")[1]).join(", "));
        }
        
        if (!data1.models && !data2.models) {
          console.error("❌ KHÔNG TÌM THẤY MODEL NÀO. Vui lòng kiểm tra:");
          console.error("1. API Key đã được kích hoạt 'Generative Language API' chưa?");
          console.error("2. Key có bị giới hạn IP/Referer không?");
        }
      } catch (e: any) {
        console.log("📂 Lỗi khi check danh sách model:", e.message);
      }

      const dummyBars = [[Date.now(), 70000, 71000, 69000, 70500, 100]];
      const testEval = await getAIAnalysis("TEST_STARTUP", 70500, 1.2, dummyBars);
      
      if (testEval && testEval.decision && !testEval.reason.includes("AI Service Error")) {
        console.log(`✅ Kết nối AI thành công! Quyết định: ${testEval.decision}`);
        console.log(`📝 AI trả lời: ${testEval.reason}`);
        botState.aiReasoning = testEval.reason; // Update UI with test result
      } else {
        console.error("❌ AI chưa hoạt động ổn định. Lý do:", testEval.reason);
      }
    } catch (err: any) {
      console.error("❌ Lỗi nghiêm trọng khi khởi tạo AI:", err.message);
    }
    console.log("-----------------------------------------");
  })();
  
  // --- BÁO CÁO ĐỊNH KỲ (5 PHÚT) ---
  setInterval(() => {
    const wsStatus = botState.isWsConnected ? "✅ Đang kết nối" : "❌ Mất kết nối";
    const statusMsg = `📊 *BÁO CÁO TRẠNG THÁI (5P)*
🌐 WebSocket: ${wsStatus}
💰 Giá BTC: $${botState.lastPrice.toFixed(2)}
⚖️ Bid/Ask: ${(botState.bid / (botState.ask || 1)).toFixed(2)}
💼 Vị thế: ${botState.inPosition ? "Đang giữ lệnh" : "Trống"}
💵 Số dư: $${botState.balance.toFixed(2)}`;
    
    sendTelegram(statusMsg);
  }, 300000); // 5 phút = 300,000ms

  sendTelegram("🐳 *Whale Bot Started (Sync)*\nBot đã đồng bộ và đang hoạt động...");

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
    }
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Trading Server running on http://localhost:${PORT}`);
  });
}

startServer();
