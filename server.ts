import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import * as ccxt from "ccxt";
import WebSocket from "ws";

import { GoogleGenAI } from "@google/genai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- AI CONFIG ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const model = "gemini-3-flash-preview";

// --- CẤU HÌNH GIAO DỊCH (TRADING CONSTANTS) ---
const PAIR = "BTC/USDT:USDT"; // Cặp giao dịch (BTC Futures trên Bitget)
const SYMBOL_ID = "BTCUSDT"; // ID Symbol cho WebSocket
const RISK_PER_TRADE = 0.01; // Rủi ro 1% tổng tài sản cho mỗi lệnh (Stop Loss sẽ mất 1%)
const RR = 2.5; // Tỷ lệ Lợi nhuận/Rủi ro (Take Profit gấp 2.5 lần Stop Loss)
const COOLDOWN_MS = 30000; // Thời gian nghỉ giữa các lệnh (30 giây) để tránh vào lệnh liên tục
const MAX_DAILY_LOSS = 0.03; // Giới hạn lỗ tối đa trong ngày (3%). Nếu chạm mốc này, Bot sẽ dừng giao dịch.

// --- PERSISTENCE ---
const DATA_DIR = path.join(process.cwd(), "data");
const TRADES_FILE = path.join(DATA_DIR, "trades.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

function loadTrades() {
  if (fs.existsSync(TRADES_FILE)) {
    try {
      const data = fs.readFileSync(TRADES_FILE, "utf-8");
      return JSON.parse(data);
    } catch (e) {
      console.error("Error loading trades:", e);
      return [];
    }
  }
  return [];
}

function saveTrade(trade: any) {
  const trades = loadTrades();
  trades.unshift(trade);
  // Keep only last 1000 trades
  const limited = trades.slice(0, 1000);
  try {
    fs.writeFileSync(TRADES_FILE, JSON.stringify(limited, null, 2));
  } catch (e) {
    console.error("Error saving trade:", e);
  }
}

// Trạng thái hệ thống (System State) để theo dõi dữ liệu thời gian thực
let botState = {
  isRunning: true, // Trạng thái hoạt động của Bot
  lastPrice: 0, // Giá thị trường hiện tại
  bid: 0, // Tổng khối lượng mua trong Orderbook
  ask: 0, // Tổng khối lượng bán trong Orderbook
  inPosition: false, // Kiểm tra xem Bot có đang giữ lệnh nào không
  lastPositionCheck: false,
  lastTradeTime: 0, // Thời điểm vào lệnh gần nhất
  balance: 0, // Số dư hiện tại (USDT)
  dailyStartingBalance: 0, // Số dư lúc bắt đầu ngày mới (để tính lãi/lỗ ngày)
  lastResetDate: "", // Ngày reset số dư gần nhất
  trades: loadTrades() as any[], // Lịch sử giao dịch
  signals: [] as any[], // Các tín hiệu đã phát hiện
  aiReasoning: "Awaiting analysis..." // Phân tích gần nhất từ AI
};

// --- LOGIC PHÂN TÍCH AI (AI ANALYSIS) ---
// Hàm này gửi dữ liệu thị trường cho AI (Gemini) để đánh giá lại tín hiệu kỹ thuật
async function getAIAnalysis(signal: string, lastPrice: number, obRatio: number, bars: any[]) {
  try {
    // Lấy 20 nến gần nhất để AI có cái nhìn tổng quan hơn về xu hướng
    const context = bars.slice(-20).map((b, i) => {
      const time = new Date(b[0]).toLocaleTimeString();
      return `[${time}] O:${b[1]} H:${b[2]} L:${b[3]} C:${b[4]} V:${b[5]}`;
    }).join("\n");

    const prompt = `You are an aggressive high-frequency whale trader. Your goal is to capture market momentum and liquidity sweeps.
SIGNAL TO EVALUATE: ${signal}
CURRENT PRICE: ${lastPrice}
ORDERBOOK BID/ASK RATIO: ${obRatio}

MARKET CONTEXT (Last 20 candles):
${context}

ANALYSIS GUIDELINES:
- Be decisive. If the market structure is even slightly aligned with the ${signal} signal, CONFIRM it.
- Look for early signs of reversal after a liquidity sweep.
- Accept moderate risks if the Bid/Ask ratio supports the move.
- We are playing for 2.5 RR, so we can afford some stops as long as we catch the big sweeps.

FINAL DECISION:
- "CONFIRM" if the signal has at least 60% probability based on your experience.
- "REJECT" only if there is a massive counter-trend volume or clear manipulative fakeout.

Return ONLY a JSON object:
{ 
  "decision": "CONFIRM" | "REJECT", 
  "reason": "Short technical explanation (max 2 sentences)",
  "confidence": 0-100
}`;

    const result = await ai.models.generateContent({
      model: model,
      contents: prompt,
      config: { responseMimeType: "application/json" }
    });

    const parsed = JSON.parse(result.text || "{}");
    return parsed;
  } catch (e) {
    console.error("AI Analysis Error:", e);
    return { decision: "REJECT", reason: "AI Service Error", confidence: 0 };
  }
}

// --- TELEGRAM HELPER ---
async function sendTelegram(msg: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg,
        parse_mode: "Markdown"
      })
    });
  } catch (e) {
    console.error("Telegram Error:", e);
  }
}

// Exchange Init (Lazy)
let exchange: ccxt.bitget | null = null;
function getExchange() {
  if (!exchange) {
    const apiKey = process.env.BG_API_KEY;
    const secret = process.env.BG_SECRET_KEY;
    const password = process.env.BG_PASSPHRASE;

    if (!apiKey || !secret) {
      console.warn("⚠️ API keys missing. Bot will run in monitoring mode.");
      return null;
    }

    exchange = new ccxt.bitget({
      apiKey,
      secret,
      password,
      enableRateLimit: true,
      options: { defaultType: 'future' }
    });
  }
  return exchange;
}

// Ported Logic from Python
// Tính toán vùng thanh khoản (Liquidity) dựa trên đỉnh/đáy của các nến trước đó
function getLiquidity(ohlcv: any[]) {
  // OHLCV structure: [timestamp, open, high, low, close, volume]
  const slice = ohlcv.slice(-6, -1); // Lấy 5 nến trước nến hiện tại
  const highs = slice.map(b => b[2]); // Lấy giá cao nhất
  const lows = slice.map(b => b[3]); // Lấy giá thấp nhất
  return { 
    eqHigh: Math.max(...highs), // Đỉnh cũ gần nhất
    eqLow: Math.min(...lows)   // Đáy cũ gần nhất
  };
}

// Phát hiện cú quét thanh khoản (Liquidity Sweep)
// Xảy ra khi giá vượt qua đỉnh/đáy cũ nhưng đóng cửa quay lại bên trong
function detectSweep(lastBar: any[], eqHigh: number, eqLow: number) {
  const [, , h, l, c] = lastBar;
  const sweepHigh = h > eqHigh && c < eqHigh; // Quét đỉnh (Fake breakout lên)
  const sweepLow = l < eqLow && c > eqLow;   // Quét đáy (Fake breakout xuống)
  return { sweepHigh, sweepLow };
}

// Kiểm tra sự hấp thụ (Absorption)
// Nhìn vào độ dài của râu nến (Wick). Nếu râu nến dài gấp đôi thân nến kèm Volume cao => Có dấu hiệu đảo chiều.
function checkAbsorption(lastBar: any[]) {
  const [, o, h, l, c] = lastBar;
  const body = Math.abs(c - o);
  const wick = (h - l) - body;
  return wick > body * 2;
}

// Tín hiệu từ sổ lệnh (Orderbook)
// Nếu khối lượng Mua lớn hơn Bán 1.2 lần => BULL, ngược lại => BEAR
function getOrderbookSignal() {
  if (botState.bid === 0 || botState.ask === 0) return null;
  const ratio = botState.bid / botState.ask;
  if (ratio > 1.2) return "BULL"; // Lực mua mạnh
  if (ratio < 0.83) return "BEAR"; // Lực bán mạnh
  return null;
}

// WebSocket Loop (Orderbook & Ticker)
function startWS() {
  const ws = new WebSocket("wss://ws.bitget.com/v2/ws/public");

  ws.on('open', () => {
    console.log("🔌 Connected to Bitget WS");
    ws.send(JSON.stringify({
      op: "subscribe",
      args: [
        { instType: "USDT-FUTURES", channel: "books5", instId: SYMBOL_ID },
        { instType: "USDT-FUTURES", channel: "ticker", instId: SYMBOL_ID }
      ]
    }));
  });

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (!parsed.data || !parsed.data[0]) return;
      const d = parsed.data[0];

      if (d.bids) {
        botState.bid = d.bids.reduce((sum: number, x: any) => sum + parseFloat(x[1]), 0);
        botState.ask = d.asks.reduce((sum: number, x: any) => sum + parseFloat(x[1]), 0);
      }
      if (d.last) {
        botState.lastPrice = parseFloat(d.last);
      }
    } catch (e) {
      // Ignore parse errors
    }
  });

  ws.on('error', (e) => console.error("WS Error:", e));
  ws.on('close', () => setTimeout(startWS, 5000));
}

function getAvgRange(ohlcv: any[], period: number = 14) {
  const slice = ohlcv.slice(-period);
  const sum = slice.reduce((acc, bar: any) => acc + (bar[2] - bar[3]), 0);
  return sum / period;
}

// --- TECHNICAL INDICATORS ---

function calcADX(ohlcv: any[], period: number = 14) {
  if (ohlcv.length < period * 2) return 0;

  let tr: number[] = [];
  let plusDM: number[] = [];
  let minusDM: number[] = [];

  for (let i = 1; i < ohlcv.length; i++) {
    const [prevTs, prevO, prevH, prevL, prevC] = ohlcv[i - 1];
    const [ts, o, h, l, c] = ohlcv[i];

    const tr1 = h - l;
    const tr2 = Math.abs(h - prevC);
    const tr3 = Math.abs(l - prevC);
    tr.push(Math.max(tr1, tr2, tr3));

    const upMove = h - prevH;
    const downMove = prevL - l;

    if (upMove > downMove && upMove > 0) plusDM.push(upMove);
    else plusDM.push(0);

    if (downMove > upMove && downMove > 0) minusDM.push(downMove);
    else minusDM.push(0);
  }

  // Simple Moving Average for smoothing (Wilder's smoothing is standard but SMA is a close proxy)
  const smooth = (arr: number[]) => {
    let result = [arr.slice(0, period).reduce((a, b) => a + b, 0) / period];
    for (let i = period; i < arr.length; i++) {
      result.push((result[result.length - 1] * (period - 1) + arr[i]) / period);
    }
    return result;
  };

  const smoothTR = smooth(tr);
  const smoothPlusDM = smooth(plusDM);
  const smoothMinusDM = smooth(minusDM);

  const dx: number[] = [];
  for (let i = 0; i < smoothTR.length; i++) {
    const plusDI = 100 * (smoothPlusDM[i] / smoothTR[i]);
    const minusDI = 100 * (smoothMinusDM[i] / smoothTR[i]);
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / sum);
  }

  const adx = smooth(dx);
  return adx[adx.length - 1];
}

// Vòng lặp giao dịch chính (Main Trader Loop)
async function traderLoop() {
  const ex = getExchange();
  if (!ex) {
    if (botState.isRunning) {
      console.log("🔍 Scanning (Monitoring Mode - No API Keys)...");
    }
    setTimeout(traderLoop, 10000);
    return;
  }

  try {
    // 1. Cập nhật thông tin tài khoản (Sync Account Info)
    const balanceInfo = await ex.fetchBalance();
    const currentBalance = balanceInfo.USDT ? (balanceInfo.USDT as any).total : 0;
    botState.balance = currentBalance;

    // Reset số dư ngày mới lúc 00:00 UTC
    const today = new Date().toISOString().split('T')[0];
    if (botState.lastResetDate !== today) {
      console.log(`🌅 Ngày mới bắt đầu: ${today}. Ghi nhận số dư đầu ngày: ${currentBalance}`);
      botState.dailyStartingBalance = currentBalance;
      botState.lastResetDate = today;
    }

    // Kiểm tra giới hạn lỗ tối đa trong ngày (Daily Stop Loss)
    const dailyPnL = currentBalance - botState.dailyStartingBalance;
    const dailyLossPercent = botState.dailyStartingBalance > 0 ? (dailyPnL / botState.dailyStartingBalance) : 0;

    if (dailyLossPercent <= -MAX_DAILY_LOSS) {
      console.warn(`🛑 Chạm giới hạn lỗ ngày (${(dailyLossPercent * 100).toFixed(2)}%). Dừng giao dịch cho đến ngày mai.`);
      setTimeout(traderLoop, 60000 * 30); // Nghỉ 30 phút rồi check lại
      return;
    }

    // Kiểm tra vị thế hiện tại trên sàn
    const positions = await ex.fetchPositions([PAIR]);
    const isNowInPosition = positions.some(p => Math.abs(parseFloat(p.info.size || p.contracts || 0)) > 0);
    
    // Nếu vừa đóng vị thế (chốt lời/cắt lỗ xong)
    if (botState.inPosition && !isNowInPosition) {
      const dailyPnL = currentBalance - botState.dailyStartingBalance;
      const pnlPercent = (dailyPnL / botState.dailyStartingBalance * 100).toFixed(2);
      
      const tradeResult = {
        type: 'CLOSE',
        balance: currentBalance,
        pnl: dailyPnL,
        time: new Date().toISOString(),
        status: 'CLOSED'
      };
      
      botState.trades.unshift(tradeResult);
      saveTrade(tradeResult);

      const closedMsg = `🔔 *VỊ THẾ ĐÃ ĐÓNG*\n💰 Số dư hiện tại: $${botState.balance.toFixed(2)}\n📊 PnL hôm nay: ${dailyPnL >= 0 ? '+' : ''}$${dailyPnL.toFixed(2)} (${pnlPercent}%)`;
      sendTelegram(closedMsg);
    }
    
    botState.inPosition = isNowInPosition;

    // Kiểm tra thời gian chờ (Cooldown) và trạng thái lệnh
    if (botState.inPosition || (Date.now() - botState.lastTradeTime < COOLDOWN_MS)) {
      setTimeout(traderLoop, 5000);
      return;
    }

    // 2. Phân tích kỹ thuật (Technical Analysis - Nến 15 phút)
    const bars = await ex.fetchOHLCV(PAIR, '15m', 100);
    if (!bars || bars.length < 30) return;

    const adx = calcADX(bars, 14); // Chỉ báo ADX để xác định sức mạnh xu hướng
    const { eqHigh, eqLow } = getLiquidity(bars); // Đỉnh/đáy thanh khoản
    const lastBar = bars[bars.length - 1];
    const { sweepHigh, sweepLow } = detectSweep(lastBar, eqHigh, eqLow); // Quét thanh khoản
    const absorb = checkAbsorption(lastBar); // Hấp thụ giá
    const obSignal = getOrderbookSignal(); // Tín hiệu từ sổ lệnh

    console.log(`📊 ADX: ${adx.toFixed(1)} | Seek: ${sweepLow ? 'SWEEP_LOW' : sweepHigh ? 'SWEEP_HIGH' : 'NONE'}`);

    // LOGIC VÀO LỆNH:
    // LONG: Quét đáy + Sổ lệnh Bullish + Nến hấp thụ + Xu hướng có lực (ADX > 20)
    // SHORT: Quét đỉnh + Sổ lệnh Bearish + Nến hấp thụ + Xu hướng có lực (ADX > 20)
    let signal: 'LONG' | 'SHORT' | null = null;
    if (sweepLow && obSignal === "BULL" && absorb && adx > 20) signal = "LONG";
    if (sweepHigh && obSignal === "BEAR" && absorb && adx > 20) signal = "SHORT";

    if (signal) {
      // 3. Tính toán thông số lệnh (Order Calculation)
      const entry = botState.lastPrice;
      const rangeAvg = getAvgRange(bars, 14); // Độ biến động nến trung bình để đặt SL
      
      const sl = signal === "LONG" ? entry - rangeAvg : entry + rangeAvg;
      const tp = signal === "LONG" ? entry + (entry - sl) * RR : entry - (sl - entry) * RR;

      // Tính toán kích thước (Size) theo % rủi ro
      const riskAmt = botState.balance * RISK_PER_TRADE;
      const stopDist = Math.abs(entry - sl);
      
      if (stopDist > 0) {
        let size = riskAmt / stopDist;
        const maxNotional = (botState.balance * 0.1) / entry; // Giới hạn an toàn: Không quá 10% vốn mỗi lệnh
        size = Math.min(size, maxNotional);

        if (size > 0) {
          const alertMsg = `🚀 *VÀO LỆNH ${signal}*\n💰 Giá: ${entry}\n🛑 SL: ${sl.toFixed(1)}\n🎯 TP: ${tp.toFixed(1)}\n📏 Size: ${size.toFixed(4)}`;
          console.log(alertMsg);
          sendTelegram(alertMsg);
          
          // --- BƯỚC KIỂM TRA CUỐI CÙNG VỚI AI (AI SECONDARY CHECK) ---
          const aiEval = await getAIAnalysis(signal, entry, botState.bid / botState.ask, bars);
          botState.aiReasoning = aiEval.reason;

          if (aiEval.decision === "REJECT") {
            const rejectMsg = `🤖 *AI TỪ CHỐI LỆNH*\nLý do: ${aiEval.reason}`;
            console.log(rejectMsg);
            sendTelegram(rejectMsg);
            
            const tradeData = { 
              type: signal, 
              price: entry, 
              time: new Date().toISOString(), 
              status: 'AI_REJECTED', 
              reason: aiEval.reason 
            };
            botState.signals.unshift(tradeData);
            botState.trades.unshift(tradeData);
            saveTrade(tradeData);
            
            return; // Dừng không vào lệnh nữa
          }
          
          const confirmMsg = `🤖 *AI XÁC NHẬN LỆNH* (Độ tin cậy: ${aiEval.confidence}%)\nLý do: ${aiEval.reason}`;
          console.log(confirmMsg);
          sendTelegram(confirmMsg);
          
          try {
            // 4. Thực thi lệnh trên sàn (Execution)
            // Lệnh thị trường để vào vị thế ngay
            await ex.createMarketOrder(PAIR, signal === 'LONG' ? 'buy' : 'sell', size);
            
            // Lệnh giới hạn để Chốt lời (Take Profit)
            await ex.createOrder(PAIR, 'limit', signal === 'LONG' ? 'sell' : 'buy', size, tp);
            
            // Lệnh Stop Market để Cắt lỗ (Stop Loss)
            await ex.createOrder(PAIR, 'stop_market', signal === 'LONG' ? 'sell' : 'buy', size, undefined, { 
              'stopPrice': sl,
              'reduceOnly': true 
            });

            botState.lastTradeTime = Date.now();
            botState.inPosition = true;
            
            const tradeData = { 
              type: signal, 
              price: entry, 
              time: new Date().toISOString(), 
              status: 'EXECUTED',
              sl,
              tp,
              size
            };
            botState.signals.unshift(tradeData);
            botState.trades.unshift(tradeData);
            saveTrade(tradeData);
          } catch (orderError) {
            console.error("❌ Lỗi thực thi lệnh:", orderError);
          }
        }
      }
    }

  } catch (e) {
    console.error("Lỗi trong vòng lặp Trader:", e);
  }

  setTimeout(traderLoop, 5000); // Lặp lại sau mỗi 5 giây
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Logger Middleware
  app.use((req, res, next) => {
    if (req.url.startsWith('/api')) {
      console.log(`[API] ${req.method} ${req.url}`);
    }
    next();
  });

  // Health Check
  app.get("/api/health", (req, res) => {
    console.log("[Health] Health check requested");
    res.json({ status: "ok", time: new Date().toISOString(), node: process.version });
  });

  // API Routes
  app.get("/api/trading/status", (req, res) => {
    try {
      console.log("[API] /api/trading/status requested");
      res.json({
        status: botState.isRunning ? "running" : "idle",
        symbol: PAIR,
        last_price: botState.lastPrice || 0,
        bid_ratio: botState.ask !== 0 ? (botState.bid / botState.ask).toFixed(2) : "1.00",
        in_position: botState.inPosition,
        signals: botState.signals.slice(0, 10),
        balance: botState.balance || 0,
        ai_reasoning: botState.aiReasoning
      });
    } catch (e) {
      console.error("Status API Error:", e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.get("/api/trading/balance", (req, res) => {
    res.json({
      total: botState.balance,
      currency: "USDT"
    });
  });

  app.get("/api/trading/history", (req, res) => {
    res.json(botState.trades);
  });

  // Start Loops
  startWS();
  traderLoop();

  // Telegram Start Notification
  sendTelegram("🐳 *Whale Bot Started (VPS)*\nBot đã sẵn sàng và đang quét lệnh...");

  // Health Check: Mỗi 4 tiếng
  setInterval(() => {
    let msg = `🛰 *Health Report*\n🕒 Thời gian: ${new Date().toLocaleTimeString()}\n📈 Giá hiện tại: $${botState.lastPrice}\n💰 Số dư: $${botState.balance.toFixed(2)}\n🔄 Trạng thái: ${botState.inPosition ? 'Đang có vị thế' : 'Đang chờ sweep'}`;
    if (!botState.isRunning) msg += `\n⚠️ Lý do: Bot đang tạm dừng (Lỗi hoặc Pause)`;
    sendTelegram(msg);
  }, 1000 * 60 * 60 * 4);

  // Vite integration
  try {
    if (process.env.NODE_ENV !== "production") {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
      console.log("🛠 Vite middleware initialized");
    } else {
      const distPath = path.join(process.cwd(), "dist");
      if (fs.existsSync(distPath)) {
        app.use(express.static(distPath));
        app.get("*", (req, res) => {
          res.sendFile(path.join(distPath, "index.html"));
        });
      }
    }
  } catch (e) {
    console.error("Vite setup error:", e);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Trading Server running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket Listener: Active`);
    console.log(`🔗 Node version: ${process.version}`);
  });
}

startServer();
