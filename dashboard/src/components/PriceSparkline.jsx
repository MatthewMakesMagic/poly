import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AreaChart, Area, ResponsiveContainer, Tooltip, YAxis } from 'recharts';

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const MAX_POINTS = 60;
const FETCH_INTERVAL_MS = 5000;

const SYMBOL_COLORS = {
  BTC: '#fbbf24',
  ETH: '#a78bfa',
  SOL: '#22d3ee',
  XRP: '#60a5fa',
};

function formatPrice(price) {
  if (price == null) return '--';
  if (price >= 1000) return `$${Number(price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (price >= 1) return `$${Number(price).toFixed(2)}`;
  return `$${Number(price).toFixed(4)}`;
}

export default React.memo(function PriceSparkline() {
  const [activeSymbol, setActiveSymbol] = useState('BTC');
  const [buffers, setBuffers] = useState(() => {
    const init = {};
    for (const s of SYMBOLS) init[s] = [];
    return init;
  });
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;

  const fetchPrices = useCallback(async () => {
    try {
      const res = await fetch('/api/instruments');
      if (!res.ok) return;
      const { instruments } = await res.json();
      if (!instruments) return;

      setBuffers(prev => {
        const next = { ...prev };
        const now = Date.now();
        for (const sym of SYMBOLS) {
          const key = sym.toLowerCase();
          const inst = instruments[key];
          if (!inst) continue;

          // Prefer chainlink oracle, fall back to polymarket ref, then any exchange
          let price = inst.oraclePrices?.chainlink?.price
            ?? inst.oraclePrices?.polymarketRef?.price
            ?? null;

          if (price == null && inst.exchangePrices) {
            const exchanges = Object.values(inst.exchangePrices);
            if (exchanges.length > 0) price = exchanges[0].price;
          }

          if (price == null) continue;

          const buf = [...prev[sym], { time: now, price: Number(price) }];
          if (buf.length > MAX_POINTS) buf.splice(0, buf.length - MAX_POINTS);
          next[sym] = buf;
        }
        return next;
      });
    } catch {
      // silently skip fetch errors
    }
  }, []);

  useEffect(() => {
    fetchPrices();
    const id = setInterval(fetchPrices, FETCH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchPrices]);

  const data = buffers[activeSymbol] || [];
  const currentPrice = data.length > 0 ? data[data.length - 1].price : null;
  const firstPrice = data.length > 0 ? data[0].price : null;
  const delta = currentPrice != null && firstPrice != null ? currentPrice - firstPrice : null;
  const deltaPct = delta != null && firstPrice > 0 ? (delta / firstPrice) * 100 : null;
  const color = SYMBOL_COLORS[activeSymbol] || '#34d399';
  const deltaColor = delta > 0 ? 'text-accent-green' : delta < 0 ? 'text-accent-red' : 'text-white/50';
  const gradientId = `sparkGrad-${activeSymbol}`;

  return (
    <div className="glass p-4" style={{ width: '100%', maxWidth: 320 }}>
      {/* Symbol tabs */}
      <div className="flex items-center gap-1.5 mb-3">
        {SYMBOLS.map(sym => (
          <button
            key={sym}
            onClick={() => setActiveSymbol(sym)}
            className={`text-[10px] font-semibold px-2 py-0.5 rounded-full transition-colors ${
              activeSymbol === sym
                ? 'text-white'
                : 'text-white/30 hover:text-white/60'
            }`}
            style={activeSymbol === sym ? {
              backgroundColor: `${SYMBOL_COLORS[sym]}22`,
              border: `1px solid ${SYMBOL_COLORS[sym]}44`,
              color: SYMBOL_COLORS[sym],
            } : { border: '1px solid transparent' }}
          >
            {sym}
          </button>
        ))}
      </div>

      {/* Price display */}
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-xl font-bold text-white">
          {formatPrice(currentPrice)}
        </span>
        {delta != null && (
          <span className={`text-xs font-semibold ${deltaColor}`}>
            {delta >= 0 ? '+' : ''}{formatPrice(Math.abs(delta)).replace('$', '')}
            {deltaPct != null && (
              <span className="text-white/25 ml-1">
                ({deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(2)}%)
              </span>
            )}
          </span>
        )}
      </div>

      {/* Chart */}
      {data.length >= 2 ? (
        <ResponsiveContainer width="100%" height={80}>
          <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis domain={['dataMin', 'dataMax']} hide />
            <Tooltip
              contentStyle={{
                backgroundColor: 'rgba(15, 23, 42, 0.9)',
                backdropFilter: 'blur(12px)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                fontSize: '10px',
                color: 'rgba(255,255,255,0.8)',
              }}
              formatter={(value) => [formatPrice(value), activeSymbol]}
              labelFormatter={() => ''}
            />
            <Area
              type="monotone"
              dataKey="price"
              stroke={color}
              strokeWidth={1.5}
              fill={`url(#${gradientId})`}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-[80px] flex items-center justify-center">
          <span className="text-[10px] text-white/20">Collecting data...</span>
        </div>
      )}
    </div>
  );
});
