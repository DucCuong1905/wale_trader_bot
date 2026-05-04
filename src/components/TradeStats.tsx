
import React, { useMemo, useState } from 'react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  Cell,
  Legend
} from 'recharts';
import { Calendar, ChevronDown } from 'lucide-react';

interface Trade {
  time: string | number;
  type?: string;
  status: string;
  price?: number;
  pnl?: number;
  balance?: number;
}

interface TradeStatsProps {
  trades: Trade[];
}

type Period = 'day' | 'week' | 'month';

export default function TradeStats({ trades }: TradeStatsProps) {
  const [period, setPeriod] = useState<Period>('day');

  const stats = useMemo(() => {
    const now = new Date();
    
    // Filter trades that have PnL and valid time
    const closedTrades = trades.filter(t => t.status === 'CLOSED' && t.pnl !== undefined && t.time);

    const getGroupKey = (date: Date, p: Period) => {
      if (isNaN(date.getTime())) return 'Invalid';
      if (p === 'day') {
        return date.toLocaleDateString();
      } else if (p === 'week') {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - d.getDay()); // Start of week (Sunday)
        return `Week ${d.toLocaleDateString()}`;
      } else {
        return `${date.getMonth() + 1}/${date.getFullYear()}`;
      }
    };

    const groupedData: Record<string, { name: string; win: number; loss: number; total: number }> = {};

    closedTrades.forEach(trade => {
      const tradeDate = new Date(trade.time);
      const key = getGroupKey(tradeDate, period);
      
      if (!groupedData[key]) {
        groupedData[key] = { name: key, win: 0, loss: 0, total: 0 };
      }
      
      if ((trade.pnl || 0) > 0) {
        groupedData[key].win += 1;
      } else if ((trade.pnl || 0) < 0) {
        groupedData[key].loss += 1;
      }
      groupedData[key].total += 1;
    });

    // Sort by date (keys might not be alphabetical)
    return Object.values(groupedData).reverse().slice(-10); // Last 10 periods
  }, [trades, period]);

  const totalWins = stats.reduce((acc, curr) => acc + curr.win, 0);
  const totalLosses = stats.reduce((acc, curr) => acc + curr.loss, 0);
  const winRate = totalWins + totalLosses > 0 ? (totalWins / (totalWins + totalLosses) * 100).toFixed(1) : "0.0";

  return (
    <div className="bg-[#0f0f13] border border-white/5 rounded-2xl p-6 shadow-xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Calendar className="w-5 h-5 text-blue-400" />
            Trade Performance
          </h3>
          <p className="text-xs text-gray-400">Win/Loss distribution by {period}</p>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex bg-white/5 p-1 rounded-lg">
            {(['day', 'week', 'month'] as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1 text-[10px] uppercase tracking-wider font-bold rounded-md transition-all ${
                  period === p ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          
          <div className="flex flex-col items-end">
            <span className="text-[10px] text-gray-500 uppercase font-bold tracking-widest">Win Rate</span>
            <span className={`text-xl font-black font-mono ${parseFloat(winRate) >= 50 ? 'text-green-400' : 'text-red-400'}`}>
              {winRate}%
            </span>
          </div>
        </div>
      </div>

      <div className="h-[300px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={stats}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.05)" />
            <XAxis 
              dataKey="name" 
              stroke="#4b5563" 
              fontSize={10} 
              axisLine={false} 
              tickLine={false}
              tickFormatter={(value) => value.split(' ').pop() || value}
            />
            <YAxis stroke="#4b5563" fontSize={10} axisLine={false} tickLine={false} />
            <Tooltip 
              cursor={{ fill: 'rgba(255,255,255,0.03)' }}
              contentStyle={{ backgroundColor: '#18181b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px' }} 
              itemStyle={{ fontSize: '12px' }}
            />
            <Legend iconType="circle" wrapperStyle={{ paddingTop: '20px', fontSize: '10px' }} />
            <Bar dataKey="win" name="Wins" fill="#10b981" radius={[4, 4, 0, 0]} />
            <Bar dataKey="loss" name="Losses" fill="#ef4444" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
        {stats.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500 opacity-50">Đang cập nhật hiệu suất...</p>
          </div>
        )}
      </div>
    </div>
  );
}
