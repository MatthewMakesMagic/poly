import React, { useState, useEffect, useCallback } from 'react';
import DrawdownChart from '../components/DrawdownChart.jsx';
import AssertionBoard from '../components/AssertionBoard.jsx';
import RuntimeControls from '../components/RuntimeControls.jsx';
import StrategyPerformanceCards from '../components/StrategyPerformanceCards.jsx';
import FeedHealthPanel from '../components/FeedHealthPanel.jsx';
import AdminActionsPanel from '../components/AdminActionsPanel.jsx';

export default function RiskDashboard({ state, connected }) {
  const [assertions, setAssertions] = useState(null);
  const [controls, setControls] = useState([]);
  const [trades, setTrades] = useState([]);

  // Fetch assertions
  const fetchAssertions = useCallback(async () => {
    try {
      const res = await fetch('/api/assertions');
      const data = await res.json();
      setAssertions(data);
    } catch {
      // Ignore
    }
  }, []);

  // Fetch runtime controls
  const fetchControls = useCallback(async () => {
    try {
      const res = await fetch('/api/controls');
      const data = await res.json();
      setControls(data.controls || []);
    } catch {
      // Ignore
    }
  }, []);

  // Fetch recent trades for drawdown chart
  const fetchTrades = useCallback(async () => {
    try {
      const res = await fetch('/api/trades');
      const data = await res.json();
      setTrades(data.trades || []);
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    fetchAssertions();
    fetchControls();
    fetchTrades();

    const interval = setInterval(() => {
      fetchAssertions();
      fetchControls();
    }, 5000);

    return () => clearInterval(interval);
  }, [fetchAssertions, fetchControls, fetchTrades]);

  return (
    <div className="space-y-4">
      {/* Top row: Drawdown chart + Strategy Performance Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DrawdownChart state={state} trades={trades} />
        <StrategyPerformanceCards />
      </div>

      {/* Feed health */}
      <FeedHealthPanel />

      {/* Assertions + Runtime controls */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <AssertionBoard assertions={assertions} />
        <RuntimeControls controls={controls} onRefresh={fetchControls} />
      </div>

      {/* Admin actions */}
      <AdminActionsPanel />
    </div>
  );
}
