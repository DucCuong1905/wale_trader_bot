import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cors from "cors";
import { runBacktest, stopBacktestExecution } from "./backtester.ts";

dotenv.config();

const resolvedFilename = typeof __filename !== "undefined" ? __filename : "server.cjs";
const resolvedDirname = typeof __dirname !== "undefined" ? __dirname : ".";

// --- QUẢN LÝ VỊ THẾ GIẢ LẬP (PAPER TRADING) ---
const MT5_ENABLED = process.env.MT5_ENABLED === "true";
const PAIR = process.env.MT5_SYMBOL || 'XAUUSD'; 
 
const TIMEFRAME = "1m"; 
const IS_LIVE_TRADING_ENABLED = process.env.IS_LIVE_TRADING_ENABLED === "true";
const MT5_BRIDGE_URL = process.env.MT5_WEBHOOK_URL?.replace('/webhook', '') || "http://localhost:5000";
const RISK_PER_TRADE = 0.01; // Rủi ro trên mỗi lệnh (1% tài khoản)
const RR = 1.2; // Tỷ lệ Risk/Reward
const COOLDOWN_MS = 30000; // Thời gian chờ giữa các lệnh (30 giây)
const MAX_DAILY_LOSS = 0.06; // Giới hạn lỗ tối đa trong ngày (6%)

// CẤU HÌNH PHIÊN GIAO DỊCH (LONDON & NEW YORK)
let ENABLE_SESSION_FILTER = false; 
const VWMA_PERIOD = 20; // Cố định VWMA 20
let ADX_THRESHOLD = 20; // Ngưỡng ADX mặc định
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
  progress: 0
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

function getVietnamTimeString(dateInput?: Date | string): string {
  const date = dateInput ? new Date(dateInput) : new Date();
  const localString = date.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" });
  const d = new Date(localString);
  
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");
  
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

async function sendReportToMT5Bridge(trade: any) {
  try {
    console.log(`[MT5 BRIDGE] Đang gửi report lệnh ticket ${trade.ticket} sang MT5 Bridge...`);
    const res = await fetch(`${MT5_BRIDGE_URL}/save_report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trade)
    });
    const result = await res.json() as any;
    if (result && result.status === "success") {
       console.log(`✅ [MT5 BRIDGE] Đã lưu thành công báo cáo lệnh vào ổ cứng VPS!`);
    } else {
       console.warn(`⚠️ [MT5 BRIDGE] Phản hồi lỗi từ VPS:`, result?.message);
    }
  } catch (err: any) {
    console.error(`❌ [MT5 BRIDGE] Gửi báo cáo thất bại:`, err.message);
  }
}

function saveTrade(trade: any) {
  const trades = loadTrades();
  trades.unshift(trade);
  const limited = trades.slice(0, 1000);
  try {
    fs.writeFileSync(TRADES_FILE, JSON.stringify(limited, null, 2));

    // Ghi cục bộ vào file CSV (data/live_reports.csv)
    const localCsvPath = path.join(DATA_DIR, "live_reports.csv");
    const csvExists = fs.existsSync(localCsvPath);
    const headers = "time,ticket,type,volume,entry,exit,pnl,status,strategy,balanceBefore,balanceAfter\n";
    const newRow = `"${trade.time || ''}","${trade.ticket || ''}","${trade.type || ''}","${trade.volume || ''}","${trade.entry || ''}","${trade.exit || ''}","${trade.pnl || ''}","${trade.status || ''}","${trade.strategy || ''}","${trade.balanceBefore || ''}","${trade.balanceAfter || ''}"\n`;
    
    if (!csvExists) {
      fs.writeFileSync(localCsvPath, headers + newRow);
    } else {
      fs.appendFileSync(localCsvPath, newRow);
    }
    console.log(`✅ Đã lưu báo cáo lệnh ticket ${trade.ticket || 'paper'} tại ${localCsvPath}`);
  } catch (e) {
    console.error("Error saving trade locally:", e);
  }

  // Nếu là lệnh có ticket (LIVE) hoặc nếu người dùng muốn lưu live thì ta đồng bộ sang VPS ổ cứng
  if (trade.ticket && MT5_ENABLED) {
    sendReportToMT5Bridge(trade).catch(err => {
      console.error("❌ Không thể gửi report sang MT5 Bridge:", err.message);
    });
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
  ema20_5m: 0,
  ema50_5m: 0,
  shadowEma5mCheck: "",
  plusDI: 0,
  minusDI: 0,
  vwap: 0,
  aiReasoning: "TA Only Mode",
  isWsConnected: false,
  isInitNotified: false, 
  apiError: "",
  lastReportKey: "",
  activeMT5Positions: [] as any[]
};

/**
 * Gửi thông báo qua Telegram.
 */
async function sendTelegram(msg: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
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
async function placeMT5Order(type: 'buy' | 'sell', sl: number, tp: number, signalInfo: string, lotSize?: number) {
    if (!MT5_ENABLED) return null;
    try {
        const orderLot = lotSize !== undefined && !isNaN(lotSize) ? lotSize : parseFloat(process.env.MT5_LOT_SIZE || "0.01");
        console.log(`[MT5 BRIDGE] Sending ${type} order for ${PAIR} with ${orderLot} lot(s)...`);
        const res = await fetch(`${MT5_BRIDGE_URL}/order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                symbol: PAIR,
                type: type,
                lot: orderLot,
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
       console.log(`[MT5] Webhook success: order executed on MT5 with ID ${result.order}`);
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
    console.error(`[MT5 BRIDGE] Lỗi lấy nến (${timeframe}) cho ${symbol}: ${err.message}`);
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
  if (bars.length < 16) return { sweepLow: false, sweepHigh: false };
  
  const sweepCandle = bars[bars.length - 2]; // Nến quét thanh khoản
  const confirmCandle = bars[bars.length - 1]; // Nến xác nhận (Displacement)

  const [, sO, sH, sL, sC, sV] = sweepCandle;
  const [, cO, cH, cL, cC, cV] = confirmCandle;

  // 1. LOGIC QUÉT THANH KHOẢN (Local Swing Sweep - 14 nến trước nến quét)
  const prevBars = bars.slice(bars.length - 16, bars.length - 2);
  const localLow = Math.min(...prevBars.map(b => b[3]));
  const localHigh = Math.max(...prevBars.map(b => b[2]));

  const sweepSize = sH - sL || 1;
  const lowerWick = Math.min(sO, sC) - sL;
  const upperWick = sH - Math.max(sO, sC);

  const volumes = bars.slice(-15, -1).map(b => b[5]);
  const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;

  const sweepLow = sL <= localLow && sC >= localLow && (lowerWick / sweepSize >= 0.25);
  const sweepHigh = sH >= localHigh && sC <= localHigh && (upperWick / sweepSize >= 0.25);

  // 2. DISPLACEMENT & BODY SIZE
  const body = Math.abs(cC - cO);
  const totalSize = cH - cL || 1;
  const bodySizes = bars.slice(-15, -1).map(b => Math.abs(b[4] - b[1]));
  const avgBody = bodySizes.reduce((a, b) => a + b, 0) / bodySizes.length;
  
  const displacementBullish = body > avgBody * 0.6 && (cC - cL) / totalSize > 0.45 && cC > Math.max(sO, sC);
  const displacementBearish = body > avgBody * 0.6 && (cH - cC) / totalSize > 0.45 && cC < Math.min(sO, sC);

  // 4. VOLUME CONFIRM (Standard)
  const isConstantVol = volumes.length > 0 && volumes.every(v => v === volumes[0]);
  const volConfirm = isConstantVol ? true : cV > avgVol * 0.9;

  return {
    sweepLow,
    sweepHigh,
    displacementBullish,
    displacementBearish,
    volConfirm,
    low: sL,
    high: sH,
    confirmHigh: cH,
    confirmLow: cL,
    sweepOpen: sO,
    confirmClose: cC
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
    const divisor = str[i] === 0 ? 1 : str[i];
    const pDI = 100 * (spDM[i] / divisor), mDI = 100 * (smDM[i] / divisor);
    pDIs.push(pDI); mDIs.push(mDI);
    dx.push(100 * Math.abs(pDI - mDI) / (pDI + mDI || 1));
  }
  const adxl = smooth(dx);
  return { adx: adxl[adxl.length - 1], pDI: pDIs[pDIs.length - 1], mDI: mDIs[mDIs.length - 1] };
}

function calculateEMA(bars: any[], period: number = 20): number {
  if (bars.length === 0) return 0;
  if (bars.length < period) return bars[bars.length - 1][4];
  const k = 2 / (period + 1);
  const sliceLen = Math.min(bars.length, period * 4);
  const startIdx = bars.length - sliceLen;
  let ema = bars[startIdx][4];
  for (let i = startIdx + 1; i < bars.length; i++) {
    ema = bars[i][4] * k + ema * (1 - k);
  }
  return ema;
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

let waitingMsgLogged = false;
/**
 * Vòng lặp chính của Bot: Kiểm tra nến, tín hiệu và thực hiện giao dịch.
 */
async function traderLoop() {
  try {
    // 0. LẤY DỮ LIỆU NẾN TRƯỚC HẾT
    let bars: any[] = [];
    let bars5m: any[] = [];
    let bars1d: any[] = [];
    try {
      bars = await fetchMT5OHLCV(PAIR, "1m", 1000);
      bars5m = await fetchMT5OHLCV(PAIR, "5m", 100);
      bars1d = await fetchMT5OHLCV(PAIR, "1d", 100);
    } catch (ohlcvErr: any) {
      console.error("❌ Lỗi fetchMT5OHLCV (sau khi retry):", ohlcvErr.message);
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
      curr = await fetchMT5Balance();
    } else {
      curr = paperBalance;
    }
    
    botState.balance = curr;
    // Tự động reset số dư gốc mỗi ngày
    if (botState.lastResetDate !== new Date().toISOString().split('T')[0]) {
      botState.dailyStartingBalance = curr; botState.lastResetDate = new Date().toISOString().split('T')[0];
    }
    // Dừng nếu lỗ quá 6% trong ngày
    if (botState.dailyStartingBalance > 0 && (curr - botState.dailyStartingBalance) / botState.dailyStartingBalance <= -MAX_DAILY_LOSS) {
      console.log("[WARNING] Đã chạm giới hạn lỗ tối đa trong ngày. Tạm dừng.");
      setTimeout(traderLoop, 15 * 60000); return;
    }

    // 2. KIỂM TRA TRẠNG THÁI VỊ THẾ, LỆNH CHỜ VÀ COOLDOWN
    if (IS_LIVE_TRADING_ENABLED) {
      try {
        const pos = await fetchMT5Positions(PAIR);
        botState.inPosition = pos.length > 0;
        
        // Gán hoặc giữ lại balanceBefore cho các vị thế hiện tại
        for (const p of pos) {
           const existing = botState.activeMT5Positions.find((old: any) => old.ticket === p.ticket);
           if (existing) {
              p.balanceBefore = existing.balanceBefore || curr;
           } else {
              p.balanceBefore = curr;
           }
        }

        // Notify if a position was closed
        for (const oldPos of botState.activeMT5Positions) {
           const stillOpen = pos.find((p: any) => p.ticket === oldPos.ticket);
           if (!stillOpen) {
              const isBuy = oldPos.type === 0 || oldPos.type === "0" || 
                            (typeof oldPos.type === "string" && (
                              oldPos.type.toLowerCase().includes("buy") || 
                              oldPos.type.toLowerCase() === "long"
                            ));
              const isSell = oldPos.type === 1 || oldPos.type === "1" || 
                             (typeof oldPos.type === "string" && (
                               oldPos.type.toLowerCase().includes("sell") || 
                               oldPos.type.toLowerCase() === "short"
                             ));

              const typeStr = isBuy ? "LONG (BUY)" : isSell ? "SHORT (SELL)" : (oldPos.type || "UNKNOWN");
              const openP = oldPos.price_open || 0;
              const openStr = openP ? openP.toFixed(2) : "N/A";
              
              const exitPrice = currentPrice;
              let isWin = false;
              if (isBuy && exitPrice >= openP) isWin = true;
              if (isSell && exitPrice <= openP) isWin = true;
              
              const pnlVal = isBuy ? (exitPrice - openP) : (openP - exitPrice);
              const volume = parseFloat(oldPos.volume) || 0.01;
              const pnlDollar = pnlVal * volume * 100; // rough estimation for XAUUSD

              const balanceBefore = oldPos.balanceBefore || curr;
              const balanceAfter = IS_LIVE_TRADING_ENABLED ? await fetchMT5Balance() : paperBalance;

              const tradeRecord = {
                 time: getVietnamTimeString(),
                 type: isBuy ? "LONG" : isSell ? "SHORT" : "UNKNOWN", 
                 entry: openP,
                 exit: exitPrice,
                 pnl: pnlDollar,
                 status: isWin ? "WIN" : "LOSS",
                 strategy: "WHALE SWEEP (LIVE)",
                 balanceBefore: balanceBefore,
                 balanceAfter: balanceAfter,
                 ticket: oldPos.ticket,
                 volume: volume
              };
              botState.trades.unshift(tradeRecord);
              saveTrade(tradeRecord);

              sendTelegram(`🔔 **THÔNG BÁO MT5**\nLệnh ${typeStr} (Ticket: ${oldPos.ticket || 'N/A'}) đã đóng!\n• Cặp: ${PAIR}\n• Giá vào: ${openStr}\n• Giá thoát (ước tính): ${exitPrice.toFixed(2)}\n• PnL (ước tính): ${pnlDollar >= 0 ? '+' : ''}${pnlDollar.toFixed(2)}$\n• Số dư: Trước $${balanceBefore.toFixed(2)} | Sau $${balanceAfter.toFixed(2)}\n• Bạn hãy kiểm tra lại ứng dụng MT5 để xem kết quả thật.`).catch(console.error);
           }
        }
        botState.activeMT5Positions = pos;

      } catch (err: any) {
        console.error("❌ LỖI LIVE POSITIONS MT5: ", err);
        botState.inPosition = false; 
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
          
          const tradeRecord = {
            time: getVietnamTimeString(),
            type: paperPosition.type,
            entry: paperPosition.entry,
            exit: exitPrice,
            pnl: pnlDollar,
            status: status,
            strategy: paperPosition.strategy
          };
          botState.trades.unshift(tradeRecord);
          saveTrade(tradeRecord);

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


    // 4. TÍNH TOÁN CÁC CHỈ BÁO KỸ THUẬT dựa trên nến đã đóng hoàn toàn (Khớp 100% với Mô hình Backtest)
    const closedBarsFull = bars.slice(0, -1);
    const lastClosedCandle = closedBarsFull[closedBarsFull.length - 1];
    const lastClosedCandleTime = lastClosedCandle[0];

    // Chỉ phân tích khi có nến mới đã đóng hoàn toàn (M1)
    if (lastClosedCandleTime <= botState.lastProcessedCandleTime) {
      setTimeout(traderLoop, 5000);
      return;
    }
    botState.lastProcessedCandleTime = lastClosedCandleTime;

    // Chỉ cắt đúng một đoạn 50 nến để tính toán giống hệt backtest
    const closedBars = closedBarsFull.slice(-50);

    // --- Khung M1 ---
    const atrM1 = calculateATR(closedBars, 14);
    const vwapM1 = calculateVWAP(closedBars);
    const vwmaM1 = calculateVWMA(closedBars, 20); // VWMA 20 M1
    const vwmaM1Prev = calculateVWMA(closedBars.slice(0, -1), 20);
    const slopeM1 = vwmaM1 - vwmaM1Prev;
    const adxM1 = calcADX(closedBars, 14);
    const prevAdxM1 = calcADX(closedBars.slice(0, -1), 14);
    const emaM1 = calculateEMA(closedBars, 20); // EMA 20 M1
    
    // Condition: close > emaM1 && close > vwmaM1 && emaM1 > vwmaM1
    const closePriceM1 = lastClosedCandle[4];
    const bullishM1 = closePriceM1 > emaM1 && closePriceM1 > vwmaM1 && emaM1 > vwmaM1;
    const bearishM1 = closePriceM1 < emaM1 && closePriceM1 < vwmaM1 && emaM1 < vwmaM1;
    
    // --- Khung M1 Filter ---
    const vwma1m = vwmaM1;
    
    // --- Mean Reversion Filter (Check if price is too far from VWMA) ---
    const distFromVWMA = Math.abs(currentPrice - vwmaM1);
    
    const isInSession = isWithinTradingSessions(lastClosedCandleTime);
    
    botState.adx = adxM1.adx; // Lưu ADX M1 vào botState để hiển thị
    botState.ema20_5m = emaM1;
    botState.ema50_5m = vwmaM1;
    botState.shadowEma5mCheck = `close: ${closePriceM1.toFixed(2)} | EMA20: ${emaM1.toFixed(2)} | VWMA20: ${vwmaM1.toFixed(2)}`;
    botState.vwap = vwapM1;

    // THÔNG BÁO KHI SẴN SÀNG
    if (!botState.isInitNotified) {
      botState.isInitNotified = true;
      console.log(`🤖 WHALE BOT SẴN SÀNG!`);
    }

    const sweep = detectWhaleSweep(closedBars);

    let sig: "LONG" | "SHORT" | null = null;
    
    // ========================================================
    // 5. ĐIỀU KIỆN VÀO LỆNH (WHALE SWEEP ONLY)
    // ========================================================
    const isOverExtendedLong = distFromVWMA > (atrM1 * 1.2);
    const isOverExtendedShort = distFromVWMA > (atrM1 * 1.2);

    const slDistanceLong = Math.abs(currentPrice - sweep.low);
    const slDistanceShort = Math.abs(sweep.high - currentPrice);
    const hasBadEntryPriceLong = slDistanceLong > (atrM1 * 4.0);
    const hasBadEntryPriceShort = slDistanceShort > (atrM1 * 4.0);

    // LONG ENTRY
    if ( !isOverExtendedLong && !hasBadEntryPriceLong && adxM1.adx >= ADX_THRESHOLD && sweep.sweepLow && sweep.displacementBullish && sweep.volConfirm && isInSession && (sweep.confirmClose > sweep.sweepOpen || sweep.confirmClose > sweep.high) && bullishM1 ) {
      sig = "LONG";
    }

    // SHORT ENTRY
    if ( !isOverExtendedShort && !hasBadEntryPriceShort && adxM1.adx >= ADX_THRESHOLD && sweep.sweepHigh && sweep.displacementBearish && sweep.volConfirm && isInSession && (sweep.confirmClose < sweep.sweepOpen || sweep.confirmClose < sweep.low) && bearishM1 ) {
      sig = "SHORT";
    }

    // GỬI TELEGRAM CHO CÁC LỆNH SWEEP BỊ LỌC (KHÔNG KHỚP)
    if (!sig) {
      const vnTime = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
      if (sweep.sweepLow) {
        const condCloseOk = sweep.confirmClose > sweep.sweepOpen || sweep.confirmClose > sweep.high;
        const msg = [
          `🔍 **PHÁT HIỆN SWEEP (QUÉT ĐÁY) - BỊ BỘ LỌC CHẶN**`,
          `• Cặp giao dịch: ${PAIR}`,
          `• Hướng giao dịch đề xuất: **BUY (LONG)**`,
          `• Giá hiện tại: $${currentPrice.toFixed(2)}`,
          `• Thời gian (VN): ${vnTime}`,
          `\n📋 **CHI TIẾT KIỂM TRA BỘ LỌC:**`,
          `1. Quét đáy M1 (SweepLow): ✅ Đạt (Low: ${sweep.low.toFixed(2)})`,
          `2. Lực nến thắng thế (Displacement): ${sweep.displacementBullish ? '✅ Đạt' : '❌ Thua/Yếu'} (Nến xác nhận đóng: ${sweep.confirmClose.toFixed(2)})`,
          `3. Xác nhận Vol (Volume Confirm): ${sweep.volConfirm ? '✅ Đạt' : '❌ Thấp'}`,
          `4. Chỉ số ADX M1 (>=${ADX_THRESHOLD}): ${adxM1.adx >= ADX_THRESHOLD ? '✅ Đạt' : '❌ Thấp'} (Thực tế: ${adxM1.adx.toFixed(1)})`,
          `5. Khung giờ giao dịch (Session): ${isInSession ? '✅ Trong phiên' : '❌ Ngoài phiên'}`,
          `6. Đóng nến xác nhận (> Open/High): ${condCloseOk ? '✅ Đạt' : '❌ Không đạt'} (Đóng: ${sweep.confirmClose.toFixed(2)} vs Open: ${sweep.sweepOpen.toFixed(2)} / High: ${sweep.high.toFixed(2)})`,
          `7. Đồ thị quá mua/bán (Overextended < 1.2 ATR): ${!isOverExtendedLong ? '✅ Đạt' : '❌ Quá xa VWMA (Overextended)'} (Khoảng cách: ${distFromVWMA.toFixed(2)} vs Ngưỡng: ${(atrM1 * 1.2).toFixed(2)})`,
          `8. Khoảng dừng lỗ hợp lệ (SL < 4 ATR): ${!hasBadEntryPriceLong ? '✅ Đạt' : '❌ SL quá rộng (Bad entry)'} (Khoảng: ${slDistanceLong.toFixed(2)} vs Ngưỡng: ${(atrM1 * 4.0).toFixed(2)})`,
          `9. Bộ lọc Xu hướng M1 (Close > EMA20 > VWMA20): ${bullishM1 ? '✅ Hợp lệ' : '❌ Không đồng thuận'} (Close: ${closePriceM1.toFixed(2)} | EMA20: ${emaM1.toFixed(2)} | VWMA20: ${vwmaM1.toFixed(2)})`
        ].join('\n');
        // Log to console instead of sending telegram as requested by user
        console.log(msg);
      } else if (sweep.sweepHigh) {
        const condCloseOk = sweep.confirmClose < sweep.sweepOpen || sweep.confirmClose < sweep.low;
        const msg = [
          `🔍 **PHÁT HIỆN SWEEP (QUÉT ĐỈNH) - BỊ BỘ LỌC CHẶN**`,
          `• Cặp giao dịch: ${PAIR}`,
          `• Hướng giao dịch đề xuất: **SELL (SHORT)**`,
          `• Giá hiện tại: $${currentPrice.toFixed(2)}`,
          `• Thời gian (VN): ${vnTime}`,
          `\n📋 **CHI TIẾT KIỂM TRA BỘ LỌC:**`,
          `1. Quét đỉnh M1 (SweepHigh): ✅ Đạt (High: ${sweep.high.toFixed(2)})`,
          `2. Lực nến thắng thế (Displacement): ${sweep.displacementBearish ? '✅ Đạt' : '❌ Thua/Yếu'} (Nến xác nhận đóng: ${sweep.confirmClose.toFixed(2)})`,
          `3. Xác nhận Vol (Volume Confirm): ${sweep.volConfirm ? '✅ Đạt' : '❌ Thấp'}`,
          `4. Chỉ số ADX M1 (>=${ADX_THRESHOLD}): ${adxM1.adx >= ADX_THRESHOLD ? '✅ Đạt' : '❌ Thấp'} (Thực tế: ${adxM1.adx.toFixed(1)})`,
          `5. Khung giờ giao dịch (Session): ${isInSession ? '✅ Trong phiên' : '❌ Ngoài phiên'}`,
          `6. Đóng nến xác nhận (< Open/Low): ${condCloseOk ? '✅ Đạt' : '❌ Không đạt'} (Đóng: ${sweep.confirmClose.toFixed(2)} vs Open: ${sweep.sweepOpen.toFixed(2)} / Low: ${sweep.low.toFixed(2)})`,
          `7. Đồ thị quá mua/bán (Overextended < 1.2 ATR): ${!isOverExtendedShort ? '✅ Đạt' : '❌ Quá xa VWMA (Overextended)'} (Khoảng cách: ${distFromVWMA.toFixed(2)} vs Ngưỡng: ${(atrM1 * 1.2).toFixed(2)})`,
          `8. Khoảng dừng lỗ hợp lệ (SL < 4 ATR): ${!hasBadEntryPriceShort ? '✅ Đạt' : '❌ SL quá rộng (Bad entry)'} (Khoảng: ${slDistanceShort.toFixed(2)} vs Ngưỡng: ${(atrM1 * 4.0).toFixed(2)})`,
          `9. Bộ lọc Xu hướng M1 (Close < EMA20 < VWMA20): ${bearishM1 ? '✅ Hợp lệ' : '❌ Không đồng thuận'} (Close: ${closePriceM1.toFixed(2)} | EMA20: ${emaM1.toFixed(2)} | VWMA20: ${vwmaM1.toFixed(2)})`
        ].join('\n');
        // Log to console instead of sending telegram as requested by user
        console.log(msg);
      }
    }

    const currentRR = RR;
    const strategyLabel = "WHALE SWEEP";

    // 7. XỬ LÝ LỆNH (MARKET ENTRY)
    if (sig) {
      const e = currentPrice; 
      const slRaw = sig === "LONG" ? (sweep.low - atrM1 * 0.2) : (sweep.high + atrM1 * 0.2);
      const minRisk = atrM1 * 1.5;
      let sl = 0;
      if (sig === "LONG") {
        sl = Math.min(slRaw, currentPrice - minRisk);
      } else {
        sl = Math.max(slRaw, currentPrice + minRisk);
      }
      
      const risk = Math.abs(e - sl);
      const tp = sig === "LONG" ? e + risk * RR : e - risk * RR;

      const baseRiskPercent = 0.01;
      const currentRiskPercent = baseRiskPercent;

      console.log(`\n[SIGNAL] ${sig} | ${strategyLabel} | Risk: ${(currentRiskPercent * 100).toFixed(1)}% | Price: $${e.toFixed(2)} | SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)}`);
      
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

        const strategyName = "WHALE SWEEP (Quét thanh khoản)";

        const condCloseOk = sig === 'LONG' 
          ? (sweep.confirmClose > sweep.sweepOpen || sweep.confirmClose > sweep.high)
          : (sweep.confirmClose < sweep.sweepOpen || sweep.confirmClose < sweep.low);

        const conditions = [
          `📡 Chiến lược: **${strategyName}**`,
          `1. Khoảng cách VWMA: ${sig === 'LONG' ? (!isOverExtendedLong ? '✅ Ok' : '❌ Quá xa') : (!isOverExtendedShort ? '✅ Ok' : '❌ Quá xa')} (${distFromVWMA.toFixed(2)})`,
          `2. ADX M1 (>=${ADX_THRESHOLD}): ${adxM1.adx >= ADX_THRESHOLD ? '✅ Ok' : '❌ Thấp'} (${adxM1.adx.toFixed(1)})`,
          `3. Xác nhận đóng nến (Close vs Open/Wick nến quét): ${condCloseOk ? '✅ Ok' : '❌ Trượt'} (Confirm: ${sweep.confirmClose?.toFixed(2)}, SweepOpen: ${sweep.sweepOpen?.toFixed(2)}, SweepHigh/Low: ${sig === 'LONG' ? sweep.high?.toFixed(2) : sweep.low?.toFixed(2)})`,
          `4. Bộ lọc Xu hướng M1: ${sig === 'LONG' ? (bullishM1 ? '✅ Hợp lệ (Close > EMA20 > VWMA20)' : '❌ Không đồng thuận') : (bearishM1 ? '✅ Hợp lệ (Close < EMA20 < VWMA20)' : '❌ Không đồng thuận')}`,
          `5. Sweep M1: ✅ Confirmed`
        ].join('\n');

        await sendTelegram(`🚀 [SIGNAL] **${sig}** Market Entry!\n\n` +
          `📊 **Thông số lệnh:**\n` +
          `🎯 Entry: ${e.toFixed(2)}\n` +
          `🛑 SL: ${sl.toFixed(2)} | 💎 TP: ${tp.toFixed(2)}\n\n` +
          `📝 **Điều kiện:**\n${conditions}\n\n` +
          `⏰ Giờ VN: ${vnTime}`); 


        // Gửi tới MT5 VPS (nếu enabled)
        await sendToMT5(sig, e, sl, tp, PAIR);
      } else {
        // Chế độ Trade thật
        try {
          // Tính toán lot size tự động theo Risk (USD) nếu có cấu hình
          let lotSize: number | undefined = undefined;
          const riskUsdStr = process.env.MT5_RISK_USD;
          if (riskUsdStr) {
             const riskUsd = parseFloat(riskUsdStr);
             const contractSize = parseFloat(process.env.MT5_CONTRACT_SIZE || "100");
             const slDistancePrices = Math.abs(e - sl);
             if (!isNaN(riskUsd) && riskUsd > 0 && contractSize > 0 && slDistancePrices > 0) {
                 const rawLot = riskUsd / (slDistancePrices * contractSize);
                 // Làm tròn đến 2 chữ số thập phân (bước lot 0.01 của MT5)
                 lotSize = Math.max(0.01, Math.round(rawLot * 100) / 100);
             }
          }

          const res = await placeMT5Order(sig === 'LONG' ? 'buy' : 'sell', sl, tp, strategyLabel, lotSize);
          if (res && (res.status === "success" || res.order || res.ticket || res.retcode === 10009 || res.retcode === 10008)) {
             sendTelegram(`🔥 **MT5 LIVE TRADE EXECUTED**\n• Cặp: ${PAIR}\n• Lệnh: ${sig}\n• Lot: ${lotSize !== undefined ? lotSize : (process.env.MT5_LOT_SIZE || "0.01")}\n• Ticket: ${res.order || res.ticket || 'N/A'}\n• Entry: ${e.toFixed(2)}\n• SL: ${sl.toFixed(2)} | TP: ${tp.toFixed(2)}`);
          } else {
             sendTelegram(`⚠️ **MT5 ORDER FAILED**\nChi tiết MT5 Bridge: ${JSON.stringify(res)}`);
          }
        } catch (err) {
          console.error("MT5 Execution Error:", err);
        }
      }
    }
  } catch (e) {
    console.error("Trader Loop Error:", e);
  }
  setTimeout(traderLoop, 1000);
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
    }, adxThreshold !== undefined ? adxThreshold : 10).then(async (r: any) => { 
      backtestStatus.isRunning = false; 
      
      // Gửi báo cáo Telegram khi hoàn tất backtest
        if (r && !r.error) {
          const formatDateStr = (dateStr: string) => {
            const d = new Date(dateStr);
            return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`;
          };

          // 1. Thống kê Whale Sweep (Chi tiết từng tháng & Tổng kết)
          let whaleMonthlyReport = "";
          if (r.monthlySnapshots && r.monthlySnapshots.length > 0) {
            whaleMonthlyReport = r.monthlySnapshots.map((m: any) => {
              const wr = m.whaleTrades > 0 ? (m.whaleWins / m.whaleTrades * 100).toFixed(1) : "0";
              return `• ${m.date}: ${m.whalePnLR.toFixed(1)}R | WR: ${wr}% (${m.whaleTrades} lệnh)`;
            }).join('\n');
          }
          const whaleTrades = r.totalTrades;
          const whaleWins = r.wins;
          const whalePnLR = r.totalProfitR;
          const whaleWR = whaleTrades > 0 ? (whaleWins / whaleTrades * 100).toFixed(1) : "0.0";

          // Tạo báo cáo về các bộ lọc (Filters status)
          let filterReport = "";
          if (r.filterStats) {
            const fsVal = r.filterStats;
            filterReport = [
              `🔍 **THỐNG KÊ QUÉT & BỘ LỌC:**`,
              `• Tổng số Sweeps: **${fsVal.totalSweeps}** (Quét đáy: ${fsVal.totalSweepLow} | Quét đỉnh: ${fsVal.totalSweepHigh})`,
              `• LONG vượt bộ lọc: **${fsVal.passedLong}** | SHORT vượt bộ lọc: **${fsVal.passedShort}**`,
              `• Lệnh thực tế khớp: **${r.totalTrades}** (có thể bị chặn bởi SL/TP đang chạy hoặc cooldown)`,
              `\n❌ **SỐ LỆNH BỊ CHẶN BỞI CÁC BỘ LỌC:**`,
              `1. Lọc Xu hướng M1 (Close/EMA20/VWMA20): **${fsVal.blockedTrendM1}**`,
              `2. Lọc Khoảng cách VWMA (Overextended): **${fsVal.blockedOverextended}**`,
              `3. Lọc Khoảng dừng lỗ SL quá rộng: **${fsVal.blockedBadEntryPrice}**`,
              `4. Lọc Chỉ số ADX M1 thấp: **${fsVal.blockedAdx}**`,
              `5. Lọc Lực nến thắng thế (Displacement): **${fsVal.blockedDisplacement}**`,
              `6. Lọc Xác nhận Vol yếu: **${fsVal.blockedVolume}**`,
              `7. Lọc Khung giờ Session: **${fsVal.blockedSession}**`,
              `8. Lọc Nến xác nhận đóng yếu: **${fsVal.blockedConfirmClose}**`
            ].join('\n');
            
            // Console log chi tiết để theo dõi trên VPS / system log
            console.log("=== BÁO CÁO BỘ LỌC CHẶN (BACKTEST) ===");
            console.log(filterReport);
            console.log("=====================================");
          }

          // Gửi đúng 1 tin nhắn duy nhất chứa toàn bộ thông tin
          const reportMsg = [
            `📊 **KẾT QUẢ BACKTEST WHALE SWEEP ONLY**`,
            `📅 Từ: ${formatDateStr(r.startTime)} đến ${formatDateStr(r.endTime)}`,
            `💰 Số dư cuối: $${r.finalBalance.toFixed(2)}`,
            `📈 Tổng PnL: ${whalePnLR.toFixed(1)}R`,
            `⚡ Tổng lệnh: ${whaleTrades} | Winrate: ${whaleWR}%`,
            `📉 Max Drawdown: -$${r.maxDrawdownValue ? r.maxDrawdownValue.toFixed(2) : '0.00'} (${r.maxDrawdownPercent ? r.maxDrawdownPercent.toFixed(2) : '0.00'}%)`,
            `🔥 Max Consecutive Losses: ${r.maxConsecutiveLosses !== undefined ? r.maxConsecutiveLosses : 0} lệnh`,
            ``,
            filterReport,
            ``,
            `Thống kê Whale Sweep theo tháng:`,
            whaleMonthlyReport || `• Không có dữ liệu tháng`
          ].join('\n');

          await sendTelegram(reportMsg);
        }
    }).catch(err => {
      console.error("Backtest Error:", err);
      backtestStatus.isRunning = false;
      try {
        fs.writeFileSync(BACKTEST_RESULTS_FILE, JSON.stringify({ error: err.message }));
      } catch (e) {}
    });
    res.json({ message: "Started" });
  });
  app.post("/api/backtest/stop", (req, res) => {
    stopBacktestExecution();
    res.json({ status: "Stopping" });
  });

  app.get("/api/backtest/status", (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (backtestStatus.isRunning) {
      return res.send(JSON.stringify({
        isRunning: true,
        progress: backtestStatus.progress,
        lastResult: null
      }));
    }
    
    if (fs.existsSync(BACKTEST_RESULTS_FILE)) {
      try {
        const data = fs.readFileSync(BACKTEST_RESULTS_FILE, "utf-8");
        return res.send(`{"isRunning":false,"progress":100,"lastResult":${data}}`);
      } catch (e) {
        console.error("Lỗi đọc kết quả backtest từ ổ đĩa:", e);
      }
    }
    
    return res.send(JSON.stringify({
      isRunning: false,
      progress: 0,
      lastResult: null
    }));
  });
  app.get("/api/trading/status", (req, res) => {
    res.json({
      symbol: PAIR, last_price: botState.lastPrice, in_position: botState.inPosition,
      signals: botState.signals.slice(0, 10), balance: botState.balance, ai_reasoning: botState.aiReasoning,
      adx: botState.adx.toFixed(1),
      adx_threshold: ADX_THRESHOLD,
      ema20_5m: botState.ema20_5m.toFixed(2),
      ema50_5m: botState.ema50_5m.toFixed(2),
      shadow_ema_5m: botState.shadowEma5mCheck, 
      enable_session_filter: ENABLE_SESSION_FILTER,
      vwma_period: VWMA_PERIOD,
      is_ws_connected: botState.isWsConnected
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
    
    // Gửi thông báo khi server khởi động xong
    sendTelegram("🚀 Hệ thống XAUUSD Bot đã khởi động thành công và đang hoạt động!").catch(e => console.error("Lỗi gửi tele khởi động:", e));

    traderLoop(); 
  });
}

startServer();
