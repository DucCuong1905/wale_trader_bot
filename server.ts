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
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
const modelName = "gemini-2.0-flash"; // Sử dụng tên model ổn định trong AI Studio

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
  aiReasoning: "Awaiting analysis..." // Phân tích gần nhất từ AI
};

// --- LOGIC PHÂN TÍCH AI (AI ANALYSIS) ---
async function getAIAnalysis(signal: string, lastPrice: number, obRatio: number, bars: any[]) {
  try {
    const context = bars.slice(-20).map((b) => {
      const time = new Date(b[0]).toLocaleTimeString();
      return `[${time}] O:${b[1]} H:${b[2]} L:${b[3]} C:${b[4]} V:${b[5]}`;
    }).join("\n");

    const prompt = `You are an aggressive high-frequency whale trader. Your goal is to capture market momentum and liquidity sweeps.
SIGNAL TO EVALUATE: ${signal}
CURRENT PRICE: ${lastPrice}
ORDERBOOK BID/ASK RATIO: ${obRatio}

MARKET CONTEXT (Last 20 candles):
${context}

ANALYSIS GUIDELINES:
- Be decisive. If the market structure is even slightly aligned with the ${signal} signal, CONFIRM it.
- Look for early signs of reversal after a liquidity sweep.
- Accept moderate risks if the Bid/Ask ratio supports the move.
- We are playing for 2.5 RR, so we can afford some stops as long as we catch the big sweeps.

FINAL DECISION:
- "CONFIRM" if the signal has at least 60% probability based on your experience.
- "REJECT" only if there is a massive counter-trend volume or clear manipulative fakeout.

Return ONLY a JSON object:
{
  "decision": "CONFIRM" | "REJECT",
  "reason": "Short technical explanation (max 2 sentences)",
  "confidence": 0-100
}`;

    const modelResource = ai.getGenerativeModel({ model: modelName });
    const result = await modelResource.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    });

    const response = await result.response;
    const parsed = JSON.parse(response.text() || "{}");
    return parsed;
  } catch (e) {
    console.error("AI Analysis Error:", e);
    return { decision: "REJECT", reason: "AI Service Error", confidence: 0 };
  }
}

// --- TELEGRAM HELPER ---
async function sendTelegram(msg: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
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
  return wick > body * 2;
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
    } catch (e) { }
  });

  ws.on('error', (e) => console.error("WS Error:", e));
  ws.on('close', () => setTimeout(startWS, 5000));
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
    if (botState.inPosition || (Date.now() - botState.lastTradeTime < COOLDOWN_MS)) {
      setTimeout(traderLoop, 5000);
      return;
    }

    const bars = await ex.fetchOHLCV(PAIR, '15m', 100);
    if (!bars || bars.length < 30) return;

    const adx = calcADX(bars, 14);
    const { eqHigh, eqLow } = getLiquidity(bars);
    const lastBar = bars[bars.length - 1];
    const { sweepHigh, sweepLow } = detectSweep(lastBar, eqHigh, eqLow);
    const absorb = checkAbsorption(lastBar);
    const obSignal = getOrderbookSignal();

    let signal: 'LONG' | 'SHORT' | null = null;
    if (sweepLow && obSignal === "BULL" && absorb && adx > 20) signal = "LONG";
    if (sweepHigh && obSignal === "BEAR" && absorb && adx > 20) signal = "SHORT";

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
          const aiEval = await getAIAnalysis(signal, entry, botState.bid / botState.ask, bars);
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
  app.use(express.json());

  app.get("/api/health", (req, res) => res.json({ status: "ok" }));
  app.get("/api/trading/status", (req, res) => {
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
