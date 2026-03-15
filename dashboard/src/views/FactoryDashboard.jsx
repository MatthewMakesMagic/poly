import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useLeaderboard, useFactoryRuns, useFactoryResults, useStrategyLineage } from '../hooks/useFactoryData.js';
import LeaderboardTable from '../components/factory/LeaderboardTable.jsx';
import StrategyCard from '../components/factory/StrategyCard.jsx';
import RunHistoryList from '../components/factory/RunHistoryList.jsx';
import ComparisonTable from '../components/factory/ComparisonTable.jsx';
import LineageTree from '../components/factory/LineageTree.jsx';
import MetricSparkline from '../components/factory/MetricSparkline.jsx';
import ConfidenceBadge from '../components/factory/ConfidenceBadge.jsx';
import { formatMetric } from '../components/factory/chart-theme.js';

// ============================================================================
// Back button component — consistent across all drill-down views
// ============================================================================

function BackButton({ onClick, label = 'Back' }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-[11px] text-white/35 hover:text-white/60 transition-colors duration-150 group"
    >
      <span className="text-white/25 group-hover:text-white/50 transition-colors">&larr;</span>
      {label}
    </button>
  );
}

// ============================================================================
// Sub-views: Run Detail and Strategy Lineage
// ============================================================================

function RunDetailView({ run, onBack }) {
  const { results, loading, error } = useFactoryResults(run.run_id);

  if (loading) {
    return (
      <div className="space-y-4">
        <BackButton onClick={onBack} label="Back to runs" />
        <div className="glass p-12 text-center">
          <p className="text-xs text-white/25 animate-pulse">Loading run details...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <BackButton onClick={onBack} label="Back to runs" />
        <div className="glass p-12 text-center">
          <p className="text-xs text-red-400/80">Failed to load: {error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <BackButton onClick={onBack} label="Back to runs" />

      {/* Run header */}
      <div className="glass p-4 flex items-center gap-6">
        <span className="section-title">Run Detail</span>
        <div className="flex items-center gap-4 text-[11px] text-white/40">
          <span className="font-mono tracking-tight">{run.manifest_name}</span>
          <StatusBadge status={run.status} />
          {run.summary?.bestSharpe != null && (
            <span className="text-emerald-400 font-mono tabular-nums font-semibold">Best Sharpe: {formatMetric(run.summary.bestSharpe, 'sharpe')}</span>
          )}
        </div>
      </div>

      {run.error_message && (
        <div className="glass p-4 rounded-xl border border-red-500/15">
          <p className="text-xs text-red-400/80">{run.error_message}</p>
        </div>
      )}

      <ComparisonTable results={results} />
    </div>
  );
}

function StatusBadge({ status }) {
  const colors = {
    completed: 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/20',
    running: 'bg-yellow-500/15 text-yellow-400 ring-1 ring-yellow-500/20',
    failed: 'bg-red-500/15 text-red-400 ring-1 ring-red-500/20',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold rounded-full tracking-wide ${colors[status] || 'bg-white/10 text-white/40'}`}>
      {status}
    </span>
  );
}

function StrategyLineageView({ strategyName, onBack }) {
  const { lineage, loading, error } = useStrategyLineage(strategyName);

  // Build sparkline data from lineage — map to best sharpe per iteration
  const sparklineData = useMemo(() => {
    if (!lineage || lineage.length < 2) return [];
    // Each node in lineage order is an iteration
    return lineage.map((entry, i) => ({
      iteration: i + 1,
      name: entry.strategy_name,
      sharpe: 0, // Will be enriched if we had results; placeholder
    }));
  }, [lineage]);

  if (loading) {
    return (
      <div className="space-y-4">
        <BackButton onClick={onBack} />
        <div className="glass p-12 text-center">
          <p className="text-xs text-white/25 animate-pulse">Loading lineage...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <BackButton onClick={onBack} />
        <div className="glass p-12 text-center">
          <p className="text-xs text-red-400/80">Failed to load lineage: {error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <BackButton onClick={onBack} />

      <div className="glass p-4 flex items-center gap-4">
        <span className="section-title">Strategy Lineage</span>
        <span className="text-xs text-white/70 font-mono tracking-tight">{strategyName}</span>
        {lineage.length > 0 && (
          <span className="text-[10px] text-white/25 font-mono tabular-nums">{lineage.length} iterations</span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Lineage tree — 2 cols */}
        <div className="lg:col-span-2">
          <LineageTree lineage={lineage} highlightStrategy={strategyName} />
        </div>

        {/* Side panel: sparkline + info */}
        <div className="space-y-4">
          {sparklineData.length >= 2 && (
            <div className="glass p-4 rounded-xl">
              <h3 className="label-xs mb-2">Convergence</h3>
              <MetricSparkline data={sparklineData} width={200} height={60} />
            </div>
          )}

          <div className="glass p-4 rounded-xl">
            <h3 className="label-xs mb-3">Lineage Info</h3>
            <div className="space-y-2.5 text-xs">
              <div className="flex justify-between items-baseline">
                <span className="text-white/35">Root</span>
                <span className="text-white/65 font-mono tracking-tight">{lineage[0]?.strategy_name || '--'}</span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-white/35">Generations</span>
                <span className="text-white/65 font-mono tabular-nums">{lineage.length}</span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-white/35">Authors</span>
                <span className="text-white/65">
                  {[...new Set(lineage.map(l => l.created_by).filter(Boolean))].join(', ') || '--'}
                </span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-white/35">Mutation Types</span>
                <span className="text-white/65">
                  {[...new Set(lineage.map(l => l.mutation_type).filter(Boolean))].join(', ') || '--'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Factory Dashboard
// ============================================================================

export default function FactoryDashboard() {
  const [drillView, setDrillView] = useState(null); // null | { type: 'run', run } | { type: 'strategy', name }

  const { strategies, loading: lbLoading, error: lbError } = useLeaderboard({ limit: 25 });
  const { runs, loading: runsLoading, error: runsError } = useFactoryRuns({});

  // Drill-down handlers
  const handleSelectStrategy = useCallback((name) => {
    setDrillView({ type: 'strategy', name });
  }, []);

  const handleSelectRun = useCallback((run) => {
    setDrillView({ type: 'run', run });
  }, []);

  const handleBack = useCallback(() => {
    setDrillView(null);
  }, []);

  // --- Drilled views ---
  if (drillView?.type === 'run') {
    return <RunDetailView run={drillView.run} onBack={handleBack} />;
  }

  if (drillView?.type === 'strategy') {
    return <StrategyLineageView strategyName={drillView.name} onBack={handleBack} />;
  }

  // --- Main view ---
  const isLoading = lbLoading && runsLoading;

  if (isLoading) {
    return (
      <div className="glass p-12 text-center">
        <p className="text-xs text-white/25 animate-pulse">Loading Factory Dashboard...</p>
      </div>
    );
  }

  // Top 4 strategies for cards
  const topStrategies = (strategies || []).slice(0, 4);

  return (
    <div className="space-y-4">
      {/* Strategy candidate cards */}
      {topStrategies.length > 0 && (
        <div>
          <h2 className="section-title mb-3">Top Candidates</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {topStrategies.map(s => (
              <StrategyCard
                key={`${s.strategy_name}-${s.symbol}`}
                strategy={s}
                lineage={null}
                onClick={handleSelectStrategy}
              />
            ))}
          </div>
        </div>
      )}

      {/* Leaderboard */}
      {lbError ? (
        <div className="glass p-6 text-center">
          <p className="text-xs text-red-400/80">Failed to load leaderboard: {lbError}</p>
        </div>
      ) : (
        <LeaderboardTable strategies={strategies} onSelectStrategy={handleSelectStrategy} />
      )}

      {/* Run History */}
      {runsError ? (
        <div className="glass p-6 text-center">
          <p className="text-xs text-red-400/80">Failed to load runs: {runsError}</p>
        </div>
      ) : (
        <RunHistoryList runs={runs} onSelectRun={handleSelectRun} />
      )}
    </div>
  );
}
