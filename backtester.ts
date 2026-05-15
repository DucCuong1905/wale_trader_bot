
import * as ccxt from "ccxt";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { calculateMarketRegime, Candle } from "./regime.ts";

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

function getCleanEnv(key: string) {
  const val = process.env[key];
  if (!val) return "";
  return val.trim().replace(/^["']|["']$/g, "").trim();
}

const aiString = getCleanEnv("GEMINI_API_KEY");
const ai = new GoogleGenAI({ apiKey: aiString });
const modelName = "gemini-2.0-flash";

const PAIR = "BTC/USDT";
const START_DATE = "2026-01-01T00:00:00Z"; 
const END_DATE = "2026-04-01T00:00:00Z";
const RR = 1.0; 
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
  regimeStats: {
    "TREND_EXPANSION": { trades: 0, wins: 0, pnlR: 0 },
    "NEUTRAL": { trades: 0, wins: 0, pnlR: 0 },
    "COMPRESSION": { trades: 0, wins: 0, pnlR: 0 },
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

function detectSweep(bars: any[]) {
  if (bars.length < 20) return { 
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
  
  const sweepCandle = bars[bars.length - 2];
  const confirmCandle = bars[bars.length - 1];

  const [, sO, sH, sL, sC, sV] = sweepCandle;
  const [, cO, cH, cL, cC, cV] = confirmCandle;

  const prevBars = bars.slice(bars.length - 7, bars.length - 2);
  const localLow = Math.min(...prevBars.map(b => b[3]));
  const localHigh = Math.max(...prevBars.map(b => b[2]));

  const sweepSize = sH - sL || 1;
  const lowerWick = Math.min(sO, sC) - sL;
  const upperWick = sH - Math.max(sO, sC);

  const sweepLow = sL <= localLow && sC >= localLow && (lowerWick / sweepSize >= 0.25);
  const sweepHigh = sH >= localHigh && sC <= localHigh && (upperWick / sweepSize >= 0.25);

  const body = Math.abs(cC - cO);
  const totalSize = cH - cL || 1;
  const bodySizes = bars.slice(-21, -1).map(b => Math.abs(b[4] - b[1]));
  const avgBody = bodySizes.reduce((a, b) => a + b, 0) / bodySizes.length;
  
  const displacementBullish = body > avgBody * 1.5 && (cC - cL) / totalSize > 0.7 && cC > sH;
  const displacementBearish = body > avgBody * 1.5 && (cH - cC) / totalSize > 0.7 && cC < sL;

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
  const period = 14;
  if (ohlcv.length < period * 2) return { adx: 0, pDI: 0, mDI: 0 };
  let tr: number[] = [], plusDM: number[] = [], minusDM: number[] = [];

  for (let i = 1; i < ohlcv.length; i++) {
    const [ts, o, h, l, c] = ohlcv[i], prevC = ohlcv[i-1][4], prevH = ohlcv[i-1][2], prevL = ohlcv[i-1][3];
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

// --- MAIN RUNNER ---

let shouldStopBacktest = false;

export function stopBacktestExecution() {
  shouldStopBacktest = true;
}

export async function runBacktest(
  startDate: string = START_DATE,
  endDate: string = END_DATE,
  rr: number = RR,
  timeframe: string = "1m",
  enableSessionFilter: boolean = false,
  vwmaPeriod: number = 20, // Thêm tham số vwmaPeriod
  onProgress?: (p: number) => void,
  adxThreshold: number = 10 // Thêm tham số adxThreshold
) {
  shouldStopBacktest = false;
  console.log(`[BACKTEST] Start ${PAIR} from ${startDate} to ${endDate} (RR: ${rr}, TF: ${timeframe}, SessionFilter: ${enableSessionFilter}, VWMA: ${vwmaPeriod}, ADX: ${adxThreshold})`);
  const exchange = new ccxt.binance({ 
    timeout: 30000,
    options: { defaultType: 'future' } 
  });

  async function fetchOHLCVWithRetry(ex: ccxt.Exchange, symbol: string, tf: string, sinceVal: number, limit: number, retries: number = 3) {
    for (let i = 0; i < retries; i++) {
      if (shouldStopBacktest) return [];
      try {
        return await ex.fetchOHLCV(symbol, tf, sinceVal, limit);
      } catch (e: any) {
        if (i === retries - 1) throw e;
        const delay = Math.pow(2, i) * 2000;
        console.warn(`[CCXT BACKTEST] Fetch failed (attempt ${i + 1}/${retries}). Retrying in ${delay}ms... Error: ${e.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    return [];
  }
  
  let allKlines: any[] = [];
  const startTs = exchange.parse8601(startDate);
  const endTs = exchange.parse8601(endDate);

  // KIỂM TRA PHẠM VI ĐẶC BIỆT (Tháng 1 -> Tháng 5 năm 2026) ĐỂ CACHE VĨNH VIỄN
  const isSpecialRange = (startDate.startsWith("2026-01-01") && endDate.startsWith("2026-05-01"));
  const is2224Range = (startDate.startsWith("2022-01-01") && endDate.startsWith("2024-01-01"));
  const is2426Range = (startDate.startsWith("2024-01-01") && endDate.startsWith("2026-01-01"));
  const is2022Range = (startDate.startsWith("2020-01-01") && endDate.startsWith("2022-01-01"));

  if (isSpecialRange && fs.existsSync(SPECIAL_CACHE_FILE)) {
    try {
      console.log(`[BACKTEST] 💠 PHÁT HIỆN KHUNG GIỜ VÀNG (2026-01-01 -> 2026-05-01)`);
      console.log(`[BACKTEST] 💾 Đang đọc dữ liệu CACHE VĨNH VIỄN từ ổ đĩa...`);
      const rawData = fs.readFileSync(SPECIAL_CACHE_FILE, "utf-8");
      allKlines = JSON.parse(rawData);
      console.log(`[BACKTEST] ✅ Đã tải ${allKlines.length} nến từ file cache.`);
    } catch (e) {
      console.error("[BACKTEST] ❌ Lỗi khi đọc cache vĩnh viễn, sẽ fetch lại:", e);
    }
  } else if (is2022Range && fs.existsSync(CACHE_20_22_FILE)) {
    try {
      console.log(`[BACKTEST] 💠 PHÁT HIỆN KHUNG GIỜ 2020-2022`);
      console.log(`[BACKTEST] 💾 Đang đọc dữ liệu CACHE 2020-2022 từ ổ đĩa...`);
      const rawData = fs.readFileSync(CACHE_20_22_FILE, "utf-8");
      allKlines = JSON.parse(rawData);
      console.log(`[BACKTEST] ✅ Đã tải ${allKlines.length} nến từ file cache.`);
    } catch (e) {
      console.error("[BACKTEST] ❌ Lỗi khi đọc cache 20-22, sẽ fetch lại:", e);
    }
  } else if (is2224Range && fs.existsSync(CACHE_22_24_FILE)) {
    try {
      console.log(`[BACKTEST] 💠 PHÁT HIỆN KHUNG GIỜ 2022-2024`);
      console.log(`[BACKTEST] 💾 Đang đọc dữ liệu CACHE 2022-2024 từ ổ đĩa...`);
      const rawData = fs.readFileSync(CACHE_22_24_FILE, "utf-8");
      allKlines = JSON.parse(rawData);
      console.log(`[BACKTEST] ✅ Đã tải ${allKlines.length} nến từ file cache.`);
    } catch (e) {
      console.error("[BACKTEST] ❌ Lỗi khi đọc cache 22-24, sẽ fetch lại:", e);
    }
  } else if (is2426Range && fs.existsSync(CACHE_24_26_FILE)) {
    try {
      console.log(`[BACKTEST] 💠 PHÁT HIỆN KHUNG GIỜ 2024-2026`);
      console.log(`[BACKTEST] 💾 Đang đọc dữ liệu CACHE 2024-2026 từ ổ đĩa...`);
      const rawData = fs.readFileSync(CACHE_24_26_FILE, "utf-8");
      allKlines = JSON.parse(rawData);
      console.log(`[BACKTEST] ✅ Đã tải ${allKlines.length} nến từ file cache.`);
    } catch (e) {
      console.error("[BACKTEST] ❌ Lỗi khi đọc cache 24-26, sẽ fetch lại:", e);
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
      console.log(`[BACKTEST] 🌐 Fetching dữ liệu mới từ sàn...`);
      let since = startTs;
      while (since < endTs) {
        if (shouldStopBacktest) break;
        try {
          const klines = await fetchOHLCVWithRetry(exchange, PAIR, timeframe, since, 1000);
          if (!klines.length) break;
          allKlines.push(...klines);
          since = klines[klines.length - 1][0] + 1;
          console.log(`Fetched ${allKlines.length} klines...`);
          if (onProgress) onProgress(Math.min(50, (allKlines.length / 3000) * 50));
        } catch (err: any) {
          console.error("❌ Lỗi nghiêm trọng khi tải dữ liệu backtest:", err.message);
          throw new Error(`Không thể kết nối với sàn Binance để tải dữ liệu: ${err.message}`);
        }
      }
      
      // Lưu vào Cache bộ nhớ
      if (!shouldStopBacktest && allKlines.length > 0) {
        backtestDataCache = {
          pair: PAIR,
          timeframe,
          start: startDate,
          end: endDate,
          data: allKlines
        };
        console.log(`[BACKTEST] ✅ Đã lưu dữ liệu vào Cache bộ nhớ (${allKlines.length} nến)`);

        // NẾU LÀ KHUNG ĐẶC BIỆT THÌ LƯU VÀO FILE
        if (isSpecialRange) {
          try {
            console.log(`[BACKTEST] 💾 Đang lưu dữ liệu CACHE VĨNH VIỄN vào ổ đĩa...`);
            fs.writeFileSync(SPECIAL_CACHE_FILE, JSON.stringify(allKlines));
            console.log(`[BACKTEST] ✅ Hoàn tất lưu cache vĩnh viễn.`);
          } catch (e) {
            console.error("[BACKTEST] ❌ Lỗi khi ghi cache vĩnh viễn:", e);
          }
        } else if (is2224Range) {
          try {
            console.log(`[BACKTEST] 💾 Đang lưu dữ liệu CACHE 2022-2024 vào ổ đĩa...`);
            fs.writeFileSync(CACHE_22_24_FILE, JSON.stringify(allKlines));
            console.log(`[BACKTEST] ✅ Hoàn tất lưu cache 2022-2024.`);
          } catch (e) {
            console.error("[BACKTEST] ❌ Lỗi khi ghi cache 2022-2024:", e);
          }
        } else if (is2426Range) {
          try {
            console.log(`[BACKTEST] 💾 Đang lưu dữ liệu CACHE 2024-2026 vào ổ đĩa...`);
            fs.writeFileSync(CACHE_24_26_FILE, JSON.stringify(allKlines));
            console.log(`[BACKTEST] ✅ Hoàn tất lưu cache 2024-2026.`);
          } catch (e) {
            console.error("[BACKTEST] ❌ Lỗi khi ghi cache 2024-2026:", e);
          }
        } else if (is2022Range) {
          try {
            console.log(`[BACKTEST] 💾 Đang lưu dữ liệu CACHE 2020-2022 vào ổ đĩa...`);
            fs.writeFileSync(CACHE_20_22_FILE, JSON.stringify(allKlines));
            console.log(`[BACKTEST] ✅ Hoàn tất lưu cache 2020-2022.`);
          } catch (e) {
            console.error("[BACKTEST] ❌ Lỗi khi ghi cache 2020-2022:", e);
          }
        }
      }
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
    regimeStats: {
      "TREND_EXPANSION": { trades: 0, wins: 0, pnlR: 0 },
      "NEUTRAL": { trades: 0, wins: 0, pnlR: 0 },
      "COMPRESSION": { trades: 0, wins: 0, pnlR: 0 },
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
  let monthlySnapshots: any[] = [];
  
  // Tracking for NEW Continuation strategy
  let continuationTrades = 0;
  let continuationWins = 0;
  let continuationPnLR = 0;

  let sessionSkippedCount = 0;
  const isWithinSessions = (ts: number) => {
    if (!enableSessionFilter) return true;
    const date = new Date(ts);
    const hour = date.getUTCHours();
    const result = hour >= SESSION_START_GMT && hour < SESSION_END_GMT;
    if (!result) sessionSkippedCount++;
    return result;
  };

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

    // --- KHUNG 5P FILTER ---
    const calcWindow5mRaw = allKlines.slice(Math.max(0, i - 1500), i + 1);
    const bars5m = aggregateCandles(calcWindow5mRaw, 5);
    const vwma5m = calculateVWMA(bars5m, 20);

    // --- MARKET REGIME FILTER (Optimize: Only calculate every 15 mins) ---
    const shouldUpdateRegime = i % 15 === 0 || !results.marketRegime;
    if (shouldUpdateRegime) {
      const calcWindowDailyRaw = allKlines.slice(Math.max(0, i - 1440 * 100), i + 1);
      const bars1d = aggregateCandles(calcWindowDailyRaw, 1440);
      
      const toCandle = (b: any): Candle => ({
        open: b[1],
        high: b[2],
        low: b[3],
        close: b[4],
        volume: b[5]
      });

      const m5CandlesBacktest = bars5m.map(toCandle);
      const m1Candles = allKlines.slice(Math.max(0, i - 100), i + 1).map(toCandle);
      results.marketRegime = calculateMarketRegime(m5CandlesBacktest, m1Candles);
    }
    const regimeData = results.marketRegime!;

    // --- KHUNG 1P (ENTRIES) ---
    const currentPrice = allKlines[i][4];
    const calcWindow = allKlines.slice(Math.max(0, i - 100), i + 1);
    const vwapM1 = calculateVWAP(calcWindow);
    const vwmaM1 = calculateVWMA(calcWindow, 20); // VWMA 20 M1
    const vwmaM1Prev = calculateVWMA(allKlines.slice(Math.max(0, i - 101), i), 20);
    const slopeM1 = vwmaM1 - vwmaM1Prev;
    const adxM1 = calcADX(calcWindow);
    const sweep = detectSweep(calcWindow);
    const atrM1 = calculateATR(calcWindow, 14);
    const isInSession = isWithinSessions(allKlines[i][0]);

    const distFromVWMA = Math.abs(currentPrice - vwmaM1);
    
    const isOverExtendedLong = distFromVWMA > (atrM1 * 2);
    const isOverExtendedShort = distFromVWMA > (atrM1 * 2);

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
        shortWins: monthlyShortWins
      });

      monthlyWins = 0; monthlyLosses = 0; monthlyLongTrades = 0; monthlyLongWins = 0;
      monthlyShortTrades = 0; monthlyShortWins = 0; monthlyPnL = 0; monthlyProfitR = 0;
    }
    lastMonth = currentMonth;
    lastYear = currentYear;

    // --- MINI COMPRESSION & CONTINUATION LOGIC ---
    const recent5 = allKlines.slice(Math.max(0, i - 5), i);
    const recentHigh = Math.max(...recent5.map(b => b[2]));
    const recentLow = Math.min(...recent5.map(b => b[3]));
    const compRange = recentHigh - recentLow;
    
    const volMA = allKlines.slice(Math.max(0, i - 20), i).reduce((s, b) => s + b[5], 0) / 20;
    const bodySize = Math.abs(allKlines[i][4] - allKlines[i][1]);
    const prevHigh = allKlines[i-1][2];
    const prevLow = allKlines[i-1][3];

    // LONG CONTINUATION V2
    const adxRisingLong = adxM1.adx > (allKlines[i-1] ? /* logic for prev adx would be complex here, using simple threshold for now */ adxM1.adx : 20); 
    // Note: I will use a slightly higher ADX threshold and stricter volume instead of a complex lookback here for efficiency
    
    const isContinuationLong = 
      regimeData.totalScore >= 70 &&   // Cần trend rõ ràng hơn (65 -> 70)
      currentPrice > vwma5m &&
      currentPrice > vwapM1 &&
      slopeM1 > 0 &&
      adxM1.adx >= 25 &&              // Tăng ADX tối thiểu lên 25
      adxM1.pDI > adxM1.mDI &&
      distFromVWMA < (atrM1 * 1.5) && // Chặt chẽ hơn về khoảng cách (1.7 -> 1.5)
      compRange < (atrM1 * 1.0) &&    // Nén cực chặt (1.3 -> 1.0)
      recentLow > vwma5m &&           
      currentPrice > recentHigh &&    
      bodySize > (atrM1 * 0.7) &&     // Nến breakout mạnh mẽ hơn (0.5 -> 0.7)
      allKlines[i][5] > volMA * 1.2 && // Volume bùng nổ rõ rệt (0.95 -> 1.2)
      currentPrice > prevHigh;

    // SHORT CONTINUATION V2
    const isContinuationShort = 
      regimeData.totalScore >= 70 &&
      currentPrice < vwma5m &&
      currentPrice < vwapM1 &&
      slopeM1 < 0 &&
      adxM1.adx >= 25 &&
      adxM1.mDI > adxM1.pDI &&
      distFromVWMA < (atrM1 * 1.5) &&
      compRange < (atrM1 * 1.0) &&
      recentHigh < vwma5m &&
      currentPrice < recentLow &&
      bodySize > (atrM1 * 0.7) &&
      allKlines[i][5] > volMA * 1.2 &&
      currentPrice < prevLow;

    // --- ENTRY DECISION (SWEP OR CONTINUATION) ---
    let isLong = (regimeData.riskPercent > 0) && isInSession && (
      (!isOverExtendedLong && currentPrice > vwma5m && currentPrice > vwapM1 && adxM1.adx >= adxThreshold && slopeM1 > 0 && sweep.sweepLow && sweep.displacementBullish && sweep.volConfirm && adxM1.pDI > adxM1.mDI) ||
      isContinuationLong
    );

    let isShort = (regimeData.riskPercent > 0) && isInSession && (
      (!isOverExtendedShort && currentPrice < vwma5m && currentPrice < vwapM1 && adxM1.adx >= adxThreshold && slopeM1 < 0 && sweep.sweepHigh && sweep.displacementBearish && sweep.volConfirm && adxM1.mDI > adxM1.pDI) ||
      isContinuationShort
    );

    if (isLong || isShort) {
      const type = isLong ? "LONG" : "SHORT";
      const isContTrade = (type === "LONG" ? isContinuationLong : isContinuationShort);
      const entryPrice = currentPrice; 
      
      const time = new Date(allKlines[i][0]).toISOString();
      // Nếu là lệnh Continuation, ta dùng ATR để đặt SL thay vì dùng nến Sweep (vì Sweep có thể ko tồn tại)
      let sl = type === "LONG" ? (sweep.low || (currentPrice - atrM1 * 2)) : (sweep.high || (currentPrice + atrM1 * 2));
      
      // Fine-tune SL cho Continuation: Nếu SL Sweep quá xa hoặc ko có, dùng 1.5 ATR
      if (isContinuationLong || isContinuationShort) {
         sl = type === "LONG" ? (currentPrice - atrM1 * 1.5) : (currentPrice + atrM1 * 1.5);
      } else {
         // Lệnh Sweep vẫn dùng SL cũ
         sl = type === "LONG" ? (sweep.low - atrM1 * 0.2) : (sweep.high + atrM1 * 0.2);
      }
      const tp = entryPrice + (entryPrice - sl > 0 ? (entryPrice - sl) * rr : (sl - entryPrice) * -rr);

      const riskPercentForTrade = RISK_PER_TRADE * regimeData.riskPercent;

      console.log(`[SIGNAL] ${type} Market Entry at ${time} ($${entryPrice.toFixed(2)}) | Regime: ${regimeData.regime} (Risk: ${regimeData.riskPercent}x)`);
      
      // Tìm kết quả trong các nến tiếp theo
      let exitPrice = 0;
      let pnlR = 0;
      let status = "LOSS";
      
      for (let j = i + 1; j < Math.min(i + 100, allKlines.length); j++) {
        const [,, h, l, c] = allKlines[j];
        if (type === "LONG") {
          if (l <= sl) { exitPrice = sl; break; }
          if (h >= tp) { exitPrice = tp; status = "WIN"; break; }
        } else {
          if (h >= sl) { exitPrice = sl; break; }
          if (l <= tp) { exitPrice = tp; status = "WIN"; break; }
        }
      }

      if (exitPrice === 0) exitPrice = allKlines[Math.min(i + 99, allKlines.length - 1)][4];
      pnlR = status === "WIN" ? rr : -1.0; 
      
      const dollarPnL = results.finalBalance * riskPercentForTrade * pnlR;
      
      // Tính phí và trượt giá dự kiến (Để thống kê, ko trừ túi)
      const feeRate = 0.0005; // 0.05% taker
      const slippageRate = 0.0002; // 0.02% slippage
      
      const riskAmount = results.finalBalance * RISK_PER_TRADE;
      const stopLossDistPct = Math.abs(entryPrice - sl) / entryPrice;
      const positionNotional = stopLossDistPct > 0 ? riskAmount / stopLossDistPct : 0;
      
      const estimatedFee = positionNotional * feeRate * 2; 
      const estimatedSlippage = positionNotional * slippageRate * 2;
      
      results.totalFees += estimatedFee;
      results.totalSlippage += estimatedSlippage;
      results.finalBalance += dollarPnL; 
      monthlyPnL += dollarPnL;
      monthlyProfitR += (pnlR * regimeData.riskPercent);

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
    const effectiveR = pnlR * regimeData.riskPercent;
    results.totalProfitR += effectiveR;
    
    // Track Continuation stats
    if (isContTrade) {
      continuationTrades++;
      continuationPnLR += effectiveR;
      if (status === "WIN") {
        continuationWins++;
      }
    }

    // Track regime stats
    if (results.regimeStats[regimeData.regime]) {
      results.regimeStats[regimeData.regime].trades++;
      results.regimeStats[regimeData.regime].pnlR += effectiveR;
      if (status === "WIN") {
        results.regimeStats[regimeData.regime].wins++;
      }
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
      regime: regimeData.regime
    });
    
    console.log(`[TRADE] ${status} | PnL: ${pnlR}R (Eff: ${effectiveR.toFixed(1)}R) | $${dollarPnL.toFixed(2)} | Balance: $${results.finalBalance.toFixed(2)}`);
      
      // Nhảy vòng lặp đến điểm nến hiện tại
    }
  }

  results.monthlySnapshots = monthlySnapshots;
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log(`[DONE] Backtest complete. Results: ${RESULTS_FILE}`);

  console.log("\n📈 --- THỐNG KÊ CHI TIẾT THEO REGIME ---");
  Object.entries(results.regimeStats).forEach(([regime, stats]: [string, any]) => {
    const wr = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : "0";
    console.log(`• ${regime}: ${stats.trades} trades | WR: ${wr}% | PnL: ${stats.pnlR.toFixed(1)}R`);
  });

  if (continuationTrades > 0) {
    const contWR = ((continuationWins / continuationTrades) * 100).toFixed(1);
    console.log(`\n🚀 --- THỐNG KÊ CHIẾN LƯỢC CONTINUATION (PULLBACK/BREAKOUT) ---`);
    console.log(`• Số lệnh: ${continuationTrades} | Winrate: ${contWR}% | PnL: ${continuationPnLR.toFixed(1)}R`);
  }
  console.log("--------------------------------------\n");

  if (enableSessionFilter) {
    console.log(`[SESSION] Filtered out ${sessionSkippedCount} candles outside of 08:00 - 21:00 UTC.`);
  }
  return results;
}
