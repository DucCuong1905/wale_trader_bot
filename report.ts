import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const TRADES_FILE = path.join(process.cwd(), 'data', 'trades.json');

console.log("======================================================================");
console.log("📊 BÁO CÁO THỐNG KÊ GIAO DỊCH LIVE (MT5)");
console.log("======================================================================");

if (!fs.existsSync(TRADES_FILE)) {
  console.log("⚠️ Không tìm thấy dữ liệu giao dịch live nào ở (data/trades.json).");
  console.log("Bot chưa lưu hoạt động giao dịch Live nào.");
  process.exit(0);
}

try {
  const data = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf-8'));
  
  if (!Array.isArray(data) || data.length === 0) {
    console.log("⚠️ Danh sách giao dịch trống.");
    process.exit(0);
  }

  // Filter for live trades
  const liveTrades = data.filter((t: any) => 
    t.strategy && t.strategy.toUpperCase().includes("LIVE")
  );

  if (liveTrades.length === 0) {
    console.log("ℹ️ Không tìm thấy lệnh LIVE nào trong dữ liệu.");
    console.log(`(Tổng số lệnh nháp/backtest ghi nhận trong file: ${data.length} lệnh)`);
    process.exit(0);
  }

  // Sắp xếp các lệnh theo thời gian tăng dần để phân tích chuỗi liên tiếp và drawdown
  const sortedTrades = [...liveTrades].sort((a: any, b: any) => 
    new Date(a.time).getTime() - new Date(b.time).getTime()
  );

  let wins = 0;
  let losses = 0;
  let totalPnl = 0;

  let maxConsecutiveLosses = 0;
  let currentConsecutiveLosses = 0;

  let peakBalance = sortedTrades[0].balanceBefore || 5000;
  let currentBalance = peakBalance;
  let maxDrawdownValue = 0;
  let maxDrawdownPercent = 0;

  console.log(`\n📋 CHI TIẾT CÁC LỆNH LIVE GIAO DỊCH (Từ cũ đến mới):\n`);
  console.log(
    "| " + "Thời gian".padEnd(19) + 
    " | " + "Ticket".padEnd(12) + 
    " | " + "Lệnh".padEnd(6) + 
    " | " + "Vol".padEnd(5) + 
    " | " + "Giá vào".padEnd(9) + 
    " | " + "Giá thoát".padEnd(9) + 
    " | " + "PnL ($)".padEnd(10) + 
    " | " + "Số dư (Trước ➔ Sau)".padEnd(25) + " |"
  );
  console.log("-".repeat(110));

  for (const trade of sortedTrades) {
    const timeStr = new Date(trade.time).toISOString().replace('T', ' ').substring(0, 19);
    const ticket = String(trade.ticket || 'N/A').padEnd(12);
    const type = String(trade.type || 'N/A').padEnd(6);
    const vol = String(trade.volume || '0.01').padEnd(5);
    const entry = String(trade.entry ? trade.entry.toFixed(2) : '0.00').padEnd(9);
    const exit = String(trade.exit ? trade.exit.toFixed(2) : '0.00').padEnd(9);
    
    const pnl = parseFloat(trade.pnl) || 0;
    totalPnl += pnl;

    const pnlSign = pnl >= 0 ? "+" : "";
    const pnlStr = (pnlSign + pnl.toFixed(2) + "$").padEnd(10);
    
    // Balance before & after
    const bBefore = trade.balanceBefore !== undefined ? trade.balanceBefore : currentBalance;
    const bAfter = trade.balanceAfter !== undefined ? trade.balanceAfter : (bBefore + pnl);
    currentBalance = bAfter;

    if (trade.status === 'WIN' || pnl > 0) {
      wins++;
      currentConsecutiveLosses = 0;
    } else {
      losses++;
      currentConsecutiveLosses++;
      if (currentConsecutiveLosses > maxConsecutiveLosses) {
        maxConsecutiveLosses = currentConsecutiveLosses;
      }
    }

    // Drawdown Calculation
    if (currentBalance > peakBalance) {
      peakBalance = currentBalance;
    } else {
      const ddVal = peakBalance - currentBalance;
      const ddPct = (ddVal / peakBalance) * 100;
      if (ddVal > maxDrawdownValue) {
        maxDrawdownValue = ddVal;
      }
      if (ddPct > maxDrawdownPercent) {
        maxDrawdownPercent = ddPct;
      }
    }

    const bStr = `$${bBefore.toFixed(1)} ➔ $${bAfter.toFixed(1)}`.padEnd(25);

    console.log(`| ${timeStr} | ${ticket} | ${type} | ${vol} | ${entry} | ${exit} | ${pnlStr} | ${bStr} |`);
  }

  const totalTrades = wins + losses;
  const winrate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  
  const startBalance = sortedTrades[0].balanceBefore || 5000;
  const finalBalance = currentBalance;

  console.log("-".repeat(110));
  console.log(`\n=================== TỔNG KẾT HIỆU SUẤT LIVE ===================\n`);
  console.log(`🟢 Tổng số lệnh Live : ${totalTrades}`);
  console.log(`🏆 Thắng / Thua      : ${wins} / ${losses}`);
  console.log(`📊 Tỷ lệ thắng       : ${winrate.toFixed(1)}%`);
  console.log(`💰 Tổng PnL thực tế  : ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
  console.log(`🏦 tài khoản ban đầu : $${startBalance.toFixed(2)}`);
  console.log(`🏦 tài khoản hiện tại: $${finalBalance.toFixed(2)}`);
  console.log(`📉 Max Drawdown      : $${maxDrawdownValue.toFixed(2)} (${maxDrawdownPercent.toFixed(2)}%)`);
  console.log(`🔥 Chuỗi thua tối đa : ${maxConsecutiveLosses} lệnh liên tiếp`);
  console.log(`\n==============================================================\n`);

} catch (err: any) {
  console.error("❌ Lỗi khi đọc hoặc xử lý file báo cáo giao dịch:", err.message);
}
