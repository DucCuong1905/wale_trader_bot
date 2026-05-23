import { runBacktest } from "./backtester.ts";
import dotenv from "dotenv";

dotenv.config();

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
  let adxThreshold = 10;
  let enableWhaleSweep = true;

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
  console.log(`🐋 Whale Sweep Only:  ${enableWhaleSweep ? "BẬT" : "TẮT"}`);
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
      (() => {
        let lastPrinted = -1;
        return (p) => {
          const rounded = Math.floor(p / 5) * 5;
          if (rounded !== lastPrinted) {
            console.log(`⏳ Tiến độ backtest: ${rounded}%`);
            lastPrinted = rounded;
          }
        };
      })(),
      adxThreshold,
      enableWhaleSweep
    );

    console.log("\n=============================================================");
    console.log("🎉 KẾT QUẢ BACKTEST THÀNH CÔNG RỰC RỠ TRÊN TERMINAL!");
    console.log("=============================================================");
    console.log(`💰 Số dư ban đầu:  $5,000.00`);
    console.log(`💰 Số dư cuối cùng: $${results.finalBalance.toFixed(2)}`);
    console.log(`📈 Tổng lợi nhuận:  ${results.totalProfitR.toFixed(2)} R`);
    console.log(`📊 Tổng số lệnh:   ${results.totalTrades} lệnh`);
    console.log(`🥇 Số lệnh Thắng:   ${results.wins} | Số lệnh Thua: ${results.losses}`);
    console.log(`🏆 Tỷ lệ thắng (Winrate): ${((results.wins / (results.totalTrades || 1)) * 100).toFixed(1)}%`);
    console.log("=============================================================");
  } catch (error: any) {
    console.error("\n❌ Đã xảy ra lỗi khi chạy backtest:", error.message);
  }
}

main();
