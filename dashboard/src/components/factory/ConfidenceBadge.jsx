import React from 'react';

/**
 * Confidence badge based on trade count thresholds.
 * <50 = red "Insufficient", 50-99 = orange "Low",
 * 100-199 = yellow "Moderate", 200+ = green "High"
 */

const TIERS = [
  { min: 200, label: 'High',         color: 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/20', tip: '200+ trades — statistically robust' },
  { min: 100, label: 'Moderate',     color: 'bg-yellow-500/15 text-yellow-400 ring-1 ring-yellow-500/20',   tip: '100-199 trades — moderate confidence' },
  { min: 50,  label: 'Low',          color: 'bg-orange-500/15 text-orange-400 ring-1 ring-orange-500/20',   tip: '50-99 trades — low confidence' },
  { min: 0,   label: 'Insufficient', color: 'bg-red-500/15 text-red-400 ring-1 ring-red-500/20',         tip: '<50 trades — insufficient sample' },
];

export default function ConfidenceBadge({ trades, confidenceIntervals }) {
  const tier = TIERS.find(t => (trades || 0) >= t.min) || TIERS[TIERS.length - 1];

  let ciText = '';
  if (confidenceIntervals?.sharpe) {
    const ci = confidenceIntervals.sharpe;
    ciText = ` | CI width: ${(ci.upper - ci.lower).toFixed(2)}`;
  }

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold rounded-full cursor-default tracking-wide ${tier.color}`}
      title={`${tier.tip}${ciText}`}
    >
      {tier.label}
    </span>
  );
}
