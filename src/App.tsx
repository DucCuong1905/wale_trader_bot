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
  Brain
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

// State for the app
export default function App() {
  const [data, setData] = useState<any>(null);
  const [lastPrice, setLastPrice] = useState(0);
  const [bidRatio, setBidRatio] = useState(1);
  const [signals, setSignals] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/trading/status');
        if (!res.ok) throw new Error(`Status API error: ${res.status}`);
        const json = await res.json();
        setData(json);
        setLastPrice(json.last_price);
        setBidRatio(parseFloat(json.bid_ratio));
        setSignals(json.signals);

        try {
          const histRes = await fetch('/api/trading/history');
          if (histRes.ok) {
            const histJson = await histRes.json();
            setHistory(histJson);
          }
        } catch (hErr) {
          console.warn("History fetch failed, but status ok", hErr);
        }
        
        setError(null);
      } catch (e) {
        console.error("Failed to fetch status:", e);
        setError("Could not connect to Trading Engine. Please check if the server is running on port 3000.");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, []);

  const addMockSignal = async () => {
    // This is just a UI interaction now since the server handles the real signals
    console.log("Monitoring active...");
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0c] text-white flex items-center justify-center font-sans">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-400 animate-pulse font-mono text-xs tracking-widest uppercase">Initializing Neural Engine...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#0a0a0c] text-white flex items-center justify-center font-sans p-6">
        <div className="max-w-md w-full bg-red-500/10 border border-red-500/20 p-8 rounded-3xl text-center">
          <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-red-400 mb-2">Connection Failure</h2>
          <p className="text-sm text-red-400/70 mb-6">{error}</p>
          <button 
            onClick={() => window.location.reload()}
            className="px-6 py-2 bg-red-500 text-white rounded-full text-sm font-bold hover:bg-red-600 transition-colors"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0c] text-white font-sans selection:bg-blue-500/30">
      {/* Header */}
      <header className="border-b border-white/5 bg-[#0f0f13]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-[1400px] mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-500/20">
              <Zap className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-lg leading-none">WhaleBot <span className="text-blue-500">v2.1</span></h1>
              <span className="text-[10px] text-blue-400 font-mono tracking-widest uppercase opacity-70">Deep Liquidity Engine</span>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className="flex flex-col items-end">
              <span className="text-xs text-gray-400 font-medium">BTC/USDT</span>
              <span className="font-mono text-lg font-bold">${lastPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>
            <div className="h-8 w-px bg-white/10 hidden sm:block" />
            <div className="flex items-center gap-2 bg-green-500/10 px-3 py-1.5 rounded-full border border-green-500/20">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              <span className="text-xs font-semibold text-green-400"> LIVE API</span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Stats & Main Chart */}
        <div className="lg:col-span-8 space-y-6">
          {/* Quick Stats Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard 
              label="Account Balance" 
              value={`$${(data?.balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`} 
              change={data?.balance ? "+0.0%" : ""} 
              positive={true} 
              icon={<Wallet className="w-4 h-4" />} 
            />
            <StatCard 
              label="Bot Status" 
              value={data?.status === 'running' ? 'Active' : 'Idle'} 
              change={data?.in_position ? "POSITION OPEN" : "WAITING"} 
              positive={data?.status === 'running'} 
              icon={<TrendingUp className="w-4 h-4" />} 
            />
            <StatCard 
              label="Last Detect" 
              value={signals[0]?.type || "None"} 
              subValue={signals[0] ? `At ${signals[0].price}` : "No signals yet"}
              icon={<Activity className="w-4 h-4" />} 
            />
          </div>

          {/* AI Analysis Section */}
          <div className="mt-8 p-6 bg-blue-500/10 border border-blue-500/20 rounded-2xl">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-blue-600 rounded-lg shadow-[0_0_15px_rgba(37,99,235,0.4)]">
                <Brain className="w-5 h-5 text-white" />
              </div>
              <h3 className="font-semibold text-blue-100">AI Market Context Analysis</h3>
            </div>
            <p className="text-blue-100/70 text-sm italic leading-relaxed">
              "{data?.ai_reasoning || 'Waiting for the next signal to analyze market context with Gemini AI...'}"
            </p>
          </div>

          {/* Main Balance Chart */}
          <section className="bg-[#0f0f13] border border-white/5 rounded-2xl p-6 shadow-xl relative overflow-hidden">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h3 className="text-lg font-semibold">Growth Performance</h3>
                <p className="text-sm text-gray-400">Track your equity curve over time</p>
              </div>
              <div className="flex gap-2">
                <button className="px-3 py-1 rounded-md bg-white/5 hover:bg-white/10 text-xs transition-colors">1H</button>
                <button className="px-3 py-1 rounded-md bg-blue-600 text-xs transition-colors font-semibold">ALL</button>
              </div>
            </div>
            
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={history.filter(h => h.balance).reverse().map(h => ({
                  time: new Date(h.time).toLocaleTimeString(),
                  balance: h.balance
                }))}>
                  <defs>
                    <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="time" stroke="#4b5563" fontSize={10} axisLine={false} tickLine={false} />
                  <YAxis hide={true} domain={['auto', 'auto']} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#18181b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px' }} 
                    itemStyle={{ color: '#fff' }}
                  />
                  <Area 
                    type="monotone" 
                    dataKey="balance" 
                    stroke="#3b82f6" 
                    strokeWidth={2}
                    fillOpacity={1} 
                    fill="url(#colorBalance)" 
                    animationDuration={2000}
                  />
                </AreaChart>
              </ResponsiveContainer>
              {history.filter(h => h.balance).length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#0f0f13]/50">
                  <p className="text-sm text-gray-500">No balance history recorded yet.</p>
                </div>
              )}
            </div>
          </section>

          {/* Recent Trades Table */}
          <section className="bg-[#0f0f13] border border-white/5 rounded-2xl overflow-hidden">
            <div className="p-6 border-b border-white/5 flex items-center gap-2">
              <History className="w-5 h-5 text-gray-400" />
              <h3 className="font-semibold">Execution History</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-white/2 text-[10px] uppercase tracking-wider text-gray-400">
                  <tr>
                    <th className="px-6 py-4 font-semibold">Time</th>
                    <th className="px-6 py-4 font-semibold">Type</th>
                    <th className="px-6 py-4 font-semibold">Details</th>
                    <th className="px-6 py-4 font-semibold text-right">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {history.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-6 py-12 text-center text-gray-500 text-sm">
                        No trade history available yet.
                      </td>
                    </tr>
                  ) : history.map((item, idx) => (
                    <tr key={idx} className="hover:bg-white/[0.02] transition-colors group">
                      <td className="px-6 py-4 text-xs font-mono text-gray-400">
                        {new Date(item.time).toLocaleString()}
                      </td>
                      <td className="px-6 py-4">
                        <span className={cn(
                          "text-[10px] font-bold px-2 py-0.5 rounded-full border",
                          item.status === 'EXECUTED' ? "bg-blue-500/10 border-blue-500/30 text-blue-400" :
                          item.status === 'CLOSED' ? "bg-purple-500/10 border-purple-500/30 text-purple-400" :
                          "bg-gray-500/10 border-gray-500/30 text-gray-400"
                        )}>
                          {item.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 font-mono text-sm">
                        {item.status === 'EXECUTED' && `${item.type} @ ${item.price}`}
                        {item.status === 'CLOSED' && `PnL: $${item.pnl?.toFixed(2)}`}
                        {item.status === 'AI_REJECTED' && `REJECTED: ${item.reason}`}
                      </td>
                      <td className={cn(
                        "px-6 py-4 text-right font-mono text-sm font-bold",
                        item.pnl > 0 ? "text-green-400" : item.pnl < 0 ? "text-red-400" : "text-gray-400"
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
          <section className="bg-[#0f0f13] border border-white/5 rounded-2xl p-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-semibold flex items-center gap-2">
                <Shield className="w-5 h-5 text-blue-400" />
                Sentiment Engine
              </h3>
              <span className="text-[10px] text-gray-500 font-mono tracking-tighter">BITGET.WS.V2</span>
            </div>

            <div className="space-y-6">
              <div className="flex justify-between text-xs mb-2">
                <span className="text-green-400 font-bold uppercase tracking-widest">Buy Pressure</span>
                <span className="text-red-400 font-bold uppercase tracking-widest">Sell Pressure</span>
              </div>
              <div className="h-4 w-full bg-white/5 rounded-full flex overflow-hidden ring-4 ring-white/2">
                <motion.div 
                  className="bg-gradient-to-r from-green-600 to-green-400 h-full"
                  initial={false}
                  animate={{ width: `${(bidRatio / (bidRatio + 1)) * 100}%` }}
                />
                <motion.div 
                  className="bg-gradient-to-l from-red-600 to-red-400 h-full"
                  initial={false}
                  animate={{ width: `${(1 / (bidRatio + 1)) * 100}%` }}
                />
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-3xl font-bold font-mono tracking-tighter">{(bidRatio).toFixed(2)}</span>
                <span className="text-xs text-gray-400">Orderbook Ratio</span>
              </div>
              {bidRatio > 1.5 && (
                <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-xl flex items-center gap-3">
                  <TrendingUp className="w-5 h-5 text-green-400" />
                  <div>
                    <h4 className="text-xs font-bold text-green-400 uppercase tracking-wide">Heavy Accumulation</h4>
                    <p className="text-[10px] text-green-400/70">Whale buying detected in lower books</p>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Real-time Signals */}
          <section className="bg-[#0f0f13] border border-white/5 rounded-2xl p-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-semibold flex items-center gap-2 text-blue-400">
                <Zap className="w-5 h-5" />
                Signal Log
              </h3>
              <button 
                onClick={addMockSignal}
                className="p-1 px-2 text-[10px] font-bold bg-white/5 hover:bg-white/10 rounded transition-all active:scale-95"
              >
                TEST DETECT
              </button>
            </div>

            <div className="space-y-3">
              <AnimatePresence>
                {signals.length === 0 ? (
                  <div className="text-center py-12 border-2 border-dashed border-white/5 rounded-xl">
                    <p className="text-xs text-gray-500">Waiting for liquidity sweep...</p>
                  </div>
                ) : signals.map((signal, idx) => (
                  <motion.div 
                    key={idx}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="p-4 bg-white/5 border border-white/5 rounded-xl flex items-center justify-between group cursor-pointer hover:bg-white/[0.08] transition-all"
                  >
                    <div className="flex items-center gap-4">
                      <div className={cn(
                        "w-10 h-10 rounded-full flex items-center justify-center shadow-lg",
                        signal.type === 'LONG' ? "bg-green-500/20 shadow-green-500/20" : "bg-red-500/20 shadow-red-500/20"
                      )}>
                        {signal.type === 'LONG' ? <ArrowUpRight className="text-green-400" /> : <ArrowDownRight className="text-red-400" />}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={cn("text-xs font-black tracking-widest", signal.type === 'LONG' ? "text-green-400" : "text-red-400")}>{signal.type}</span>
                          <span className="text-[10px] text-gray-500 font-mono">{signal.time}</span>
                        </div>
                        <p className="text-xs font-mono text-gray-300">${signal.price.toFixed(1)}</p>
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
              <h4 className="text-sm font-bold text-red-500 uppercase tracking-wide">Risk Management</h4>
            </div>
            <p className="text-xs text-red-400/80 leading-relaxed">
              Bot logic depends on external liquidity sweeps. Always verify SL is confirmed by API before leaving unattended. Current leverage safety: <strong>Low</strong>.
            </p>
          </div>
        </div>
      </main>

      {/* Footer / Connection Status */}
      <footer className="max-w-[1400px] mx-auto px-6 py-8 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-4">
        <p className="text-xs text-gray-500">© 2024 WhaleTrade. Licensed for algorithmic use only.</p>
        <div className="flex items-center gap-6">
          <FooterItem label="IP" value="152.42.***.***" />
          <FooterItem label="Latency" value="42ms" />
          <FooterItem label="Uptime" value="99.9%" />
        </div>
      </footer>
    </div>
  );
}

function StatCard({ label, value, change, positive, subValue, icon }: { label: string, value: string, change?: string, positive?: boolean, subValue?: string, icon: React.ReactNode }) {
  return (
    <div className="bg-[#0f0f13] border border-white/5 p-6 rounded-2xl hover:border-white/10 transition-colors group relative overflow-hidden">
      <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
        {icon}
      </div>
      <p className="text-xs text-gray-400 font-medium mb-1">{label}</p>
      <div className="flex items-baseline gap-2">
        <h4 className="text-2xl font-bold tracking-tight">{value}</h4>
        {change && (
          <span className={cn("text-xs font-bold", positive ? "text-green-400" : "text-red-400")}>
            {change}
          </span>
        )}
      </div>
      {subValue && <p className="text-[10px] text-gray-500 mt-2 font-mono">{subValue}</p>}
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

function cn(...inputs: any[]) {
  return inputs.filter(Boolean).join(' ');
}
