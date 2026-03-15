import React from 'react';
import { useDataCoverage } from '../hooks/useFactoryData.js';
import CoverageMatrix from '../components/factory/CoverageMatrix.jsx';

/**
 * Data Coverage view — shows which symbols have data,
 * date ranges, L2 availability, and quality metrics.
 */
export default function DataCoverage() {
  const { coverage, loading, error, refetch } = useDataCoverage();

  if (loading) {
    return (
      <div className="glass p-12 text-center">
        <p className="text-xs text-white/25 animate-pulse">Loading data coverage...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass p-12 text-center">
        <p className="text-xs text-red-400/80 mb-4">Failed to load coverage: {error}</p>
        <button
          onClick={refetch}
          className="px-4 py-1.5 text-[11px] font-medium bg-white/[0.04] rounded-lg border border-white/[0.08] text-white/45 hover:text-white/70 hover:bg-white/[0.07] hover:border-white/[0.12] transition-all duration-200"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <CoverageMatrix coverage={coverage} />
    </div>
  );
}
