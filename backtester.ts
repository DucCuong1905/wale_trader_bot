import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

let isRunning = false;

export function stopBacktestExecution() {
  isRunning = false;
}

export function tryLoadFromXauCsv(startDate: string, endDate: string, timeframe: string) {
  let dataDir = path.join(process.cwd(), 'data');
  const customWindowsDir = 'C:\\xau_data';
  
  // Kiểm tra nếu người dùng đang có ổ C:\xau_data
  if (fs.existsSync(customWindowsDir)) {
      dataDir = customWindowsDir;
  }
  
  if (!fs.existsSync(dataDir)) return [];
  
  const files = fs.readdirSync(dataDir);
  const csvFiles = files.filter(f => f.endsWith('.csv'));
  const jsonFile = files.find(f => f.endsWith('.json') && f.includes('1m'));

  let klines: any[] = [];
  if (jsonFile && csvFiles.length === 0) {
     try {
       const text = fs.readFileSync(path.join(dataDir, jsonFile), 'utf8');
       klines = JSON.parse(text);
     } catch (e) {
       console.error("Error reading JSON data:", e);
     }
  } else if (csvFiles.length > 0) {
     try {
       // Merge tất cả các file CSV trong thư mục lại
       for (const csvFile of csvFiles) {
         const text = fs.readFileSync(path.join(dataDir, csvFile), 'utf8');
         const lines = text.split('\n');
         
         // Bỏ qua dòng tiêu đề
         for (let i = 1; i < lines.length; i++) {
           const l = lines[i].trim();
           if (!l) continue;
           const parts = l.split(',');
           
           if (parts.length >= 6) {
             let ts = 0;
             let timeStr = "";
             let oIdx = 1, hIdx = 2, lIdx = 3, cIdx = 4, vIdx = 5;

             // Phát hiện xem có cột Time riêng biệt không (VD: Date, Time, Open...)
             if (parts[1].includes(':')) {
                 timeStr = `${parts[0].replace(/\./g, '-')}T${parts[1]}`;
                 if (timeStr.length === 16) timeStr += ':00'; // Đảm bảo có giây
                 timeStr += 'Z'; // Assume UTC for consistency
                 
                 oIdx = 2; hIdx = 3; lIdx = 4; cIdx = 5; vIdx = 6;
             } else {
                 timeStr = parts[0].replace(/\./g, '-');
             }
             
             if (!isNaN(Number(parts[0]))) ts = Number(parts[0]);
             else ts = new Date(timeStr).getTime();
             
             if (!isNaN(ts)) {
                 klines.push([
                   ts, 
                   parseFloat(parts[oIdx]), parseFloat(parts[hIdx]), 
                   parseFloat(parts[lIdx]), parseFloat(parts[cIdx]), 
                   parseFloat(parts[vIdx])
                 ]);
             }
           }
         }
       }
       klines.sort((a,b) => a[0] - b[0]);
     } catch(e) {
       console.error("Error reading CSV data:", e);
     }
  }
  return klines;
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

function calculateVWMA(bars: any[], period: number) {
  if (bars.length < period) return bars[bars.length - 1][4];
  let pv = 0, v = 0;
  for (let i = bars.length - period; i < bars.length; i++) { pv += bars[i][4] * bars[i][5]; v += bars[i][5]; }
  return v === 0 ? bars[bars.length - 1][4] : pv / v;
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

function detectWhaleSweep(bars: any[]) {
  if (bars.length < 16) return { sweepLow: false, sweepHigh: false };
  
  const sweepCandle = bars[bars.length - 2]; 
  const confirmCandle = bars[bars.length - 1]; 

  const [, sO, sH, sL, sC, sV] = sweepCandle;
  const [, cO, cH, cL, cC, cV] = confirmCandle;

  const prevBars = bars.slice(bars.length - 16, bars.length - 2);
  const localLow = Math.min(...prevBars.map(b => b[3]));
  const localHigh = Math.max(...prevBars.map(b => b[2]));

  const sweepSize = sH - sL || 1;
  const lowerWick = Math.min(sO, sC) - sL;
  const upperWick = sH - Math.max(sO, sC);

  const volumes = bars.slice(-15, -1).map(b => b[5]);
  const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;

  const WICK_RATIO = (global as any).CONFIG_WICK_RATIO_VAL ?? 0.25;
  const sweepLow = sL <= localLow && sC >= localLow && (lowerWick / sweepSize >= WICK_RATIO);
  const sweepHigh = sH >= localHigh && sC <= localHigh && (upperWick / sweepSize >= WICK_RATIO);

  const body = Math.abs(cC - cO);
  const totalSize = cH - cL || 1;
  const bodySizes = bars.slice(-15, -1).map(b => Math.abs(b[4] - b[1]));
  const avgBody = bodySizes.reduce((a, b) => a + b, 0) / bodySizes.length;
  
  const BODY_RATIO = (global as any).CONFIG_BODY_RATIO_VAL ?? 0.60;
  const CLOSE_RATIO = (global as any).CONFIG_CLOSE_RATIO_VAL ?? 0.45;
  
  const displacementBullish = body > avgBody * BODY_RATIO && (cC - cL) / totalSize > CLOSE_RATIO && cC > Math.max(sO, sC);
  const displacementBearish = body > avgBody * BODY_RATIO && (cH - cC) / totalSize > CLOSE_RATIO && cC < Math.min(sO, sC);

  const isConstantVol = volumes.length > 0 && volumes.every(v => v === volumes[0]);
  const VOL_RATIO = (global as any).CONFIG_VOL_RATIO_VAL ?? 0.9;
  const volConfirm = isConstantVol ? true : cV > avgVol * VOL_RATIO;

  return { sweepLow, sweepHigh, displacementBullish, displacementBearish, volConfirm, low: sL, high: sH, confirmOpen: cO, confirmClose: cC, sweepOpen: sO };
}

export async function runBacktest(
  startDate: string,
  endDate: string,
  rr: number,
  timeframe: string,
  enableSessionFilter: boolean,
  vwmaPeriod: number,
  onProgress: (progress: number) => void,
  adxThreshold: number,
  verbose: boolean = false
) {
  isRunning = true;
  
  const data = (global as any).OPTIMIZE_DATA || tryLoadFromXauCsv(startDate, endDate, timeframe);
  if (!data || data.length === 0) {
    throw new Error('No data found for backtesting. Please upload data/xauusd.csv');
  }

  const startTs = new Date(startDate).getTime();
  const endTs = new Date(endDate).getTime();

  let balance = 5000;
  let totalProfitR = 0;
  let totalTrades = 0;
  let wins = 0;
  
  let maxConsecutiveLosses = 0;
  let currentConsecutiveLosses = 0;
  
  let peakBalance = 5000;
  let maxDrawdownPercent = 0;
  let maxDrawdownValue = 0;
  
  let paperPosition: any = null;
  const monthlyStats = new Map<string, { trades: number, wins: number, profitR: number }>();

  for (let i = 50; i < data.length; i++) {
    if (!isRunning) break;
    
    // progress report
    if (i % 10000 === 0) {
      const p = Math.floor((i / data.length) * 100);
      onProgress(p);
    }
    
    // Nến vừa đóng hoàn toàn (đóng vai trò là nến -1 ở hiện tại)
    const slice = data.slice(i-50, i);
    const lastClosed = slice[slice.length - 1]; // chính là data[i-1]
    const cTs = lastClosed[0];
    
    // Nến đang chạy
    const currCandle = data[i];
    const [, cO, cH, cL, cC, cV] = currCandle;
    
    if (cTs < startTs || cTs > endTs) continue;

    // Quản lý Position (Exit check)
    if (paperPosition) {
       let closed = false;
       let status: "WIN" | "LOSS" = "LOSS";
       let profitR = 0;
       
       const { type, entry, sl, reachedTp1, tp1, tp2, tp2R, risk, riskUsd } = paperPosition;
       
       if (type === "LONG") {
         if (!reachedTp1) {
           const hitSl = cL <= sl;
           const hitTp1 = cH >= tp1;
           
           if (hitSl && hitTp1) {
             // Thận trọng: coi như dính SL trước
             closed = true;
             status = "LOSS";
             profitR = -1;
           } else if (hitSl) {
             closed = true;
             status = "LOSS";
             profitR = -1;
           } else if (hitTp1) {
             paperPosition.reachedTp1 = true;
             // Đạt TP1: Chốt 50% ở 1.2R, dời SL về BE (entry)
             const hitBe = cL <= entry;
             const hitTp2 = cH >= tp2;
             
             if (hitBe && hitTp2) {
               closed = true;
               status = "WIN";
               profitR = 0.5 * 1.2; // nửa thứ 2 chạm BE (0R)
             } else if (hitBe) {
               closed = true;
               status = "WIN";
               profitR = 0.5 * 1.2;
             } else if (hitTp2) {
               closed = true;
               status = "WIN";
               profitR = 0.5 * 1.2 + 0.5 * tp2R; // = 1.6R (nếu tp2R = 2)
             }
           }
         } else {
           // Đã đạt TP1 tự trước đó, SL dời về BE
           const hitBe = cL <= entry;
           const hitTp2 = cH >= tp2;
           
           if (hitBe && hitTp2) {
             closed = true;
             status = "WIN";
             profitR = 0.5 * 1.2;
           } else if (hitBe) {
             closed = true;
             status = "WIN";
             profitR = 0.5 * 1.2;
           } else if (hitTp2) {
             closed = true;
             status = "WIN";
             profitR = 0.5 * 1.2 + 0.5 * tp2R;
           }
         }
       } else { // SHORT
         if (!reachedTp1) {
           const hitSl = cH >= sl;
           const hitTp1 = cL <= tp1;
           
           if (hitSl && hitTp1) {
             closed = true;
             status = "LOSS";
             profitR = -1;
           } else if (hitSl) {
             closed = true;
             status = "LOSS";
             profitR = -1;
           } else if (hitTp1) {
             paperPosition.reachedTp1 = true;
             // Đạt TP1: Chốt 50% ở 1.2R, dời SL về BE (entry)
             const hitBe = cH >= entry;
             const hitTp2 = cL <= tp2;
             
             if (hitBe && hitTp2) {
               closed = true;
               status = "WIN";
               profitR = 0.5 * 1.2;
             } else if (hitBe) {
               closed = true;
               status = "WIN";
               profitR = 0.5 * 1.2;
             } else if (hitTp2) {
               closed = true;
               status = "WIN";
               profitR = 0.5 * 1.2 + 0.5 * tp2R;
             }
           }
         } else {
           // Đã đạt TP1 tự trước đó, SL dời về BE
           const hitBe = cH >= entry;
           const hitTp2 = cL <= tp2;
           
           if (hitBe && hitTp2) {
             closed = true;
             status = "WIN";
             profitR = 0.5 * 1.2;
           } else if (hitBe) {
             closed = true;
             status = "WIN";
             profitR = 0.5 * 1.2;
           } else if (hitTp2) {
             closed = true;
             status = "WIN";
             profitR = 0.5 * 1.2 + 0.5 * tp2R;
           }
         }
       }

       if (closed) {
          totalTrades++;
          
          const d = new Date(cTs);
          const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
          if (!monthlyStats.has(monthKey)) {
             monthlyStats.set(monthKey, { trades: 0, wins: 0, profitR: 0 });
          }
          const stat = monthlyStats.get(monthKey)!;
          stat.trades++;
          
          let pnlDollar = 0;
          if (profitR > 0) {
            wins++;
            totalProfitR += profitR;
            stat.wins++;
            stat.profitR += profitR;
            pnlDollar = paperPosition.riskUsd * profitR;
            
            // Reset consecutive losses
            currentConsecutiveLosses = 0;
          } else {
            totalProfitR += profitR; // profitR là -1
            stat.profitR += profitR;
            pnlDollar = paperPosition.riskUsd * profitR;
            
            // Increment consecutive losses
            currentConsecutiveLosses++;
            if (currentConsecutiveLosses > maxConsecutiveLosses) {
              maxConsecutiveLosses = currentConsecutiveLosses;
            }
          }
          balance += pnlDollar;
          
          // Update drawdown
          if (balance > peakBalance) {
            peakBalance = balance;
          } else {
            const currentDrawdownValue = peakBalance - balance;
            const currentDrawdownPercent = (currentDrawdownValue / peakBalance) * 100;
            if (currentDrawdownPercent > maxDrawdownPercent) {
              maxDrawdownPercent = currentDrawdownPercent;
            }
            if (currentDrawdownValue > maxDrawdownValue) {
              maxDrawdownValue = currentDrawdownValue;
            }
          }
          
          if (verbose) {
            const timeStr = new Date(cTs).toISOString().replace("T", " ").substring(0, 19);
            console.log(`[TRADE] ${timeStr} | ${paperPosition.type} | ${profitR > 0 ? "WIN" : "LOSS"} | PnL: ${profitR >= 0 ? '+' : ''}${profitR.toFixed(2)}R | PnL $: ${pnlDollar >= 0 ? '+' : ''}${pnlDollar.toFixed(2)}$ | B: ${balance.toFixed(2)}$`);
          }

          paperPosition = null;
       }
       continue; // Cooldown / 1 bar 1 lệnh
    }

    // Lọc theo Session
    const date = new Date(cTs);
    const hoursGMT = date.getUTCHours();
    const SESSION_START_GMT = 8;
    const SESSION_END_GMT = 21;
    let isInSession = true;
    if (enableSessionFilter) {
       if (SESSION_START_GMT <= SESSION_END_GMT) {
         isInSession = hoursGMT >= SESSION_START_GMT && hoursGMT < SESSION_END_GMT;
       } else {
         isInSession = hoursGMT >= SESSION_START_GMT || hoursGMT < SESSION_END_GMT;
       }
    }

    // Tính Indicator (Dựa trên slice của các nến đã đóng)
    const atrM1 = calculateATR(slice, 14);
    const vwmaM1 = calculateVWMA(slice, vwmaPeriod);
    const emaM1 = calculateEMA(slice, 20);
    const adxM1 = calcADX(slice, 14);
    const sweep = detectWhaleSweep(slice);

    const closePriceM1 = lastClosed[4];
    const distFromVWMA = Math.abs(closePriceM1 - vwmaM1);
    const bullishM1 = closePriceM1 > emaM1 && closePriceM1 > vwmaM1 && emaM1 > vwmaM1;
    const bearishM1 = closePriceM1 < emaM1 && closePriceM1 < vwmaM1 && emaM1 < vwmaM1;

    let sig: "LONG" | "SHORT" | null = null;
    const isOverExtendedLong = distFromVWMA > (atrM1 * 1.2);
    const isOverExtendedShort = distFromVWMA > (atrM1 * 1.2);

    const slDistanceLong = Math.abs(closePriceM1 - sweep.low);
    const slDistanceShort = Math.abs(sweep.high - closePriceM1);
    const hasBadEntryPriceLong = slDistanceLong > (atrM1 * 4.0);
    const hasBadEntryPriceShort = slDistanceShort > (atrM1 * 4.0);

    // Xác nhận vào lệnh Long
    if ( !isOverExtendedLong && !hasBadEntryPriceLong && adxM1.adx >= adxThreshold && sweep.sweepLow && sweep.displacementBullish && sweep.volConfirm && isInSession && (sweep.confirmClose > sweep.sweepOpen || sweep.confirmClose > sweep.high) && bullishM1 ) {
      sig = "LONG";
    }

    // Xác nhận vào lệnh Short
    if ( !isOverExtendedShort && !hasBadEntryPriceShort && adxM1.adx >= adxThreshold && sweep.sweepHigh && sweep.displacementBearish && sweep.volConfirm && isInSession && (sweep.confirmClose < sweep.sweepOpen || sweep.confirmClose < sweep.low) && bearishM1 ) {
      sig = "SHORT";
    }

    if (sig) {
      const e = closePriceM1; // Vào lệnh dựa vào giá mở cửa nến hiện tại (bằng với close nến trước)
      const slRaw = sig === "LONG" ? (sweep.low - atrM1 * 0.2) : (sweep.high + atrM1 * 0.2);
      const minRisk = atrM1 * 1.5;
      let sl = 0;
      if (sig === "LONG") {
        sl = Math.min(slRaw, closePriceM1 - minRisk);
      } else {
        sl = Math.max(slRaw, closePriceM1 + minRisk);
      }
      
      const risk = Math.abs(e - sl);
      const tp1R = 1.2;
      const tp2R = rr; // Thường là 2.0, lấy từ tham số rr cho linh hoạt
      const tp1 = sig === "LONG" ? e + risk * tp1R : e - risk * tp1R;
      const tp2 = sig === "LONG" ? e + risk * tp2R : e - risk * tp2R;

      const riskUsdStr = process.env.MT5_RISK_USD;
      let tradeRiskUsd = balance * 0.01; // Mặc định 1% tài khoản 5000 = 50$
      if (riskUsdStr) {
         const parsedRisk = parseFloat(riskUsdStr);
         if (!isNaN(parsedRisk) && parsedRisk > 0) {
             tradeRiskUsd = parsedRisk;
         } else {
             // Nếu cấu hình lot size cố định, ta tính ra dollar risk = Lot * Contract * SL_Distance
             const fixedLot = parseFloat(process.env.MT5_LOT_SIZE || "0.01");
             const contractSize = parseFloat(process.env.MT5_CONTRACT_SIZE || "100");
             tradeRiskUsd = fixedLot * contractSize * risk;
         }
      } else {
         const fixedLot = parseFloat(process.env.MT5_LOT_SIZE || "0.01");
         const contractSize = parseFloat(process.env.MT5_CONTRACT_SIZE || "100");
         tradeRiskUsd = fixedLot * contractSize * risk;
      }

      paperPosition = {
        type: sig,
        entry: e,
        sl: sl,
        tp: tp2,
        reachedTp1: false,
        tp1: tp1,
        tp2: tp2,
        tp2R: tp2R,
        risk: risk,
        riskUsd: tradeRiskUsd
      };
    }
  }

  const monthlySnapshots = Array.from(monthlyStats.entries()).map(([month, stat]) => ({
    date: month,
    whaleTrades: stat.trades,
    whaleWins: stat.wins,
    whalePnLR: stat.profitR
  }));
  
  // Sắp xếp lại theo thời gian từ cũ đến mới
  monthlySnapshots.sort((a, b) => a.date.localeCompare(b.date));

  const results = {
    startTime: startDate,
    endTime: endDate,
    finalBalance: balance,
    totalProfitR: totalProfitR,
    totalTrades: totalTrades,
    wins: wins,
    maxConsecutiveLosses,
    maxDrawdownPercent,
    maxDrawdownValue,
    monthlySnapshots
  };

  try {
    fs.writeFileSync(path.join(process.cwd(), 'data', 'backtest_results.json'), JSON.stringify(results));
  } catch (e) {}
  
  return results;
}
