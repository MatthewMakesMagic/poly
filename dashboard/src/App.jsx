import React, { useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket.js';
import HealthBar from './components/HealthBar.jsx';
import CommandCenter from './views/CommandCenter.jsx';
import RiskDashboard from './views/RiskDashboard.jsx';
import InstrumentDeepDive from './views/InstrumentDeepDive.jsx';
import TradeHistory from './views/TradeHistory.jsx';

const VIEWS = [
  { key: 'command', label: 'Command Center', icon: '\u25C9' },
  { key: 'instruments', label: 'Instruments', icon: '\u25CE' },
  { key: 'risk', label: 'Risk', icon: '\u25B2' },
  { key: 'trades', label: 'History', icon: '\u2630' },
];

export default function App() {
  const { state, events, connected } = useWebSocket();
  const [activeView, setActiveView] = useState('command');

  return (
    <div className="min-h-screen flex flex-col">
      {/* System health bar - always visible */}
      <HealthBar state={state} connected={connected} />

      {/* Navigation */}
      <nav className="glass-subtle mx-4 mt-3 px-2 py-1.5 flex items-center gap-1">
        {VIEWS.map(({ key, label, icon }) => (
          <button
            key={key}
            onClick={() => setActiveView(key)}
            className={`px-4 py-2 text-xs font-medium rounded-lg transition-all duration-300 flex items-center gap-2 ${
              activeView === key
                ? 'bg-white/10 text-white shadow-lg shadow-accent-violet/10 border border-white/10'
                : 'text-white/40 hover:text-white/70 hover:bg-white/5'
            }`}
          >
            <span className="text-sm">{icon}</span>
            {label}
          </button>
        ))}
      </nav>

      {/* Main content */}
      <main className="flex-1 p-4 overflow-auto">
        {activeView === 'command' && (
          <CommandCenter state={state} events={events} connected={connected} />
        )}
        {activeView === 'instruments' && (
          <InstrumentDeepDive state={state} connected={connected} />
        )}
        {activeView === 'risk' && (
          <RiskDashboard state={state} connected={connected} />
        )}
        {activeView === 'trades' && (
          <TradeHistory />
        )}
      </main>
    </div>
  );
}
