import React, { useState, useEffect, useCallback, useMemo } from 'react';
import PanelNav from '../components/lab/PanelNav.jsx';
import FilterWorkbench from '../components/lab/FilterWorkbench.jsx';
import ComparisonMatrix from '../components/lab/ComparisonMatrix.jsx';
import TradeScatter from '../components/lab/TradeScatter.jsx';
import OracleGapVisualizer from '../components/lab/OracleGapVisualizer.jsx';
import TimingHeatmap from '../components/lab/TimingHeatmap.jsx';
import EdgeDecayChart from '../components/lab/EdgeDecayChart.jsx';
import CorrelationExplorer from '../components/lab/CorrelationExplorer.jsx';
import ABComparison from '../components/lab/ABComparison.jsx';

export default function StrategyLab() {
  const [dataset, setDataset] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activePanel, setActivePanel] = useState('filter');

  // Shared filter state
  const [filters, setFilters] = useState({
    symbols: [],
    dateFrom: '',
    dateTo: '',
    entryOffset: 60,
    strategy: 'consensus',
    confidenceMin: 0,
    confidenceMax: 1,
    clobThreshold: 0.5,
  });

  const fetchDataset = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/backtest-dataset');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDataset(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDataset();
  }, [fetchDataset]);

  const windows = useMemo(() => dataset?.windows || [], [dataset]);
  const meta = useMemo(() => dataset?.meta || {}, [dataset]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="glass p-12 text-center">
          <p className="text-xs text-white/30 animate-pulse">Loading backtest dataset...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <div className="glass p-12 text-center">
          <p className="text-xs text-accent-red">Failed to load dataset: {error}</p>
          <button
            onClick={fetchDataset}
            className="mt-4 px-4 py-2 text-xs bg-white/5 rounded-lg border border-white/10 text-white/50 hover:text-white/70 hover:bg-white/10 transition-all duration-300"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Dataset summary strip */}
      <div className="glass p-4 flex items-center gap-6">
        <span className="section-title">Strategy Lab</span>
        <div className="flex items-center gap-4 text-[10px] text-white/40">
          <span>{meta.total?.toLocaleString()} windows</span>
          <span>{(meta.symbols || []).map(s => s.toUpperCase()).join(', ')}</span>
          {meta.dateRange?.from && (
            <span>
              {new Date(meta.dateRange.from).toLocaleDateString()} — {new Date(meta.dateRange.to).toLocaleDateString()}
            </span>
          )}
          {meta.resolutionCoverage && (
            <span className="text-accent-green/70">
              Gamma: {meta.resolutionCoverage.pct}
            </span>
          )}
        </div>
      </div>

      {/* Panel navigation */}
      <PanelNav activePanel={activePanel} onSelect={setActivePanel} />

      {/* Active panel */}
      {activePanel === 'filter' && (
        <FilterWorkbench windows={windows} filters={filters} onFiltersChange={setFilters} />
      )}
      {activePanel === 'matrix' && (
        <ComparisonMatrix windows={windows} filters={filters} />
      )}
      {activePanel === 'scatter' && (
        <TradeScatter windows={windows} filters={filters} />
      )}
      {activePanel === 'oracle' && (
        <OracleGapVisualizer windows={windows} />
      )}
      {activePanel === 'timing' && (
        <TimingHeatmap windows={windows} filters={filters} />
      )}
      {activePanel === 'decay' && (
        <EdgeDecayChart windows={windows} filters={filters} />
      )}
      {activePanel === 'correlation' && (
        <CorrelationExplorer windows={windows} filters={filters} />
      )}
      {activePanel === 'ab' && (
        <ABComparison windows={windows} />
      )}
    </div>
  );
}
