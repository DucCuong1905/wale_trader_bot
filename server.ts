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
    console.warn(`[WARN] Error reading .env directly for ${key}:`, e);
  }

  const val = process.env[key];
  if (!val) return "";
  
  let cleaned = val.trim();
  cleaned = cleaned.replace(/^["']|["']$/g, '').trim();
  return cleaned;
};

const aiKey = getEnv("GEMINI_API_KEY");
const ai = new GoogleGenAI({ apiKey: aiKey });
const modelName = "gemini-2.0-flash"; 

// --- CẤU HÌNH GIAO DỊCH ---
const PAIR = "BTC/USDT:USDT"; // Cặp giao dịch (Futures)
const SYMBOL_ID = "btcusdt"; // ID ký hiệu cho WebSocket
const TIMEFRAME = "1m"; // Khung thời gian nến (1 phút)
const IS_LIVE_TRADING_ENABLED = false; // Chế độ giao dịch thật (true = bật, false = test)
const RISK_PER_TRADE = 0.01; // Rủi ro trên mỗi lệnh (1% tài khoản)
const RR = 1.0; // Tỷ lệ Risk/Reward 1:1 theo yêu cầu
const COOLDOWN_MS = 30000; // Thời gian chờ giữa các lệnh (30 giây)
const MAX_DAILY_LOSS = 0.03; // Giới hạn lỗ tối đa trong ngày (3%)

// --- QUẢN LÝ VỊ THẾ GIẢ LẬP (PAPER TRADING) ---
let paperPosition: {
  type: "LONG" | "SHORT";
  entry: number;
  sl: number;
  tp: number;
  size: number;
  startTime: number;
} | null = null;
let paperBalance = 5000; // Vốn giả lập ban đầu 5000$

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
      const filtered = trades.filter((t: any) => {
        if (!t.time) return true;
        const isTest = t.time.includes('2026-05-03T16:09:19') || t.time.includes('2026-05-03T09:09:19');
        return !isTest;
      });
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
  const limited = trades.slice(0, 1000);
  try {
    fs.writeFileSync(TRADES_FILE, JSON.stringify(limited, null, 2));
  } catch (e) {
    console.error("Error saving trade:", e);
  }
}

interface WhaleTrade {
  time: number;
  side: 'buy' | 'sell';
  amount: number; 
  price: number;
}

let botState = {
  isRunning: true,
  lastPrice: 0,
  bid: 0,
  ask: 0,
  inPosition: false,
  lastTradeTime: 0,
  lastProcessedCandleTime: 0,
  balance: 0,
  dailyStartingBalance: 0,
  lastResetDate: "",
  trades: loadTrades() as any[],
  signals: [] as any[],
  lastNotifiedCandle: -1,
  obRatioEMA: 1.0,
  adx: 0,
  plusDI: 0,
  minusDI: 0,
  aiReasoning: "Đang chờ phân tích...",
  isWsConnected: false,
  isInitNotified: false, // Thêm cờ thông báo khởi động
  apiError: "",
  recentWhaleTrades: [] as WhaleTrade[],
  lastReportKey: "",
  latestSweepStatus: "None" as "None" | "Low" | "High",
  latestSweepCandle: -1,
};

/**
 * Hàm lấy phân tích từ AI Gemini để xác nhận tín hiệu giao dịch.
 * @param signal Loại tín hiệu (LONG/SHORT)
 * @param lastPrice Giá hiện tại
 * @param obRatio Tỷ lệ Orderbook (Mua/Bán)
 * @param bars Dữ liệu nến gần đây
 * @param touches Số lần chạm vùng thanh khoản
 */
async function getAIAnalysis(signal: string, lastPrice: number, obRatio: number, bars: any[], touches?: number) {
  const maxRetriesPerModel = 2;
  const modelsToTry = ["gemini-2.0-flash", "gemini-2.0-flash-lite-preview-02-05"]; 

  for (let modelToUse of modelsToTry) {
    for (let i = 0; i < maxRetriesPerModel; i++) {
      try {
        const context = bars.slice(-20).map((b: any) => {
          const time = new Date(b[0]).toLocaleTimeString();
          return `[${time}] O:${b[1]} H:${b[2]} L:${b[3]} C:${b[4]} V:${b[5]}`;
        }).join("\n");

        const fiveMinsAgo = Date.now() - 300000;
        const whales30k = botState.recentWhaleTrades.filter(t => t.amount >= 30000 && t.time >= fiveMinsAgo);
        const aggressiveBuy = whales30k.filter(t => t.side === 'buy').reduce((sum, t) => sum + t.amount, 0);
        const aggressiveSell = whales30k.filter(t => t.side === 'sell').reduce((sum, t) => sum + t.amount, 0);
        const totalWhaleBuy = botState.recentWhaleTrades.filter(t => t.side === 'buy').reduce((sum, t) => sum + t.amount, 0);
        const totalWhaleSell = botState.recentWhaleTrades.filter(t => t.side === 'sell').reduce((sum, t) => sum + t.amount, 0);

        const whaleSummary = `
- TỔNG DÒNG TIỀN (5m): Buy $${(totalWhaleBuy/1000000).toFixed(2)}M / Sell $${(totalWhaleSell/1000000).toFixed(2)}M.
- ÁP LỰC CUỐI NẾN (5p): Buy $${(aggressiveBuy/1000000).toFixed(2)}M / Sell $${(aggressiveSell/1000000).toFixed(2)}M.`;

        const prompt = `Bạn là một nhà giao dịch cá voi chuyên nghiệp tại Binance Futures. Bạn phân tích hợp lưu giữa Tường lệnh (Orderbook) và dòng tiền thực tế của cá voi (Whale Trades) trong nến 5 phút.
TÍN HIỆU CẦN ĐÁNH GIÁ: ${signal}
GIÁ HIỆN TẠI: $${lastPrice.toLocaleString()}
ORDERBOOK RATIO (EMA): ${obRatio.toFixed(2)} (Bid/Ask)
LỰC CÁ VOI (Whale Context): ${whaleSummary}
SỐ LẦN CHẠM VÙNG THANH KHOẢN: ${touches || 1}

BỐI CẢNH THỊ TRƯỜNG (20 nến):
${context}

HƯỚNG DẪN RA QUYẾT ĐỊNH CHUYÊN SÂU:
1. Xác định "Bẫy Orderbook" (Hidden Pressure): Nếu Orderbook nghiêng hẳn về một bên (ví dụ Bid/Ask > 1.5) nhưng "ÁP LỰC CUỐI NẾN" (Whale Trades) lại đang ép ngược lại, đó là dấu hiệu của tường ảo để dụ gà. Hãy REJECT.
2. Xác nhận "Aggressive Money": Whale thật thường đẩy giá dồn dập vào 5 phút cuối nến để tạo nến đẹp. Nếu "ÁP LỰC CUỐI NẾN" đồng thuận với tín hiệu, hãy CONFIRM mạnh tay.
3. Độ mạnh vùng thanh khoản: Tín hiệu xảy ra tại vùng có >= 2 lần chạm (Touches) có xác suất đảo chiều cao hơn.
4. Quản trị rủi ro: Nếu Áp lực 5p cuối và Tổng quan trái ngược nhau hoàn toàn, hãy REJECT.

Trả về duy nhất JSON với format: {"decision": "CONFIRM" hoặc "REJECT", "reason": "...", "confidence": 0-100}`;

        const result = await ai.models.generateContent({
          model: modelToUse,
          contents: prompt,
          config: { responseMimeType: "application/json" }
        });

        const text = result.text;
        if (!text) throw new Error("AI không trả về nội dung.");
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        const cleanText = jsonMatch ? jsonMatch[0] : text;
        const parsed = JSON.parse(cleanText);
        console.log(`[AI SUCCESS] ${parsed.decision} (${parsed.confidence}%) dùng ${modelToUse}`);
        return parsed;
      } catch (e: any) {
        console.warn(`[AI RETRY] ${modelToUse} failed: ${e.message}`);
      }
    }
  }
  return { decision: "REJECT", reason: "AI Service Unavailable", confidence: 0 };
}

// --- HELPERS ---
/**
 * Gửi thông báo qua Telegram.
 */
async function sendTelegram(msg: string) {
  const token = getEnv("TELEGRAM_BOT_TOKEN");
  const chatId = getEnv("TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    console.error("[TELEGRAM] Thiếu TOKEN hoặc CHAT_ID trong .env");
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "Markdown" })
    });
    const data = await res.json() as any;
    if (!data.ok) {
      console.error("[TELEGRAM ERROR]", data);
    } else {
      console.log("[TELEGRAM] Đã gửi thông báo thành công.");
    }
  } catch (e: any) {
    console.error("[TELEGRAM FETCH ERROR]", e.message);
  }
}

let exchange: ccxt.binance | null = null;
/**
 * Khởi tạo hoặc lấy đối tượng kết nối với sàn Binance.
 */
function getExchange() {
  const apiKey = getEnv("BINANCE_API_KEY");
  const secret = getEnv("BINANCE_API_SECRET");

  if (!apiKey || !secret) {
    if (!botState.apiError) {
      console.warn("[WARN] BINANCE_API_KEY hoặc BINANCE_API_SECRET chưa được cấu hình.");
      botState.apiError = "Thiếu API Key/Secret. Vui lòng cấu hình trong Settings.";
    }
    return null;
  }

  if (!exchange) {
    exchange = new ccxt.binance({ 
      apiKey, 
      secret, 
      enableRateLimit: true, 
      options: { defaultType: 'future', adjustForTimeDifference: true } 
    });
    
    // Set leverage and margin once
    (async () => {
      try {
        await exchange!.setLeverage(10, PAIR);
        await exchange!.setMarginMode('CROSSED', PAIR);
        botState.apiError = null; // Clear error if success
      } catch (e: any) {
        if (e.name === 'AuthenticationError') {
          botState.apiError = "Lỗi xác thực: API Key sai hoặc thiếu quyền Futures.";
        }
      }
    })();
  }
  return exchange;
}

function getAvgRange(bars: any[], period: number = 20) {
  const slice = bars.slice(-period);
  if (slice.length === 0) return 0;
  return slice.reduce((sum, b) => sum + (b[2] - b[3]), 0) / slice.length;
}

function getSwingPoints(bars: any[], type: 'high' | 'low', lookback: number = 2) {
  const swings: { price: number; index: number }[] = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const current = type === 'high' ? bars[i][2] : bars[i][3];
    let isSwing = true;
    for (let j = 1; j <= lookback; j++) {
      if (type === 'high') {
        if (current <= bars[i - j][2] || current <= bars[i + j][2]) { isSwing = false; break; }
      } else {
        if (current >= bars[i - j][3] || current >= bars[i + j][3]) { isSwing = false; break; }
      }
    }
    if (isSwing) swings.push({ price: current, index: i });
  }
  return swings;
}

function getLiquidityZones(bars: any[], type: 'high' | 'low') {
  const swings = getSwingPoints(bars, type);
  const zones: { price: number; touches: number; lastTouch: number; }[] = [];
  const avgRange = getAvgRange(bars, 20);
  const threshold = avgRange * 0.15;
  for (const swing of swings) {
    let found = false;
    for (const zone of zones) {
      if (Math.abs(zone.price - swing.price) <= threshold) {
        zone.price = (zone.price * zone.touches + swing.price) / (zone.touches + 1);
        zone.touches++;
        zone.lastTouch = swing.index;
        found = true;
        break;
      }
    }
    if (!found) zones.push({ price: swing.price, touches: 1, lastTouch: swing.index });
  }
  return zones.filter(z => z.touches >= 2).sort((a, b) => (b.touches * 10 + b.lastTouch) - (a.touches * 10 + a.lastTouch));
}

function calculateATR(bars: any[], period: number = 14) {
  if (bars.length < period + 1) return 0;
  let trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i][2], l = bars[i][3], pc = bars[i-1][4];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/**
 * Phát hiện hành động quét thanh khoản (Whale Sweep).
 * Sử dụng logic 2 nến: Nến quét (n-2) và nến xác nhận (n-1).
 */
function detectWhaleSweep(bars: any[]) {
  if (bars.length < 15) return { sweepLow: false, sweepHigh: false };
  
  const sweepCandle = bars[bars.length - 2]; // Nến quét thanh khoản
  const confirmCandle = bars[bars.length - 1]; // Nến xác nhận (Displacement)

  const [, sO, sH, sL, sC] = sweepCandle;
  const [, cO, cH, cL, cC, cV] = confirmCandle;

  // 1. LOGIC QUÉT THANH KHOẢN (Local Swing Sweep - 5 nến trước nến quét)
  const prev5Bars = bars.slice(bars.length - 7, bars.length - 2);
  const localLow = Math.min(...prev5Bars.map(b => b[3]));
  const localHigh = Math.max(...prev5Bars.map(b => b[2]));

  // Quét đáy: Râu nến quét thấp hơn đáy cũ nhưng đóng cửa trên đáy cũ
  const sweepLow = sL < localLow && sC > localLow;
  // Quét đỉnh: Râu nến quét cao hơn đỉnh cũ nhưng đóng cửa dưới đỉnh cũ
  const sweepHigh = sH > localHigh && sC < localHigh;

  // 2. VAI TRÒ XÁC NHẬN (Displacement - Thể hiện lực đẩy mạnh)
  const body = Math.abs(cC - cO);
  const totalSize = cH - cL || 1;
  const bodySizes = bars.slice(-16, -1).map(b => Math.abs(b[4] - b[1]));
  const avgBody = bodySizes.reduce((a, b) => a + b, 0) / bodySizes.length;
  
  // Nến xác nhận phải có thân nến lớn (body > 1.2 lần trung bình) và chiếm phần lớn cây nến (> 70%)
  const displacementBullish = body > avgBody * 1.2 && (cC - cL) / totalSize > 0.7;
  const displacementBearish = body > avgBody * 1.2 && (cH - cC) / totalSize > 0.7;

  // 3. VAI TRÒ KHỐI LƯỢNG (Volume)
  const volumes = bars.slice(-21, -1).map(b => b[5]);
  const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  // Khối lượng của nến xác nhận phải cao hơn trung bình (cV > avgVol)
  const volConfirm = cV > avgVol;

  return {
    sweepLow,
    sweepHigh,
    displacementBullish,
    displacementBearish,
    volConfirm,
    low: sL,
    high: sH,
    confirmHigh: cH,
    confirmLow: cL
  };
}

function calcADX(ohlcv: any[], period: number = 14) {
  if (ohlcv.length < period * 2) return { adx: 0, pDI: 0, mDI: 0 };
  let tr: number[] = [], pDM: number[] = [], mDM: number[] = [];
  for (let i = 1; i < ohlcv.length; i++) {
    const pc = ohlcv[i - 1][4], [ts, o, h, l, c] = ohlcv[i], ph = ohlcv[i - 1][2], pl = ohlcv[i - 1][3];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, down = pl - l;
    pDM.push(up > down && up > 0 ? up : 0);
    mDM.push(down > up && down > 0 ? down : 0);
  }
  const smooth = (arr: number[]) => {
    let res = [arr.slice(0, period).reduce((a, b) => a + b, 0) / period];
    for (let i = period; i < arr.length; i++) res.push((res[res.length - 1] * (period - 1) + arr[i]) / period);
    return res;
  };
  const str = smooth(tr), spDM = smooth(pDM), smDM = smooth(mDM);
  const dx: number[] = [], pDIs: number[] = [], mDIs: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const pDI = 100 * (spDM[i] / str[i]), mDI = 100 * (smDM[i] / str[i]);
    pDIs.push(pDI); mDIs.push(mDI);
    dx.push(100 * Math.abs(pDI - mDI) / (pDI + mDI || 1));
  }
  const adxl = smooth(dx);
  return { adx: adxl[adxl.length - 1], pDI: pDIs[pDIs.length - 1], mDI: mDIs[mDIs.length - 1] };
}

function calculateRSI(prices: number[], period: number) {
  if (prices.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[prices.length - i] - prices[prices.length - i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - (100 / (1 + (g / period) / (l / period)));
}

function calculateVWMA(bars: any[], period: number) {
  if (bars.length < period) return bars[bars.length - 1][4];
  let pv = 0, v = 0;
  for (let i = bars.length - period; i < bars.length; i++) { pv += bars[i][4] * bars[i][5]; v += bars[i][5]; }
  return v === 0 ? bars[bars.length - 1][4] : pv / v;
}

// --- WS ---
function startWS() {
  const streams = `${SYMBOL_ID}@aggtrade/${SYMBOL_ID}@trade/${SYMBOL_ID}@miniticker/${SYMBOL_ID}@depth20`;
  const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);
  ws.on('open', () => { botState.isWsConnected = true; });
  ws.on('message', (data) => {
    try {
      const p = JSON.parse(data.toString());
      const d = p.data; if (!d) return;
      if (d.p) botState.lastPrice = parseFloat(d.p);
      else if (d.c) botState.lastPrice = parseFloat(d.c);
      if (p.stream.includes('@depth')) {
        botState.bid = (d.b || d.bids).reduce((s: number, x: any) => s + parseFloat(x[1]), 0);
        botState.ask = (d.a || d.asks).reduce((s: number, x: any) => s + parseFloat(x[1]), 0);
        const r = botState.ask !== 0 ? botState.bid / botState.ask : 1.0;
        botState.obRatioEMA = (r * 0.1) + (botState.obRatioEMA * 0.9);
      } else if (p.stream.includes('trade')) {
        const amount = parseFloat(d.q) * parseFloat(d.p);
        if (amount > 30000) {
          botState.recentWhaleTrades.push({ time: Date.now(), side: d.m ? 'sell' : 'buy', amount, price: parseFloat(d.p) });
          botState.recentWhaleTrades = botState.recentWhaleTrades.filter(t => t.time > Date.now() - 300000);
        }
      }
    } catch (e) {}
  });
  ws.on('error', () => { botState.isWsConnected = false; });
  ws.on('close', () => { botState.isWsConnected = false; setTimeout(startWS, 5000); });
}

/**
 * Vòng lặp chính của Bot: Kiểm tra nến, tín hiệu và thực hiện giao dịch.
 */
async function traderLoop() {
  const ex = getExchange(); 
  if (!ex) { 
    console.log("[INFO] Đang chờ cấu hình API Key để bắt đầu giao dịch...");
    setTimeout(traderLoop, 15000); 
    return; 
  }

  try {
    // 1. KIỂM TRA SỐ DƯ VÀ QUẢN LÝ RỦI RO NGÀY
    let curr = 0;
    if (IS_LIVE_TRADING_ENABLED) {
      let bal;
      try {
        bal = await ex.fetchBalance();
      } catch (authErr: any) {
        if (authErr.message.includes("-2015") || authErr.name === "AuthenticationError") {
          console.error("❌ LỖI BINANCE: API Key không hợp lệ hoặc chưa bật quyền 'Enable Futures'!");
          await sendTelegram("⚠️ Lỗi API Binance: Vui lòng kiểm tra lại Key và quyền 'Enable Futures' trên sàn.");
          setTimeout(traderLoop, 60000); 
          return;
        }
        throw authErr;
      }
      curr = bal.USDT ? (bal.USDT as any).total : 0;
    } else {
      curr = paperBalance;
    }
    
    botState.balance = curr;
    // Tự động reset số dư gốc mỗi ngày
    if (botState.lastResetDate !== new Date().toISOString().split('T')[0]) {
      botState.dailyStartingBalance = curr; botState.lastResetDate = new Date().toISOString().split('T')[0];
    }
    // Dừng nếu lỗ quá 3% trong ngày
    if (botState.dailyStartingBalance > 0 && (curr - botState.dailyStartingBalance) / botState.dailyStartingBalance <= -MAX_DAILY_LOSS) {
      console.log("[WARNING] Đã chạm giới hạn lỗ tối đa trong ngày. Tạm dừng.");
      setTimeout(traderLoop, 15 * 60000); return;
    }

    // 2. KIỂM TRA TRẠNG THÁI VỊ THẾ VÀ COOLDOWN
    if (IS_LIVE_TRADING_ENABLED) {
      const pos = await ex.fetchPositions([PAIR]);
      botState.inPosition = pos.some(p => Math.abs(parseFloat(p.info.size || (p as any).contracts || 0)) > 0);
    } else {
      // PAPER POSITION TRACKING
      if (paperPosition) {
        const lastCandle = (await ex.fetchOHLCV(PAIR, TIMEFRAME, undefined, 1))[0];
        const [, , cH, cL, cC] = lastCandle;
        const currentPrice = cC;
        let closed = false;
        let status: "WIN" | "LOSS" = "WIN";

        if (paperPosition.type === "LONG") {
          if (cL <= paperPosition.sl) { closed = true; status = "LOSS"; }
          else if (cH >= paperPosition.tp) { closed = true; status = "WIN"; }
        } else {
          if (cH <= paperPosition.tp) { closed = true; status = "WIN"; }
          else if (cL >= paperPosition.sl) { closed = true; status = "LOSS"; }
        }

        if (closed) {
          const pnlR = status === "WIN" ? RR : -1.0;
          const pnlDollar = paperPosition.size * pnlR;
          paperBalance += pnlDollar;
          const vnTime = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
          
          await sendTelegram(`✅ [PAPER CLOSED] ${status === "WIN" ? "CHỐT LỜI" : "CẮT LỖ"}\n` +
            `💰 PnL: ${pnlDollar.toFixed(2)}$ (${pnlR}R)\n` +
            `🎯 Entry: ${paperPosition.entry.toFixed(2)} | Exit: ${status === "WIN" ? paperPosition.tp.toFixed(2) : paperPosition.sl.toFixed(2)}\n` +
            `🏦 Số dư: ${paperBalance.toFixed(2)}$\n` +
            `⏰ Giờ VN: ${vnTime}`);
          
          paperPosition = null;
          botState.lastTradeTime = Date.now();
        }
      }
      botState.inPosition = !!paperPosition;
    }

    if (botState.inPosition || Date.now() - botState.lastTradeTime < COOLDOWN_MS) { 
      setTimeout(traderLoop, 10000); 
      return; 
    }

    // 3. LẤY DỮ LIỆU NẾN (OHLCV)
    const bars = await ex.fetchOHLCV(PAIR, TIMEFRAME, undefined, 100);
    if (!bars || bars.length < 50) { setTimeout(traderLoop, 10000); return; }

    // 4. TÍNH TOÁN CÁC CHỈ BÁO KỸ THUẬT (Tính trước để dùng cho thông báo hoặc phân tích)
    const adx = calcADX(bars, 14); botState.adx = adx.adx; botState.plusDI = adx.pDI; botState.minusDI = adx.mDI;
    const rsi = calculateRSI(bars.map(b => b[4]), 14);
    const vwma = calculateVWMA(bars, 20); // VWMA 20 phiên
    const vwmaPrev = calculateVWMA(bars.slice(0, -1), 20);
    const slope = vwma - vwmaPrev; // Độ dốc của VWMA (Slope)
    
    const currentPrice = bars[bars.length - 1][4];
    const distance = Math.abs(currentPrice - vwma) / vwma; // Khoảng cách giá đến VWMA

    // THÔNG BÁO KHI SẴN SÀNG (CHỈ GỬI 1 LẦN KHI KHỞI ĐỘNG XONG)
    if (!botState.isInitNotified) {
      botState.isInitNotified = true;
      console.log("[INIT] Gửi thông báo khởi động...");
      const vnTime = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
      await sendTelegram(`🤖 **WHALE BOT ĐÃ SẴN SÀNG!**\n\n` +
        `✅ Kết nối sàn: Thành công\n` +
        `✅ Dữ liệu nến: Đã tải ${bars.length} nến ${TIMEFRAME}\n` +
        `📊 **Chỉ số hiện tại:**\n` +
        `• VWMA (20): ${vwma.toFixed(2)}\n` +
        `• ADX: ${adx.adx.toFixed(1)} (+DI: ${adx.pDI.toFixed(1)} | -DI: ${adx.mDI.toFixed(1)})\n` +
        `• RSI: ${rsi.toFixed(1)}\n\n` +
        `✅ Vốn khởi điểm: ${botState.balance.toFixed(2)}$\n` +
        `🚀 Chế độ: ${IS_LIVE_TRADING_ENABLED ? "LIVE TRADING ⚡" : "PAPER TRADING 📝"}\n` +
        `⏰ Thời gian: ${vnTime}`);
    }

    const lastCandle = bars[bars.length - 1];
    const lastCandleTime = lastCandle[0];

    // Chỉ phân tích khi có nến mới đóng (M5)
    if (lastCandleTime <= botState.lastProcessedCandleTime) {
      setTimeout(traderLoop, 5000);
      return;
    }
    botState.lastProcessedCandleTime = lastCandleTime;

    const sweep = detectWhaleSweep(bars);
    const atr = calculateATR(bars, 14);

    let sig: "LONG" | "SHORT" | null = null;
    
    // ========================================================
    // 5. ĐIỀU KIỆN VÀO LỆNH LONG (MUA)
    // ========================================================
    if (
      currentPrice > vwma &&             // 1. Giá nằm trên đường VWMA 20
      slope > 0 &&                       // 2. Xu hướng VWMA đang đi lên (Slope dương)
      distance < 0.01 &&                 // 3. Giá không quá xa VWMA (tránh fomo)
      sweep.sweepLow &&                  // 4. Có tín hiệu quét râu ở đáy (Liquidity Sweep Low)
      sweep.displacementBullish &&       // 5. Có nến xác nhận tăng mạnh (Displacement)
      sweep.volConfirm &&                // 6. Khối lượng nến xác nhận đủ lớn
      adx.adx > 15 &&                    // 7. Độ mạnh xu hướng ADX > 15
      adx.pDI > adx.mDI                  // 8. Phe mua mạnh hơn phe bán (+DI > -DI)
    ) {
      sig = "LONG";
    }

    // ========================================================
    // 6. ĐIỀU KIỆN VÀO LỆNH SHORT (BÁN)
    // ========================================================
    if (
      currentPrice < vwma &&             // 1. Giá nằm dưới đường VWMA 20
      slope < 0 &&                       // 2. Xu hướng VWMA đang đi xuống (Slope âm)
      distance < 0.01 &&                 // 3. Giá không quá xa VWMA
      sweep.sweepHigh &&                 // 4. Có tín hiệu quét râu ở đỉnh (Liquidity Sweep High)
      sweep.displacementBearish &&       // 5. Có nến xác nhận giảm mạnh (Displacement)
      sweep.volConfirm &&                // 6. Khối lượng nến xác nhận đủ lớn
      adx.adx > 15 &&                    // 7. Độ mạnh xu hướng ADX > 15
      adx.mDI > adx.pDI                  // 8. Phe bán mạnh hơn phe mua (-DI > +DI)
    ) {
      sig = "SHORT";
    }

    // 7. XỬ LÝ LỆNH (BỎ QUA AI CHECK ĐỂ TRÁNH DELAY)
    if (sig) {
      const confirmRange = sweep.confirmHigh - sweep.confirmLow;
      // Vào lệnh tại điểm hồi (Retracement 40% của nến xác nhận)
      const entryPrice = sig === "LONG" 
        ? sweep.confirmLow + confirmRange * 0.4 
        : sweep.confirmHigh - confirmRange * 0.4;
      
      const e = entryPrice;
      // Stop Loss tại đáy/đỉnh râu quét +- một chút ATR
      const sl = sig === "LONG" ? (sweep.low - atr * 0.2) : (sweep.high + atr * 0.2);
      const tp = e + (e - sl > 0 ? (e - sl) * RR : (sl - e) * -RR);
      
      botState.aiReasoning = `Tín hiệu TA: ${sig} tại ${e.toFixed(2)} (Bỏ qua AI để tối ưu tốc độ)`;
      
      if (!IS_LIVE_TRADING_ENABLED) { 
        // Chế độ Trade thử nghiệm (Paper Trading) logic nâng cao
        const riskAmount = paperBalance * RISK_PER_TRADE;
        const stopLossDistance = Math.abs(e - sl);
        const positionSize = riskAmount; // Đơn giản hóa: Size tính theo USD Risk

        paperPosition = {
          type: sig,
          entry: e,
          sl: sl,
          tp: tp,
          size: positionSize,
          startTime: Date.now()
        };

        const vnTime = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
        botState.lastTradeTime = Date.now(); 

        const conditions = [
          `1. Giá vs VWMA: ${sig === 'LONG' ? (currentPrice > vwma ? '✅ Above' : '❌ Below') : (currentPrice < vwma ? '✅ Below' : '❌ Above')}`,
          `2. Slope: ${sig === 'LONG' ? (slope > 0 ? '✅ Positive' : '❌ Negative') : (slope < 0 ? '✅ Negative' : '❌ Positive')}`,
          `3. Distance: ${distance < 0.01 ? '✅ Safe' : '❌ Fomo'} (${(distance * 100).toFixed(2)}%)`,
          `4. Sweep: ${sig === 'LONG' ? (sweep.sweepLow ? '✅ Low Sweep' : '❌ No Sweep') : (sweep.sweepHigh ? '✅ High Sweep' : '❌ No Sweep')}`,
          `5. Displacement: ${sig === 'LONG' ? (sweep.displacementBullish ? '✅ Strong Bull' : '❌ Weak') : (sweep.displacementBearish ? '✅ Strong Bear' : '❌ Weak')}`,
          `6. Volume: ${sweep.volConfirm ? '✅ Confirmed' : '❌ Low'}`,
          `7. ADX (>15): ${adx.adx > 15 ? '✅' : '❌'} (${adx.adx.toFixed(1)})`,
          `8. DI Power: ${sig === 'LONG' ? (adx.pDI > adx.mDI ? '✅ +DI > -DI' : '❌') : (adx.mDI > adx.pDI ? '✅ -DI > +DI' : '❌')}`
        ].join('\n');

        await sendTelegram(`🚀 [PAPER SIGNAL] **${sig}** Detected!\n\n` +
          `📊 **Thông số lệnh:**\n` +
          `🎯 Entry: ${e.toFixed(2)}\n` +
          `🛑 SL: ${sl.toFixed(2)} | 💎 TP: ${tp.toFixed(2)}\n` +
          `🏦 Balance: ${paperBalance.toFixed(2)}$\n\n` +
          `📝 **8 Điều kiện vào lệnh:**\n${conditions}\n\n` +
          `📈 **Chỉ số kỹ thuật:**\n` +
          `• VWMA: ${vwma.toFixed(2)}\n` +
          `• ADX: ${adx.adx.toFixed(1)} (+DI: ${adx.pDI.toFixed(1)} | -DI: ${adx.mDI.toFixed(1)})\n` +
          `• RSI: ${rsi.toFixed(1)}\n` +
          `⏰ Giờ VN: ${vnTime}`); 
      } else {
        // Chế độ Trade thật trên sàn
        try {
          const size = (botState.balance * RISK_PER_TRADE) / Math.abs(e - sl);
          const amt = ex.amountToPrecision(PAIR, Math.max(size, 0.001));
          await ex.createMarketOrder(PAIR, sig === 'LONG' ? 'buy' : 'sell', parseFloat(amt));
          botState.lastTradeTime = Date.now();
          
          const vnTime = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
          const conditions = [
            `1. Giá vs VWMA: ${sig === 'LONG' ? (currentPrice > vwma ? '✅ Above' : '❌ Below') : (currentPrice < vwma ? '✅ Below' : '❌ Above')}`,
            `2. Slope: ${sig === 'LONG' ? (slope > 0 ? '✅ Positive' : '❌ Negative') : (slope < 0 ? '✅ Negative' : '❌ Positive')}`,
            `3. Distance: ${distance < 0.01 ? '✅ Safe' : '❌ Fomo'} (${(distance * 100).toFixed(2)}%)`,
            `4. Sweep: ${sig === 'LONG' ? (sweep.sweepLow ? '✅ Low Sweep' : '❌ No Sweep') : (sweep.sweepHigh ? '✅ High Sweep' : '❌ No Sweep')}`,
            `5. Displacement: ${sig === 'LONG' ? (sweep.displacementBullish ? '✅ Strong Bull' : '❌ Weak') : (sweep.displacementBearish ? '✅ Strong Bear' : '❌ Weak')}`,
            `6. Volume: ${sweep.volConfirm ? '✅ Confirmed' : '❌ Low'}`,
            `7. ADX (>15): ${adx.adx > 15 ? '✅' : '❌'} (${adx.adx.toFixed(1)})`,
            `8. DI Power: ${sig === 'LONG' ? (adx.pDI > adx.mDI ? '✅ +DI > -DI' : '❌') : (adx.mDI > adx.pDI ? '✅ -DI > +DI' : '❌')}`
          ].join('\n');

          await sendTelegram(`⚡ [LIVE ORDER] **${sig}** ${amt} BTC at ${e.toFixed(2)}\n\n` +
            `📝 **8 Điều kiện vào lệnh:**\n${conditions}\n` +
            `⏰ Giờ VN: ${vnTime}`);
        } catch (err) {
          console.error("Order Error:", err);
        }
      }
    }
  } catch (e) {
    console.error("Trader Loop Error:", e);
  }
  setTimeout(traderLoop, 5000);
}

/**
 * AI News Watcher: Quét tin tức thế giới ảnh hưởng đến BTC mỗi giờ.
 * Sử dụng Google Search Grounding để lấy thông tin thực tế.
 */
async function newsWatcherLoop() {
  try {
    const aiKey = getEnv("GEMINI_API_KEY");
    if (!aiKey) return;

    const genAI = new GoogleGenAI({ apiKey: aiKey });
    
    const prompt = `Bạn là một chuyên gia phân tích tài chính vĩ mô. 
    Hãy tìm kiếm tin tức thế giới mới nhất trong 1 giờ qua (kinh tế Mỹ, chính sách Fed, cá voi di chuyển, tin tức sàn giao dịch) có ảnh hưởng MẠNH đến Bitcoin.
    
    YÊU CẦU:
    1. Nếu KHÔNG có tin gì đặc biệt quan trọng có khả năng thay đổi xu hướng, hãy trả về kết quả duy nhất là từ: "NONE".
    2. Nếu CÓ tin quan trọng, hãy tóm tắt bằng TIẾNG VIỆT: Tên tin, Tác động (Xấu/Tốt), và mức độ ảnh hưởng (1-10).
    
    Chỉ trả về nội dung tóm tắt, không giải thích dài dòng.`;

    const result = await genAI.models.generateContent({ 
      model: "gemini-2.0-flash", 
      contents: prompt,
      tools: [{ googleSearch: {} }],
      toolConfig: { includeServerSideToolInvocations: true }
    });

    const response = result.text.trim();

    if (response !== "NONE" && response.length > 10) {
      console.log("[NEWS WATCHER] Tin tức quan trọng phát hiện.");
      await sendTelegram(`📰 **AI MACRO WATCHER**\n\n${response}`);
    } else {
      console.log("[NEWS WATCHER] Không có tin mới quan trọng.");
    }
  } catch (err) {
    console.error("News Watcher Error:", err);
  }
  // Chạy lại sau 1 giờ
  setTimeout(newsWatcherLoop, 3600000);
}

async function startServer() {
  const app = express();
  app.use(cors()); app.use(express.json());
  app.get("/api/health", (req, res) => res.json({ status: "ok" }));
  app.post("/api/backtest/run", async (req, res) => {
    if (backtestStatus.isRunning) return res.status(400).json({ error: "Running" });
    const { startDate, endDate, rr } = req.body;
    backtestStatus.isRunning = true;
    runBacktest(startDate, endDate, rr, p => { 
      backtestStatus.progress = p; 
    }).then(r => { 
      backtestStatus.isRunning = false; 
      backtestStatus.lastResult = r; 
    }).catch(err => {
      console.error("Backtest Error:", err);
      backtestStatus.isRunning = false;
      backtestStatus.lastResult = { error: err.message };
    });
    res.json({ message: "Started" });
  });
  app.get("/api/backtest/status", (req, res) => res.json(backtestStatus));
  app.get("/api/trading/status", (req, res) => {
    const b = botState.recentWhaleTrades.filter(t => t.side === 'buy').reduce((s, t) => s + t.amount, 0);
    const s = botState.recentWhaleTrades.filter(t => t.side === 'sell').reduce((s, t) => s + t.amount, 0);
    res.json({
      symbol: PAIR, last_price: botState.lastPrice, bid_ratio: botState.obRatioEMA.toFixed(2), in_position: botState.inPosition,
      signals: botState.signals.slice(0, 10), balance: botState.balance, ai_reasoning: botState.aiReasoning,
      adx: botState.adx.toFixed(1), whale_trades: { buy: b.toFixed(0), sell: s.toFixed(0), count: botState.recentWhaleTrades.length }
    });
  });
  app.get("/api/trading/history", (req, res) => res.json(botState.trades));

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(process.cwd(), "dist");
    if (fs.existsSync(dist)) { app.use(express.static(dist)); app.get("*", (req, res) => res.sendFile(path.join(dist, "index.html"))); }
  }

  app.listen(3000, "0.0.0.0", async () => { 
    console.log(`🚀 [SERVER] Bot running at http://0.0.0.0:3000`);
    console.log(`--- SYSTEM REBOOTED 2026 ---`);
    
    // Gửi test Telegram ngay lập tức
    await sendTelegram("🔄 **WHALE BOT ĐÃ RESTART**\nĐang khởi tạo các kết nối và tải dữ liệu nến...");
    
    startWS(); 
    traderLoop(); 
    newsWatcherLoop();
  });
}

startServer();
