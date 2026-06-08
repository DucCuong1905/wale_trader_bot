import { runBacktest, tryLoadFromXauCsv } from "./backtester.ts";
import * as fs from "fs";

async function optimize() {
  const startDate = "2024-01-01T00:00:00Z";
  const endDate = "2026-01-01T00:00:00Z";
  const timeframe = "1m";

  console.log("⏳ Đang tải dữ liệu một lần duy nhất để phục vụ Optimizer...");
  const klines = tryLoadFromXauCsv(startDate, endDate, timeframe);
  
  if (!klines || klines.length === 0) {
    console.error("❌ Không tìm thấy dữ liệu. Hãy đảm bảo bạn đã upload file CSV vào thư mục 'data/' hoặc đang chạy trên VPS có sẵn file ở ổ đĩa.");
    return;
  }
  
  // Set global cache for backtester
  (global as any).OPTIMIZE_DATA = klines;
  console.log(`✅ Đã tải ${klines.length} nến vào RAM. Bắt đầu Grid Search...\n`);

  // --- GRID SEARCH PARAMETERS ---
  const riskRatios = [1.0, 1.2, 1.5, 2.0]; // ADDED RISKS
  const wickRatios = [0.25, 0.35, 0.40];
  const bodyRatios = [0.60, 0.70, 0.80];
  const closeRatios = [0.45, 0.50];
  const adxThresholds = [10, 15, 20];
  const volRatios = [0.60, 0.75, 0.90];
  
  let topConfigs: any[] = [];
  const totalCombinations = riskRatios.length * wickRatios.length * bodyRatios.length * closeRatios.length * adxThresholds.length * volRatios.length;
  let runCount = 0;

  for (const r of riskRatios) {
    console.log(`\n=============================================================`);
    console.log(`🚀 BẮT ĐẦU GRID SEARCH VỚI RISK REWARD RATIO = ${r}`);
    console.log(`=============================================================\n`);
    for (const w of wickRatios) {
      for (const b of bodyRatios) {
        for (const c of closeRatios) {
          for (const a of adxThresholds) {
            for (const v of volRatios) {
              runCount++;
              console.log(`[${runCount}/${totalCombinations}] Đang test cấu hình: RR=${r}, Wick=${w}, Body=${b}, Close=${c}, ADX=${a}, Vol=${v}`);
              
              // Override parameters globally
              (global as any).CONFIG_WICK_RATIO_VAL = w;
              (global as any).CONFIG_BODY_RATIO_VAL = b;
              (global as any).CONFIG_CLOSE_RATIO_VAL = c;
              (global as any).CONFIG_VOL_RATIO_VAL = v;

              // Run light mode (no telegram, no logs internally as much as possible)
              // Suppress console.log temporarily to keep terminal clean
              const originalLog = console.log;
              console.log = function() {}; 
              
              // TRUYỀN RISK (r) THAY VÌ 1.0 CỐ ĐỊNH
              const res = await runBacktest(startDate, endDate, r, timeframe, false, 20, (progress: number) => {}, a);
              
              console.log = originalLog; // Restore console

              // Calculate metrics
              const wr = res.totalTrades > 0 ? (res.wins / res.totalTrades) * 100 : 0;
              
              console.log(`   ---> [Kết quả] Lệnh đã khớp: ${res.totalTrades} | Winrate: ${wr.toFixed(1)}% | Lãi/lỗ: ${res.totalProfitR.toFixed(1)}R`);
              
              // Giả định dữ liệu test 2 năm = 24 tháng 
              // Nếu bạn test khung tgian khác hãy chỉnh lại logic này 
              const diffTime = (new Date(endDate).getTime() - new Date(startDate).getTime());
              const months = diffTime / (1000 * 60 * 60 * 24 * 30.44);
              const tradesPerMonth = res.totalTrades / months;
              
              const isTargetMet = wr > 60 && tradesPerMonth >= 15;
              
              if (isTargetMet) {
                  console.log(`   --> 🟢 ĐẠT CHUẨN: RR: ${r} | Lệnh/tháng: ${tradesPerMonth.toFixed(1)} | Winrate: ${wr.toFixed(1)}% | PnL: ${res.totalProfitR.toFixed(1)}R`);
              }

              // Scoring system:
              let score = 0;
              if (isTargetMet) {
                  score = res.totalProfitR; // Priority 1: High PnL among qualified configs
              } else {
                  score = res.totalProfitR - 1000; // Priority 2: Penalized heavily for not meeting criteria
              }

              topConfigs.push({
                score: score,
                riskScore: r,
                wickScore: w, bodyScore: b, closeScore: c, adxScore: a, volScore: v,
                winrate: wr,
                tradesPerMonth: tradesPerMonth,
                totalTrades: res.totalTrades,
                totalR: res.totalProfitR,
                isTargetMet: isTargetMet
              });
              
              topConfigs.sort((a, b) => b.score - a.score);
              if (topConfigs.length > 5) {
                topConfigs.pop();
              }
            }
          }
        }
      }
    }
  }

  console.log(`\n🏆 =========== KẾT QUẢ TỐI ƯU HÓA TỐT NHẤT (TOP 5) =========== 🏆`);
  topConfigs.forEach((config, index) => {
    console.log(`\n--- Hạng ${index + 1} ---`);
    if (config.isTargetMet) {
      console.log(`✅ ĐẠT ĐIỀU KIỆN (Winrate > 60%, >= 15 lệnh/tháng)`);
    } else {
      console.log(`⚠️ CHƯA ĐẠT CHUẨN (Không đủ winrate hoặc không đủ số lệnh)`);
    }
    console.log(`- Risk Reward  : ${config.riskScore}`);
    console.log(`- Wick Ratio   : ${config.wickScore}`);
    console.log(`- Body Ratio   : ${config.bodyScore}`);
    console.log(`- Close Ratio  : ${config.closeScore}`);
    console.log(`- ADX Threshold: ${config.adxScore}`);
    console.log(`- Vol Confirm  : ${config.volScore}`);
    console.log(`-----------------------------------------------`);
    console.log(`-> Winrate: ${config.winrate.toFixed(1)}%`);
    console.log(`-> Trung bình số lệnh/tháng: ${config.tradesPerMonth.toFixed(1)} lệnh (Tổng ${config.totalTrades} lệnh)`);
    console.log(`-> Tổng PnL dự kiến: ${config.totalR.toFixed(1)}R`);
  });
  console.log(`\n====== BẠN CÓ THỂ CẬP NHẬT TRỰC TIẾP LỰA CHỌN TỐT NHẤT VÀO SERVER.TS ======`);
}

optimize().catch(console.error);
