import React from 'react';

const KNOWN_ASSERTIONS = [
  'signal_order_mapping',
  'order_fill_confirmation',
  'fill_position_created',
  'position_count_match',
  'pnl_balance_match',
  'no_null_order_ids',
  'instrument_scope',
  'no_future_windows',
  'capital_cap',
  'system_heartbeat',
];

const ASSERTION_LABELS = {
  signal_order_mapping: 'Signal->Order',
  order_fill_confirmation: 'Fill Confirm',
  fill_position_created: 'Fill->Position',
  position_count_match: 'Pos Count',
  pnl_balance_match: 'P&L Match',
  no_null_order_ids: 'Order IDs',
  instrument_scope: 'Instruments',
  no_future_windows: 'No Future Win',
  capital_cap: 'Capital Cap',
  system_heartbeat: 'Heartbeat',
};

export default function AssertionBoard({ assertions }) {
  const cbState = assertions?.circuitBreakerState || 'UNKNOWN';
  const results = assertions?.assertions || [];
  const lastCheck = assertions?.lastCheckAt;

  // Build a map from known assertions
  const resultMap = {};
  for (const r of results) {
    resultMap[r.name || r.key] = r;
  }

  const passCount = results.filter(r => r.passed === true).length;

  const cbColor =
    cbState === 'CLOSED' ? 'text-accent-green' :
    cbState === 'OPEN' ? 'text-accent-red' : 'text-accent-yellow';

  return (
    <div className="glass p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="section-title">Assertion Board</h2>
        <div className="flex items-center gap-3">
          <span className={`text-[10px] font-bold ${cbColor}`}>
            CB: {cbState}
          </span>
          {results.length > 0 && (
            <span className="text-[10px] text-white/25">
              {passCount}/{results.length} pass
            </span>
          )}
          {lastCheck && (
            <span className="text-[10px] text-white/20">
              {new Date(lastCheck).toLocaleTimeString('en-US', { hour12: false })}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {KNOWN_ASSERTIONS.map((name) => {
          const result = resultMap[name];
          const passed = result?.passed ?? result?.pass;
          const hasResult = result != null;
          const message = result?.message || '';

          let bgClass = 'bg-white/[0.02] border border-white/5';
          let textColor = 'text-white/25';
          let indicator = '--';
          let dotColor = 'bg-white/15';

          if (hasResult) {
            if (passed === null) {
              bgClass = 'bg-white/[0.02] border border-white/5';
              textColor = 'text-white/30';
              indicator = 'WAIT';
              dotColor = 'bg-white/20';
            } else if (passed) {
              bgClass = 'bg-accent-green/[0.06] border border-accent-green/10';
              textColor = 'text-accent-green';
              indicator = 'PASS';
              dotColor = 'bg-accent-green shadow-[0_0_4px_rgba(52,211,153,0.5)]';
            } else {
              bgClass = 'bg-accent-red/[0.06] border border-accent-red/10';
              textColor = 'text-accent-red';
              indicator = 'FAIL';
              dotColor = 'bg-accent-red shadow-[0_0_4px_rgba(248,113,113,0.5)]';
            }
          }

          return (
            <div
              key={name}
              className={`${bgClass} rounded-lg px-3 py-2.5 flex items-center justify-between transition-all duration-300`}
              title={message}
            >
              <div className="flex items-center gap-2">
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor}`} />
                <span className="text-[10px] text-white/50">{ASSERTION_LABELS[name] || name}</span>
              </div>
              <span className={`text-[10px] font-bold ${textColor}`}>{indicator}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
