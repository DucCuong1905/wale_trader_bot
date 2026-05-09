
import * as ccxt from "ccxt";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

// --- CONFIG ---
const DATA_DIR = path.join(process.cwd(), "data");
const RESULTS_FILE = path.join(DATA_DIR, "backtest_results.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

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
const ENABLE_SESSION_FILTER = false;
const SESSION_START_GMT = 8;
const SESSION_END_GMT = 21;

interface BacktestResult {
  totalTrades: number;
  wins: number;
  losses: number;
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
  extStrongTrades: number;
  extStrongWins: number;
  displaceTrades: number;
  displaceWins: number;
  totalProfitR: number;
}

let results: BacktestResult = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
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
  extStrongTrades: 0,
  extStrongWins: 0,
  displaceTrades: 0,
  displaceWins: 0,
  totalProfitR: 0
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

function detectSweep(bars: any[]) {
  if (bars.length < 20) return { 
    sweepHigh: false, 
    sweepLow: false, 
    displacementBullish: false, 
    displacementBearish: false, 
    extremelyStrongBullish: false,
    extremelyStrongBearish: false,
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

  const sweepLow = sL <= localLow && sC >= localLow;
  const sweepHigh = sH >= localHigh && sC <= localHigh;

  const body = Math.abs(cC - cO);
  const totalSize = cH - cL || 1;
  const bodySizes = bars.slice(-21, -1).map(b => Math.abs(b[4] - b[1]));
  const avgBody = bodySizes.reduce((a, b) => a + b, 0) / bodySizes.length;
  
  const displacementBullish = body > avgBody * 1.2 && (cC - cL) / totalSize > 0.7;
  const displacementBearish = body > avgBody * 1.2 && (cH - cC) / totalSize > 0.7;

  // EXTREMELY STRONG SWEEP (OR CONDITION)
  const sBody = Math.abs(sC - sO);
  const sRange = sH - sL || 1;
  const sVolRatio = sV / (bars.slice(-21, -2).reduce((a, b) => a + b[5], 0) / 19 || 1);

  const strongSweepCloseBull = sBody > avgBody * 1.5 && (sC - sL) / sRange > 0.75;
  const strongSweepCloseBear = sBody > avgBody * 1.5 && (sH - sC) / sRange > 0.75;
  const bullishBOSOnSweep = sC > localHigh;
  const bearishBOSOnSweep = sC < localLow;

  const extremelyStrongBullish = sweepLow && strongSweepCloseBull && bullishBOSOnSweep && sVolRatio >= 1.3;
  const extremelyStrongBearish = sweepHigh && strongSweepCloseBear && bearishBOSOnSweep && sVolRatio >= 1.3;

  const volumes = bars.slice(-21, -1).map(b => b[5]);
  const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const volConfirm = cV > avgVol;

  return {
    sweepLow,
    sweepHigh,
    displacementBullish,
    displacementBearish,
    extremelyStrongBullish,
    extremelyStrongBearish,
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
  timeframe: string = "15m",
  enableSessionFilter: boolean = false,
  vwmaPeriod: number = 20, // Thêm tham số vwmaPeriod
  onProgress?: (p: number) => void
) {
  shouldStopBacktest = false;
  console.log(`[BACKTEST] Start ${PAIR} from ${startDate} to ${endDate} (RR: ${rr}, TF: ${timeframe}, SessionFilter: ${enableSessionFilter}, VWMA: ${vwmaPeriod})`);
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
  let since = exchange.parse8601(startDate);
  const endTs = exchange.parse8601(endDate);

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

  allKlines = allKlines.filter(k => k[0] <= endTs);
  console.log(`[DATA] Loaded ${allKlines.length} klines.`);

  results = { 
    ...results, 
    totalTrades: 0, 
    wins: 0, 
    losses: 0, 
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
    extStrongTrades: 0,
    extStrongWins: 0,
    displaceTrades: 0,
    displaceWins: 0,
    totalProfitR: 0
  };

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

    const window = allKlines.slice(0, i + 1);
    const currentPrice = allKlines[i][4];
    
    // --- KHUNG 1M ---
    const vwma = calculateVWMA(window, vwmaPeriod);
    const vwmaPrev = calculateVWMA(window.slice(0, -1), vwmaPeriod);
    const slope = vwma - vwmaPrev;
    
    const adx = calcADX(window);
    const sweep = detectSweep(window);
    const atr = calculateATR(window, 14);

    const isInSession = isWithinSessions(allKlines[i][0]);

    const vwmaDistance = Math.abs(currentPrice - vwma);
    const maxDistance = atr * 1.2;

    const baseCandleConditions = adx.adx >= 10 && isInSession && vwmaDistance < maxDistance;
    
    let isLongExt = baseCandleConditions && currentPrice > vwma && slope > 0 && sweep.extremelyStrongBullish && adx.pDI > adx.mDI;
    let isLongStd = baseCandleConditions && currentPrice > vwma && slope > 0 && sweep.sweepLow && sweep.displacementBullish && sweep.volConfirm && adx.pDI > adx.mDI;
    
    let isShortExt = baseCandleConditions && currentPrice < vwma && slope < 0 && sweep.extremelyStrongBearish && adx.mDI > adx.pDI;
    let isShortStd = baseCandleConditions && currentPrice < vwma && slope < 0 && sweep.sweepHigh && sweep.displacementBearish && sweep.volConfirm && adx.mDI > adx.pDI;

    const isLong = isLongExt || isLongStd;
    const isShort = isShortExt || isShortStd;
    const entryType = (isLongExt || isShortExt) ? "ExtremelyStrong" : "Standard";

    if (isLong || isShort) {
      const type = isLong ? "LONG" : "SHORT";
      const entryPrice = currentPrice; // Market Entry at Close
      
      const time = new Date(allKlines[i][0]).toISOString();
      const sl = type === "LONG" ? (sweep.low - atr * 0.2) : (sweep.high + atr * 0.2);
      const tp = entryPrice + (entryPrice - sl > 0 ? (entryPrice - sl) * rr : (sl - entryPrice) * -rr);

      console.log(`[SIGNAL] ${type} (${entryType}) Market Entry at ${time} ($${entryPrice.toFixed(2)})`);
      
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
      
      const dollarPnL = results.finalBalance * RISK_PER_TRADE * pnlR;
      
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

      results.totalTrades++;
      if (status === "WIN") {
        results.wins++;
        if (entryType === "ExtremelyStrong") results.extStrongWins++; else results.displaceWins++;
      } else {
        results.losses++;
      }
      
      if (entryType === "ExtremelyStrong") results.extStrongTrades++; else results.displaceTrades++;
      
      results.totalPnL += pnlR;
      results.totalProfitR += pnlR;

      results.trades.push({ 
        time, 
        type, 
        entryType,
        entryPrice, 
        exitPrice, 
        status, 
        pnlR, 
        dollarPnL, 
        estimatedFee,
        estimatedSlippage,
        currentBalance: results.finalBalance,
        reason: `TA ${entryType} Entry`
      });
      
      console.log(`[TRADE] ${status} | Type: ${entryType} | PnL: ${pnlR}R ($${dollarPnL.toFixed(2)}) | Balance: $${results.finalBalance.toFixed(2)}`);
      
      // Nhảy vòng lặp đến điểm nến hiện tại
    }
  }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log(`[DONE] Backtest complete. Results: ${RESULTS_FILE}`);
  if (enableSessionFilter) {
    console.log(`[SESSION] Filtered out ${sessionSkippedCount} candles outside of 08:00 - 21:00 UTC.`);
  }
  return results;
}
