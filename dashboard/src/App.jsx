import React, { useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket.js';
import HealthBar from './components/HealthBar.jsx';
import CommandCenter from './views/CommandCenter.jsx';
import RiskDashboard from './views/RiskDashboard.jsx';
import InstrumentDeepDive from './views/InstrumentDeepDive.jsx';
import TradeHistory from './views/TradeHistory.jsx';

const VIEWS = {
  command: 'Command Center',
  instruments: 'Instruments',
  risk: 'Risk Dashboard',
  trades: 'Trade History',
};

export default function App() {
  const { state, events, connected } = useWebSocket();
  const [activeView, setActiveView] = useState('command');

  return (
    <div className="min-h-screen bg-bg-primary flex flex-col">
      {/* System health bar - always visible */}
      <HealthBar state={state} connected={connected} />

      {/* Navigation */}
      <nav className="bg-bg-secondary border-b border-gray-700 px-4 py-2 flex gap-4">
        {Object.entries(VIEWS).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveView(key)}
            className={`px-3 py-1 text-sm rounded transition-colors ${
              activeView === key
                ? 'bg-accent-blue text-white'
                : 'text-gray-400 hover:text-gray-200 hover:bg-bg-tertiary'
            }`}
          >
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
