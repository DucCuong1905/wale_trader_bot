import fs from 'fs';
import path from 'path';
import { runBacktest } from "./backtester.ts";
import dotenv from "dotenv";

dotenv.config();

// ==========================================================
// HÀM TẢI DỮ LIỆU BITCOIN RIÊNG BIỆT (Tránh lẫn lộn với Vàng)
// ==========================================================
function tryLoadFromBtcCsv(startDate: string, endDate: string, timeframe: string): any[] {
  let dataDir = path.join(process.cwd(), 'data');
  const customWindowsDir = 'C:\\btc_data';
  
  // Kiểm tra nếu người dùng tải qua download_btc_data.py vào ổ C:\btc_data
  if (fs.existsSync(customWindowsDir)) {
      dataDir = customWindowsDir;
  }
  
  if (!fs.existsSync(dataDir)) {
      console.log(`❌ Thư mục dữ liệu không tồn tại: ${dataDir}`);
      return [];
  }
  
  const files = fs.readdirSync(dataDir);
  let csvFiles: string[] = [];
  let jsonFiles: string[] = [];

  // Nếu đọc từ ổ C:\btc_data, ta lấy mọi file csv/json trong đó
  if (dataDir === customWindowsDir) {
      csvFiles = files.filter(f => f.endsWith('.csv'));
      jsonFiles = files.filter(f => f.endsWith('.json'));
  } else {
      // Nếu đọc từ thư mục dự án ./data, ta lọc thông minh chỉ lấy file tên chứa "btc" để không dính nến Vàng
      csvFiles = files.filter(f => f.toLowerCase().includes('btc') && f.endsWith('.csv'));
      jsonFiles = files.filter(f => f.toLowerCase().includes('btc') && f.endsWith('.json'));
  }

  let klines: any[] = [];
  
  if (jsonFiles.length > 0 && csvFiles.length === 0) {
      console.log(`📡 Phát hiện ${jsonFiles.length} file JSON Bitcoin. Đang nạp dữ liệu...`);
      for (const fName of jsonFiles) {
         try {
           const text = fs.readFileSync(path.join(dataDir, fName), 'utf8');
           let parsed: any[] = [];
           try {
              const result = JSON.parse(text);
              if (Array.isArray(result)) {
                 parsed = result;
              }
           } catch {
              // Fallback cho file json bị đứt đoạn
              const matches = text.match(/\[\d+(?:\.\d+)?(?:,[\d.-]+(?:\.\d+)?){5}\]/g);
              if (matches) {
                 for (const match of matches) {
                    try {
                       parsed.push(JSON.parse(match));
                    } catch {}
                 }
              }
              console.log(`⚠️ Đã khôi phục thành công ${parsed.length} nến từ file JSON bị lỗi (${fName})`);
           }
           klines = klines.concat(parsed);
         } catch (e: any) {
           console.error(`Lỗi khi đọc file JSON ${fName}:`, e.message);
         }
      }
  } else if (csvFiles.length > 0) {
      console.log(`📡 Phát hiện ${csvFiles.length} file CSV Bitcoin. Đang gộp dữ liệu lịch sử...`);
      try {
        for (const csvFile of csvFiles) {
          console.log(`   👉 Đang đọc nến từ file: ${csvFile}`);
          const text = fs.readFileSync(path.join(dataDir, csvFile), 'utf8');
          const lines = text.split('\n');
          
          // Bỏ qua tiêu đề
          for (let i = 1; i < lines.length; i++) {
            const l = lines[i].trim();
            if (!l) continue;
            const parts = l.split(',');
            
            if (parts.length >= 6) {
              let ts = 0;
              let timeStr = "";
              let oIdx = 1, hIdx = 2, lIdx = 3, cIdx = 4, vIdx = 5;

              // Phát hiện định dạng của MetaTrader5 CSV
              if (parts[1] && parts[1].includes(':')) {
                  timeStr = `${parts[0].replace(/\./g, '-')}T${parts[1]}`;
                  if (timeStr.length === 16) timeStr += ':00';
                  timeStr += 'Z';
                  
                  oIdx = 2; hIdx = 3; lIdx = 4; cIdx = 5; vIdx = 6;
              } else {
                  timeStr = parts[0].replace(/\./g, '-');
                  if (timeStr.includes(' ')) {
                      timeStr = timeStr.replace(' ', 'T') + 'Z';
                  } else if (timeStr.length === 10) {
                      timeStr += 'T00:00:00Z';
                  }
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
      } catch(e: any) {
        console.error("Error reading CSV BTC data:", e.message);
      }
  }
  
  // Loại bỏ các nến bị trùng timestamp
  if (klines.length > 0) {
      const uniqueKlines: any[] = [];
      let lastTs = -1;
      for (const k of klines) {
          if (k[0] !== lastTs) {
              uniqueKlines.push(k);
              lastTs = k[0];
          }
      }
      console.log(`📊 Đã lọc trùng lặp: Giữ lại ${uniqueKlines.length} nến m1 Bitcoin.`);
      return uniqueKlines;
  }
  
  return klines;
}

async function main() {
  console.log("=============================================================");
  console.log("🚀 SCRIPT KHỞI CHẠY BACKTEST TOÀN DIỆN BITCOIN (BTC)");
  console.log("=============================================================");

  const args = process.argv.slice(2);
  
  let startDate = "2026-01-01T00:00:00Z";
  let endDate = "2026-06-01T00:00:00Z";
  let timeframe = "1m";
  let rr = 1.2;
  let enableSessionFilter = true; // Crypto có thể tắt bộ lọc giờ m1 nếu muốn trade 24/7
  let adxThreshold = 20;

  // Cú pháp: npx tsx run_backtest_btc.ts [startDate] [endDate] [timeframe] [rr] [enableSessionFilter]
  if (args[0]) {
    startDate = args[0].includes("T") ? args[0] : `${args[0]}T00:00:00Z`;
  }
  if (args[1]) {
    endDate = args[1].includes("T") ? args[1] : `${args[1]}T00:00:00Z`;
  }
  if (args[2]) {
    timeframe = args[2];
  }
  if (args[3]) {
    rr = parseFloat(args[3]) || 1.2;
  }
  if (args[4] !== undefined) {
    enableSessionFilter = args[4] === "true";
  }
  if (args[5] !== undefined) {
    adxThreshold = parseFloat(args[5]) || 20;
  }

  console.log(`📌 THÔNG SỐ BACKTEST BITCOIN CHI TIẾT:`);
  console.log(`📅 Từ ngày:      ${startDate}`);
  console.log(`📅 Đến ngày:     ${endDate}`);
  console.log(`⏱️ Khung thời gian: ${timeframe}`);
  console.log(`⚖️ Tỷ lệ Risk Reward (RR):  ${rr}`);
  console.log(`🌐 Session Filter (Giờ vàng): ${enableSessionFilter ? "BẬT (08:00 - 21:00 UTC)" : "TẮT (Giao dịch 24/7)"}`);
  console.log(`📊 Ngưỡng ADX:    ${adxThreshold}`);
  console.log("-------------------------------------------------------------");

  // Nạp dữ liệu đặc thù BTC
  const btcData = tryLoadFromBtcCsv(startDate, endDate, timeframe);
  
  if (!btcData || btcData.length === 0) {
      console.log(`\n❌ Không tìm thấy dữ liệu Bitcoin để chạy backtest!`);
      console.log(`👉 Vui lòng chạy lệnh: python download_btc_data.py`);
      console.log(`Hoặc đặt các file nến rải rác trùng tên chứa 'btc' vào thư mục 'data/'. Ví dụ: data/2026_btc.csv`);
      return;
  }

  console.log(`🟢 Đã nạp thành công ${btcData.length.toLocaleString()} nến Bitcoin.`);
  console.log("📡 Đang tính toán chiến thuật Whale Sweep trên luồng nến BTC...");

  // Chỉ định dữ liệu Bitcoin này vào heap Global để backtester.ts nạp thay vì nạp Vàng
  (global as any).OPTIMIZE_DATA = btcData;

  try {
    const results = await runBacktest(
      startDate,
      endDate,
      rr,
      timeframe,
      enableSessionFilter,
      20, // VWMA Period
      (p: number) => {}, // progress callback
      adxThreshold,
      true // Hiển thị chi tiết lệnh [TRADE] trên terminal
    );

    console.log("\n=============================================================");
    console.log("🎉 KẾT QUẢ BACKTEST BITCOIN THÀNH CÔNG RỰC RỠ!");
    console.log("=============================================================");
    console.log(`💰 Số dư ban đầu:  $5,000.00`);
    console.log(`💰 Số dư cuối cùng: $${results.finalBalance.toFixed(2)}`);
    console.log(`📈 Tổng lợi nhuận:  ${results.totalProfitR.toFixed(2)} R`);
    console.log(`📊 Tổng số lệnh:   ${results.totalTrades} lệnh`);
    console.log(`🥇 Số lệnh Thắng:   ${results.wins} | Số lệnh Thua: ${results.totalTrades - results.wins}`);
    console.log(`🏆 Tỷ lệ thắng (Winrate): ${((results.wins / (results.totalTrades || 1)) * 100).toFixed(1)}%`);
    console.log(`📉 Sụt giảm tài khoản lớn nhất (Max Drawdown):   $${results.maxDrawdownValue.toFixed(2)} (${results.maxDrawdownPercent.toFixed(2)}%)`);
    console.log(`🔥 Chuỗi thua liên tiếp tối đa (Max Consecutive Losses): ${results.maxConsecutiveLosses} lệnh`);
    console.log("=============================================================");

    if (results.filterStats) {
      const fsVal = results.filterStats;
      console.log("\n🔍 CHI TIẾT CÁC BỘ LỌC CHẶN (BITCOIN):");
      console.log(`• Tổng số cơ hội Sweeps: ${fsVal.totalSweeps} (Quét đáy: ${fsVal.totalSweepLow} | Quét đỉnh: ${fsVal.totalSweepHigh})`);
      console.log(`• Tín hiệu LONG qua bộ lọc: ${fsVal.passedLong} | SHORT qua bộ lọc: ${fsVal.passedShort}`);
      console.log(`• Tổng lệnh khớp thực tế:  ${results.totalTrades} (loại bỏ do cooldown hoặc lệnh cũ chưa đóng)`);
      console.log("\n❌ CÁC LÝ DO LOẠI BỎ TÍN HIỆU:");
      console.log(`1. Lọc Xu hướng nến M1 (EMA/VWMA/Close): ${fsVal.blockedTrendM1}`);
      console.log(`2. Lọc Giá quá cách xa VWMA (Overextended): ${fsVal.blockedOverextended}`);
      console.log(`3. Lọc Độ rộng Stop Loss quá lớn: ${fsVal.blockedBadEntryPrice}`);
      console.log(`4. Lọc Chỉ báo ADX thấp (<${adxThreshold}): ${fsVal.blockedAdx}`);
      console.log(`5. Lọc Lực nến vượt đỉnh/đáy yếu (Displacement): ${fsVal.blockedDisplacement}`);
      console.log(`6. Lọc Thể tích giao dịch thấp (M1 Vol): ${fsVal.blockedVolume}`);
      console.log(`7. Lọc Khung giờ Session: ${fsVal.blockedSession}`);
      console.log(`8. Lọc Nến đóng xác nhận yếu: ${fsVal.blockedConfirmClose}`);
      console.log("=============================================================");
    }

    if (results.monthlySnapshots && results.monthlySnapshots.length > 0) {
      console.log("\n📅 THỐNG KÊ CHI TIẾT TỪNG THÁNG (BITCOIN):");
      console.log("-------------------------------------------------------------");
      results.monthlySnapshots.forEach((m: any) => {
        const wr = m.whaleTrades > 0 ? (m.whaleWins / m.whaleTrades) * 100 : 0;
        console.log(`Tháng ${m.date}: ${m.whaleTrades} lệnh | Winrate: ${wr.toFixed(1).padStart(4)}% | Lãi/Lỗ: ${m.whalePnLR.toFixed(2).padStart(6)} R`);
      });
      console.log("=============================================================\n");
    }

  } catch (error: any) {
    console.error("\n❌ Khởi chạy backtest thất bại:", error.message);
  } finally {
    // Dọn dẹp bộ nhớ global
    delete (global as any).OPTIMIZE_DATA;
  }
}

main();
