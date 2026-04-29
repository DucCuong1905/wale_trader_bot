import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import * as ccxt from "ccxt";
import WebSocket from "ws";

import { GoogleGenAI } from "@google/genai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- AI CONFIG ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const model = "gemini-3-flash-preview";

// --- TRADING LOGIC CONSTANTS ---
const PAIR = "BTC/USDT:USDT";
const SYMBOL_ID = "BTCUSDT"; // For Bitget WS
const RISK_PER_TRADE = 0.005;
const RR = 2;
const COOLDOWN_MS = 60000;
const MAX_DAILY_LOSS = 0.02; // Chặn nếu lỗ 2% trong ngày

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

// System State
let botState = {
  isRunning: true,
  lastPrice: 0,
  bid: 0,
  ask: 0,
  inPosition: false,
  lastPositionCheck: false,
  lastTradeTime: 0,
  balance: 0,
  dailyStartingBalance: 0,
  lastResetDate: "",
  trades: loadTrades() as any[],
  signals: [] as any[],
  aiReasoning: "Awaiting analysis..."
};

// --- AI LOGIC ---
async function getAIAnalysis(signal: string, lastPrice: number, obRatio: number, bars: any[]) {
  try {
    const context = bars.slice(-5).map(b => `Price: ${b[4]}, Vol: ${b[5]}`).join("\n");
    const prompt = `You are a professional whale trader.
Technical Signal: ${signal}
Price: ${lastPrice}
Orderbook Bid/Ask Ratio: ${obRatio}
Recent 5m candles:
${context}

Task: Decide if this trade is likely to succeed based on "Orderflow Absorption" and "Liquidity Sweeps".
Return ONLY a JSON object:
{ "decision": "CONFIRM" | "REJECT", "reason": "1-sentence explanation" }`;

    const result = await ai.models.generateContent({
      model: model,
      contents: prompt,
      config: { responseMimeType: "application/json" }
    });

    const parsed = JSON.parse(result.text || "{}");
    return parsed;
  } catch (e) {
    console.error("AI Analysis Error:", e);
    return { decision: "REJECT", reason: "AI Service Error" };
  }
}

// --- TELEGRAM HELPER ---
async function sendTelegram(msg: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg,
        parse_mode: "Markdown"
      })
    });
  } catch (e) {
    console.error("Telegram Error:", e);
  }
}

// Exchange Init (Lazy)
let exchange: ccxt.bitget | null = null;
function getExchange() {
  if (!exchange) {
    const apiKey = process.env.BG_API_KEY;
    const secret = process.env.BG_SECRET_KEY;
    const password = process.env.BG_PASSPHRASE;

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

// Ported Logic from Python
function getLiquidity(ohlcv: any[]) {
  // OHLCV structure: [timestamp, open, high, low, close, volume]
  const slice = ohlcv.slice(-6, -1); // 5 candles before current
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
  return wick > body * 2;
}

function getOrderbookSignal() {
  if (botState.bid === 0 || botState.ask === 0) return null;
  const ratio = botState.bid / botState.ask;
  if (ratio > 1.5) return "BULL";
  if (ratio < 0.66) return "BEAR";
  return null;
}

// WebSocket Loop (Orderbook & Ticker)
function startWS() {
  const ws = new WebSocket("wss://ws.bitget.com/v2/ws/public");

  ws.on('open', () => {
    console.log("🔌 Connected to Bitget WS");
    ws.send(JSON.stringify({
      op: "subscribe",
      args: [
        { instType: "USDT-FUTURES", channel: "books5", instId: SYMBOL_ID },
        { instType: "USDT-FUTURES", channel: "ticker", instId: SYMBOL_ID }
      ]
    }));
  });

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (!parsed.data || !parsed.data[0]) return;
      const d = parsed.data[0];

      if (d.bids) {
        botState.bid = d.bids.reduce((sum: number, x: any) => sum + parseFloat(x[1]), 0);
        botState.ask = d.asks.reduce((sum: number, x: any) => sum + parseFloat(x[1]), 0);
      }
      if (d.last) {
        botState.lastPrice = parseFloat(d.last);
      }
    } catch (e) {
      // Ignore parse errors
    }
  });

  ws.on('error', (e) => console.error("WS Error:", e));
  ws.on('close', () => setTimeout(startWS, 5000));
}

function getAvgRange(ohlcv: any[], period: number = 14) {
  const slice = ohlcv.slice(-period);
  const sum = slice.reduce((acc, bar: any) => acc + (bar[2] - bar[3]), 0);
  return sum / period;
}

// --- TECHNICAL INDICATORS ---

function calcADX(ohlcv: any[], period: number = 14) {
  if (ohlcv.length < period * 2) return 0;

  let tr: number[] = [];
  let plusDM: number[] = [];
  let minusDM: number[] = [];

  for (let i = 1; i < ohlcv.length; i++) {
    const [prevTs, prevO, prevH, prevL, prevC] = ohlcv[i - 1];
    const [ts, o, h, l, c] = ohlcv[i];

    const tr1 = h - l;
    const tr2 = Math.abs(h - prevC);
    const tr3 = Math.abs(l - prevC);
    tr.push(Math.max(tr1, tr2, tr3));

    const upMove = h - prevH;
    const downMove = prevL - l;

    if (upMove > downMove && upMove > 0) plusDM.push(upMove);
    else plusDM.push(0);

    if (downMove > upMove && downMove > 0) minusDM.push(downMove);
    else minusDM.push(0);
  }

  // Simple Moving Average for smoothing (Wilder's smoothing is standard but SMA is a close proxy)
  const smooth = (arr: number[]) => {
    let result = [arr.slice(0, period).reduce((a, b) => a + b, 0) / period];
    for (let i = period; i < arr.length; i++) {
      result.push((result[result.length - 1] * (period - 1) + arr[i]) / period);
    }
    return result;
  };

  const smoothTR = smooth(tr);
  const smoothPlusDM = smooth(plusDM);
  const smoothMinusDM = smooth(minusDM);

  const dx: number[] = [];
  for (let i = 0; i < smoothTR.length; i++) {
    const plusDI = 100 * (smoothPlusDM[i] / smoothTR[i]);
    const minusDI = 100 * (smoothMinusDM[i] / smoothTR[i]);
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / sum);
  }

  const adx = smooth(dx);
  return adx[adx.length - 1];
}

// Main Trader Loop
async function traderLoop() {
  const ex = getExchange();
  if (!ex) {
    if (botState.isRunning) {
      console.log("🔍 Scanning (Monitoring Mode - No API Keys)...");
    }
    setTimeout(traderLoop, 10000);
    return;
  }

  try {
    // 1. Sync Account Info
    const balanceInfo = await ex.fetchBalance();
    const currentBalance = balanceInfo.USDT ? (balanceInfo.USDT as any).total : 0;
    botState.balance = currentBalance;

    // Reset daily starting balance at UTC 00:00
    const today = new Date().toISOString().split('T')[0];
    if (botState.lastResetDate !== today) {
      console.log(`🌅 New Day Started: ${today}. Recording daily starting balance: ${currentBalance}`);
      botState.dailyStartingBalance = currentBalance;
      botState.lastResetDate = today;
    }

    // Daily Stop Loss Check
    const dailyPnL = currentBalance - botState.dailyStartingBalance;
    const dailyLossPercent = botState.dailyStartingBalance > 0 ? (dailyPnL / botState.dailyStartingBalance) : 0;

    if (dailyLossPercent <= -MAX_DAILY_LOSS) {
      console.warn(`🛑 Daily Loss Limit Reached (${(dailyLossPercent * 100).toFixed(2)}%). Trading paused until tomorrow.`);
      setTimeout(traderLoop, 60000 * 30); // Sleep for 30 mins before re-checking
      return;
    }

    const positions = await ex.fetchPositions([PAIR]);
    const isNowInPosition = positions.some(p => Math.abs(parseFloat(p.info.size || p.contracts || 0)) > 0);
    
    // Kiểm tra nếu mới đóng vị thế
    if (botState.inPosition && !isNowInPosition) {
      const dailyPnL = currentBalance - botState.dailyStartingBalance;
      const pnlPercent = (dailyPnL / botState.dailyStartingBalance * 100).toFixed(2);
      
      const tradeResult = {
        type: 'CLOSE',
        balance: currentBalance,
        pnl: dailyPnL,
        time: new Date().toISOString(),
        status: 'CLOSED'
      };
      
      botState.trades.unshift(tradeResult);
      saveTrade(tradeResult);

      const closedMsg = `🔔 *VỊ THẾ ĐÃ ĐÓNG*\n💰 Số dư hiện tại: $${botState.balance.toFixed(2)}\n📊 PnL hôm nay: ${dailyPnL >= 0 ? '+' : ''}$${dailyPnL.toFixed(2)} (${pnlPercent}%)`;
      sendTelegram(closedMsg);
    }
    
    botState.inPosition = isNowInPosition;

    // Cooldown check
    if (botState.inPosition || (Date.now() - botState.lastTradeTime < COOLDOWN_MS)) {
      setTimeout(traderLoop, 5000);
      return;
    }

    // 2. Technical Analysis (15m Candles)
    const bars = await ex.fetchOHLCV(PAIR, '15m', 100);
    if (!bars || bars.length < 30) return;

    const adx = calcADX(bars, 14);
    const { eqHigh, eqLow } = getLiquidity(bars);
    const lastBar = bars[bars.length - 1];
    const { sweepHigh, sweepLow } = detectSweep(lastBar, eqHigh, eqLow);
    const absorb = checkAbsorption(lastBar);
    const obSignal = getOrderbookSignal();

    console.log(`📊 ADX: ${adx.toFixed(1)} | Seek: ${sweepLow ? 'SWEEP_LOW' : sweepHigh ? 'SWEEP_HIGH' : 'NONE'}`);

    let signal: 'LONG' | 'SHORT' | null = null;
    if (sweepLow && obSignal === "BULL" && absorb && adx > 25) signal = "LONG";
    if (sweepHigh && obSignal === "BEAR" && absorb && adx > 25) signal = "SHORT";

    if (signal) {
      // ADX đã lọc nhiễu, tiến hành vào lệnh
      const entry = botState.lastPrice;
      const rangeAvg = getAvgRange(bars, 14);
      
      const sl = signal === "LONG" ? entry - rangeAvg : entry + rangeAvg;
      const tp = signal === "LONG" ? entry + (entry - sl) * RR : entry - (sl - entry) * RR;

      // Risk Calc
      const riskAmt = botState.balance * RISK_PER_TRADE;
      const stopDist = Math.abs(entry - sl);
      
      if (stopDist > 0) {
        let size = riskAmt / stopDist;
        const maxNotional = (botState.balance * 0.1) / entry; // Safe limit 10%
        size = Math.min(size, maxNotional);

        if (size > 0) {
          const alertMsg = `🚀 *VÀO LỆNH ${signal}*\n💰 Giá: ${entry}\n🛑 SL: ${sl.toFixed(1)}\n🎯 TP: ${tp.toFixed(1)}\n📏 Size: ${size.toFixed(4)}`;
          console.log(alertMsg);
          sendTelegram(alertMsg);
          
          // --- AI SECONDARY CHECK ---
          const aiEval = await getAIAnalysis(signal, entry, botState.bid / botState.ask, bars);
          botState.aiReasoning = aiEval.reason;

          if (aiEval.decision === "REJECT") {
            const rejectMsg = `🤖 *AI REJECTED TRADE*\nLý do: ${aiEval.reason}`;
            console.log(rejectMsg);
            sendTelegram(rejectMsg);
            
            const tradeData = { 
              type: signal, 
              price: entry, 
              time: new Date().toISOString(), 
              status: 'AI_REJECTED', 
              reason: aiEval.reason 
            };
            botState.signals.unshift(tradeData);
            botState.trades.unshift(tradeData);
            saveTrade(tradeData);
            
            return;
          }
          
          const confirmMsg = `🤖 *AI CONFIRMED TRADE*\nLý do: ${aiEval.reason}`;
          console.log(confirmMsg);
          sendTelegram(confirmMsg);
          
          try {
            // Market Entry
            await ex.createMarketOrder(PAIR, signal === 'LONG' ? 'buy' : 'sell', size);
            
            // Set TP (Limit)
            await ex.createOrder(PAIR, 'limit', signal === 'LONG' ? 'sell' : 'buy', size, tp);
            
            // Set SL (Stop Market)
            await ex.createOrder(PAIR, 'stop_market', signal === 'LONG' ? 'sell' : 'buy', size, undefined, { 
              'stopPrice': sl,
              'reduceOnly': true 
            });

            botState.lastTradeTime = Date.now();
            botState.inPosition = true;
            
            const tradeData = { 
              type: signal, 
              price: entry, 
              time: new Date().toISOString(), 
              status: 'EXECUTED',
              sl,
              tp,
              size
            };
            botState.signals.unshift(tradeData);
            botState.trades.unshift(tradeData);
            saveTrade(tradeData);
          } catch (orderError) {
            console.error("❌ Execution Failed:", orderError);
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

  app.use(express.json());

  // Logger Middleware
  app.use((req, res, next) => {
    if (req.url.startsWith('/api')) {
      console.log(`[API] ${req.method} ${req.url}`);
    }
    next();
  });

  // Health Check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // API Routes
  app.get("/api/trading/status", (req, res) => {
    try {
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
    } catch (e) {
      console.error("Status API Error:", e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.get("/api/trading/balance", (req, res) => {
    res.json({
      total: botState.balance,
      currency: "USDT"
    });
  });

  app.get("/api/trading/history", (req, res) => {
    res.json(botState.trades);
  });

  // Start Loops
  startWS();
  traderLoop();

  // Telegram Start Notification
  sendTelegram("🐳 *Whale Bot Started (VPS)*\nBot đã sẵn sàng và đang quét lệnh...");

  // Health Check: Mỗi 4 tiếng
  setInterval(() => {
    let msg = `🛰 *Health Report*\n🕒 Thời gian: ${new Date().toLocaleTimeString()}\n📈 Giá hiện tại: $${botState.lastPrice}\n💰 Số dư: $${botState.balance.toFixed(2)}\n🔄 Trạng thái: ${botState.inPosition ? 'Đang có vị thế' : 'Đang chờ sweep'}`;
    if (!botState.isRunning) msg += `\n⚠️ Lý do: Bot đang tạm dừng (Lỗi hoặc Pause)`;
    sendTelegram(msg);
  }, 1000 * 60 * 60 * 4);

  // Vite integration
  try {
    if (process.env.NODE_ENV !== "production") {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
      console.log("🛠 Vite middleware initialized");
    } else {
      const distPath = path.join(process.cwd(), "dist");
      if (fs.existsSync(distPath)) {
        app.use(express.static(distPath));
        app.get("*", (req, res) => {
          res.sendFile(path.join(distPath, "index.html"));
        });
      }
    }
  } catch (e) {
    console.error("Vite setup error:", e);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Trading Server running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket Listener: Active`);
  });
}

startServer();
