import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import * as ccxt from "ccxt";
import WebSocket from "ws";
import cors from "cors";
import { runBacktest, stopBacktestExecution } from "./backtester.ts";
import { calculateMarketRegime, Candle } from "./regime.ts";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- QUẢN LÝ VỊ THẾ GIẢ LẬP (PAPER TRADING) ---
const PAIR = "BTC/USDT:USDT"; // Cặp giao dịch (Futures)
const SYMBOL_ID = "btcusdt"; // ID ký hiệu cho WebSocket
const TIMEFRAME = "1m"; // Khung thời gian nến (1 phút)
const IS_LIVE_TRADING_ENABLED = false; // Chế độ giao dịch thật (true = bật, false = test)
const RISK_PER_TRADE = 0.01; // Rủi ro trên mỗi lệnh (1% tài khoản)
const RR = 1.5; // Tỷ lệ Risk/Reward 1.5 theo yêu cầu
const COOLDOWN_MS = 30000; // Thời gian chờ giữa các lệnh (30 giây)
const MAX_DAILY_LOSS = 0.06; // Giới hạn lỗ tối đa trong ngày (6%)

// CẤU HÌNH PHIÊN GIAO DỊCH (LONDON & NEW YORK)
let ENABLE_SESSION_FILTER = true; 
const VWMA_PERIOD = 20; // Cố định VWMA 20
let ADX_THRESHOLD = 10; // Ngưỡng ADX mặc định
const SESSION_START_GMT = 8;  // 08:00 GMT (Mở phiên Âu)
const SESSION_END_GMT = 21;    // 21:00 GMT (Đóng phiên Mỹ)

// --- QUẢN LÝ VỊ THẾ GIẢ LẬP (PAPER TRADING) ---
let paperPosition: {
  type: "LONG" | "SHORT";
  entry: number;
  sl: number;
  tp: number;
  size: number;
  strategy: string;
  startTime: number;
} | null = null;

let paperPendingOrder: {
  type: "LONG" | "SHORT";
  entry: number;
  sl: number;
  tp: number;
  size: number;
  startTime: number;
  candleCount: number;
  maxCandles: number;
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

// Load last backtest result on startup
if (fs.existsSync(BACKTEST_RESULTS_FILE)) {
  try {
    const data = fs.readFileSync(BACKTEST_RESULTS_FILE, "utf-8");
    backtestStatus.lastResult = JSON.parse(data);
    console.log("📊 Đã tải kết quả backtest gần nhất từ file.");
  } catch (e) {
    console.error("Lỗi khi tải kết quả backtest:", e);
  }
}

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
  vwap: 0,
  aiReasoning: "TA Only Mode",
  isWsConnected: false,
  isInitNotified: false, 
  apiError: "",
  recentWhaleTrades: [] as WhaleTrade[],
  lastReportKey: "",
  latestSweepStatus: "None" as "None" | "Low" | "High",
  latestSweepCandle: -1,
  marketRegime: {
    tqs5m: 0,
    tqs1m: 0,
    totalScore: 0,
    regime: "NEUTRAL",
    riskPercent: 0.5
  }
};

// --- HELPERS ---
/**
 * Gửi thông báo qua Telegram.
 */
async function sendTelegram(msg: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
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
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;

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
      timeout: 30000, // Increase timeout to 30s
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

function calculateVWAP(bars: any[]) {
  if (bars.length === 0) return 0;
  const lastBarDate = new Date(bars[bars.length - 1][0]).getUTCDate();
  let totalPV = 0, totalV = 0;
  for (let i = bars.length - 1; i >= 0; i--) {
    const date = new Date(bars[i][0]).getUTCDate();
    if (date !== lastBarDate) break;
    const typicalPrice = (bars[i][2] + bars[i][3] + bars[i][4]) / 3;
    totalPV += typicalPrice * bars[i][5];
    totalV += bars[i][5];
  }
  return totalV === 0 ? bars[bars.length - 1][4] : totalPV / totalV;
}

/**
 * Phát hiện hành động quét thanh khoản (Whale Sweep).
 * Sử dụng logic 2 nến: Nến quét (n-2) và nến xác nhận (n-1).
 */
function detectWhaleSweep(bars: any[]) {
  if (bars.length < 20) return { sweepLow: false, sweepHigh: false };
  
  const sweepCandle = bars[bars.length - 2]; // Nến quét thanh khoản
  const confirmCandle = bars[bars.length - 1]; // Nến xác nhận (Displacement)

  const [, sO, sH, sL, sC, sV] = sweepCandle;
  const [, cO, cH, cL, cC, cV] = confirmCandle;

  // 1. LOGIC QUÉT THANH KHOẢN (Local Swing Sweep - 5 nến trước nến quét)
  const prevBars = bars.slice(bars.length - 7, bars.length - 2);
  const localLow = Math.min(...prevBars.map(b => b[3]));
  const localHigh = Math.max(...prevBars.map(b => b[2]));

  const sweepSize = sH - sL || 1;
  const lowerWick = Math.min(sO, sC) - sL;
  const upperWick = sH - Math.max(sO, sC);

  const sweepLow = sL <= localLow && sC >= localLow && (lowerWick / sweepSize >= 0.25);
  const sweepHigh = sH >= localHigh && sC <= localHigh && (upperWick / sweepSize >= 0.25);

  // 2. DISPLACEMENT & BODY SIZE
  const body = Math.abs(cC - cO);
  const totalSize = cH - cL || 1;
  const bodySizes = bars.slice(-21, -1).map(b => Math.abs(b[4] - b[1]));
  const avgBody = bodySizes.reduce((a, b) => a + b, 0) / bodySizes.length;
  
  const displacementBullish = body > avgBody * 1.5 && (cC - cL) / totalSize > 0.7 && cC > sH;
  const displacementBearish = body > avgBody * 1.5 && (cH - cC) / totalSize > 0.7 && cC < sL;

  // 4. VOLUME CONFIRM (Standard)
  const volumes = bars.slice(-21, -1).map(b => b[5]);
  const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
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

function calcBB(ohlcv: any[], period: number = 20, stdDev: number = 2) {
  if (ohlcv.length < period) return { mid: 0, top: 0, bot: 0, width: 0 };
  const closes = ohlcv.slice(-period).map(b => b[4]);
  const mid = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((a, b) => a + Math.pow(b - mid, 2), 0) / period;
  const sd = Math.sqrt(variance);
  const top = mid + sd * stdDev;
  const bot = mid - sd * stdDev;
  const width = (top - bot) / mid;
  return { mid, top, bot, width };
}

function calculateVWMA(bars: any[], period: number) {
  if (bars.length < period) return bars[bars.length - 1][4];
  let pv = 0, v = 0;
  for (let i = bars.length - period; i < bars.length; i++) { pv += bars[i][4] * bars[i][5]; v += bars[i][5]; }
  return v === 0 ? bars[bars.length - 1][4] : pv / v;
}

// Kiểm tra phiên giao dịch
function isWithinTradingSessions(timestamp?: number): boolean {
  if (!ENABLE_SESSION_FILTER) return true;
  
  const date = timestamp ? new Date(timestamp) : new Date();
  const hoursGMT = date.getUTCHours();
  
  // Phiên Âu (8h GMT) -> Hết phiên Mỹ (21h GMT)
  if (SESSION_START_GMT <= SESSION_END_GMT) {
    return hoursGMT >= SESSION_START_GMT && hoursGMT < SESSION_END_GMT;
  } else {
    return hoursGMT >= SESSION_START_GMT || hoursGMT < SESSION_END_GMT;
  }
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

async function fetchOHLCVWithRetry(ex: ccxt.Exchange, symbol: string, timeframe: string, since: number | undefined, limit: number, retries: number = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await ex.fetchOHLCV(symbol, timeframe, since, limit);
    } catch (e: any) {
      if (i === retries - 1) throw e;
      const delay = Math.pow(2, i) * 1000;
      console.warn(`[CCXT] Fetch failed (attempt ${i + 1}/${retries}). Retrying in ${delay}ms... Error: ${e.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  return [];
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

    // 2. KIỂM TRA TRẠNG THÁI VỊ THẾ, LỆNH CHỜ VÀ COOLDOWN
    if (IS_LIVE_TRADING_ENABLED) {
      try {
        const pos = await ex.fetchPositions([PAIR]);
        botState.inPosition = pos.some(p => Math.abs(parseFloat(p.info.size || (p as any).contracts || 0)) > 0);
      } catch (authErr: any) {
        if (authErr.message.includes("-2015") || authErr.name === "AuthenticationError") {
          console.error("❌ LỖI BINANCE POSITIONS: API Key không hợp lệ hoặc thiếu quyền!");
          botState.inPosition = false; // Mặc định false nếu không check được
        } else {
          throw authErr;
        }
      }
    } else {
      // PAPER POSITION TRACKING
      let lastCandleSet;
      try {
        lastCandleSet = await fetchOHLCVWithRetry(ex, PAIR, TIMEFRAME, undefined, 1);
      } catch (e: any) {
        console.error("❌ Lỗi lấy nến cuối (paper):", e.message);
        setTimeout(traderLoop, 10000);
        return;
      }
      const lastCandle = lastCandleSet[0];
      const [, , cH, cL, cC] = lastCandle;
      const currentPrice = cC;

      if (paperPosition) {
        let closed = false;
        let status: "WIN" | "LOSS" = "WIN";

        if (paperPosition.type === "LONG") {
          if (cL <= paperPosition.sl) { closed = true; status = "LOSS"; }
          else if (cH >= paperPosition.tp) { closed = true; status = "WIN"; }
        } else {
          if (cH >= paperPosition.sl) { closed = true; status = "LOSS"; }
          else if (cL <= paperPosition.tp) { closed = true; status = "WIN"; }
        }

        if (closed) {
          const pnlR = status === "WIN" ? (paperPosition.strategy === "CONTINUATION" ? 1.2 : 1.0) : -1.0;
          const pnlDollar = paperPosition.size * pnlR;
          paperBalance += pnlDollar;
          const vnTime = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
          
          console.log(`[TRADE] ${status} | ${paperPosition.strategy} | PnL: ${pnlR.toFixed(1)}R | Balance: $${paperBalance.toFixed(2)}`);
          
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
    let bars: any[] = [];
    let bars5m: any[] = [];
    let bars1d: any[] = [];
    try {
      bars = await fetchOHLCVWithRetry(ex, PAIR, TIMEFRAME, undefined, 100);
      bars5m = await fetchOHLCVWithRetry(ex, PAIR, "5m", undefined, 100);
      bars1d = await fetchOHLCVWithRetry(ex, PAIR, "1d", undefined, 100);
    } catch (ohlcvErr: any) {
      console.error("❌ Lỗi fetchOHLCV (sau khi retry):", ohlcvErr.message);
      setTimeout(traderLoop, 10000);
      return;
    }
    if (!bars || bars.length < 50 || !bars5m || bars5m.length < 50 || !bars1d || bars1d.length < 35) { 
      setTimeout(traderLoop, 10000); 
      return; 
    }

    // 3.1 CALCULATE MARKET REGIME
    const toCandle = (b: any): Candle => ({
      open: b[1],
      high: b[2],
      low: b[3],
      close: b[4],
      volume: b[5]
    });

    const m5Candles = bars5m.map(toCandle);
    const m1Candles = bars.map(toCandle);

    const regimeData = calculateMarketRegime(m5Candles, m1Candles);
    botState.marketRegime = regimeData;

    // 4. TÍNH TOÁN CÁC CHỈ BÁO KỸ THUẬT
    // --- Khung M1 ---
    const atrM1 = calculateATR(bars, 14);
    const vwapM1 = calculateVWAP(bars);
    const vwmaM1 = calculateVWMA(bars, 20); // VWMA 20 M1
    const vwmaM1Prev = calculateVWMA(bars.slice(0, -1), 20);
    const slopeM1 = vwmaM1 - vwmaM1Prev;
    const adxM1 = calcADX(bars, 14);
    const currentPrice = bars[bars.length - 1][4];
    
    // --- Khung M5 Filter ---
    const vwma5m = calculateVWMA(bars5m, 20);
    
    // --- Mean Reversion Filter (Check if price is too far from VWMA) ---
    const distFromVWMA = Math.abs(currentPrice - vwmaM1);
    
    botState.adx = adxM1.adx; // Lưu ADX M1 vào botState để hiển thị
    botState.vwap = vwapM1;

    // THÔNG BÁO KHI SẴN SÀNG
    if (!botState.isInitNotified) {
      botState.isInitNotified = true;
      console.log(`🤖 WHALE BOT SẴN SÀNG! Regime: ${regimeData.regime} (TQS 5m: ${regimeData.tqs5m}, TQS 1m: ${regimeData.tqs1m}, Tổng: ${regimeData.totalScore})`);
    }

    const lastCandle = bars[bars.length - 1];
    const lastCandleTime = lastCandle[0];
    const lastCandleLow = lastCandle[3];
    const lastCandleHigh = lastCandle[2];

    // Chỉ phân tích khi có nến mới (M1)
    if (lastCandleTime <= botState.lastProcessedCandleTime) {
      setTimeout(traderLoop, 5000);
      return;
    }
    botState.lastProcessedCandleTime = lastCandleTime;

    const sweep = detectWhaleSweep(bars);

    let sig: "LONG" | "SHORT" | null = null;
    
    // ========================================================
    // 5. ĐIỀU KIỆN VÀO LỆNH (SWEP & CONTINUATION)
    // ========================================================
    const isOverExtendedLong = distFromVWMA > (atrM1 * 2);
    const isOverExtendedShort = distFromVWMA > (atrM1 * 2);

    // --- MINI COMPRESSION & CONTINUATION LOGIC ---
    const recent5 = bars.slice(-6, -1);
    const recentHigh = Math.max(...recent5.map(b => b[2]));
    const recentLow = Math.min(...recent5.map(b => b[3]));
    const compRange = recentHigh - recentLow;
    const volMA = bars.slice(-21, -1).reduce((s, b) => s + b[5], 0) / 20;
    const atrMA = bars.slice(-15, -1).reduce((s, b) => s + (b[2] - b[3]), 0) / 14;
    const atrPrev = bars.length >= 2 ? (bars[bars.length - 2][2] - bars[bars.length - 2][3]) : atrM1;
    const bodySize = Math.abs(bars[bars.length - 1][4] - bars[bars.length - 1][1]);
    const prevHigh = bars[bars.length - 2][2];
    const prevLow = bars[bars.length - 2][3];

    let overlapCount = 0;
    for (let j = 0; j < recent5.length - 1; j++) {
      const h1 = recent5[j][2];
      const l1 = recent5[j][3];
      const h2 = recent5[j+1][2];
      const l2 = recent5[j+1][3];
      if (l1 <= h2 && h1 >= l2) overlapCount++;
    }

    const isAtrExpansion = (atrM1 > atrPrev) || (atrM1 > atrMA * 1.03);

    // LONG CONTINUATION V5
    const isContinuationLong = 
      regimeData.totalScore >= 69 &&   
      currentPrice > vwma5m &&
      currentPrice > vwapM1 &&
      slopeM1 > 0 &&
      adxM1.adx >= 23 &&              
      adxM1.pDI > adxM1.mDI &&
      distFromVWMA < (atrM1 * 1.7) && 
      compRange < (atrM1 * 1.2) &&    
      overlapCount >= 2 &&            
      recentLow > vwma5m &&           
      bars.slice(-4, -1).every(b => b[4] > vwma5m) && 
      isAtrExpansion &&               
      currentPrice > recentHigh &&    
      bodySize > (atrM1 * 0.55) &&     
      bars[bars.length - 1][5] > volMA * 1.15 && 
      currentPrice > prevHigh;

    // SHORT CONTINUATION V5
    const isContinuationShort = 
      regimeData.totalScore >= 69 &&
      currentPrice < vwma5m &&
      currentPrice < vwapM1 &&
      slopeM1 < 0 &&
      adxM1.adx >= 23 &&
      adxM1.mDI > adxM1.pDI &&
      distFromVWMA < (atrM1 * 1.7) &&
      compRange < (atrM1 * 1.2) &&
      overlapCount >= 2 &&
      recentHigh < vwma5m &&
      bars.slice(-4, -1).every(b => b[4] < vwma5m) &&
      isAtrExpansion &&
      currentPrice < recentLow &&
      bodySize > (atrM1 * 0.55) &&
      bars[bars.length - 1][5] > volMA * 1.15 &&
      currentPrice < prevLow;

    // LONG ENTRY
    if (
      isWithinTradingSessions() && (
        (!isOverExtendedLong && currentPrice > vwma5m && currentPrice > vwapM1 && slopeM1 > 0 && adxM1.adx >= ADX_THRESHOLD && adxM1.pDI > adxM1.mDI && sweep.sweepLow && sweep.displacementBullish && sweep.volConfirm) ||
        (regimeData.riskPercent > 0 && isContinuationLong)
      )
    ) {
      sig = "LONG";
    }

    // SHORT ENTRY
    if (
      isWithinTradingSessions() && (
        (!isOverExtendedShort && currentPrice < vwma5m && currentPrice < vwapM1 && slopeM1 < 0 && adxM1.adx >= ADX_THRESHOLD && adxM1.mDI > adxM1.pDI && sweep.sweepHigh && sweep.displacementBearish && sweep.volConfirm) ||
        (regimeData.riskPercent > 0 && isContinuationShort)
      )
    ) {
      sig = "SHORT";
    }

    const isContTrade = (sig === "LONG" && isContinuationLong) || (sig === "SHORT" && isContinuationShort);
    const currentRR = isContTrade ? 1.2 : 1.0;
    const strategyLabel = isContTrade ? "CONTINUATION" : "WHALE SWEEP";

    // 7. XỬ LÝ LỆNH (MARKET ENTRY)
    if (sig && isWithinTradingSessions()) {
      const e = currentPrice; 
      // Set SL cho Continuation
      let sl = sig === "LONG" ? (sweep.low || (currentPrice - atrM1 * 2)) : (sweep.high || (currentPrice + atrM1 * 2));
      if (isContinuationLong || isContinuationShort) {
        sl = sig === "LONG" ? (currentPrice - atrM1 * 1.5) : (currentPrice + atrM1 * 1.5);
      } else {
        sl = sig === "LONG" ? (sweep.low - atrM1 * 0.2) : (sweep.high + atrM1 * 0.2);
      }
      const tp = e + (e - sl > 0 ? (e - sl) * currentRR : (sl - e) * -currentRR);

      console.log(`\n[SIGNAL] ${sig} | ${strategyLabel} | Price: $${e.toFixed(2)}`);
      
      if (!IS_LIVE_TRADING_ENABLED) { 
        const riskPercent = isContTrade ? 0.05 : 0.01; // Whale Sweep cố định 1%
        const riskAmount = paperBalance * riskPercent;
        const positionSize = riskAmount; 

        paperPosition = {
          type: sig,
          entry: e,
          sl: sl,
          tp: tp,
          size: positionSize,
          strategy: strategyLabel,
          startTime: Date.now()
        };

        const vnTime = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
        botState.lastTradeTime = Date.now(); 

        const strategyName = isContTrade ? "CONTINUATION (Bùng nổ tiếp diễn)" : "WHALE SWEEP (Quét thanh khoản)";

        const conditions = [
          `📡 Chiến lược: **${strategyName}**`,
          `1. Khoảng cách VWMA: ${sig === 'LONG' ? (!isOverExtendedLong ? '✅ Ok' : '❌ Quá xa') : (!isOverExtendedShort ? '✅ Ok' : '❌ Quá xa')} (${distFromVWMA.toFixed(2)})`,
          `2. Giá vs VWMA 5m: ${currentPrice > vwma5m ? '✅ Trên' : '❌ Dưới'}`,
          `3. Giá vs VWAP: ${currentPrice > vwapM1 ? '✅ Above' : '❌ Below'}`,
          `4. Slope M1: ${sig === 'LONG' ? (slopeM1 > 0 ? '✅ Positive' : '❌ Negative') : (slopeM1 < 0 ? '✅ Negative' : '❌ Positive')}`,
          `5. ADX M1 (>=${ADX_THRESHOLD}): ${adxM1.adx >= ADX_THRESHOLD ? '✅' : '❌'} (${adxM1.adx.toFixed(1)})`,
          `6. Sweep M1: ${isContTrade ? 'N/A (Continuation)' : '✅ Confirmed'}`,
          `7. DI Power M1: ${sig === 'LONG' ? (adxM1.pDI > adxM1.mDI ? '✅ +DI > -DI' : '❌') : (adxM1.mDI > adxM1.pDI ? '✅ -DI > +DI' : '❌')}`
        ].join('\n');

        await sendTelegram(`🚀 [SIGNAL] **${sig}** Market Entry!\n\n` +
          `📊 **Thông số lệnh:**\n` +
          `🎯 Entry: ${e.toFixed(2)}\n` +
          `🛑 SL: ${sl.toFixed(2)} | 💎 TP: ${tp.toFixed(2)}\n\n` +
          `📝 **Điều kiện:**\n${conditions}\n\n` +
          `⏰ Giờ VN: ${vnTime}`); 
      } else {
        // Chế độ Trade thật trên sàn
        try {
          const riskPercent = isContTrade ? 0.05 : 0.01;
          const riskAmount = botState.balance * riskPercent;
          const size = riskAmount / Math.abs(e - sl);
          const amt = ex.amountToPrecision(PAIR, Math.max(size, 0.001));
          await ex.createMarketOrder(PAIR, sig === 'LONG' ? 'buy' : 'sell', parseFloat(amt));
          botState.lastTradeTime = Date.now();
          
          const vnTime = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
          const conditions = [
            `1. Khoảng cách VWMA: ${sig === 'LONG' ? (!isOverExtendedLong ? '✅ Ok' : '❌ Quá xa') : (!isOverExtendedShort ? '✅ Ok' : '❌ Quá xa')} (${distFromVWMA.toFixed(2)})`,
            `2. Giá vs VWMA 5m: ${currentPrice > vwma5m ? '✅ Trên' : '❌ Dưới'}`,
            `3. Giá vs VWAP: ${currentPrice > vwapM1 ? '✅ Above' : '❌ Below'}`,
            `4. Slope M1: ${sig === 'LONG' ? (slopeM1 > 0 ? '✅ Positive' : '❌ Negative') : (slopeM1 < 0 ? '✅ Negative' : '❌ Positive')}`,
            `5. ADX M1 (>=${ADX_THRESHOLD}): ${adxM1.adx >= ADX_THRESHOLD ? '✅' : '❌'} (${adxM1.adx.toFixed(1)})`,
            `6. Sweep M1: ✅ Confirmed`,
            `7. DI Power M1: ${sig === 'LONG' ? (adxM1.pDI > adxM1.mDI ? '✅ +DI > -DI' : '❌') : (adxM1.mDI > adxM1.pDI ? '✅ -DI > +DI' : '❌')}`
          ].join('\n');

          await sendTelegram(`⚡ [SIGNAL] **${sig}** Market Order (Live)!\n\n` +
            `📊 Entry: ${e.toFixed(2)} (Pure 1M Strategy)\n` +
            `📝 **Điều kiện vào lệnh:**\n${conditions}\n` +
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

async function startServer() {
  const app = express();
  app.use(cors()); app.use(express.json());
  app.get("/api/health", (req, res) => res.json({ status: "ok" }));
  app.post("/api/backtest/run", async (req, res) => {
    if (backtestStatus.isRunning) return res.status(400).json({ error: "Running" });
    const { startDate, endDate, rr, timeframe, enableSessionFilter, adxThreshold } = req.body;
    console.log(`[SERVER] Received backtest request: sessionFilter=${enableSessionFilter}, adxThreshold=${adxThreshold}`);
    backtestStatus.isRunning = true;
    runBacktest(startDate, endDate, rr, timeframe, enableSessionFilter, 20, p => { 
      backtestStatus.progress = p; 
    }, adxThreshold || 10).then(async (r: any) => { 
      backtestStatus.isRunning = false; 
      backtestStatus.lastResult = r; 
      
      // Gửi báo cáo Telegram khi hoàn tất backtest
        if (r && !r.error) {
          const winRate = r.totalTrades > 0 ? (r.wins / r.totalTrades * 100).toFixed(1) : "0.0";
          const longWR = r.longTrades > 0 ? (r.longWins / r.longTrades * 100).toFixed(1) : "0.0";
          const shortWR = r.shortTrades > 0 ? (r.shortWins / r.shortTrades * 100).toFixed(1) : "0.0";
          const netProfit = r.finalBalance - 5000;
          const period = `${new Date(r.startTime).toLocaleDateString('vi-VN')} - ${new Date(r.endTime).toLocaleDateString('vi-VN')}`;
          
          let monthlyStatsReport = "";
          if (r.monthlySnapshots && r.monthlySnapshots.length > 0) {
            monthlyStatsReport = r.monthlySnapshots.map((m: any) => 
              `• ${m.date}: ${m.monthlyProfit.toFixed(2)}$ (${m.monthlyProfitR.toFixed(2)}R) | WR: ${m.winRate}% (${m.trades} trades) (L: ${m.longTrades}, WL: ${m.longWins} -- S: ${m.shortTrades}, WS: ${m.shortWins})`
            ).join('\n');
          }

          // In ra Console để xem dữ liệu thực tế
          console.log("\n" + "=".repeat(60));
          console.log("📊 KẾT QUẢ BACKTEST THỦ CÔNG HOÀN TẤT");
          console.log("-".repeat(60));
          console.log(monthlyStatsReport);
          console.log("-".repeat(60));
          console.log(`💰 Lợi nhuận: ${r.totalProfitR.toFixed(2)}R ($${netProfit.toFixed(2)})`);
          console.log(`📈 Win Rate: ${winRate}% (L: ${longWR}% | S: ${shortWR}%)`);
          console.log(`🔄 Tổng lệnh: ${r.totalTrades}`);
          console.log("=".repeat(60) + "\n");

          await sendTelegram(`📊 **KẾT QUẢ BACKTEST HOÀN TẤT**\n\n` +
            `🗓 **Giai đoạn:** ${period}\n\n` +
            `📅 **Chi tiết từng tháng:**\n${monthlyStatsReport}\n\n` +
            `📈 **Lợi nhuận:** ${r.totalProfitR.toFixed(2)}R ($${netProfit.toFixed(2)})\n` +
            `🎯 **Win Rate:** ${winRate}%\n` +
            `🚀 **LONG:** ${r.longWins}/${r.longTrades} (${longWR}%)\n` +
            `📉 **SHORT:** ${r.shortWins}/${r.shortTrades} (${shortWR}%)\n` +
            `🔄 **Tổng lệnh:** ${r.totalTrades}`);
        }
    }).catch(err => {
      console.error("Backtest Error:", err);
      backtestStatus.isRunning = false;
      backtestStatus.lastResult = { error: err.message };
    });
    res.json({ message: "Started" });
  });
  app.post("/api/backtest/stop", (req, res) => {
    stopBacktestExecution();
    res.json({ status: "Stopping" });
  });

  app.get("/api/backtest/status", (req, res) => res.json(backtestStatus));
  app.get("/api/trading/status", (req, res) => {
    const b = botState.recentWhaleTrades.filter(t => t.side === 'buy').reduce((s, t) => s + t.amount, 0);
    const s = botState.recentWhaleTrades.filter(t => t.side === 'sell').reduce((s, t) => s + t.amount, 0);
    res.json({
      symbol: PAIR, last_price: botState.lastPrice, bid_ratio: botState.obRatioEMA.toFixed(2), in_position: botState.inPosition,
      signals: botState.signals.slice(0, 10), balance: botState.balance, ai_reasoning: botState.aiReasoning,
      adx: botState.adx.toFixed(1), whale_trades: { buy: b.toFixed(0), sell: s.toFixed(0), count: botState.recentWhaleTrades.length },
      enable_session_filter: ENABLE_SESSION_FILTER, vwma_period: VWMA_PERIOD, adx_threshold: ADX_THRESHOLD,
      is_ws_connected: botState.isWsConnected,
      market_regime: botState.marketRegime
    });
  });
  app.post("/api/trading/toggle-session", (req, res) => {
    ENABLE_SESSION_FILTER = !ENABLE_SESSION_FILTER;
    res.json({ success: true, enabled: ENABLE_SESSION_FILTER });
  });
  app.post("/api/trading/set-adx", (req, res) => {
    const { threshold } = req.body;
    if (typeof threshold === 'number' && threshold >= 0) {
      ADX_THRESHOLD = threshold;
      res.json({ success: true, threshold: ADX_THRESHOLD });
    } else {
      res.status(400).json({ error: "Invalid threshold" });
    }
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
    
    console.log("[INIT] Hệ thống đã sẵn sàng.");

    startWS(); 
    traderLoop(); 
    
    // Tự động chạy backtest 2020-2022 khi start
    setTimeout(() => {
      autoRunInitialBacktest();
    }, 5000);
  });
}

async function autoRunInitialBacktest() {
  if (backtestStatus.isRunning) return;
  
  const startDate = "2020-01-01T00:00:00Z";
  const endDate = "2022-01-01T00:00:00Z";
  
  console.log(`[AUTO-BACKTEST] 🔄 Đang tự động chạy backtest từ ${startDate} đến ${endDate}...`);
  
  backtestStatus.isRunning = true;
  runBacktest(startDate, endDate, RR, "1m", ENABLE_SESSION_FILTER, VWMA_PERIOD, (p) => {
    backtestStatus.progress = p;
  }, ADX_THRESHOLD).then(async (r: any) => {
    backtestStatus.isRunning = false;
    backtestStatus.lastResult = r;
    
    if (r && !r.error) {
      const winRate = r.totalTrades > 0 ? (r.wins / r.totalTrades * 100).toFixed(1) : "0.0";
      console.log(`\n✅ [AUTO-BACKTEST] HOÀN TẤT`);
      console.log(`• Giai đoạn: 2020 - 2022`);
      console.log(`• Tổng lệnh: ${r.totalTrades} | Winrate: ${winRate}% | Profit: ${r.totalProfitR.toFixed(1)}R`);
      
      await sendTelegram(`🤖 **TỰ ĐỘNG BACKTEST KHI LÊN SÀN**\n\n` +
        `🗓 Giai đoạn: 2020 - 2022\n` +
        `🔄 Tổng lệnh: ${r.totalTrades}\n` +
        `🎯 Win Rate: ${winRate}%\n` +
        `💰 Profit: ${r.totalProfitR.toFixed(2)}R`);
    }
  }).catch(err => {
    console.error("[AUTO-BACKTEST] Lỗi:", err);
    backtestStatus.isRunning = false;
  });
}

startServer();
