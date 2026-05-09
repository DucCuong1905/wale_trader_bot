/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  TrendingUp, 
  TrendingDown, 
  Zap, 
  Shield, 
  Activity, 
  Wallet, 
  History, 
  Settings as SettingsIcon,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownRight,
  Brain,
  BarChart3
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  AreaChart,
  Area
} from 'recharts';
import TradeStats from './components/TradeStats';
import { cn } from './lib/utils';

// State for the app
export default function App() {
  const [data, setData] = useState<any>(null);
  const [lastPrice, setLastPrice] = useState(0);
  const [bidRatio, setBidRatio] = useState(1);
  const [signals, setSignals] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'live' | 'backtest'>('live');
  const [backtestStatus, setBacktestStatus] = useState<any>(null);
  const [isBacktestRunning, setIsBacktestRunning] = useState(false);
  const [startDate, setStartDate] = useState('2026-01-01');
  const [endDate, setEndDate] = useState('2026-03-31');
  const [backtestRR, setBacktestRR] = useState(1.2);
  const [backtestTimeframe, setBacktestTimeframe] = useState('15m');
  const [backtestSessionFilter, setBacktestSessionFilter] = useState(false);
  const [vwmaPeriod, setVwmaPeriod] = useState(20);

  useEffect(() => {
    let retryCount = 0;
    const maxRetries = 15; // Thử lại trong khoảng 7.5 giây trước khi báo lỗi cứng
    let timerId: any;

    const fetchData = async () => {
      try {
        const res = await fetch(`/api/trading/status?cache_bust=${Date.now()}`);
        
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Server báo lỗi ${res.status}`);
        }

        const contentType = res.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
          throw new Error("Dữ liệu không hợp lệ (Server đang khởi động)");
        }

        const json = await res.json();
        
        setData(json);
        setLastPrice(json.last_price);
        setBidRatio(parseFloat(json.bid_ratio));
        setSignals(json.signals);

        // Fetch history silently
        fetch('/api/trading/history')
          .then(r => r.json())
          .then(setHistory)
          .catch(() => {});

        setError(null);
        retryCount = 0;
      } catch (e: any) {
        if (e.name === 'AbortError') return;
        
        if (retryCount < maxRetries) {
          retryCount++;
          console.warn(`Fetch error, retrying ${retryCount}/${maxRetries}...`);
        } else {
          setError(`Mất kết nối với Engine: ${e.message}. Vui lòng kiểm tra cài đặt API Key Binance.`);
        }
      } finally {
        setLoading(false);
        timerId = setTimeout(fetchData, 1000);
      }
    };

    fetchData();
    
    // Poll backtest status
    const pollBacktest = async () => {
      try {
        const res = await fetch('/api/backtest/status');
        const json = await res.json();
        setBacktestStatus(json);
        setIsBacktestRunning(json.isRunning);
      } catch (e) {}
      setTimeout(pollBacktest, 2000);
    };
    pollBacktest();

    return () => {
      if (timerId) clearTimeout(timerId);
    };
  }, []);

  const addMockSignal = async () => {
    console.log("Monitoring active...");
  };

  const startBacktest = async () => {
    try {
      const response = await fetch('/api/backtest/run', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          startDate: `${startDate}T00:00:00Z`, 
          endDate: `${endDate}T23:59:59Z`, 
          rr: backtestRR,
          timeframe: backtestTimeframe,
          enableSessionFilter: backtestSessionFilter,
          vwmaPeriod: vwmaPeriod
        })
      });
      if (response.ok) {
        setIsBacktestRunning(true);
      } else {
        const err = await response.json();
        alert(`Không thể bắt đầu: ${err.error || 'Server đang bận'}`);
      }
    } catch (e) {
      alert("Lỗi kết nối khi khởi động Backtest");
    }
  };

  const toggleSession = async () => {
    try {
      await fetch('/api/trading/toggle-session', { method: 'POST' });
    } catch (e) {
      console.error("Lỗi khi chuyển đổi phiên:", e);
    }
  };

  const setBotVwma = async (period: number) => {
    try {
      await fetch('/api/trading/set-vwma', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period })
      });
    } catch (e) {
      console.error("Lỗi khi đặt VWMA:", e);
    }
  };

  const handleStopBacktest = async () => {
    try {
      setIsBacktestRunning(false); // Cập nhật ngay lập tức trên UI
      await fetch('/api/backtest/stop', { method: 'POST' });
    } catch (err) {
      console.error("Không thể dừng backtest:", err);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0c0c14] text-white flex items-center justify-center font-sans tracking-[0.2em] uppercase">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-6 shadow-[0_0_30px_rgba(59,130,246,0.3)]"></div>
          <p className="text-blue-400 animate-pulse font-mono text-xs font-bold">Đang nạp hệ thống...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#0c0c14] text-white flex items-center justify-center font-sans p-6">
        <div className="max-w-md w-full bg-red-500/10 border border-red-500/20 p-10 rounded-[2.5rem] text-center glow-red shadow-2xl shadow-red-500/5">
          <AlertTriangle className="w-16 h-16 text-red-500 mx-auto mb-6" />
          <h2 className="text-2xl font-black text-red-50 mb-2 uppercase tracking-tight">Lỗi Kết Nối</h2>
          <p className="text-sm text-red-200/60 mb-8 leading-relaxed font-medium">{error}</p>
          <button 
            onClick={() => window.location.reload()}
            className="w-full py-4 bg-red-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-red-500 transition-all active:scale-95 shadow-xl shadow-red-600/20"
          >
            Thử Kết Nối Lại
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0c0c14] text-slate-100 font-sans selection:bg-blue-500/30">
      {/* Header */}
      <header className="border-b border-white/10 bg-[#12121c]/90 backdrop-blur-2xl sticky top-0 z-50">
        <div className="max-w-[1400px] mx-auto px-8 h-20 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center shadow-2xl shadow-blue-500/40 glow-blue">
              <Zap className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="font-black text-2xl tracking-tighter leading-none uppercase italic text-white">WhaleBot <span className="text-blue-500 not-italic">5M Edition</span></h1>
              <span className="text-[10px] text-blue-400 font-mono tracking-[0.3em] uppercase opacity-90 font-black">Hệ Thống Phân Tích Cá Voi - KHUNG 5P</span>
            </div>
          </div>

            <div className="flex items-center gap-10">
              <button 
                onClick={toggleSession}
                className={cn(
                  "px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all border",
                  data?.enable_session_filter 
                    ? "bg-amber-500/10 border-amber-500/30 text-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.1)]" 
                    : "bg-white/5 border-white/10 text-slate-400 hover:text-slate-200"
                )}
              >
                SESSION: {data?.enable_session_filter ? "ON" : "OFF"}
              </button>

              <div className="flex bg-white/5 p-1 rounded-xl border border-white/10 items-center">
                 <button 
                    onClick={() => setBotVwma(20)}
                    className={cn(
                       "px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all",
                       data?.vwma_period === 20 ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20" : "text-slate-500 hover:text-slate-300"
                    )}
                 >
                    VWMA 20
                 </button>
                 <button 
                    onClick={() => setBotVwma(50)}
                    className={cn(
                       "px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all",
                       data?.vwma_period === 50 ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20" : "text-slate-500 hover:text-slate-300"
                    )}
                 >
                    VWMA 50
                 </button>
              </div>

              <div className="flex bg-white/5 p-1 rounded-2xl border border-white/10">
                <button 
                  onClick={() => setActiveTab('live')}
                  className={cn(
                    "px-6 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all",
                    activeTab === 'live' ? "bg-blue-600 text-white glow-blue" : "text-slate-500 hover:text-slate-300"
                  )}
                >
                  LIVE (ANALYSIS)
                </button>
                <button 
                  onClick={() => setActiveTab('backtest')}
                  className={cn(
                    "px-6 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all",
                    activeTab === 'backtest' ? "bg-purple-600 text-white glow-purple" : "text-slate-500 hover:text-slate-300"
                  )}
                >
                  BACKTEST (2025-2026)
                </button>
              </div>

              <div className="flex flex-col items-end">
              <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-1">Giá BTC/USDT</span>
              <span className="font-mono text-3xl font-black text-white tracking-tighter glow-blue">${(lastPrice || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>
            <div className="h-12 w-px bg-white/10 hidden sm:block" />
            <div className={cn(
              "flex items-center gap-3 px-5 py-2.5 rounded-2xl border transition-all duration-500",
              data?.is_ws_connected 
                ? "bg-green-500/10 border-green-500/30 glow-green shadow-inner" 
                : "bg-red-500/10 border-red-500/30 glow-red"
            )}>
              <div className={cn(
                "w-2.5 h-2.5 rounded-full shadow-lg",
                data?.is_ws_connected ? "bg-green-500 animate-pulse shadow-green-500/50" : "bg-red-500 shadow-red-500/50"
              )} />
              <span className={cn(
                "text-xs font-black uppercase tracking-widest",
                data?.is_ws_connected ? "text-green-400" : "text-red-400"
              )}>
                {data?.is_ws_connected ? "STREAMING" : "OFFLINE"}
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto p-6">
        {activeTab === 'live' ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* API Error Alert */}
            {data?.api_error && (
              <div className="lg:col-span-12">
                <motion.div 
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  className="bg-red-500/10 border border-red-500/30 p-5 rounded-[1.5rem] flex items-center gap-4 glow-red mb-2"
                >
                  <div className="p-2 bg-red-500 rounded-xl shadow-lg shadow-red-500/40">
                    <AlertTriangle className="w-5 h-5 text-white" />
                  </div>
                  <div className="flex-1">
                    <h4 className="text-xs font-black text-red-100 uppercase tracking-widest mb-0.5">CẢNH BÁO HỆ THỐNG GIAO DỊCH</h4>
                    <p className="text-sm text-red-200/80 font-medium leading-relaxed">{data.api_error}</p>
                  </div>
                  <div className="text-[10px] bg-red-500/20 px-3 py-1 rounded-full text-red-200 font-bold uppercase tracking-tight">
                    CHECK CONFIG
                  </div>
                </motion.div>
              </div>
            )}

            {/* Left Column: Stats & Main Chart */}
            <div className="lg:col-span-8 space-y-6">
              {/* Quick Stats Grid */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <StatCard 
                    label="Số Dư Tài Khoản" 
                    value={`$${(data?.balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`} 
                    change={data?.balance ? "+0.0%" : ""} 
                    positive={true} 
                    icon={<Wallet className="w-4 h-4" />} 
                  />
                  <StatCard 
                    label="Trạng Thái Bot" 
                    value={data?.status === 'running' ? 'Hoạt Động' : 'Nghỉ'} 
                    change={data?.in_position ? "ĐANG GIỮ LỆNH" : "ĐANG ĐỢI"} 
                    positive={data?.status === 'running'} 
                    icon={<TrendingUp className="w-4 h-4" />} 
                  />
                  <StatCard 
                    label="Sức Mạnh Xu Hướng" 
                    value={`ADX: ${data?.adx || '0.0'}`} 
                    subValue={`DI+: ${data?.plus_di || '0'} | DI-: ${data?.minus_di || '0'}`}
                    positive={(parseFloat(data?.adx) || 0) > 25}
                    icon={<BarChart3 className="w-4 h-4" />} 
                  />
                  <StatCard 
                    label="Tín Hiệu Cuối" 
                    value={signals[0]?.type || "Trống"} 
                    subValue={signals[0] ? `Tại ${signals[0].price}` : "Chưa có tín hiệu"}
                    icon={<Activity className="w-4 h-4" />} 
                  />
                </div>

              {/* Whale Real-time Trades Section */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-[#12121c] border border-emerald-500/20 p-6 rounded-[2rem] glow-green group hover:bg-emerald-500/5 transition-all">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-[10px] text-emerald-500 font-black uppercase tracking-[0.2em]">Whale Buy (5m)</p>
                    <div className="p-2 bg-emerald-500/10 rounded-lg">
                      <ArrowUpRight className="w-4 h-4 text-emerald-500" />
                    </div>
                  </div>
                  <p className="text-2xl font-mono text-emerald-400 font-black tracking-tighter">
                    ${(parseFloat((data as any)?.whale_trades?.buy || "0") / 1000000).toFixed(2)}M
                  </p>
                </div>
                <div className="bg-[#12121c] border border-red-500/20 p-6 rounded-[2rem] glow-red group hover:bg-red-500/5 transition-all">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-[10px] text-red-500 font-black uppercase tracking-[0.2em]">Whale Sell (5m)</p>
                    <div className="p-2 bg-red-500/10 rounded-lg">
                      <ArrowDownRight className="w-4 h-4 text-red-500" />
                    </div>
                  </div>
                  <p className="text-2xl font-mono text-red-400 font-black tracking-tighter">
                    ${(parseFloat((data as any)?.whale_trades?.sell || "0") / 1000000).toFixed(2)}M
                  </p>
                </div>
                <div className={cn(
                  "p-6 rounded-[2rem] group transition-all border",
                  (parseFloat((data as any)?.whale_trades?.buy || "0") - parseFloat((data as any)?.whale_trades?.sell || "0")) >= 0
                    ? "bg-[#12121c] border-blue-500/20 glow-blue hover:bg-blue-500/5"
                    : "bg-[#12121c] border-orange-500/20 glow-orange hover:bg-orange-500/5"
                )}>
                  <div className="flex items-center justify-between mb-4">
                    <p className={cn(
                      "text-[10px] font-black uppercase tracking-[0.2em]",
                      (parseFloat((data as any)?.whale_trades?.buy || "0") - parseFloat((data as any)?.whale_trades?.sell || "0")) >= 0
                        ? "text-blue-400"
                        : "text-orange-400"
                    )}>Whale Net (5m)</p>
                    <div className={cn(
                      "p-2 rounded-lg",
                      (parseFloat((data as any)?.whale_trades?.buy || "0") - parseFloat((data as any)?.whale_trades?.sell || "0")) >= 0
                        ? "bg-blue-500/10"
                        : "bg-orange-500/10"
                    )}>
                      <Activity className={cn(
                        "w-4 h-4",
                        (parseFloat((data as any)?.whale_trades?.buy || "0") - parseFloat((data as any)?.whale_trades?.sell || "0")) >= 0
                          ? "text-blue-400"
                          : "text-orange-400"
                      )} />
                    </div>
                  </div>
                  <p className={cn(
                    "text-2xl font-mono font-black tracking-tighter",
                    (parseFloat((data as any)?.whale_trades?.buy || "0") - parseFloat((data as any)?.whale_trades?.sell || "0")) >= 0
                      ? "text-blue-400"
                      : "text-orange-400"
                  )}>
                    {((parseFloat((data as any)?.whale_trades?.buy || "0") - parseFloat((data as any)?.whale_trades?.sell || "0")) / 1000000).toFixed(2)}M
                  </p>
                </div>
              </div>

              {/* Win/Loss Statistics Chart */}
              <TradeStats trades={history} />

              {/* Main Balance Chart */}
              <section className="glass-card rounded-[2rem] p-8 glow-blue relative overflow-hidden">
                <div className="flex items-center justify-between mb-10 relative z-10">
                  <div>
                    <h3 className="text-xl font-black uppercase tracking-tight text-white mb-1">Tăng Trưởng Tài Sản</h3>
                    <p className="text-xs text-slate-400 uppercase tracking-widest font-bold">Biểu đồ đường cong vốn</p>
                  </div>
              <div className="flex gap-2">
                    <button className="px-5 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-[10px] font-black uppercase tracking-widest transition-all">1H</button>
                    <button className="px-5 py-2 rounded-xl bg-blue-600 text-[10px] font-black uppercase tracking-widest transition-all shadow-lg shadow-blue-600/20 glow-blue">TẤT CẢ</button>
                  </div>
                </div>
                
                <div className="h-[350px] w-full relative z-10">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={history.filter(h => h.balance && h.time).reverse().map(h => ({
                      time: h.time ? new Date(h.time).toLocaleTimeString() : 'N/A',
                      balance: h.balance
                    }))}>
                      <defs>
                        <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4}/>
                          <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.08)" />
                      <XAxis dataKey="time" stroke="#94a3b8" fontSize={10} axisLine={false} tickLine={false} />
                      <YAxis hide={true} domain={['auto', 'auto']} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '16px', boxShadow: '0 10px 30px -10px rgba(0,0,0,0.5)' }} 
                        itemStyle={{ color: '#fff', fontSize: '12px', fontWeight: '800' }}
                      />
                      <Area 
                        type="monotone" 
                        dataKey="balance" 
                        stroke="#3b82f6" 
                        strokeWidth={4}
                        fillOpacity={1} 
                        fill="url(#colorBalance)" 
                        animationDuration={2500}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </section>

              {/* Recent Trades Table */}
              <section className="glass-card rounded-[2rem] overflow-hidden">
                <div className="p-8 border-b border-white/10 flex items-center gap-3">
                  <div className="p-2 bg-slate-800 rounded-lg">
                    <History className="w-5 h-5 text-blue-400" />
                  </div>
                  <h3 className="text-lg font-black uppercase tracking-tight">Nhật Ký Giao Dịch</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead className="bg-white/[0.02] text-[10px] uppercase tracking-[0.2em] text-slate-400">
                      <tr>
                        <th className="px-8 py-5 font-black">Thời Gian</th>
                        <th className="px-8 py-5 font-black">Loại Lệnh</th>
                        <th className="px-8 py-5 font-black">Chi Tiết Kỹ Thuật</th>
                        <th className="px-8 py-5 font-black text-right">Lợi Nhuận</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {history.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-8 py-16 text-center text-slate-500 text-sm font-medium">
                            Bot đang quét tín hiệu...
                          </td>
                        </tr>
                      ) : history.map((item, idx) => (
                        <tr key={idx} className="hover:bg-white/[0.03] transition-all group">
                          <td className="px-8 py-5 text-[11px] font-mono font-bold text-slate-400">
                            {item.time ? new Date(item.time).toLocaleString() : 'N/A'}
                          </td>
                          <td className="px-8 py-5">
                            <span className={cn(
                              "text-[9px] font-black px-3 py-1 rounded-lg border uppercase tracking-widest shadow-sm",
                              item.status === 'EXECUTED' ? "bg-blue-600/20 border-blue-500/40 text-blue-400" :
                              item.status === 'CLOSED' ? "bg-purple-600/20 border-purple-500/40 text-purple-400" :
                              "bg-slate-700/20 border-slate-600/40 text-slate-400"
                            )}>
                              {item.status === 'EXECUTED' ? 'KHỚP LỆNH' : item.status === 'CLOSED' ? 'HOÀN TẤT' : item.status}
                            </span>
                          </td>
                          <td className="px-8 py-5 font-mono text-[13px] text-slate-200">
                            {item.status === 'EXECUTED' && (
                              <div className="flex items-center gap-2">
                                <span className={item.type === 'LONG' ? "text-green-400" : "text-red-400"}>{item.type}</span>
                                <span>@ {item.price}</span>
                              </div>
                            )}
                            {item.status === 'CLOSED' && (
                              <span className="text-blue-300 font-bold">Lãi/Lỗ ròng: $${item.pnl?.toFixed(2)}</span>
                            )}
                          </td>
                          <td className={cn(
                            "px-8 py-5 text-right font-mono text-[15px] font-black",
                            item.pnl > 0 ? "text-green-400 glow-green" : item.pnl < 0 ? "text-red-400 glow-red" : "text-slate-500"
                          )}>
                            {item.pnl !== undefined ? `${item.pnl >= 0 ? '+' : ''}$${item.pnl.toFixed(2)}` : '--'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            {/* Right Column: Order Book & Signal Log */}
            <div className="lg:col-span-4 space-y-6">
              {/* Orderbook Analysis */}
              <section className="glass-card rounded-[2rem] p-8 glow-blue">
                <div className="flex items-center justify-between mb-8">
                  <h3 className="text-lg font-black uppercase tracking-tight flex items-center gap-3">
                    <Shield className="w-6 h-6 text-blue-400" />
                    Chỉ Báo Tâm Lý
                  </h3>
                  <span className="text-[10px] text-slate-500 font-mono font-bold tracking-widest">BINANCE.WS.FUTURES</span>
                </div>

                <div className="space-y-8">
                  <div className="flex justify-between text-[10px] font-black uppercase tracking-[0.2em]">
                    <span className="text-green-400 glow-green">Lực Mua</span>
                    <span className="text-red-400 glow-red">Lực Bán</span>
                  </div>
                  <div className="h-6 w-full bg-white/5 rounded-full flex overflow-hidden ring-4 ring-white/5 shadow-inner">
                    <motion.div 
                      className="bg-gradient-to-r from-green-600 to-green-400 h-full shadow-[0_0_15px_rgba(34,197,94,0.3)]"
                      initial={false}
                      animate={{ width: `${(bidRatio / (bidRatio + 1)) * 100}%` }}
                    />
                    <motion.div 
                      className="bg-gradient-to-l from-red-600 to-red-400 h-full shadow-[0_0_15px_rgba(239,68,68,0.3)]"
                      initial={false}
                      animate={{ width: `${(1 / (bidRatio + 1)) * 100}%` }}
                    />
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-5xl font-black font-mono tracking-tighter text-white glow-blue">{(bidRatio).toFixed(2)}</span>
                    <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest">Tỷ Lệ Sổ Lệnh</span>
                  </div>
                  {bidRatio > 1.5 && (
                    <div className="p-5 bg-green-500/10 border border-green-500/20 rounded-2xl flex items-center gap-4 glow-green">
                      <div className="p-2 bg-green-500 rounded-lg">
                        <TrendingUp className="w-5 h-5 text-white" />
                      </div>
                      <div>
                        <h4 className="text-xs font-black text-green-400 uppercase tracking-widest">Tích Lũy Mạnh</h4>
                        <p className="text-[10px] text-green-400/70 font-semibold">Phát hiện cá voi đang gom hàng quyết liệt</p>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* Real-time Signals */}
              <section className="glass-card rounded-[2rem] p-8 glow-blue">
                <div className="flex items-center justify-between mb-8">
                  <h3 className="text-lg font-black uppercase tracking-tight flex items-center gap-3 text-blue-400">
                    <Zap className="w-6 h-6" />
                    Dòng Tín Hiệu
                  </h3>
                  <button 
                    onClick={addMockSignal}
                    className="p-2 px-4 text-[10px] font-black uppercase tracking-widest bg-white/5 hover:bg-white/10 rounded-xl border border-white/10 transition-all active:scale-95"
                  >
                    LIVE FEED
                  </button>
                </div>

                <div className="space-y-4">
                  <AnimatePresence>
                    {signals.length === 0 ? (
                      <div className="text-center py-16 border-2 border-dashed border-white/5 rounded-[2rem]">
                        <div className="w-12 h-12 bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
                          <Activity className="w-6 h-6 text-slate-500" />
                        </div>
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Đang đồng bộ luồng...</p>
                      </div>
                    ) : signals.map((signal, idx) => (
                      <motion.div 
                        key={idx}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        className="p-5 bg-white/[0.03] border border-white/10 rounded-2xl flex items-center justify-between group cursor-pointer hover:bg-white/[0.08] transition-all hover:border-blue-500/30"
                      >
                        <div className="flex items-center gap-5">
                          <div className={cn(
                            "w-12 h-12 rounded-2xl flex items-center justify-center shadow-2xl transition-all group-hover:scale-110",
                            signal.type === 'LONG' ? "bg-green-600/20 shadow-green-500/20 text-green-400" : "bg-red-600/20 shadow-red-500/20 text-red-400"
                          )}>
                            {signal.type === 'LONG' ? <ArrowUpRight className="w-6 h-6" /> : <ArrowDownRight className="w-6 h-6" />}
                          </div>
                          <div>
                            <div className="flex items-center gap-3 mb-1">
                              <span className={cn("text-[10px] font-black tracking-[0.2em] uppercase", signal.type === 'LONG' ? "text-green-400" : "text-red-400")}>{signal.type}</span>
                              <span className="text-[10px] text-slate-500 font-mono font-bold">{signal.time}</span>
                            </div>
                            <p className="text-lg font-mono text-white font-black tracking-tighter">${signal.price.toLocaleString()}</p>
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </section>

              {/* Risk Warning */}
              <div className="p-6 bg-red-950/20 border border-red-500/20 rounded-2xl">
                <div className="flex items-center gap-3 mb-2">
                  <AlertTriangle className="w-5 h-5 text-red-500" />
                  <h4 className="text-sm font-bold text-red-500 uppercase tracking-wide">Quản Trị Rủi Ro</h4>
                </div>
                <p className="text-xs text-red-400/80 leading-relaxed">
                  Bot dựa trên các cú quét thanh khoản thực tế. Luôn kiểm tra lệnh SL đã được API xác nhận. Độ an toàn đòn bẩy hiện tại: <strong>THẤP</strong>.
                </p>
              </div>
            </div>
          </div>
        ) : (
           <div className="space-y-6">
              <div className="bg-[#12121c] p-10 rounded-[2.5rem] border border-white/5 glow-purple relative overflow-hidden">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center relative z-10">
                  <div>
                    <h2 className="text-3xl font-black uppercase italic tracking-tighter mb-4">Cấu Hình Backtest Pro</h2>
                    <div className="grid grid-cols-2 gap-4 mb-6">
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Từ ngày</label>
                        <input 
                          type="date" 
                          value={startDate} 
                          onChange={(e) => setStartDate(e.target.value)}
                          className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-xs font-mono focus:border-purple-500 transition-all outline-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Đến ngày</label>
                        <input 
                          type="date" 
                          value={endDate} 
                          onChange={(e) => setEndDate(e.target.value)}
                          className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-xs font-mono focus:border-purple-500 transition-all outline-none"
                        />
                      </div>
                      <div className="space-y-2 col-span-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Khung thời gian</label>
                        <select 
                          value={backtestTimeframe}
                          onChange={(e) => setBacktestTimeframe(e.target.value)}
                          className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-xs font-mono focus:border-purple-500 transition-all outline-none appearance-none"
                        >
                          <option value="1m">1 MINUTE (Scaping)</option>
                          <option value="5m">5 MINUTES (Scalp/Intraday)</option>
                          <option value="15m">15 MINUTES (Intraday)</option>
                          <option value="1h">1 HOUR (Swing)</option>
                          <option value="4h">4 HOURS (Swing)</option>
                          <option value="1d">1 DAY (Position)</option>
                        </select>
                      </div>
                      <div className="space-y-2 col-span-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Risk/Reward Ratio (1 : {backtestRR})</label>
                        <div className="flex items-center gap-4">
                          <input 
                            type="range" 
                            min="0.5" 
                            max="5" 
                            step="0.1" 
                            value={backtestRR} 
                            onChange={(e) => setBacktestRR(parseFloat(e.target.value))}
                            className="flex-1 accent-purple-500"
                          />
                          <span className="w-16 text-center font-mono font-black text-purple-400 bg-purple-500/10 rounded-lg py-1 border border-purple-500/30">1 : {backtestRR}</span>
                        </div>
                      </div>
                      <div className="space-y-2 col-span-2 flex items-center gap-4 bg-white/5 p-4 rounded-xl border border-white/10 mt-2">
                         <div className="flex-1">
                            <label className="text-[10px] font-black text-slate-300 uppercase tracking-widest block mb-1">Session Filter (London/NY)</label>
                            <p className="text-[9px] text-slate-500 font-bold uppercase">Chỉ vào lệnh từ 08:00 - 21:00 UTC</p>
                         </div>
                         <button 
                            onClick={() => setBacktestSessionFilter(!backtestSessionFilter)}
                            className={cn(
                               "w-12 h-6 rounded-full p-1 transition-all duration-300",
                               backtestSessionFilter ? "bg-purple-600 shadow-[0_0_15px_rgba(147,51,234,0.3)]" : "bg-white/10"
                            )}
                         >
                            <div className={cn(
                               "w-4 h-4 bg-white rounded-full transition-transform duration-300",
                               backtestSessionFilter ? "translate-x-6" : "translate-x-0"
                            )} />
                         </button>
                      </div>

                      <div className="space-y-2 col-span-2 flex items-center gap-4 bg-white/5 p-4 rounded-xl border border-white/10 mt-1">
                         <div className="flex-1">
                            <label className="text-[10px] font-black text-slate-300 uppercase tracking-widest block mb-1">VWMA Period</label>
                            <p className="text-[9px] text-slate-500 font-bold uppercase">Chọn chu kỳ đường trung bình (20 hoặc 50)</p>
                         </div>
                         <div className="flex bg-black/40 rounded-lg p-1 border border-white/5">
                            <button 
                               onClick={() => setVwmaPeriod(20)}
                               className={cn(
                                  "px-3 py-1 rounded-md text-[9px] font-black tracking-widest transition-all",
                                  vwmaPeriod === 20 ? "bg-purple-600 text-white" : "text-slate-500 hover:text-slate-300"
                               )}
                            >
                               20
                            </button>
                            <button 
                               onClick={() => setVwmaPeriod(50)}
                               className={cn(
                                  "px-3 py-1 rounded-md text-[9px] font-black tracking-widest transition-all",
                                  vwmaPeriod === 50 ? "bg-purple-600 text-white" : "text-slate-500 hover:text-slate-300"
                               )}
                            >
                               50
                            </button>
                         </div>
                      </div>
                    </div>
                    <p className="text-slate-500 text-[10px] uppercase tracking-widest font-bold">
                       Hệ thống sẽ fetch dữ liệu trực tiếp từ Binance Futures (M5).
                    </p>
                  </div>

                  <div className="flex flex-col items-center lg:items-end justify-center">
                    {isBacktestRunning ? (
                      <div className="flex flex-col items-end gap-3 w-full max-w-xs">
                         <div className="flex items-center justify-between w-full">
                            <div className="flex items-center gap-3">
                               <div className="w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
                               <span className="text-xs font-black text-purple-400 uppercase tracking-widest animate-pulse">Running ({Math.round(backtestStatus?.progress || 0)}%)</span>
                            </div>
                            <button 
                              onClick={handleStopBacktest}
                              className="px-4 py-1.5 bg-red-600/20 hover:bg-red-600 border border-red-500/30 text-red-500 hover:text-white text-[9px] font-black uppercase tracking-widest rounded-lg transition-all active:scale-95 shadow-lg shadow-red-500/10"
                            >
                              Dừng Backtest
                            </button>
                         </div>
                         <div className="w-full h-3 bg-white/5 rounded-full overflow-hidden p-0.5 border border-white/10">
                            <motion.div 
                              className="h-full bg-gradient-to-r from-purple-600 to-blue-500 rounded-full shadow-[0_0_20px_rgba(168,85,247,0.5)]"
                              initial={{ width: 0 }}
                              animate={{ width: `${backtestStatus?.progress || 0}%` }}
                            />
                         </div>
                      </div>
                    ) : (
                      <button 
                        onClick={startBacktest}
                        className="group relative px-12 py-6 bg-purple-600 hover:bg-purple-500 text-white rounded-[2rem] text-xs font-black uppercase tracking-[0.3em] shadow-2xl shadow-purple-600/30 transition-all active:scale-95 overflow-hidden"
                      >
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-1000" />
                        KHỞI ĐỘNG KIỂM THỬ
                      </button>
                    )}
                  </div>
                </div>
                <div className="absolute top-0 right-0 w-96 h-96 bg-purple-600/5 blur-[120px] -mr-48 -mt-48 rounded-full" />
              </div>

             {backtestStatus?.lastResult && (
               <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                  {backtestStatus.lastResult.isLiquidated && (
                    <div className="lg:col-span-12">
                      <motion.div 
                        initial={{ scale: 0.9, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="bg-red-600/20 border-2 border-red-500 p-8 rounded-[2.5rem] flex items-center gap-8 glow-red mb-2"
                      >
                        <div className="p-4 bg-red-600 rounded-2xl shadow-[0_0_30px_rgba(239,68,68,0.5)]">
                          <AlertTriangle className="w-10 h-10 text-white" />
                        </div>
                        <div>
                          <h3 className="text-2xl font-black text-red-500 uppercase tracking-tighter mb-1">CẢNH BÁO: CHÁY TÀI KHOẢN (MARGIN CALL)</h3>
                          <p className="text-red-200/80 font-medium leading-relaxed">
                            Tài khoản đã chạm mức thanh lý (<span className="font-mono font-black">$10</span>) vào lúc <span className="font-mono font-black text-white">{new Date(backtestStatus.lastResult.liquidationDate).toLocaleString()}</span>. 
                            Hệ thống đã tự động dừng kiểm thử để bảo vệ dữ liệu.
                          </p>
                        </div>
                      </motion.div>
                    </div>
                  )}
                  <div className="lg:col-span-4 space-y-6">
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                       <div className="bg-[#12121c] p-6 rounded-[2rem] border border-white/5">
                          <p className="text-[10px] text-slate-500 font-black uppercase mb-2">Tổng Giao Dịch</p>
                          <p className="text-3xl font-mono font-black">{backtestStatus.lastResult.totalTrades}</p>
                       </div>
                       <div className="bg-[#12121c] p-6 rounded-[2rem] border border-white/5">
                          <p className="text-[10px] text-slate-500 font-black uppercase mb-2">Tỷ Lệ Thắng</p>
                          <p className="text-3xl font-mono font-black text-green-400">
                             {backtestStatus.lastResult.totalTrades > 0 
                               ? Math.round((backtestStatus.lastResult.wins / backtestStatus.lastResult.totalTrades) * 100) 
                               : 0}%
                          </p>
                       </div>
                       <div className="bg-[#12121c] p-6 rounded-[2rem] border border-white/5">
                          <p className="text-[10px] text-slate-500 font-black uppercase mb-2">Trung Bình PnL</p>
                          <p className="text-3xl font-mono font-black text-blue-400">
                             {backtestStatus.lastResult.totalTrades > 0 
                               ? (backtestStatus.lastResult.totalPnL / backtestStatus.lastResult.totalTrades).toFixed(2) 
                               : 0}R
                          </p>
                       </div>
                    </div>

                    <div className={cn(
                        "bg-[#12121c] p-8 rounded-[2rem] border transition-all",
                        backtestStatus.lastResult.totalPnL >= 0 
                          ? "border-emerald-500/20 glow-green" 
                          : "border-red-500/20 glow-red"
                      )}>
                       <p className={cn(
                          "text-[10px] font-black uppercase mb-4 tracking-widest",
                          backtestStatus.lastResult.totalPnL >= 0 ? "text-emerald-500" : "text-red-500"
                       )}>Tổng Tỷ Lệ Lợi Nhuận: {(backtestStatus.lastResult.totalPnL || 0).toFixed(1)}R</p>
                       <div className="flex items-end gap-3">
                          <p className={cn(
                            "text-6xl font-mono font-black",
                            backtestStatus.lastResult.totalPnL >= 0 ? "text-emerald-400" : "text-red-400"
                          )}>{backtestStatus.lastResult.totalPnL > 0 ? '+' : ''}{backtestStatus.lastResult.totalPnL.toFixed(1)}R</p>
                       </div>
                    </div>

                    <div className={cn(
                        "bg-[#12121c] p-8 rounded-[2rem] border transition-all",
                        backtestStatus.lastResult.finalBalance >= 2000 
                          ? "border-blue-500/20 glow-blue shadow-[0_0_20px_rgba(59,130,246,0.1)]" 
                          : "border-red-500/20 glow-red shadow-[0_0_20px_rgba(239,68,68,0.1)]"
                      )}>
                       <p className={cn(
                          "text-[10px] font-black uppercase mb-4 tracking-widest",
                          backtestStatus.lastResult.finalBalance >= 2000 ? "text-blue-500" : "text-red-500"
                       )}>Số Dư Cuối Cùng</p>
                       <div className="flex items-end gap-3">
                          <p className={cn(
                            "text-4xl font-mono font-black",
                            backtestStatus.lastResult.finalBalance >= 2000 ? "text-blue-400" : "text-red-400"
                          )}>
                            ${backtestStatus.lastResult.finalBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </p>
                          <p className={cn(
                            "text-sm font-bold mb-2 uppercase",
                            backtestStatus.lastResult.finalBalance >= 2000 ? "text-blue-600" : "text-red-600"
                          )}>USD</p>
                       </div>
                    </div>
                  </div>

                  <div className="lg:col-span-8 bg-[#12121c] rounded-[2rem] border border-white/5 overflow-hidden">
                     <div className="p-8 border-b border-white/5 flex items-center justify-between">
                        <h3 className="text-lg font-black uppercase">Nhật Ký Backtest</h3>
                        <div className="flex items-center gap-4 text-[10px] font-bold">
                           <span className="flex items-center gap-1.5"><div className="w-2 h-2 bg-green-500 rounded-full" /> WIN: {backtestStatus.lastResult.wins}</span>
                           <span className="flex items-center gap-1.5"><div className="w-2 h-2 bg-red-500 rounded-full" /> LOSS: {backtestStatus.lastResult.losses}</span>
                        </div>
                     </div>
                     <div className="max-h-[600px] overflow-y-auto">
                        <table className="w-full text-left">
                           <thead className="bg-white/[0.02] text-[10px] uppercase font-black text-slate-500">
                              <tr>
                                 <th className="px-8 py-4">Thời Gian</th>
                                 <th className="px-8 py-4">Lệnh</th>
                                 <th className="px-8 py-4">Lý Do</th>
                                 <th className="px-8 py-4 text-right">PnL</th>
                              </tr>
                           </thead>
                           <tbody className="divide-y divide-white/5">
                              {backtestStatus.lastResult.trades.map((t: any, i: number) => (
                                <tr key={i} className="hover:bg-white/[0.02] transition-all">
                                   <td className="px-8 py-4 text-[11px] font-mono whitespace-nowrap">{new Date(t.time).toLocaleString()}</td>
                                   <td className="px-8 py-4">
                                      <span className={cn(
                                        "text-[9px] font-black px-2 py-0.5 rounded border uppercase",
                                        t.type === 'LONG' ? "text-green-400 border-green-500/30" : "text-red-400 border-red-500/30"
                                      )}>{t.type}</span>
                                   </td>
                                   <td className="px-8 py-4 text-xs text-slate-300 italic">"{t.reason}"</td>
                                   <td className={cn(
                                     "px-8 py-4 text-right font-mono font-black",
                                     (t.pnlR !== undefined ? t.pnlR : t.pnl) > 0 ? "text-green-400" : "text-red-400"
                                   )}>
                                      {t.pnlR !== undefined ? (t.pnlR > 0 ? `+${t.pnlR}R` : `${t.pnlR}R`) : (t.pnl > 0 ? `+${t.pnl}R` : `${t.pnl}R`)}
                                   </td>
                                </tr>
                              ))}
                           </tbody>
                        </table>
                     </div>
                  </div>
               </div>
             )}
          </div>
        )}
      </main>

      <footer className="max-w-[1400px] mx-auto px-6 py-8 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-4">
        <p className="text-xs text-gray-500">© 2026 WhaleBot. Hệ thống hỗ trợ quyết định giao dịch.</p>
        <div className="flex items-center gap-6">
          <FooterItem label="GIAO THỨC" value="WebSocket/CCXT" />
          <FooterItem label="ĐỘ TRỄ" value="42ms" />
          <FooterItem label="MÃ NGUỒN" value="v2.1" />
        </div>
      </footer>
    </div>
  );
}

function StatCard({ label, value, change, positive, subValue, icon }: { label: string, value: string, change?: string, positive?: boolean, subValue?: string, icon: React.ReactNode }) {
  return (
    <div className="glass-card p-6 md:p-7 rounded-[2rem] hover:border-blue-500/30 transition-all group relative overflow-hidden glow-blue">
      <div className="absolute top-0 right-0 p-5 opacity-10 group-hover:opacity-20 group-hover:scale-125 transition-all duration-500 text-blue-400">
        {icon}
      </div>
      <p className="text-[9px] text-slate-400 font-black uppercase tracking-[0.2em] mb-4 opacity-70">{label}</p>
      <div className="flex flex-col gap-2">
        <h4 className="text-2xl font-black tracking-tight text-white leading-tight break-words">{value}</h4>
        {change && (
          <div className="flex">
            <span className={cn(
              "text-[9px] font-black px-2 py-0.5 rounded-lg border uppercase tracking-widest shadow-lg", 
              positive ? "bg-green-500/20 border-green-500/30 text-green-400" : "bg-red-500/20 border-red-500/30 text-red-400"
            )}>
              {change}
            </span>
          </div>
        )}
      </div>
      {subValue && (
        <div className="mt-4 flex items-center gap-2 pt-3 border-t border-white/5">
           <div className={cn("w-1 h-1 rounded-full animate-pulse", positive ? "bg-green-400 shadow-[0_0_8px_#4ade80]" : "bg-red-400")}></div>
           <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest leading-tight">{subValue}</p>
        </div>
      )}
    </div>
  );
}

function FooterItem({ label, value }: { label: string, value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-gray-600 font-bold uppercase tracking-widest">{label}</span>
      <span className="text-[10px] text-gray-400 font-mono">{value}</span>
    </div>
  );
}
