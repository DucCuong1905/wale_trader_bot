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

const resolvedFilename = typeof __filename !== "undefined" ? __filename : "server.cjs";
const resolvedDirname = typeof __dirname !== "undefined" ? __dirname : ".";

// --- QUẢN LÝ VỊ THẾ GIẢ LẬP (PAPER TRADING) ---
const MT5_ENABLED = process.env.MT5_ENABLED === "true";
const PAIR = MT5_ENABLED ? (process.env.MT5_SYMBOL || "XAUUSD") : "BTC/USDT:USDT"; 
const SYMBOL_ID = MT5_ENABLED ? (process.env.MT5_SYMBOL?.toLowerCase() || "xauusd") : "btcusdt"; 
const TIMEFRAME = "1m"; 
const IS_LIVE_TRADING_ENABLED = process.env.IS_LIVE_TRADING_ENABLED === "true";
const MT5_BRIDGE_URL = process.env.MT5_WEBHOOK_URL?.replace('/webhook', '') || "http://localhost:5000";
const RISK_PER_TRADE = 0.01; // Rủi ro trên mỗi lệnh (1% tài khoản)
const RR = 1.2; // Tỷ lệ Risk/Reward 1.2 theo yêu cầu
const COOLDOWN_MS = 30000; // Thời gian chờ giữa các lệnh (30 giây)
const MAX_DAILY_LOSS = 0.06; // Giới hạn lỗ tối đa trong ngày (6%)

// CẤU HÌNH PHIÊN GIAO DỊCH (LONDON & NEW YORK)
let ENABLE_SESSION_FILTER = true; 
let ENABLE_WHALE_SWEEP = true; 
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
  isBE?: boolean; // Đã dời về hòa vốn chưa
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

// Load last backtest result on startup (disabled as requested)
/*
if (fs.existsSync(BACKTEST_RESULTS_FILE)) {
  try {
    const data = fs.readFileSync(BACKTEST_RESULTS_FILE, "utf-8");
    backtestStatus.lastResult = JSON.parse(data);
    console.log("📊 Đã tải kết quả backtest gần nhất từ file.");
  } catch (e) {
    console.error("Lỗi khi tải kết quả backtest:", e);
  }
}
*/

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
  adx: 0,
  plusDI: 0,
  minusDI: 0,
  vwap: 0,
  aiReasoning: "TA Only Mode",
  isWsConnected: false,
  isInitNotified: false, 
  apiError: "",
  lastReportKey: "",
  latestSweepStatus: "None" as "None" | "Low" | "High",
  latestSweepCandle: -1,
  efficiencyHistory: [1.5, 1.5, 1.5] as number[],
  efficiencyPending: [] as { entryPrice: number, type: "LONG" | "SHORT", candleCount: number }[],
  marketRegime: {
    tqs5m: 0,
    tqs1m: 0,
    totalScore: 0,
    regime: "NEUTRAL",
    riskPercent: 0.5
  }
};

/**
 * Gửi thông báo qua Telegram.
 */
async function sendTelegram(msg: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn("[TELEGRAM] Thiếu TOKEN hoặc CHAT_ID, bỏ qua gửi thông báo.");
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
    }
  } catch (e: any) {
    console.error("[TELEGRAM FETCH ERROR]", e.message);
  }
}

/**
 * Thực hiện lệnh qua MT5 Bridge
 */
async function placeMT5Order(type: 'buy' | 'sell', sl: number, tp: number, signalInfo: string) {
    if (!MT5_ENABLED) return null;
    try {
        console.log(`[MT5 BRIDGE] Sending ${type} order for ${PAIR}...`);
        const res = await fetch(`${MT5_BRIDGE_URL}/order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                symbol: PAIR,
                type: type,
                lot: parseFloat(process.env.MT5_LOT_SIZE || "0.01"),
                sl: sl,
                tp: tp,
                comment: signalInfo
            })
        });
        const result = await res.json();
        console.log(`[MT5 BRIDGE] Result:`, result);
        return result;
    } catch (e) {
        console.error("MT5 Bridge Connect Error:", e);
        return { error: "Failed to connect to MT5 Bridge" };
    }
}

/**
 * Gửi tín hiệu sang Python MT5 Bridge trên Windows VPS.
 */
async function sendToMT5(type: "LONG" | "SHORT", entry: number, sl: number, tp: number, symbol: string) {
  const webhookUrl = process.env.MT5_WEBHOOK_URL;
  const mt5Enabled = process.env.MT5_ENABLED === "true";
  
  if (!mt5Enabled || !webhookUrl) {
    console.log(`[MT5] Forwarding disabled or URL missing: enabled=${mt5Enabled}`);
    return;
  }

  console.log(`📡 [MT5] Sending signal for ${symbol}: ${type} at ${entry}`);

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: symbol,
        type: type,
        entry: entry,
        sl: sl,
        tp: tp,
        volume: 0.1 // Có thể điều chỉnh lot size tùy ý
      })
    });
    const result = await res.json() as any;
    if (result.status === "success") {
       await sendTelegram(`🚀 **MT5 ORDER SUCCESS**\nPair: ${symbol}\nType: ${type}\nPrice: ${entry}\nOrder ID: ${result.order}`);
    } else {
       await sendTelegram(`⚠️ **MT5 ORDER FAILED**\nReason: ${result.message}`);
    }
  } catch (err: any) {
    console.error("❌ MT5 Forward failed:", err.message);
    await sendTelegram(`❌ **MT5 CONNECTION ERROR**\n${err.message}`);
  }
}

/**
 * Lấy nến từ MT5 Bridge
 */
async function fetchMT5OHLCV(symbol: string, timeframe: string, limit: number): Promise<any[]> {
  try {
    const res = await fetch(`${MT5_BRIDGE_URL}/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=${limit}`);
    const result = await res.json() as any;
    if (result && result.status === "success" && Array.isArray(result.data)) {
      return result.data;
    }
    throw new Error(result?.message || "Định dạng dữ liệu nến MT5 không hợp lệ");
  } catch (err: any) {
    throw new Error(`Không thể lấy nến từ MT5 Bridge tại ${MT5_BRIDGE_URL}: ${err.message}`);
  }
}

/**
 * Lấy số dư từ tài khoản MT5
 */
async function fetchMT5Balance(): Promise<number> {
  try {
    const res = await fetch(`${MT5_BRIDGE_URL}/account`);
    const result = await res.json() as any;
    if (result && result.status === "success" && typeof result.balance === "number") {
      return result.balance;
    }
    throw new Error(result?.message || "Định dạng số dư MT5 không hợp lệ");
  } catch (err: any) {
    console.warn(`[MT5 BRIDGE] Không lấy được số dư MT5, sử dụng số dư giả lập. Lỗi: ${err.message}`);
    return paperBalance;
  }
}

/**
 * Lấy vị thế hiện tại từ MT5 Bridge
 */
async function fetchMT5Positions(symbol: string): Promise<any[]> {
  try {
    const res = await fetch(`${MT5_BRIDGE_URL}/positions?symbol=${encodeURIComponent(symbol)}`);
    const result = await res.json() as any;
    if (result && result.status === "success" && Array.isArray(result.positions)) {
      return result.positions;
    }
    return [];
  } catch (err: any) {
    console.error(`[MT5 BRIDGE] Không thể lấy vị thế MT5: ${err.message}`);
    return [];
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
    if (!MT5_ENABLED && !botState.apiError) {
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
    
    // Lazy init leverage and margin mode
  }
  return exchange;
}

// Separate function to initialize exchange settings
async function initExchangeSettings(ex: ccxt.binance) {
  if (botState.apiError) return;
  try {
    if (!ex.apiKey || !ex.secret) return;
    await ex.setLeverage(10, PAIR);
    await ex.setMarginMode('CROSSED', PAIR);
    botState.apiError = null;
  } catch (e: any) {
    console.error("[EXCHANGE INIT ERROR]", e.message);
    if (e.name === 'AuthenticationError' || e.message.includes("-2015")) {
      botState.apiError = "Lỗi xác thực: API Key sai hoặc thiếu quyền Futures.";
    }
  }
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
  const streams = `${SYMBOL_ID}@aggtrade/${SYMBOL_ID}@trade/${SYMBOL_ID}@miniticker`;
  const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);
  ws.on('open', () => { botState.isWsConnected = true; });
  ws.on('message', (data) => {
    try {
      const p = JSON.parse(data.toString());
      const d = p.data; if (!d) return;
      if (d.p) botState.lastPrice = parseFloat(d.p);
      else if (d.c) botState.lastPrice = parseFloat(d.c);
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
  const ex = MT5_ENABLED ? null : getExchange(); 
  if (!MT5_ENABLED && !ex) { 
    console.log("[INFO] Đang chờ cấu hình API Key để bắt đầu giao dịch...");
    setTimeout(traderLoop, 15000); 
    return; 
  }

  try {
    // 0. LẤY DỮ LIỆU NẾN TRƯỚC HẾT
    let bars: any[] = [];
    let bars5m: any[] = [];
    let bars1d: any[] = [];
    try {
      if (MT5_ENABLED) {
        bars = await fetchMT5OHLCV(PAIR, "1m", 1000);
        bars5m = await fetchMT5OHLCV(PAIR, "5m", 100);
        bars1d = await fetchMT5OHLCV(PAIR, "1d", 100);
      } else if (ex) {
        bars = await fetchOHLCVWithRetry(ex, PAIR, TIMEFRAME, undefined, 1000);
        bars5m = await fetchOHLCVWithRetry(ex, PAIR, "5m", undefined, 100);
        bars1d = await fetchOHLCVWithRetry(ex, PAIR, "1d", undefined, 100);
      }
    } catch (ohlcvErr: any) {
      console.error("❌ Lỗi fetchOHLCV (sau khi retry):", ohlcvErr.message);
      setTimeout(traderLoop, 10000);
      return;
    }
    if (!bars || bars.length < 50 || !bars5m || bars5m.length < 50 || !bars1d || bars1d.length < 35) { 
      setTimeout(traderLoop, 10000); 
      return; 
    }

    const lastCandle = bars[bars.length - 1];
    const [, , cH, cL, cC] = lastCandle;
    const currentPrice = cC;

    // 1. KIỂM TRA SỐ DƯ VÀ QUẢN LÝ RỦI RO NGÀY
    let curr = 0;
    if (IS_LIVE_TRADING_ENABLED) {
      if (MT5_ENABLED) {
        curr = await fetchMT5Balance();
      } else if (ex) {
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
      }
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
        if (MT5_ENABLED) {
          const pos = await fetchMT5Positions(PAIR);
          botState.inPosition = pos.length > 0;
        } else if (ex) {
          const pos = await ex.fetchPositions([PAIR]);
          botState.inPosition = pos.some(p => Math.abs(parseFloat(p.info.size || (p as any).contracts || 0)) > 0);
        }
      } catch (authErr: any) {
        if (authErr.message.includes("-2015") || authErr.name === "AuthenticationError") {
          console.error("❌ LỖI LIVE POSITIONS: API Key không hợp lệ hoặc thiếu quyền!");
          botState.inPosition = false; // Mặc định false nếu không check được
        } else {
          throw authErr;
        }
      }
    } else {
      // PAPER POSITION TRACKING
      if (paperPosition) {
        let closed = false;
        let status: "WIN" | "LOSS" = "WIN";

        // Tỷ lệ RR ban đầu
        const initialRiskDist = Math.abs(paperPosition.tp - paperPosition.entry) / RR;

        if (paperPosition.type === "LONG") {
          if (cL <= paperPosition.sl) { closed = true; status = "LOSS"; }
          else if (cH >= paperPosition.tp) { closed = true; status = "WIN"; }
        } else {
          if (cH >= paperPosition.sl) { closed = true; status = "LOSS"; }
          else if (cL <= paperPosition.tp) { closed = true; status = "WIN"; }
        }

        if (closed) {
          // Tính PnL dựa trên giá thoát thực tế
          const exitPrice = status === "WIN" ? paperPosition.tp : paperPosition.sl;
          const pnlActualR = (paperPosition.type === "LONG" ? (exitPrice - paperPosition.entry) : (paperPosition.entry - exitPrice)) / initialRiskDist;
          
          const pnlDollar = paperPosition.size * pnlActualR;
          paperBalance += pnlDollar;
          const vnTime = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
          
          console.log(`[TRADE] ${status} | ${paperPosition.strategy} | PnL: ${pnlActualR.toFixed(1)}R | Balance: $${paperBalance.toFixed(2)}`);
          
          await sendTelegram(`✅ [PAPER CLOSED] ${status === "WIN" ? "CHỐT LỜI" : "CẮT LỖ"}\n` +
            `💰 PnL: ${pnlDollar.toFixed(2)}$ (${pnlActualR.toFixed(2)}R)\n` +
            `🎯 Entry: ${paperPosition.entry.toFixed(2)} | Exit: ${exitPrice.toFixed(2)}\n` +
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

    // 3.1 COMPUTE ROLLING SWEEP WINRATE OVER HISTORY
    const toCandle = (b: any): Candle => ({
      open: b[1],
      high: b[2],
      low: b[3],
      close: b[4],
      volume: b[5]
    });

    const m5Candles = bars5m.map(toCandle);
    const m1Candles = bars.map(toCandle);

    let sweepHistoryQueue: number[] = [];
    let pendingSweeps: { type: "LONG" | "SHORT", entryPrice: number, sl: number, tp: number, triggerIndex: number }[] = [];

    for (let idx = 100; idx < bars.length; idx++) {
      const [, , barH, barL, barC] = bars[idx];
      
      // Resolve pending sweeps
      for (let sIdx = pendingSweeps.length - 1; sIdx >= 0; sIdx--) {
        const ps = pendingSweeps[sIdx];
        let resolved = false;
        let won = false;
        
        if (ps.type === "LONG") {
          if (barL <= ps.sl && barH >= ps.tp) {
            resolved = true;
            won = false; // conservative loss
          } else if (barL <= ps.sl) {
            resolved = true;
            won = false;
          } else if (barH >= ps.tp) {
            resolved = true;
            won = true;
          }
        } else { // SHORT
          if (barH >= ps.sl && barL <= ps.tp) {
            resolved = true;
            won = false; // conservative loss
          } else if (barH >= ps.sl) {
            resolved = true;
            won = false;
          } else if (barL <= ps.tp) {
            resolved = true;
            won = true;
          }
        }
        
        // Expired after 150 candles
        if (!resolved && (idx - ps.triggerIndex >= 150)) {
          resolved = true;
          won = ps.type === "LONG" ? (barC >= ps.entryPrice) : (barC <= ps.entryPrice);
        }
        
        if (resolved) {
          sweepHistoryQueue.push(won ? 1 : 0);
          if (sweepHistoryQueue.length > 12) {
            sweepHistoryQueue.shift();
          }
          pendingSweeps.splice(sIdx, 1);
        }
      }

      // If it's not the ticking candle (idx < bars.length - 1), we can detect new sweeps triggering
      if (idx < bars.length - 1) {
        const calcWindow = bars.slice(Math.max(0, idx - 100), idx + 1);
        const sweep = detectWhaleSweep(calcWindow);
        
        let atrVal = 0;
        if (calcWindow.length >= 15) {
          let sum = 0;
          for (let j = calcWindow.length - 14; j < calcWindow.length; j++) {
            const c_curr = calcWindow[j];
            const c_prev = calcWindow[j - 1];
            const tr = Math.max(
              c_curr[2] - c_curr[3],
              Math.abs(c_curr[2] - c_prev[4]),
              Math.abs(c_curr[3] - c_prev[4])
            );
            sum += tr;
          }
          atrVal = sum / 14;
        }

        const isNewSweepLong = sweep.sweepLow && sweep.displacementBullish && sweep.volConfirm;
        const isNewSweepShort = sweep.sweepHigh && sweep.displacementBearish && sweep.volConfirm;

        const currentPriceVal = barC;
        if (isNewSweepLong) {
          const slPrice = sweep.low - atrVal * 0.2;
          const riskAmt = Math.max(0.0001, Math.abs(currentPriceVal - slPrice));
          const tpPrice = currentPriceVal + riskAmt * RR;
          if (!pendingSweeps.some(ps => ps.triggerIndex === idx && ps.type === "LONG")) {
            pendingSweeps.push({
              type: "LONG",
              entryPrice: currentPriceVal,
              sl: slPrice,
              tp: tpPrice,
              triggerIndex: idx
            });
          }
        } else if (isNewSweepShort) {
          const slPrice = sweep.high + atrVal * 0.2;
          const riskAmt = Math.max(0.0001, Math.abs(currentPriceVal - slPrice));
          const tpPrice = currentPriceVal - riskAmt * RR;
          if (!pendingSweeps.some(ps => ps.triggerIndex === idx && ps.type === "SHORT")) {
            pendingSweeps.push({
              type: "SHORT",
              entryPrice: currentPriceVal,
              sl: slPrice,
              tp: tpPrice,
              triggerIndex: idx
            });
          }
        }
      }
    }

    const rollingWinRate = sweepHistoryQueue.length > 0
      ? (sweepHistoryQueue.reduce((a, b) => a + b, 0) / sweepHistoryQueue.length)
      : 0.50;

    let dynamicRiskMult = 0.5;
    let isContinuationEnabled = false;
    let regimeLabel = "NEUTRAL";

    if (rollingWinRate > 0.55) {
      dynamicRiskMult = 1.0;
      isContinuationEnabled = true;
      regimeLabel = "HIGH_WINRATE";
    } else if (rollingWinRate < 0.45) {
      dynamicRiskMult = 0.25;
      isContinuationEnabled = false;
      regimeLabel = "LOW_WINRATE";
    } else {
      dynamicRiskMult = 0.5;
      isContinuationEnabled = false;
      regimeLabel = "NEUTRAL";
    }

    const regimeData = {
      tqs5m: 100,
      tqs1m: 100,
      totalScore: Number((rollingWinRate * 100).toFixed(1)),
      regime: regimeLabel,
      riskPercent: dynamicRiskMult
    };
    botState.marketRegime = regimeData;

    let efficiencyLabel = "NEUTRAL";
    if (dynamicRiskMult === 1.0) efficiencyLabel = "EXPANSION";
    else if (dynamicRiskMult === 0.25) efficiencyLabel = "CHOPPY";

    // 4. TÍNH TOÁN CÁC CHỈ BÁO KỸ THUẬT
    // --- Khung M1 ---
    const atrM1 = calculateATR(bars, 14);
    const vwapM1 = calculateVWAP(bars);
    const vwmaM1 = calculateVWMA(bars, 20); // VWMA 20 M1
    const vwmaM1Prev = calculateVWMA(bars.slice(0, -1), 20);
    const slopeM1 = vwmaM1 - vwmaM1Prev;
    const adxM1 = calcADX(bars, 14);
    const prevAdxM1 = calcADX(bars.slice(0, -1), 14);
    // currentPrice already defined at top
    
    // --- Khung M5 Filter ---
    const vwma5m = calculateVWMA(bars5m, 20);
    
    // --- Mean Reversion Filter (Check if price is too far from VWMA) ---
    const distFromVWMA = Math.abs(currentPrice - vwmaM1);
    
    botState.adx = adxM1.adx; // Lưu ADX M1 vào botState để hiển thị
    botState.vwap = vwapM1;

    // THÔNG BÁO KHI SẴN SÀNG
    if (!botState.isInitNotified) {
      botState.isInitNotified = true;
      console.log(`🤖 WHALE BOT SẴN SÀNG! Regime: ${regimeData.regime} (Tỷ lệ thắng lăn Sweep: ${regimeData.totalScore}%)`);
    }

    // lastCandle already defined at top
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

    // LONG CONTINUATION V11 (Targeting 10-15 trades/month - Balanced)
    const isContinuationLong = 
      isContinuationEnabled &&   
      currentPrice > vwma5m &&
      currentPrice > vwapM1 &&
      slopeM1 > 0 &&
      adxM1.adx >= 10 &&              
      adxM1.pDI > adxM1.mDI &&
      distFromVWMA < (atrM1 * 1.8) && 
      compRange < (atrM1 * 1.45) &&    
      overlapCount >= 2 &&            
      recentLow > vwma5m &&           
      bars.slice(-3, -1).every(b => b[4] > vwma5m) && 
      isAtrExpansion &&               
      currentPrice > recentHigh &&    
      bodySize > (atrM1 * 0.5) &&     
      bars[bars.length - 1][5] > volMA * 1.1 && 
      currentPrice > prevHigh;

    // SHORT CONTINUATION V11 (Targeting 10-15 trades/month - Balanced)
    const isContinuationShort = 
      isContinuationEnabled &&
      currentPrice < vwma5m &&
      currentPrice < vwapM1 &&
      slopeM1 < 0 &&
      adxM1.adx >= 10 &&
      adxM1.mDI > adxM1.pDI &&
      distFromVWMA < (atrM1 * 1.8) &&
      compRange < (atrM1 * 1.45) &&
      overlapCount >= 2 &&
      recentHigh < vwma5m &&
      bars.slice(-3, -1).every(b => b[4] < vwma5m) &&
      isAtrExpansion &&
      currentPrice < recentLow &&
      bodySize > (atrM1 * 0.5) &&
      bars[bars.length - 1][5] > volMA * 1.1 &&
      currentPrice < prevLow;

    // LONG ENTRY
    if (
      (ENABLE_WHALE_SWEEP && !isOverExtendedLong && currentPrice > vwma5m && currentPrice > vwapM1 && slopeM1 > 0 && adxM1.adx >= ADX_THRESHOLD && adxM1.pDI > adxM1.mDI && sweep.sweepLow && sweep.displacementBullish && sweep.volConfirm && isWithinTradingSessions()) ||
      (regimeData.riskPercent > 0 && isContinuationLong && isWithinTradingSessions())
    ) {
      sig = "LONG";
    }

    // SHORT ENTRY
    if (
      (ENABLE_WHALE_SWEEP && !isOverExtendedShort && currentPrice < vwma5m && currentPrice < vwapM1 && slopeM1 < 0 && adxM1.adx >= ADX_THRESHOLD && adxM1.mDI > adxM1.pDI && sweep.sweepHigh && sweep.displacementBearish && sweep.volConfirm && isWithinTradingSessions()) ||
      (regimeData.riskPercent > 0 && isContinuationShort && isWithinTradingSessions())
    ) {
      sig = "SHORT";
    }

    const isContTrade = (sig === "LONG" && isContinuationLong) || (sig === "SHORT" && isContinuationShort);
    const currentRR = RR;
    const strategyLabel = isContTrade ? "CONTINUATION" : "WHALE SWEEP";

    // 7. XỬ LÝ LỆNH (MARKET ENTRY)
    if (sig) {
      const e = currentPrice; 
      // Set SL cho Continuation
      let sl = sig === "LONG" ? (currentPrice - atrM1 * 2) : (currentPrice + atrM1 * 2);
      if (isContTrade) {
        sl = sig === "LONG" ? (currentPrice - atrM1 * 1.5) : (currentPrice + atrM1 * 1.5);
      } else {
        sl = sig === "LONG" ? (sweep.low - atrM1 * 0.2) : (sweep.high + atrM1 * 0.2);
      }
      
      const risk = Math.abs(e - sl);
      const tp = sig === "LONG" ? e + risk * RR : e - risk * RR;

      const baseRiskPercent = 0.01;
      const currentRiskPercent = baseRiskPercent * dynamicRiskMult;

      console.log(`\n[SIGNAL] ${sig} | ${strategyLabel} | Risk: ${(currentRiskPercent * 100).toFixed(1)}% (${efficiencyLabel}) | Price: $${e.toFixed(2)} | SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)}`);
      
      if (!IS_LIVE_TRADING_ENABLED) { 
        const riskAmount = paperBalance * currentRiskPercent;
        const positionSize = riskAmount; 

        paperPosition = {
          type: sig,
          entry: e,
          sl: sl,
          tp: tp,
          size: positionSize,
          strategy: strategyLabel,
          startTime: Date.now(),
          isBE: false
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

        const rollingWRPercent = (rollingWinRate * 100).toFixed(1);
        const sweepQueueLength = sweepHistoryQueue.length;

        await sendTelegram(`🚀 [SIGNAL] **${sig}** Market Entry!\n\n` +
          `📊 **Thông số lệnh:**\n` +
          `🎯 Entry: ${e.toFixed(2)}\n` +
          `🛑 SL: ${sl.toFixed(2)} | 💎 TP: ${tp.toFixed(2)}\n\n` +
          `📈 **Hiệu suất thực tế:**\n` +
          `• Tỷ lệ thắng lăn (Rolling WR): **${rollingWRPercent}%** (Dựa trên ${sweepQueueLength} vị thế gần nhất)\n` +
          `• Phân loại thị trường: **${regimeLabel}** (Risk mult: ${dynamicRiskMult}x)\n\n` +
          `📝 **Điều kiện:**\n${conditions}\n\n` +
          `⏰ Giờ VN: ${vnTime}`); 

        // Gửi tới MT5 VPS (nếu enabled)
        await sendToMT5(sig, e, sl, tp, PAIR);
      } else {
        // Chế độ Trade thật
        if (MT5_ENABLED) {
          try {
            const res = await placeMT5Order(sig === 'LONG' ? 'buy' : 'sell', sl, tp, strategyLabel);
            if (res && !res.error && (res.retcode === 10009 || res.retcode === 10008)) {
               const rollingWRPercent = (rollingWinRate * 100).toFixed(1);
               const sweepQueueLength = sweepHistoryQueue.length;
               sendTelegram(`🔥 **MT5 LIVE TRADE EXECUTED**\n• Cặp: ${PAIR}\n• Lệnh: ${sig}\n• Ticket: ${res.order}\n• Entry: ${e.toFixed(2)}\n• SL: ${sl.toFixed(2)} | TP: ${tp.toFixed(2)}\n• Tỷ lệ thắng lăn: **${rollingWRPercent}%** (${sweepQueueLength} vị thế Sweep gần nhất)\n• Regime: **${regimeLabel}**`);
            } else {
               sendTelegram(`⚠️ **MT5 ORDER FAILED**\nLỗi: ${res?.error || res?.retcode}`);
            }
          } catch (err) {
            console.error("MT5 Execution Error:", err);
          }
        } else {
          try {
            const riskAmount = botState.balance * currentRiskPercent;
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

            const rollingWRPercent = (rollingWinRate * 100).toFixed(1);
            const sweepQueueLength = sweepHistoryQueue.length;

            await sendTelegram(`⚡ [SIGNAL] **${sig}** Market Order (Binance Live)!\n\n` +
              `📊 Entry: ${e.toFixed(2)} (Pure 1M Strategy)\n` +
              `📈 **Hiệu suất thực tế:**\n` +
              `• Tỷ lệ thắng lăn (Rolling WR): **${rollingWRPercent}%** (Dựa trên ${sweepQueueLength} vị thế gần nhất)\n` +
              `• Phân loại thị trường: **${regimeLabel}** (Risk mult: ${dynamicRiskMult}x)\n\n` +
              `📝 **Điều kiện vào lệnh:**\n${conditions}\n` +
              `⏰ Giờ VN: ${vnTime}`);
          } catch (err: any) {
            console.error("Trade Error:", err.message);
            sendTelegram(`❌ **TRADING ERROR:** ${err.message}`);
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
  app.use(cors()); app.use(express.json());
  app.get("/api/health", (req, res) => res.json({ status: "ok" }));
  app.post("/api/backtest/run", async (req, res) => {
    if (backtestStatus.isRunning) return res.status(400).json({ error: "Running" });
    const { startDate, endDate, rr, timeframe, enableSessionFilter, adxThreshold, enableWhaleSweep } = req.body;
    console.log(`[SERVER] Received backtest request: sessionFilter=${enableSessionFilter}, adxThreshold=${adxThreshold}, enableWhaleSweep=${enableWhaleSweep}`);
    backtestStatus.isRunning = true;
    runBacktest(startDate, endDate, rr, timeframe, enableSessionFilter, 20, p => { 
      backtestStatus.progress = p; 
    }, adxThreshold || 10, enableWhaleSweep !== undefined ? enableWhaleSweep : true).then(async (r: any) => { 
      backtestStatus.isRunning = false; 
      backtestStatus.lastResult = r; 
      
      // Gửi báo cáo Telegram khi hoàn tất backtest
        if (r && !r.error) {
          const period = `${new Date(r.startTime).toLocaleDateString('vi-VN')} - ${new Date(r.endTime).toLocaleDateString('vi-VN')}`;
          
          // 1. Thống kê Whale Sweep (Chi tiết từng tháng & Tổng kết)
          let whaleMonthlyReport = "";
          if (r.monthlySnapshots && r.monthlySnapshots.length > 0) {
            whaleMonthlyReport = r.monthlySnapshots.map((m: any) => {
              const wr = m.whaleTrades > 0 ? (m.whaleWins / m.whaleTrades * 100).toFixed(1) : "0";
              return `• ${m.date}: ${m.whalePnLR.toFixed(1)}R | WR: ${wr}% (${m.whaleTrades} lệnh)`;
            }).join('\n');
          }
          const whaleTrades = r.totalTrades - (r.continuationTrades || 0);
          const whaleWins = r.wins - (r.continuationWins || 0);
          const whalePnLR = r.totalProfitR - (r.continuationPnLR || 0);
          const whaleWR = whaleTrades > 0 ? (whaleWins / whaleTrades * 100).toFixed(1) : "0.0";
          const whaleSummary = `• Tổng: ${whaleTrades} lệnh | WR: ${whaleWR}% | Lợi nhuận: ${whalePnLR.toFixed(1)}R`;

          // Gửi tin nhắn 1: Thông báo cho Whale Sweep (Chi tiết từng tháng & Tổng kết)
          await sendTelegram(`📊 **KẾT QUẢ BACKTEST: WHALE SWEEP**\n\n` +
            `🗓 **Giai đoạn:** ${period}\n\n` +
            `🐋 **WHALE SWEEP (Chi tiết tháng):**\n${whaleMonthlyReport}\n\n` +
            `📊 **Tổng kết Whale Sweep:**\n${whaleSummary}`);

          // 2. Thống kê Continuation (Nếu có)
          const contTrades = r.continuationTrades || 0;
          if (contTrades > 0) {
             const contWins = r.continuationWins || 0;
             const contPnLR = r.continuationPnLR || 0;
             const contWR = (contWins / contTrades * 100).toFixed(1);
             
             // Gửi tin nhắn 2: Thông báo cho Continuation
             await sendTelegram(`📊 **KẾT QUẢ BACKTEST: CONTINUATION**\n\n` +
               `🗓 **Giai đoạn:** ${period}\n\n` +
               `🚀 **Tổng kết Continuation:**\n• Tổng: ${contTrades} lệnh | WR: ${contWR}% | Lợi nhuận: ${contPnLR.toFixed(1)}R`);
          } else {
             // Gửi thông báo Continuation trống nếu không có lệnh để đảm bảo nhận đủ 2 tin nhắn như yêu cầu
             await sendTelegram(`📊 **KẾT QUẢ BACKTEST: CONTINUATION**\n\n` +
               `🗓 **Giai đoạn:** ${period}\n\n` +
               `🚀 Không tìm thấy lệnh Continuation nào trong giai đoạn này.`);
          }
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
    const avgEfficiency = botState.efficiencyHistory.reduce((a, b) => a + b, 0) / botState.efficiencyHistory.length;
    res.json({
      symbol: PAIR, last_price: botState.lastPrice, in_position: botState.inPosition,
      signals: botState.signals.slice(0, 10), balance: botState.balance, ai_reasoning: botState.aiReasoning,
      adx: botState.adx.toFixed(1), 
      enable_session_filter: ENABLE_SESSION_FILTER,
      enable_whale_sweep: ENABLE_WHALE_SWEEP,
      vwma_period: VWMA_PERIOD,
      is_ws_connected: botState.isWsConnected,
      market_regime: botState.marketRegime,
      avg_efficiency: avgEfficiency.toFixed(2),
      efficiency_history: botState.efficiencyHistory
    });
  });
  app.post("/api/trading/toggle-session", (req, res) => {
    ENABLE_SESSION_FILTER = !ENABLE_SESSION_FILTER;
    res.json({ success: true, enabled: ENABLE_SESSION_FILTER });
  });
  app.post("/api/trading/toggle-whale", (req, res) => {
    ENABLE_WHALE_SWEEP = !ENABLE_WHALE_SWEEP;
    res.json({ success: true, enabled: ENABLE_WHALE_SWEEP });
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
  });
}

startServer();
