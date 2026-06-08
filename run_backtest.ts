import fs from 'fs';
import path from 'path';
import { runBacktest } from "./backtester.ts";
import dotenv from "dotenv";

dotenv.config();

const TRADES_FILE = path.join(process.cwd(), 'data', 'trades.json');

if (!fs.existsSync(TRADES_FILE)) {
  console.log("❌ Không tìm thấy dữ liệu giao dịch (data/trades.json)");
} else {
  try {
    const data = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf-8'));
    
    if (!Array.isArray(data) || data.length === 0) {
      console.log("⚠️ Dữ liệu giao dịch trống.");
    } else {
      const monthlyStats: Record<string, { wins: number; losses: number; pnl: number; totalR: number }> = {};
      
      let totalWins = 0;
      let totalLosses = 0;
      let totalPnl = 0;

      for (const trade of data) {
        if (!trade.time || !trade.status) continue;
        
        // Skip test trades
        if (trade.time.includes('2026-05-03T')) continue;

        const date = new Date(trade.time);
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; // YYYY-MM
        
        if (!monthlyStats[monthKey]) {
          monthlyStats[monthKey] = { wins: 0, losses: 0, pnl: 0, totalR: 0 };
        }

        if (trade.status === 'WIN' || trade.status === 'win') {
          monthlyStats[monthKey].wins++;
          totalWins++;
        } else if (trade.status === 'LOSS' || trade.status === 'loss') {
          monthlyStats[monthKey].losses++;
          totalLosses++;
        }
        
        const pnl = parseFloat(trade.pnl) || 0;
        monthlyStats[monthKey].pnl += pnl;
        totalPnl += pnl;
      }

      console.log("\n================ KẾT QUẢ GIAO DỊCH THEO THÁNG ================\n");

      const sortedMonths = Object.keys(monthlyStats).sort((a,b) => b.localeCompare(a)); // Mới nhất lên trước

      for (const month of sortedMonths) {
        const stats = monthlyStats[month];
        const total = stats.wins + stats.losses;
        const winrate = total > 0 ? (stats.wins / total) * 100 : 0;

        console.log(`📅 Tháng: ${month}`);
        console.log(`   - Tổng lệnh: ${total}`);
        console.log(`   - Thắng: ${stats.wins} | Thua: ${stats.losses}`);
        console.log(`   - Winrate: ${winrate.toFixed(1)}%`);
        console.log(`   - PnL (Lợi nhuận): $${stats.pnl.toFixed(2)}`);
        console.log(`--------------------------------------------------------------`);
      }

      const grandTotal = totalWins + totalLosses;
      const grandWinrate = grandTotal > 0 ? (totalWins / grandTotal) * 100 : 0;

      console.log(`\n================ TỔNG KẾT TOÀN THỜI GIAN ====================\n`);
      console.log(`🟢 Tổng lệnh : ${grandTotal}`);
      console.log(`🏆 Winrate   : ${grandWinrate.toFixed(1)}%`);
      console.log(`💰 Tổng PnL  : $${totalPnl.toFixed(2)}`);
      console.log(`\n==============================================================\n`);
    }
  } catch (err: any) {
    console.error("Lỗi khi đọc file giao dịch:", err.message);
  }
}

async function main() {
  console.log("=============================================================");
  console.log("🚀 SCRIPT KHỞI CHẠY BACKTEST TOÀN DIỆN VÀNG TRÊN TERMINAL");
  console.log("=============================================================");

  // Đọc tham khảo từ command-line args hoặc dùng giá trị mặc định của hệ thống
  const args = process.argv.slice(2);
  
  let startDate = "2020-01-01T00:00:00Z";
  let endDate = "2026-01-01T00:00:00Z";
  let timeframe = "1m";
  let rr = 1.2;
  let enableSessionFilter = true;
  let adxThreshold = 20;

  // Hỗ trợ truyền nhanh qua lệnh: npx tsx run_backtest.ts [startDate] [endDate] [timeframe] [rr]
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

  console.log(`📌 THÔNG SỐ BACKTEST HIỆN TẠI:`);
  console.log(`📅 Từ ngày:      ${startDate}`);
  console.log(`📅 Đến ngày:     ${endDate}`);
  console.log(`⏱️ Khung thời gian: ${timeframe}`);
  console.log(`⚖️ Tỷ lệ Risk Reward (RR):  ${rr}`);
  console.log(`🌐 Session Filter (08:00 - 21:00 UTC): ${enableSessionFilter ? "BẬT" : "TẮT"}`);
  console.log(`📊 ADX Threshold: ${adxThreshold}`);
  console.log("-------------------------------------------------------------");
  console.log("📡 Đang nạp dữ liệu từ file CSV vàng và tính toán chiến thuật...");

  try {
    const results = await runBacktest(
      startDate,
      endDate,
      rr,
      timeframe,
      enableSessionFilter,
      20, // VWMA Period
      (p: number) => {}, // Bỏ log tiến độ
      adxThreshold,
      true // Bật log chi tiết lệnh
    );

    console.log("\n=============================================================");
    console.log("🎉 KẾT QUẢ BACKTEST THÀNH CÔNG RỰC RỠ TRÊN TERMINAL!");
    console.log("=============================================================");
    console.log(`💰 Số dư ban đầu:  $5,000.00`);
    console.log(`💰 Số dư cuối cùng: $${results.finalBalance.toFixed(2)}`);
    console.log(`📈 Tổng lợi nhuận:  ${results.totalProfitR.toFixed(2)} R`);
    console.log(`📊 Tổng số lệnh:   ${results.totalTrades} lệnh`);
    console.log(`🥇 Số lệnh Thắng:   ${results.wins} | Số lệnh Thua: ${results.totalTrades - results.wins}`);
    console.log(`🏆 Tỷ lệ thắng (Winrate): ${((results.wins / (results.totalTrades || 1)) * 100).toFixed(1)}%`);
    console.log("=============================================================");

    if (results.monthlySnapshots && results.monthlySnapshots.length > 0) {
      console.log("\n📅 THỐNG KÊ TỪNG THÁNG:");
      console.log("-------------------------------------------------------------");
      results.monthlySnapshots.forEach((m: any) => {
        const wr = m.whaleTrades > 0 ? (m.whaleWins / m.whaleTrades) * 100 : 0;
        console.log(`Tháng ${m.date}: ${m.whaleTrades} lệnh | Winrate: ${wr.toFixed(1).padStart(4)}% | Lãi/Lỗ: ${m.whalePnLR.toFixed(2).padStart(6)} R`);
      });
      console.log("=============================================================\n");
    }
  } catch (error: any) {
    console.error("\n❌ Đã xảy ra lỗi khi chạy backtest:", error.message);
  }
}

main();
