
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

const aiKey = getCleanEnv("GEMINI_API_KEY");
const ai = new GoogleGenAI({ apiKey: aiKey });
const modelName = "gemini-2.5-flash";

const PAIR = "BTC/USDT";
const TIMEFRAME = "15m";
const START_DATE = "2025-03-31T00:00:00Z";
const END_DATE = "2026-03-31T23:59:59Z";
const RR = 1.5; // Tỷ lệ Lợi nhuận/Rủi ro 1:1.5
const INITIAL_BALANCE = 2000;
const RISK_PER_TRADE = 0.01; // 1% rủi ro mỗi lệnh

interface BacktestResult {
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnL: number;
  finalBalance: number;
  trades: any[];
  startTime: string;
  endTime: string;
}

let results: BacktestResult = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
  totalPnL: 0,
  finalBalance: INITIAL_BALANCE,
  trades: [],
  startTime: START_DATE,
  endTime: END_DATE
};

// --- LOGIC FUNCTIONS (COPIED & ADAPTED FROM SERVER.TS) ---

function getLiquidityZones(bars: any[], type: 'high' | 'low') {
  const points = bars.slice(-60).map(b => type === 'high' ? b[2] : b[3]);
  const zones: { price: number, touches: number }[] = [];
  const avgPrice = points.reduce((a, b) => a + b, 0) / points.length;
  const threshold = avgPrice * 0.0005; 

  for (const p of points) {
    let found = false;
    for (const zone of zones) {
      if (Math.abs(zone.price - p) <= threshold) {
        zone.price = (zone.price * zone.touches + p) / (zone.touches + 1);
        zone.touches++;
        found = true;
        break;
      }
    }
    if (!found) zones.push({ price: p, touches: 1 });
  }
  return zones.filter(z => z.touches >= 2).sort((a, b) => b.touches - a.touches);
}

function detectSweep(bars: any[]) {
  if (bars.length < 25) return { sweepHigh: false, sweepLow: false };
  const highZones = getLiquidityZones(bars.slice(0, -1), 'high');
  const lowZones = getLiquidityZones(bars.slice(0, -1), 'low');
  const currentBar = bars[bars.length - 1];
  const [, o, h, l, c, v] = currentBar;
  
  const prevPeriod = bars.slice(-21, -1);
  const avgVol = prevPeriod.reduce((sum, b) => sum + b[5], 0) / prevPeriod.length;
  const isClimaxVol = v / avgVol >= 1.2; 
  
  const totalSize = h - l;
  if (totalSize === 0) return { sweepHigh: false, sweepLow: false };
  const lowerWickRatio = (Math.min(o, c) - l) / totalSize;
  const upperWickRatio = (h - Math.max(o, c)) / totalSize;

  for (const zone of lowZones) {
    if (isClimaxVol && l < zone.price && c > zone.price && lowerWickRatio >= 0.4) {
      return { sweepLow: true, sweepHigh: false, touches: zone.touches };
    }
  }
  
  for (const zone of highZones) {
    if (isClimaxVol && h > zone.price && c < zone.price && upperWickRatio >= 0.4) {
      return { sweepLow: false, sweepHigh: true, touches: zone.touches };
    }
  }
  return { sweepHigh: false, sweepLow: false };
}

function calcADX(ohlcv: any[]) {
  const period = 14;
  if (ohlcv.length < period * 2) return 0;
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
  for (let i = 0; i < str.length; i++) {
    const pDI = 100 * (sdmP[i] / str[i]), mDI = 100 * (sdmM[i] / str[i]);
    dx.push(100 * Math.abs(pDI - mDI) / (pDI + mDI || 1));
  }
  const adxList = smooth(dx);
  return adxList[adxList.length - 1];
}

async function getAIBacktestDecision(signal: string, lastPrice: number, bars: any[]) {
  // AI is disabled for backtest performance and stability
  return { decision: "CONFIRM", reason: "AI Check Disabled for Backtest" };
}

// --- MAIN RUNNER ---

export async function runBacktest(onProgress?: (p: number) => void) {
  console.log(`🚀 Bắt đầu Backtest ${PAIR} từ ${START_DATE} đến ${END_DATE}`);
  const exchange = new ccxt.binance({ options: { defaultType: 'future' } });
  
  let allKlines: any[] = [];
  let since = exchange.parse8601(START_DATE);
  const endTs = exchange.parse8601(END_DATE);

  while (since < endTs) {
    const klines = await exchange.fetchOHLCV(PAIR, TIMEFRAME, since, 1000);
    if (!klines.length) break;
    allKlines.push(...klines);
    since = klines[klines.length - 1][0] + 1;
    console.log(`Fetched ${allKlines.length} klines...`);
    if (onProgress) onProgress(Math.min(50, (allKlines.length / 3000) * 50));
  }

  allKlines = allKlines.filter(k => k[0] <= endTs);
  console.log(`✅ Đã tải ${allKlines.length} nến.`);

  results = { ...results, totalTrades: 0, wins: 0, losses: 0, totalPnL: 0, finalBalance: INITIAL_BALANCE, trades: [] };

  for (let i = 25; i < allKlines.length; i++) {
    if (onProgress) onProgress(50 + ((i / allKlines.length) * 50));
    
    const window = allKlines.slice(0, i + 1);
    const sweep = detectSweep(window);
    const adx = calcADX(window);

    if ((sweep.sweepLow || sweep.sweepHigh) && adx >= 20) {
      const type = sweep.sweepLow ? "LONG" : "SHORT";
      const entryPrice = allKlines[i][4];
      const time = new Date(allKlines[i][0]).toISOString();
      
      console.log(`🔍 Phát hiện tín hiệu ${type} tại ${time} ($${entryPrice}). (Bỏ qua AI Check)`);
      
      // Giả lập Trade: SL/TP logic
      const range = window.slice(-14).reduce((acc, b) => acc + (b[2] - b[3]), 0) / 14;
        const sl = type === "LONG" ? entryPrice - range : entryPrice + range;
        const tp = type === "LONG" ? entryPrice + range * RR : entryPrice - range * RR;
        
        // Tìm kết quả trong các nến tiếp theo
        let exitPrice = 0;
        let pnlR = 0;
        let status = "LOSS";
        
        for (let j = i + 1; j < Math.min(i + 50, allKlines.length); j++) {
          const [,, h, l] = allKlines[j];
          if (type === "LONG") {
            if (l <= sl) { exitPrice = sl; break; }
            if (h >= tp) { exitPrice = tp; status = "WIN"; break; }
          } else {
            if (h >= sl) { exitPrice = sl; break; }
            if (l <= tp) { exitPrice = tp; status = "WIN"; break; }
          }
        }

        if (exitPrice === 0) exitPrice = allKlines[Math.min(i + 49, allKlines.length - 1)][4];
        pnlR = status === "WIN" ? RR : -1.0; 
        
        const dollarPnL = results.finalBalance * RISK_PER_TRADE * pnlR;
        results.finalBalance += dollarPnL;

        results.totalTrades++;
        if (status === "WIN") results.wins++; else results.losses++;
        results.totalPnL += pnlR;
        results.trades.push({ 
          time, 
          type, 
          entryPrice, 
          exitPrice, 
          status, 
          pnlR, 
          dollarPnL, 
          currentBalance: results.finalBalance,
          reason: "TA Signal Only" 
        });
        
        console.log(`💰 Trade: ${status} | PnL: ${pnlR}R ($${dollarPnL.toFixed(2)}) | Balance: $${results.finalBalance.toFixed(2)}`);
    }
  }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log(`✅ Backtest hoàn tất. Kết quả lưu tại ${RESULTS_FILE}`);
  return results;
}
