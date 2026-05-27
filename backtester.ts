
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

// --- CONFIG ---
const DATA_DIR = path.join(process.cwd(), "data");
const RESULTS_FILE = path.join(DATA_DIR, "backtest_results.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// --- CACHE ---
let backtestDataCache: {
  pair: string,
  timeframe: string,
  start: string,
  end: string,
  data: any[]
} | null = null;

const SPECIAL_CACHE_FILE = path.join(DATA_DIR, "backtest_data_2026_special_v2.json");
const CACHE_22_24_FILE = path.join(DATA_DIR, "backtest_data_2022_2024.json");
const CACHE_24_26_FILE = path.join(DATA_DIR, "backtest_data_2024_2026.json");
const CACHE_20_22_FILE = path.join(DATA_DIR, "backtest_data_2020_2022.json");
const CACHE_18_20_FILE = path.join(DATA_DIR, "backtest_data_2018_2020.json");

function getPredefinedCacheFile(rangeFile: string, timeframe: string): string {
  if (timeframe === "1m") {
    // Để giữ tương thích ngược, nếu file gốc (1m) tồn tại thì dùng luôn
    if (fs.existsSync(rangeFile)) {
      return rangeFile;
    }
  }
  // Tạo đường dẫn mới có chứa timeframe, ví dụ: backtest_data_2024_2026_5m.json
  const ext = path.extname(rangeFile);
  const base = rangeFile.slice(0, -ext.length);
  return `${base}_${timeframe}${ext}`;
}

function getCustomCacheFile(pair: string, timeframe: string, start: string, end: string): string {
  const cleanPair = pair.replace(/[^a-zA-Z0-9]/g, "_");
  const startYMD = start.split("T")[0].replace(/[^0-9-]/g, "");
  const endYMD = end.split("T")[0].replace(/[^0-9-]/g, "");
  return path.join(DATA_DIR, `backtest_data_custom_${cleanPair}_${timeframe}_${startYMD}_to_${endYMD}.json`);
}

function getCleanEnv(key: string) {
  const val = process.env[key];
  if (!val) return "";
  return val.trim().replace(/^["']|["']$/g, "").trim();
}

const PAIR = getCleanEnv("MT5_SYMBOL") || "XAUUSD";
const START_DATE = "2024-01-01T00:00:00Z"; 
const END_DATE = "2026-01-01T00:00:00Z";
const RR = 1.2; 
const INITIAL_BALANCE = 5000;
const RISK_PER_TRADE = 0.01; // 1%

// CẤU HÌNH PHIÊN GIAO DỊCH
const ENABLE_SESSION_FILTER = true;
const SESSION_START_GMT = 8;
const SESSION_END_GMT = 21;

interface BacktestResult {
  totalTrades: number;
  wins: number;
  losses: number;
  longTrades: number;
  longWins: number;
  shortTrades: number;
  shortWins: number;
  cancelledTrades: number;
  totalPnL: number;
  finalBalance: number;
  totalFees: number;
  totalSlippage: number;
  isLiquidated: boolean;
  liquidationDate: string | null;
  trades: any[];
  startTime: string;
  endTime: string;
  displaceTrades: number;
  displaceWins: number;
  totalProfitR: number;
  monthlySnapshots: any[];
  marketRegime?: any;
  efficiencyStats: {
    [key: string]: {
      trades: number;
      wins: number;
      pnlR: number;
    }
  };
  regimeStats: {
    [key: string]: {
      trades: number;
      wins: number;
      pnlR: number;
    }
  };
}

let results: BacktestResult = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
  longTrades: 0,
  longWins: 0,
  shortTrades: 0,
  shortWins: 0,
  cancelledTrades: 0,
  totalPnL: 0,
  finalBalance: INITIAL_BALANCE,
  totalFees: 0,
  totalSlippage: 0,
  isLiquidated: false,
  liquidationDate: null,
  trades: [],
  startTime: START_DATE,
  endTime: END_DATE,
  displaceTrades: 0,
  displaceWins: 0,
  totalProfitR: 0,
  monthlySnapshots: [],
  marketRegime: null,
  efficiencyStats: {
    "CHOPPY": { trades: 0, wins: 0, pnlR: 0 },
    "NEUTRAL": { trades: 0, wins: 0, pnlR: 0 },
    "EXPANSION": { trades: 0, wins: 0, pnlR: 0 }
  },
  regimeStats: {
    "TREND_EXPANSION": { trades: 0, wins: 0, pnlR: 0 },
    "NEUTRAL": { trades: 0, wins: 0, pnlR: 0 },
    "CHOPPY": { trades: 0, wins: 0, pnlR: 0 }
  }
};

// --- LOGIC FUNCTIONS (COPIED & ADAPTED FROM SERVER.TS) ---



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
        if (current <= bars[i - j][2] || current <= bars[i + j][2]) {
          isSwing = false;
          break;
        }
      } else {
        if (current >= bars[i - j][3] || current >= bars[i + j][3]) {
          isSwing = false;
          break;
        }
      }
    }
    if (isSwing) {
      swings.push({ price: current, index: i });
    }
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
    if (!found) {
      zones.push({ price: swing.price, touches: 1, lastTouch: swing.index });
    }
  }

  return zones.filter(z => z.touches >= 2).sort((a, b) => {
    const scoreA = a.touches * 10 + a.lastTouch;
    const scoreB = b.touches * 10 + b.lastTouch;
    return scoreB - scoreA;
  });
}

function calculateATR(bars: any[], period: number = 14) {
  if (bars.length < period + 1) return 0;
  let trSum = 0;
  const startIdx = bars.length - period;
  for (let i = startIdx; i < bars.length; i++) {
    const h = bars[i][2], l = bars[i][3], pc = bars[i-1][4];
    trSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return trSum / period;
}

function calculateVWAP(bars: any[]) {
  const len = bars.length;
  if (len === 0) return 0;
  const lastBarDayIndex = Math.floor(bars[len - 1][0] / 86400000);
  let totalPV = 0, totalV = 0;
  for (let i = len - 1; i >= 0; i--) {
    const dayIndex = Math.floor(bars[i][0] / 86400000);
    if (dayIndex !== lastBarDayIndex) break;
    const typicalPrice = (bars[i][2] + bars[i][3] + bars[i][4]) / 3;
    totalPV += typicalPrice * bars[i][5];
    totalV += bars[i][5];
  }
  return totalV === 0 ? bars[len - 1][4] : totalPV / totalV;
}

function detectSweep(bars: any[]) {
  const len = bars.length;
  if (len < 20) return { 
    sweepHigh: false, 
    sweepLow: false, 
    displacementBullish: false, 
    displacementBearish: false, 
    volConfirm: false, 
    low: 0, 
    high: 0, 
    confirmHigh: 0, 
    confirmLow: 0 
  };
  
  const sweepCandle = bars[len - 2];
  const confirmCandle = bars[len - 1];

  const sO = sweepCandle[1], sH = sweepCandle[2], sL = sweepCandle[3], sC = sweepCandle[4];
  const cO = confirmCandle[1], cH = confirmCandle[2], cL = confirmCandle[3], cC = confirmCandle[4], cV = confirmCandle[5];

  let localLow = Infinity;
  let localHigh = -Infinity;
  for (let j = len - 7; j < len - 2; j++) {
    const lowVal = bars[j][3];
    const highVal = bars[j][2];
    if (lowVal < localLow) localLow = lowVal;
    if (highVal > localHigh) localHigh = highVal;
  }

  const sweepSize = sH - sL || 1;
  const lowerWick = Math.min(sO, sC) - sL;
  const upperWick = sH - Math.max(sO, sC);

  let sumVol = 0;
  let isConstantVol = true;
  const firstVol = bars[len - 21][5];
  for (let j = len - 21; j < len - 1; j++) {
    const v = bars[j][5];
    sumVol += v;
    if (v !== firstVol) {
      isConstantVol = false;
    }
  }
  const avgVol = sumVol / 20;

  const sweepLow = sL <= localLow && sC >= localLow && (lowerWick / sweepSize >= 0.35);
  const sweepHigh = sH >= localHigh && sC <= localHigh && (upperWick / sweepSize >= 0.35);

  const body = Math.abs(cC - cO);
  const totalSize = cH - cL || 1;
  
  let sumBody = 0;
  for (let j = len - 21; j < len - 1; j++) {
    sumBody += Math.abs(bars[j][4] - bars[j][1]);
  }
  const avgBody = sumBody / 20;
  
  const displacementBullish = body > avgBody * 1.2 && (cC - cL) / totalSize > 0.7 && cC > Math.max(sO, sC);
  const displacementBearish = body > avgBody * 1.2 && (cH - cC) / totalSize > 0.7 && cC < Math.min(sO, sC);

  const volConfirm = isConstantVol ? true : cV > avgVol;

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

function calculateVWMA(bars: any[], period: number) {
  if (bars.length < period) return bars[bars.length - 1][4];
  let pvSum = 0;
  let volSum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const price = bars[i][4];
    const volume = bars[i][5];
    pvSum += price * volume;
    volSum += volume;
  }
  return volSum === 0 ? bars[bars.length - 1][4] : pvSum / volSum;
}

function aggregateCandles(oneMinBars: any[], windowSize: number = 15) {
  const aggregated: any[] = [];
  for (let i = 0; i < oneMinBars.length; i += windowSize) {
      const slice = oneMinBars.slice(i, i + windowSize);
      if (slice.length === 0) continue;
      
      aggregated.push([
          slice[0][0], // Open time
          slice[0][1], // Open
          Math.max(...slice.map(b => b[2])), // High
          Math.min(...slice.map(b => b[3])), // Low
          slice[slice.length - 1][4], // Close
          slice.reduce((acc, b) => acc + b[5], 0) // Volume
      ]);
  }
  return aggregated;
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

function calcADX(ohlcv: any[]) {
  const data = ohlcv.length > 35 ? ohlcv.slice(-35) : ohlcv;
  const period = 14;
  if (data.length < period * 2) return { adx: 0, pDI: 0, mDI: 0 };
  let tr: number[] = [], plusDM: number[] = [], minusDM: number[] = [];

  for (let i = 1; i < data.length; i++) {
    const h = data[i][2], l = data[i][3], prevC = data[i-1][4], prevH = data[i-1][2], prevL = data[i-1][3];
    tr.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
    const upMove = h - prevH, downMove = prevL - l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const smooth = (arr: number[]) => {
    let result = [arr.slice(0, period).reduce((a, b) => a + b, 0) / period];
    for (let i = period; i < arr.length; i++) result.push((result[result.length - 1] * (period - 1) + arr[i]) / period);
    return result;
  };

  const str = smooth(tr), sdmP = smooth(plusDM), sdmM = smooth(minusDM);
  const dx: number[] = [];
  const pDIs: number[] = [];
  const mDIs: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const pDI = 100 * (sdmP[i] / str[i]), mDI = 100 * (sdmM[i] / str[i]);
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

function isWithinTradingSessions(timestamp: number): boolean {
  if (!ENABLE_SESSION_FILTER) return true;
  const date = new Date(timestamp);
  const hoursGMT = date.getUTCHours();
  if (SESSION_START_GMT <= SESSION_END_GMT) {
    return hoursGMT >= SESSION_START_GMT && hoursGMT < SESSION_END_GMT;
  } else {
    return hoursGMT >= SESSION_START_GMT || hoursGMT < SESSION_END_GMT;
  }
}

async function getAIBacktestDecision(signal: string, lastPrice: number, bars: any[]) {
  // AI is disabled for backtest performance and stability
  return { decision: "CONFIRM", reason: "AI Check Disabled for Backtest" };
}

async function sendTelegramBacktest(message: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("❌ Telegram Notify Error:", err);
  }
}

// --- MAIN RUNNER ---

function aggregateCandlesByTime(oneMinBars: any[], timeframeStr: string): any[] {
  const isMinute = timeframeStr.endsWith("m");
  const isHour = timeframeStr.endsWith("h");
  const isDay = timeframeStr.endsWith("d") || timeframeStr.endsWith("D");
  
  let windowMinutes = 1;
  if (isMinute) {
    windowMinutes = parseInt(timeframeStr) || 1;
  } else if (isHour) {
    windowMinutes = (parseInt(timeframeStr) || 1) * 60;
  } else if (isDay) {
    windowMinutes = (parseInt(timeframeStr) || 1) * 1440;
  }
  
  if (windowMinutes <= 1) {
    return oneMinBars;
  }

  const intervalMs = windowMinutes * 60 * 1000;
  const groups = new Map<number, any[]>();
  
  for (const bar of oneMinBars) {
    const openTime = Math.floor(bar[0] / intervalMs) * intervalMs;
    let list = groups.get(openTime);
    if (!list) {
      list = [];
      groups.set(openTime, list);
    }
    list.push(bar);
  }
  
  const aggregated: any[] = [];
  const sortedKeys = Array.from(groups.keys()).sort((a, b) => a - b);
  
  for (const openTime of sortedKeys) {
    const slice = groups.get(openTime)!;
    aggregated.push([
      openTime,
      slice[0][1], // Open
      Math.max(...slice.map(b => b[2])), // High
      Math.min(...slice.map(b => b[3])), // Low
      slice[slice.length - 1][4], // Close
      slice.reduce((acc, b) => acc + b[5], 0) // Volume
    ]);
  }
  return aggregated;
}

function tryLoadFromXauCsv(startDate: string, endDate: string, timeframe: string): any[] | null {
  try {
    const startYear = new Date(startDate).getUTCFullYear();
    const endYear = new Date(endDate).getUTCFullYear();
    
    const candles: any[] = [];
    let loadedAny = false;
    
    for (let year = startYear; year <= endYear; year++) {
      const pathsToTry = [
        `C:/xau_data/${year}.csv`,
        `C:\\xau_data\\${year}.csv`,
        path.join(process.cwd(), "data", `xau_data_${year}.csv`)
      ];
      
      let filePath = "";
      for (const p of pathsToTry) {
        if (fs.existsSync(p)) {
          filePath = p;
          break;
        }
      }
      
      if (!filePath) {
        continue;
      }
      
      console.log(`[CSV LOAD] 📂 Phát hiện file CSV dữ liệu vàng: ${filePath}`);
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split(/\r?\n/);
      if (lines.length < 2) continue;
      
      const header = lines[0].toLowerCase().split(",");
      const timeIdx = header.indexOf("time");
      const openIdx = header.indexOf("open");
      const highIdx = header.indexOf("high");
      const lowIdx = header.indexOf("low");
      const closeIdx = header.indexOf("close");
      
      let volIdx = header.indexOf("tick_volume");
      if (volIdx === -1) volIdx = header.indexOf("volume");
      if (volIdx === -1) volIdx = header.indexOf("real_volume");
      
      if (timeIdx === -1 || openIdx === -1 || highIdx === -1 || lowIdx === -1 || closeIdx === -1) {
        console.error(`[CSV LOAD] ❌ Header không hợp lệ trong file ${filePath}`);
        continue;
      }
      
      let yearCandlesCount = 0;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const cols = line.split(",");
        if (cols.length < 5) continue;
        
        const timeStr = cols[timeIdx];
        let safeTimeStr = timeStr.trim();
        safeTimeStr = safeTimeStr.replace(/[\.\/]/g, "-");
        if (!safeTimeStr.includes("Z") && !safeTimeStr.includes("+") && !safeTimeStr.match(/-\d{2}:\d{2}$/)) {
          safeTimeStr = safeTimeStr.replace(" ", "T") + "Z";
        }
        const timestamp = new Date(safeTimeStr).getTime();
        if (isNaN(timestamp)) continue;
        
        const open = parseFloat(cols[openIdx]);
        const high = parseFloat(cols[highIdx]);
        const low = parseFloat(cols[lowIdx]);
        const close = parseFloat(cols[closeIdx]);
        const vol = volIdx !== -1 ? parseFloat(cols[volIdx]) || 1 : 1;
        
        if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) continue;
        
        candles.push([
          timestamp,
          open,
          high,
          low,
          close,
          vol
        ]);
        yearCandlesCount++;
      }
      
      console.log(`[CSV LOAD] ✅ Đã tải thành công ${yearCandlesCount} nến M1 từ ${filePath}`);
      loadedAny = true;
    }
    
    if (!loadedAny || candles.length === 0) {
      return null;
    }
    
    candles.sort((a, b) => a[0] - b[0]);
    
    const startTs = new Date(startDate).getTime();
    const endTs = new Date(endDate).getTime();
    let filtered = candles.filter(k => k[0] >= startTs && k[0] <= endTs);
    console.log(`[CSV LOAD] 📊 Tổng nến M1 nạp từ CSV: ${filtered.length} nến (Từ ${startDate} đến ${endDate})`);
    
    if (timeframe !== "1m") {
      console.log(`[CSV LOAD] 🔄 Đang gộp nến từ M1 sang ${timeframe}...`);
      filtered = aggregateCandlesByTime(filtered, timeframe);
      console.log(`[CSV LOAD] 🔄 Sau khi gộp: còn lại ${filtered.length} nến ${timeframe}`);
    }
    
    return filtered;
  } catch (err: any) {
    console.error("[CSV LOAD] ❌ Lỗi đọc dữ liệu CSV vàng:", err.message);
    return null;
  }
}

let shouldStopBacktest = false;

export function stopBacktestExecution() {
  shouldStopBacktest = true;
}

export async function runBacktest(
  startDate: string = START_DATE,
  endDate: string = END_DATE,
  rr: number = RR,
  timeframe: string = "1m",
  enableSessionFilter: boolean = true,
  vwmaPeriod: number = 20, 
  onProgress?: (p: number) => void,
  adxThreshold: number = 10,
  enableWhaleSweep: boolean = true
) {
  shouldStopBacktest = false;
  backtestDataCache = null; // Clear static memory cache of previous runs to free RAM immediately
  console.log(`[BACKTEST] Start ${PAIR} from ${startDate} to ${endDate} (RR: ${rr}, TF: ${timeframe}, SessionFilter: ${enableSessionFilter}, VWMA: ${vwmaPeriod}, ADX: ${adxThreshold}, WhaleSweep: ${enableWhaleSweep})`);
  
  let results: BacktestResult = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    longTrades: 0,
    longWins: 0,
    shortTrades: 0,
    shortWins: 0,
    cancelledTrades: 0,
    totalPnL: 0,
    finalBalance: INITIAL_BALANCE,
    totalFees: 0,
    totalSlippage: 0,
    isLiquidated: false,
    liquidationDate: null,
    trades: [],
    startTime: startDate,
    endTime: endDate,
    displaceTrades: 0,
    displaceWins: 0,
    totalProfitR: 0,
    monthlySnapshots: [],
    marketRegime: null,
    efficiencyStats: {
      "CHOPPY": { trades: 0, wins: 0, pnlR: 0 },
      "NEUTRAL": { trades: 0, wins: 0, pnlR: 0 },
      "EXPANSION": { trades: 0, wins: 0, pnlR: 0 }
    },
    regimeStats: {
      "TREND_EXPANSION": { trades: 0, wins: 0, pnlR: 0 },
      "NEUTRAL": { trades: 0, wins: 0, pnlR: 0 },
      "CHOPPY": { trades: 0, wins: 0, pnlR: 0 }
    }
  };

  let allKlines: any[] = [];
  const startTs = new Date(startDate).getTime();
  const endTs = new Date(endDate).getTime();

  try {

  // 1. CHỈNH SỬA THEO YÊU CẦU: ƯU TIÊN LOAD FILE CSV XAU_DATA TỪ VPS (C:/xau_data/{year}.csv)
  const csvCandles = tryLoadFromXauCsv(startDate, endDate, timeframe);
  if (csvCandles && csvCandles.length > 0) {
    allKlines = csvCandles;
    console.log(`[BACKTEST] 📈 SỬ DỤNG DỮ LIỆU VÀNG THỰC TẾ TỪ CSV KHÁCH HÀNG: ${allKlines.length} nến (${timeframe})`);
  }

  // KIỂM TRA PHẠM VI ĐẶC BIỆT ĐỂ CACHE VĨNH VIỄN (Có nhận biết timeframe)
  const isSpecialRange = (startDate.startsWith("2026-01-01") && endDate.startsWith("2026-05-01"));
  const is2224Range = (startDate.startsWith("2022-01-01") && endDate.startsWith("2024-01-01"));
  const is2426Range = (startDate.startsWith("2024-01-01") && endDate.startsWith("2026-01-01"));
  const is2022Range = (startDate.startsWith("2020-01-01") && endDate.startsWith("2022-01-01"));
  const is1820Range = (startDate.startsWith("2018-01-01") && endDate.startsWith("2020-01-01"));

  const specialCachePath = getPredefinedCacheFile(SPECIAL_CACHE_FILE, timeframe);
  const cache2022Path = getPredefinedCacheFile(CACHE_20_22_FILE, timeframe);
  const cache2224Path = getPredefinedCacheFile(CACHE_22_24_FILE, timeframe);
  const cache2426Path = getPredefinedCacheFile(CACHE_24_26_FILE, timeframe);
  const cache1820Path = getPredefinedCacheFile(CACHE_18_20_FILE, timeframe);
  const customCachePath = getCustomCacheFile(PAIR, timeframe, startDate, endDate);

  if (allKlines.length === 0) {
    if (isSpecialRange && fs.existsSync(specialCachePath)) {
      try {
        console.log(`[BACKTEST] 💠 PHÁT HIỆN KHUNG GIỜ VÀNG (2026-01-01 -> 2026-05-01) - Timeframe: ${timeframe}`);
        console.log(`[BACKTEST] 💾 Đang đọc dữ liệu CACHE từ ổ đĩa: ${specialCachePath}`);
        let rawData: string | null = fs.readFileSync(specialCachePath, "utf-8");
        allKlines = JSON.parse(rawData);
        rawData = null;
        console.log(`[BACKTEST] ✅ Đã tải ${allKlines.length} nến từ file cache.`);
      } catch (e) {
        console.error("[BACKTEST] ❌ Lỗi khi đọc cache vĩnh viễn, sẽ fetch lại:", e);
      }
    } else if (is2022Range && fs.existsSync(cache2022Path)) {
      try {
        console.log(`[BACKTEST] 💠 PHÁT HIỆN KHUNG GIỜ 2020-2022 - Timeframe: ${timeframe}`);
        console.log(`[BACKTEST] 💾 Đang đọc dữ liệu CACHE từ ổ đĩa: ${cache2022Path}`);
        let rawData: string | null = fs.readFileSync(cache2022Path, "utf-8");
        allKlines = JSON.parse(rawData);
        rawData = null;
        console.log(`[BACKTEST] ✅ Đã tải ${allKlines.length} nến từ file cache.`);
      } catch (e) {
        console.error("[BACKTEST] ❌ Lỗi khi đọc cache 2020-2022:", e);
      }
    } else if (is2224Range && fs.existsSync(cache2224Path)) {
      try {
        console.log(`[BACKTEST] 💠 PHÁT HIỆN KHUNG GIỜ 2022-2024 - Timeframe: ${timeframe}`);
        console.log(`[BACKTEST] 💾 Đang đọc dữ liệu CACHE từ ổ đĩa: ${cache2224Path}`);
        let rawData: string | null = fs.readFileSync(cache2224Path, "utf-8");
        allKlines = JSON.parse(rawData);
        rawData = null;
        console.log(`[BACKTEST] ✅ Đã tải ${allKlines.length} nến từ file cache.`);
      } catch (e) {
        console.error("[BACKTEST] ❌ Lỗi khi đọc cache 22-24:", e);
      }
    } else if (is2426Range && fs.existsSync(cache2426Path)) {
      try {
        console.log(`[BACKTEST] 💠 PHÁT HIỆN KHUNG GIỜ 2024-2026 - Timeframe: ${timeframe}`);
        console.log(`[BACKTEST] 💾 Đang đọc dữ liệu CACHE từ ổ đĩa: ${cache2426Path}`);
        let rawData: string | null = fs.readFileSync(cache2426Path, "utf-8");
        allKlines = JSON.parse(rawData);
        rawData = null;
        console.log(`[BACKTEST] ✅ Đã tải ${allKlines.length} nến từ file cache.`);
      } catch (e) {
        console.error("[BACKTEST] ❌ Lỗi khi đọc cache 24-26:", e);
      }
    } else if (is1820Range && fs.existsSync(cache1820Path)) {
      try {
        console.log(`[BACKTEST] 💠 PHÁT HIỆN KHUNG GIỜ 2018-2020 - Timeframe: ${timeframe}`);
        console.log(`[BACKTEST] 💾 Đang đọc dữ liệu CACHE từ ổ đĩa: ${cache1820Path}`);
        let rawData: string | null = fs.readFileSync(cache1820Path, "utf-8");
        allKlines = JSON.parse(rawData);
        rawData = null;
        console.log(`[BACKTEST] ✅ Đã tải ${allKlines.length} nến từ file cache.`);
      } catch (e) {
        console.error("[BACKTEST] ❌ Lỗi khi đọc cache 18-20:", e);
      }
    } else if (fs.existsSync(customCachePath)) {
      try {
        console.log(`[BACKTEST] 💠 PHÁT HIỆN CÓ CACHE DỮ LIỆU PHÙ HỢP - Timeframe: ${timeframe}`);
        console.log(`[BACKTEST] 💾 Đang đọc dữ liệu CACHE từ ổ đĩa: ${customCachePath}`);
        let rawData: string | null = fs.readFileSync(customCachePath, "utf-8");
        allKlines = JSON.parse(rawData);
        rawData = null;
        console.log(`[BACKTEST] ✅ Đã tải ${allKlines.length} nến từ file cache.`);
      } catch (e) {
        console.error("[BACKTEST] ❌ Lỗi khi đọc cache custom:", e);
      }
    }
  }

  if (allKlines.length === 0) {
    // KIỂM TRA CACHE TRONG BỘ NHỚ (Cho các khung giờ khác)
    if (
      backtestDataCache &&
      backtestDataCache.pair === PAIR &&
      backtestDataCache.timeframe === timeframe &&
      backtestDataCache.start === startDate &&
      backtestDataCache.end === endDate
    ) {
      console.log(`[BACKTEST] ⚡ Sử dụng dữ liệu từ Cache bộ nhớ (${backtestDataCache.data.length} nến)`);
      allKlines = backtestDataCache.data;
    } else {
      throw new Error(`Không tìm thấy dữ liệu XAUUSD cho khoảng thời gian từ ${startDate} đến ${endDate}. Vui lòng kiểm tra lại file CSV tại C:/xau_data/{year}.csv hoặc các file cache local trong thư mục "data/".`);
    }
  }

  allKlines = allKlines.filter(k => k[0] <= endTs);
  console.log(`[DATA] Loaded ${allKlines.length} klines.`);

  results = { 
    ...results, 
    totalTrades: 0, 
    wins: 0, 
    losses: 0, 
    longTrades: 0,
    longWins: 0,
    shortTrades: 0,
    shortWins: 0,
    cancelledTrades: 0,
    totalPnL: 0, 
    finalBalance: INITIAL_BALANCE, 
    totalFees: 0,
    totalSlippage: 0,
    isLiquidated: false, 
    liquidationDate: null, 
    trades: [],
    startTime: startDate,
    endTime: endDate,
    displaceTrades: 0,
    displaceWins: 0,
    totalProfitR: 0,
    monthlySnapshots: [],
    efficiencyStats: {
      "CHOPPY": { trades: 0, wins: 0, pnlR: 0 },
      "NEUTRAL": { trades: 0, wins: 0, pnlR: 0 },
      "EXPANSION": { trades: 0, wins: 0, pnlR: 0 }
    },
    regimeStats: {
      "TREND_EXPANSION": { trades: 0, wins: 0, pnlR: 0 },
      "NEUTRAL": { trades: 0, wins: 0, pnlR: 0 },
      "CHOPPY": { trades: 0, wins: 0, pnlR: 0 }
    }
  };

  let lastMonth = -1;
  let lastYear = -1;
  let monthlyWins = 0;
  let monthlyLosses = 0;
  let monthlyLongTrades = 0;
  let monthlyLongWins = 0;
  let monthlyShortTrades = 0;
  let monthlyShortWins = 0;
  let monthlyPnL = 0;
  let monthlyProfitR = 0;
  let monthlyWhaleTrades = 0;
  let monthlyWhaleWins = 0;
  let monthlyWhalePnLR = 0;
  let monthlySnapshots: any[] = [];

  // Diagnostics/Debug Tracking
  let debugTotalCandles = 0;
  let debugTotalSweepsDetected = 0;
  let debugTotalNewSweepsLong = 0;
  let debugTotalNewSweepsShort = 0;
  let debugPendingSweepsAdded = 0;
  let debugSweepLowCount = 0;
  let debugSweepHighCount = 0;
  let debugDisplacementBullishCount = 0;
  let debugDisplacementBearishCount = 0;
  let debugVolConfirmCount = 0;
  const debugWhaleLongConditions = {
    isNewSweepLongAtBar: 0,
    isInSession: 0,
    enableWhaleSweep: 0,
    notOverExtendedLong: 0,
    currentPrice_gt_vwma5m: 0,
    adx_ge_threshold: 0,
    slope_gt_0: 0
  };
  const debugWhaleShortConditions = {
    isNewSweepShortAtBar: 0,
    isInSession: 0,
    enableWhaleSweep: 0,
    notOverExtendedShort: 0,
    currentPrice_lt_vwma5m: 0,
    adx_ge_threshold: 0,
    slope_gt_neg_0_02: 0
  };

  let sessionSkippedCount = 0;
  const isWithinSessions = (ts: number) => {
    if (!enableSessionFilter) return true;
    const date = new Date(ts);
    const hour = date.getUTCHours();
    let result = false;
    if (SESSION_START_GMT <= SESSION_END_GMT) {
      result = hour >= SESSION_START_GMT && hour < SESSION_END_GMT;
    } else {
      result = hour >= SESSION_START_GMT || hour < SESSION_END_GMT;
    }
    if (!result) sessionSkippedCount++;
    return result;
  };

  let sweepHistoryQueue: number[] = [];
  let pendingSweeps: { type: "LONG" | "SHORT", entryPrice: number, sl: number, tp: number, triggerIndex: number }[] = [];
  let lastVwmaM1 = 0;

  for (let i = 100; i < allKlines.length; i++) {
    if (shouldStopBacktest) break;
    if (onProgress) onProgress(50 + ((i / allKlines.length) * 50));

    // Kiểm tra cháy tài khoản (dưới 10$)
    if (results.finalBalance <= 10) {
      results.isLiquidated = true;
      results.liquidationDate = new Date(allKlines[i][0]).toISOString();
      console.log(`[MARGIN] LIQUIDATION AT ${results.liquidationDate}. Stopping.`);
      break;
    }

    // --- 1. RESOLVE PENDING SWEEPS ON CURRENT BAR ---
    const [, , barH, barL, barC] = allKlines[i];
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
      if (!resolved && (i - ps.triggerIndex >= 150)) {
        resolved = true;
        won = ps.type === "LONG" ? (barC >= ps.entryPrice) : (barC <= ps.entryPrice);
      }
      
      if (resolved) {
        sweepHistoryQueue.push(won ? 1 : 0);
        if (sweepHistoryQueue.length > 10) {
          sweepHistoryQueue.shift();
        }
        pendingSweeps.splice(sIdx, 1);
      }
    }

    // --- KHUNG 1P (ENTRIES) ---
    const currentPrice = allKlines[i][4];
    const calcWindow = allKlines.slice(Math.max(0, i - 100), i + 1);
    const vwapM1 = calculateVWAP(calcWindow);
    const vwmaM1 = calculateVWMA(calcWindow, 20); // VWMA 20 M1
    const vwmaM1Prev = i === 100 ? calculateVWMA(allKlines.slice(Math.max(0, i - 101), i), 20) : lastVwmaM1;
    lastVwmaM1 = vwmaM1;
    const slopeM1 = vwmaM1 - vwmaM1Prev;
    const adxM1 = calcADX(calcWindow);
    const sweep = detectSweep(calcWindow);
    const atrM1 = calculateATR(calcWindow, 14);

    const isInSession = isWithinSessions(allKlines[i][0]);

    // --- 2. CALCULATE ROLLING WINRATE & RISK ENGINE ---
    const rollingWinRate = sweepHistoryQueue.length > 0
      ? (sweepHistoryQueue.reduce((a, b) => a + b, 0) / sweepHistoryQueue.length)
      : 0.50; // default to 50% if queue is empty

    const dynamicRiskPctMultiplier = 1.0; // Tải cứng 1% rủi ro, tắt Dynamic Risk theo yêu cầu
    const isContinuationEnabled = false; // Bỏ hoàn toàn chiến lược Continuation
    
    // Tái update dynamic regime chỉ mang vai trò thống kê theo dõi, CHƯA thay đổi trực tiếp đến risk/choppy block
    // dynamic lấy 10 tín hiệu sweep gần nhất để xem bao nhiêu win và loss sau đó định hình cho lệnh tiếp theo
    let finalRegimeLabel: "TREND_EXPANSION" | "NEUTRAL" | "CHOPPY" = "NEUTRAL";
    if (sweepHistoryQueue.length >= 4) {
      if (rollingWinRate <= 0.3) {
        finalRegimeLabel = "CHOPPY";
      } else if (rollingWinRate >= 0.7) {
        finalRegimeLabel = "TREND_EXPANSION";
      } else {
        finalRegimeLabel = "NEUTRAL";
      }
    } else {
      finalRegimeLabel = "NEUTRAL";
    }

    const isMarketTooChoppy = false; // Luôn cho phép trade, không thay đổi trực tiếp đến risk/block

    results.marketRegime = {
      totalScore: Number((rollingWinRate * 100).toFixed(1)),
      regime: finalRegimeLabel,
      riskPercent: dynamicRiskPctMultiplier
    };
    const regimeData = results.marketRegime;

    const distFromVWMA = Math.abs(currentPrice - vwmaM1);
    const isOverExtendedLong = distFromVWMA > (atrM1 * 1.1);
    const isOverExtendedShort = distFromVWMA > (atrM1 * 1.1);

    const slDistanceLong = Math.abs(currentPrice - sweep.low);
    const slDistanceShort = Math.abs(sweep.high - currentPrice);
    const hasBadEntryPriceLong = slDistanceLong > (atrM1 * 2.0);
    const hasBadEntryPriceShort = slDistanceShort > (atrM1 * 2.0);

    debugTotalCandles++;
    if (sweep.sweepLow || sweep.sweepHigh) {
      debugTotalSweepsDetected++;
    }
    if (sweep.sweepLow) debugSweepLowCount++;
    if (sweep.sweepHigh) debugSweepHighCount++;
    if (sweep.displacementBullish) debugDisplacementBullishCount++;
    if (sweep.displacementBearish) debugDisplacementBearishCount++;
    if (sweep.volConfirm) debugVolConfirmCount++;

    // Tracking/storing new sweep candidates
    const isNewSweepLongAtBar = sweep.sweepLow && sweep.displacementBullish && sweep.volConfirm;
    const isNewSweepShortAtBar = sweep.sweepHigh && sweep.displacementBearish && sweep.volConfirm;

    if (isNewSweepLongAtBar) {
      debugTotalNewSweepsLong++;
      debugWhaleLongConditions.isNewSweepLongAtBar++;
      if (isInSession) debugWhaleLongConditions.isInSession++;
      if (enableWhaleSweep) debugWhaleLongConditions.enableWhaleSweep++;
      if (!isOverExtendedLong) debugWhaleLongConditions.notOverExtendedLong++;
      
      const calcWindow5mRaw = allKlines.slice(Math.max(0, i - 110), i + 1);
      const bars5m = aggregateCandles(calcWindow5mRaw, 5);
      const vwma5m = calculateVWMA(bars5m, 20);
      if (currentPrice > vwma5m) debugWhaleLongConditions.currentPrice_gt_vwma5m++;
      if (adxM1.adx >= adxThreshold) debugWhaleLongConditions.adx_ge_threshold++;
      if (slopeM1 > 0) debugWhaleLongConditions.slope_gt_0++;

      if (isInSession) {
        const slRaw = sweep.low - atrM1 * 0.8;
        const minRisk = atrM1 * 1.5;
        const slPrice = Math.min(slRaw, currentPrice - minRisk);
        const riskAmt = Math.max(0.0001, Math.abs(currentPrice - slPrice));
        const tpPrice = currentPrice + riskAmt * rr;
        if (!pendingSweeps.some(ps => ps.triggerIndex === i && ps.type === "LONG")) {
          pendingSweeps.push({
            type: "LONG",
            entryPrice: currentPrice,
            sl: slPrice,
            tp: tpPrice,
            triggerIndex: i
          });
          debugPendingSweepsAdded++;
        }
      }
    } else if (isNewSweepShortAtBar) {
      debugTotalNewSweepsShort++;
      debugWhaleShortConditions.isNewSweepShortAtBar++;
      if (isInSession) debugWhaleShortConditions.isInSession++;
      if (enableWhaleSweep) debugWhaleShortConditions.enableWhaleSweep++;
      if (!isOverExtendedShort) debugWhaleShortConditions.notOverExtendedShort++;

      const calcWindow5mRaw = allKlines.slice(Math.max(0, i - 110), i + 1);
      const bars5m = aggregateCandles(calcWindow5mRaw, 5);
      const vwma5m = calculateVWMA(bars5m, 20);
      if (currentPrice < vwma5m) debugWhaleShortConditions.currentPrice_lt_vwma5m++;
      if (adxM1.adx >= adxThreshold) debugWhaleShortConditions.adx_ge_threshold++;
      if (slopeM1 > -0.02) debugWhaleShortConditions.slope_gt_neg_0_02++;

      if (isInSession) {
        const slRaw = sweep.high + atrM1 * 0.8;
        const minRisk = atrM1 * 1.5;
        const slPrice = Math.max(slRaw, currentPrice + minRisk);
        const riskAmt = Math.max(0.0001, Math.abs(currentPrice - slPrice));
        const tpPrice = currentPrice - riskAmt * rr;
        if (!pendingSweeps.some(ps => ps.triggerIndex === i && ps.type === "SHORT")) {
          pendingSweeps.push({
            type: "SHORT",
            entryPrice: currentPrice,
            sl: slPrice,
            tp: tpPrice,
            triggerIndex: i
          });
          debugPendingSweepsAdded++;
        }
      }
    }



    // --- MONTHLY SNAPSHOT LOGIC ---
    const d = new Date(allKlines[i][0]);
    const currentMonth = d.getUTCMonth();
    const currentYear = d.getUTCFullYear();
    
    if (lastMonth !== -1 && currentMonth !== lastMonth) {
      const totalMonthTrades = monthlyWins + monthlyLosses;
      const monthWinRate = totalMonthTrades > 0 ? (monthlyWins / totalMonthTrades * 100) : 0;
      
      monthlySnapshots.push({
        month: lastMonth + 1,
        year: lastYear,
        date: `Tháng ${lastMonth + 1}/${lastYear}`,
        balance: results.finalBalance,
        monthlyProfit: monthlyPnL,
        monthlyProfitR: monthlyProfitR,
        totalProfitR: results.totalProfitR,
        winRate: monthWinRate.toFixed(1),
        trades: totalMonthTrades,
        wins: monthlyWins,
        losses: monthlyLosses,
        longTrades: monthlyLongTrades,
        longWins: monthlyLongWins,
        shortTrades: monthlyShortTrades,
        shortWins: monthlyShortWins,
        // Continuation stats (completely disabled)
        continuationTrades: 0,
        continuationWins: 0,
        continuationPnLR: 0,
        whaleTrades: totalMonthTrades,
        whaleWins: monthlyWins,
        whalePnLR: monthlyProfitR
      });

      monthlyWins = 0; monthlyLosses = 0; monthlyLongTrades = 0; monthlyLongWins = 0;
      monthlyShortTrades = 0; monthlyShortWins = 0; monthlyPnL = 0; monthlyProfitR = 0;
      monthlyWhaleTrades = 0; monthlyWhaleWins = 0; monthlyWhalePnLR = 0;
    }
    lastMonth = currentMonth;
    lastYear = currentYear;

    // --- ENTRY DECISION (WHALE SWEEP ONLY) ---
    let isLong = !isMarketTooChoppy && 
      enableWhaleSweep && !isOverExtendedLong && !hasBadEntryPriceLong && currentPrice > vwmaM1 && slopeM1 > 0 && adxM1.adx >= adxThreshold && sweep.sweepLow && sweep.displacementBullish && sweep.volConfirm && isInSession;

    let isShort = !isMarketTooChoppy && 
      enableWhaleSweep && !isOverExtendedShort && !hasBadEntryPriceShort && currentPrice < vwmaM1 && slopeM1 < 0 && adxM1.adx >= adxThreshold && sweep.sweepHigh && sweep.displacementBearish && sweep.volConfirm && isInSession;

    if (isLong || isShort) {
      const type = isLong ? "LONG" : "SHORT";

      // 1. TÍNH TOÁN REAL-TIME EFFICIENCY (Dựa trên 3 nến thị trường mới nhất)
      const currentWindow = allKlines.slice(i - 2, i + 1); // C-2, C-1, C0
      let currentTradeEff = 1.0;

      if (currentWindow.length === 3) {
          const c0 = currentWindow[2]; // Nến tín hiệu
          const c1 = currentWindow[1];
          const c2 = currentWindow[0];

          const [,, h0, l0, c0c, , o0] = c0;
          
          // Component 1: Net Move của nến tín hiệu
          const netMoveScore = Math.abs(c0c - o0) / (h0 - l0 + 0.0001);
          
          // Component 2: Close Acceptance (Vị trí đóng cửa trong Range 3 nến)
          const maxH3 = Math.max(c0[2], c1[2], c2[2]);
          const minL3 = Math.min(c0[3], c1[3], c2[3]);
          const range3 = maxH3 - minL3 + 0.0001;
          
          let closeAccScore = 0.5;
          if (type === "LONG") {
              closeAccScore = (c0c - minL3) / range3;
          } else {
              closeAccScore = (maxH3 - c0c) / range3;
          }

          // Component 3: Smoothness (Độ mượt của 3 nến)
          const absMove3 = Math.abs(c0c - c2[1]);
          const sumRange3 = (c0[2]-c0[3]) + (c1[2]-c1[3]) + (c2[2]-c2[3]);
          const smoothness = absMove3 / (sumRange3 + 0.0001);

          currentTradeEff = (netMoveScore + closeAccScore + smoothness) / 3;
      }

      let dynamicRiskMult = regimeData.riskPercent;
      let efficiencyLabel = "NEUTRAL";
      if (regimeData.regime === "CHOPPY") {
        efficiencyLabel = "CHOPPY";
      } else if (regimeData.regime === "TREND_EXPANSION") {
        efficiencyLabel = "EXPANSION";
      } else {
        efficiencyLabel = "NEUTRAL";
      }

      const currentRR = rr;
      const entryPrice = currentPrice; 
      
      const time = new Date(allKlines[i][0]).toISOString();
      const slRaw = type === "LONG" ? (sweep.low - atrM1 * 0.8) : (sweep.high + atrM1 * 0.8);
      const minRisk = atrM1 * 1.5;
      let sl = 0;
      if (type === "LONG") {
        sl = Math.min(slRaw, currentPrice - minRisk);
      } else {
        sl = Math.max(slRaw, currentPrice + minRisk);
      }
      const risk = Math.abs(entryPrice - sl);
      const tp = type === "LONG" ? entryPrice + risk * rr : entryPrice - risk * rr;

      const baseRiskPercent = 0.01;
      const currentRiskPercent = baseRiskPercent * dynamicRiskMult;

      const strategyLabel = "WHALE SWEEP";
      console.log(`[SIGNAL] ${type} | ${strategyLabel} | Entry: $${entryPrice.toFixed(2)} | SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)}`);
      
      // Tìm kết quả trong các nến tiếp theo
      let exitPrice = 0;
      let pnlR = 0;
      let status = "LOSS";
      const initialRiskDist = Math.abs(entryPrice - sl);

      let tradeResolvedIdx = i;
      for (let j = i + 1; j < Math.min(i + 150, allKlines.length); j++) {
        const [, , h, l, c] = allKlines[j];
        
        if (type === "LONG") {
          if (l <= sl) { exitPrice = sl; status = "LOSS"; tradeResolvedIdx = j; break; }
          if (h >= tp) { exitPrice = tp; status = "WIN"; tradeResolvedIdx = j; break; }
        } else {
          if (h >= sl) { exitPrice = sl; status = "LOSS"; tradeResolvedIdx = j; break; }
          if (l <= tp) { exitPrice = tp; status = "WIN"; tradeResolvedIdx = j; break; }
        }
      }

      if (exitPrice === 0) {
        tradeResolvedIdx = Math.min(i + 149, allKlines.length - 1);
        exitPrice = allKlines[tradeResolvedIdx][4];
      }
      
      // Tính PnL R thực tế dựa trên rủi ro ban đầu
      pnlR = (type === "LONG" ? (exitPrice - entryPrice) : (entryPrice - exitPrice)) / initialRiskDist;
      
      const dollarPnL = results.finalBalance * currentRiskPercent * pnlR;
      
      // Tính phí và trượt giá dự kiến (Để thống kê, ko trừ túi)
      const feeRate = 0.0005; // 0.05% taker
      const slippageRate = 0.0002; // 0.02% slippage
      
      const riskAmount = results.finalBalance * currentRiskPercent;
      const stopLossDistPct = Math.abs(entryPrice - sl) / entryPrice;
      const positionNotional = stopLossDistPct > 0 ? riskAmount / stopLossDistPct : 0;
      
      const estimatedFee = positionNotional * feeRate * 2; 
      const estimatedSlippage = positionNotional * slippageRate * 2;
      
      results.totalFees += estimatedFee;
      results.totalSlippage += estimatedSlippage;
      results.finalBalance += dollarPnL; 
      monthlyPnL += dollarPnL;

      // Chuẩn hóa Profit R: 
      const multiplier = 1.0; 
      const effectiveR = pnlR * multiplier;
      
      monthlyProfitR += effectiveR;

      results.totalTrades++;
      if (type === "LONG") {
        results.longTrades++;
        monthlyLongTrades++;
      } else {
        results.shortTrades++;
        monthlyShortTrades++;
      }

      if (status === "WIN") {
        results.wins++;
        if (type === "LONG") {
          results.longWins++;
          monthlyLongWins++;
        } else {
          results.shortWins++;
          monthlyShortWins++;
        }
        results.displaceWins++;
        monthlyWins++;
      } else {
        results.losses++;
        monthlyLosses++;
      }
      
      results.displaceTrades++;
      
    results.totalPnL += dollarPnL;
    results.totalProfitR += effectiveR;
    
    // Whale Sweep stats
    monthlyWhaleTrades++;
    monthlyWhalePnLR += effectiveR;
    if (status === "WIN") {
      monthlyWhaleWins++;
    }

    // Track regime stats
    if (results.regimeStats[regimeData.regime]) {
      results.regimeStats[regimeData.regime].trades++;
      results.regimeStats[regimeData.regime].pnlR += effectiveR;
      if (status === "WIN") {
        results.regimeStats[regimeData.regime].wins++;
      }
    }

    // Track efficiency stats
    if (results.efficiencyStats[efficiencyLabel]) {
       results.efficiencyStats[efficiencyLabel].trades++;
       results.efficiencyStats[efficiencyLabel].pnlR += effectiveR;
       if (status === "WIN") results.efficiencyStats[efficiencyLabel].wins++;
     }

    results.trades.push({ 
      time, 
      type, 
      entryPrice, 
      exitPrice, 
      status, 
      pnlR, 
      dollarPnL, 
      estimatedFee,
      estimatedSlippage,
      currentBalance: results.finalBalance,
      reason: `TA Entry`,
      regime: regimeData.regime,
      efficiency: efficiencyLabel,
      effValue: currentTradeEff,
      riskPercent: Number((currentRiskPercent * 100).toFixed(2))
    });
    
    const strategyLabelResult = "WHALE SWEEP";
    console.log(`[TRADE] ${status} | ${strategyLabelResult} | Risk: ${(currentRiskPercent * 100).toFixed(1)}% (${efficiencyLabel}) | PnL: ${pnlR.toFixed(1)}R | Balance: $${results.finalBalance.toFixed(2)}`);
    
    // Log format requested by user
    const formattedTradeTime = new Date(allKlines[i][0]).toLocaleString("vi-VN");
    const formattedPnL = pnlR > 0 ? `+${pnlR.toFixed(2)}` : `${pnlR.toFixed(2)}`;
    const formattedRiskPercent = (currentRiskPercent * 100).toFixed(2);
    console.log(`[${formattedTradeTime}] ${status === "WIN" ? "Win" : "Loss"} ${formattedPnL}R Balance: $${results.finalBalance.toFixed(2)} risk: ${formattedRiskPercent}%`);
      
      // Nhảy vòng lặp đến điểm nến hiện tại
      i = tradeResolvedIdx;
    }
  }

  // Đẩy tháng cuối cùng chưa lưu nếu kết thúc loop xuyên tháng
  if (lastMonth !== -1 && (monthlyWins + monthlyLosses > 0 || monthlyWhaleTrades > 0)) {
    const totalMonthTrades = monthlyWins + monthlyLosses;
    const monthWinRate = totalMonthTrades > 0 ? (monthlyWins / totalMonthTrades * 100) : 0;
    
    monthlySnapshots.push({
      month: lastMonth + 1,
      year: lastYear,
      date: `Tháng ${lastMonth + 1}/${lastYear}`,
      balance: results.finalBalance,
      monthlyProfit: monthlyPnL,
      monthlyProfitR: monthlyProfitR,
      totalProfitR: results.totalProfitR,
      winRate: monthWinRate.toFixed(1),
      trades: totalMonthTrades,
      wins: monthlyWins,
      losses: monthlyLosses,
      longTrades: monthlyLongTrades,
      longWins: monthlyLongWins,
      shortTrades: monthlyShortTrades,
      shortWins: monthlyShortWins,
      // Continuation stats (completely disabled)
      continuationTrades: 0,
      continuationWins: 0,
      continuationPnLR: 0,
      whaleTrades: totalMonthTrades,
      whaleWins: monthlyWins,
      whalePnLR: monthlyProfitR
    });
  }

  results.monthlySnapshots = monthlySnapshots;
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log(`[DONE] Backtest complete. Results: ${RESULTS_FILE}`);

  console.log("\n📅 --- THỐNG KÊ CHI TIẾT THEO TỪNG THÁNG ---");
  if (results.monthlySnapshots && results.monthlySnapshots.length > 0) {
    results.monthlySnapshots.forEach((m: any) => {
      const wr = m.whaleTrades > 0 ? (m.whaleWins / m.whaleTrades * 100).toFixed(1) : "0.0";
      const totalPnLR = m.whalePnLR;
      console.log(`• ${m.date}: PnL: ${totalPnLR.toFixed(1)}R | Whale PnL: ${m.whalePnLR.toFixed(1)}R (WR: ${wr}%, ${m.whaleTrades} lđ) | Số dư: $${m.balance.toFixed(2)}`);
    });
  }

  console.log("\n📊 --- THỐNG KÊ THEO EFFICIENCY (DYNAMIC RISK) ---");
  Object.entries(results.efficiencyStats).forEach(([eff, stats]: [string, any]) => {
     const wr = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : "0";
     console.log(`• ${eff}: ${stats.trades} trades | WR: ${wr}% | Total: ${stats.pnlR.toFixed(1)}R`);
  });

  console.log("--------------------------------------\n");

  // GỬI TELEGRAM SUMMARY
  let teleMsg = `📊 **KẾT QUẢ BACKTEST WHALE SWEEP ONLY**\n`;
  teleMsg += `📅 Từ: ${new Date(startDate).toLocaleDateString()} đến ${new Date(endDate).toLocaleDateString()}\n`;
  teleMsg += `💰 Số dư cuối: $${results.finalBalance.toFixed(2)}\n`;
  teleMsg += `📈 Tổng PnL: ${results.totalProfitR.toFixed(1)}R\n`;
  teleMsg += `⚡ Tổng lệnh: ${results.totalTrades} | Winrate: ${((results.wins / (results.totalTrades || 1)) * 100).toFixed(1)}%\n\n`;
  
  teleMsg += `**Thống kê Whale Sweep theo tháng:**\n`;
  if (results.monthlySnapshots && results.monthlySnapshots.length > 0) {
    results.monthlySnapshots.forEach((m: any) => {
      const wr = m.whaleTrades > 0 ? (m.whaleWins / m.whaleTrades * 100).toFixed(1) : "0";
      teleMsg += `• ${m.date}: ${m.whalePnLR.toFixed(1)}R | WR: ${wr}% (${m.whaleTrades} lệnh)\n`;
    });
  }

  teleMsg += `\n**Chi tiết theo Efficiency (Dynamic Risk):**\n`;
  Object.entries(results.efficiencyStats).forEach(([eff, stats]: [string, any]) => {
     const wr = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : "0";
     teleMsg += `• ${eff}: ${stats.trades} lệnh | WR: ${wr}% | ${stats.pnlR.toFixed(1)}R\n`;
  });

  await sendTelegramBacktest(teleMsg);

  console.log("\n🔍 ==================== CHẨN ĐOÁN LỖI BACKTEST (DIAGNOSTICS) ====================");
  console.log(`• Tổng số nến đã chạy: ${debugTotalCandles}`);
  console.log(`• Nến ngoài phiên giao dịch (Bị Bỏ qua): ${sessionSkippedCount} (${(sessionSkippedCount / (debugTotalCandles || 1) * 100).toFixed(1)}%)`);
  console.log(`• Nến trong phiên giao dịch (Được Quét): ${debugTotalCandles - sessionSkippedCount} (${((debugTotalCandles - sessionSkippedCount) / (debugTotalCandles || 1) * 100).toFixed(1)}%)`);
  console.log(`• Tổng Sweep thô phát hiện (Low/High): ${debugTotalSweepsDetected} (sweepLow: ${debugSweepLowCount}, sweepHigh: ${debugSweepHighCount})`);
  console.log(`• Thống kê điều kiện mượt & Vol lớn: displacementBullish: ${debugDisplacementBullishCount}, displacementBearish: ${debugDisplacementBearishCount}, volConfirm: ${debugVolConfirmCount}`);
  console.log(`• Tổng Sweep có lực bật mượt & Vol lớn (Long): ${debugTotalNewSweepsLong}`);
  console.log(`• Tổng Sweep có lực bật mượt & Vol lớn (Short): ${debugTotalNewSweepsShort}`);
  console.log(`• Tổng Sweep được thêm thành công vào Queue tính Winrate (Pending): ${debugPendingSweepsAdded}`);
  console.log(`\n📌 THỐNG KÊ CHI TIẾT ĐIỀU KIỆN LỆNH LONG (Dựa trên ${debugWhaleLongConditions.isNewSweepLongAtBar} nến tín hiệu thô):`);
  console.log(`  [1] Nằm trong phiên giao dịch:              ${debugWhaleLongConditions.isInSession} / ${debugWhaleLongConditions.isNewSweepLongAtBar}`);
  console.log(`  [2] Bật Whale Sweep:                        ${debugWhaleLongConditions.enableWhaleSweep} / ${debugWhaleLongConditions.isNewSweepLongAtBar}`);
  console.log(`  [3] Biên độ giá không quá xa (Not Overextend): ${debugWhaleLongConditions.notOverExtendedLong} / ${debugWhaleLongConditions.isNewSweepLongAtBar}`);
  console.log(`  [4] Giá hiện tại > VWMA 5m:                 ${debugWhaleLongConditions.currentPrice_gt_vwma5m} / ${debugWhaleLongConditions.isNewSweepLongAtBar}`);
  console.log(`  [5] Chỉ số ADX M1 >= Ngưỡng (${adxThreshold}):           ${debugWhaleLongConditions.adx_ge_threshold} / ${debugWhaleLongConditions.isNewSweepLongAtBar}`);
  console.log(`  [6] Đường dốc M1 có xu hướng đi lên (Slope):  ${debugWhaleLongConditions.slope_gt_0} / ${debugWhaleLongConditions.isNewSweepLongAtBar}`);
  
  console.log(`\n📌 THỐNG KÊ CHI TIẾT ĐIỀU KIỆN LỆNH SHORT (Dựa trên ${debugWhaleShortConditions.isNewSweepShortAtBar} nến tín hiệu thô):`);
  console.log(`  [1] Nằm trong phiên giao dịch:              ${debugWhaleShortConditions.isInSession} / ${debugWhaleShortConditions.isNewSweepShortAtBar}`);
  console.log(`  [2] Bật Whale Sweep:                        ${debugWhaleShortConditions.enableWhaleSweep} / ${debugWhaleShortConditions.isNewSweepShortAtBar}`);
  console.log(`  [3] Biên độ giá không quá xa (Not Overextend): ${debugWhaleShortConditions.notOverExtendedShort} / ${debugWhaleShortConditions.isNewSweepShortAtBar}`);
  console.log(`  [4] Giá hiện tại < VWMA 5m:                 ${debugWhaleShortConditions.currentPrice_lt_vwma5m} / ${debugWhaleShortConditions.isNewSweepShortAtBar}`);
  console.log(`  [5] Chỉ số ADX M1 >= Ngưỡng (${adxThreshold}):           ${debugWhaleShortConditions.adx_ge_threshold} / ${debugWhaleShortConditions.isNewSweepShortAtBar}`);
  console.log(`  [6] Đường dốc M1 (Slope > -0.02):           ${debugWhaleShortConditions.slope_gt_neg_0_02} / ${debugWhaleShortConditions.isNewSweepShortAtBar}`);
  console.log("===============================================================================\n");

    if (enableSessionFilter) {
      console.log(`[SESSION] Filtered out ${sessionSkippedCount} candles outside of 08:00 - 21:00 UTC.`);
    }
    
    // Trả về bản sao lưu kết quả để an toàn dereference biến global lưu kết quả
    return JSON.parse(JSON.stringify(results));
  } finally {
    allKlines = []; // Free large kline arrays from heap memory
    backtestDataCache = null; // Clear static memory cache of previous runs to free RAM immediately
    results = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      longTrades: 0,
      longWins: 0,
      shortTrades: 0,
      shortWins: 0,
      cancelledTrades: 0,
      totalPnL: 0,
      finalBalance: 5000,
      totalFees: 0,
      totalSlippage: 0,
      isLiquidated: false,
      liquidationDate: null,
      trades: [],
      startTime: "",
      endTime: "",
      displaceTrades: 0,
      displaceWins: 0,
      totalProfitR: 0,
      monthlySnapshots: [],
      efficiencyStats: {},
      regimeStats: {}
    };
    if (global && typeof (global as any).gc === 'function') {
      try {
        (global as any).gc();
      } catch (e) {}
    }
  }
}
