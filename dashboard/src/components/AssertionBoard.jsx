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
  const failCount = results.filter(r => r.passed === false).length;

  return (
    <div className="bg-bg-secondary rounded-lg border border-gray-700 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Assertion Board
        </h2>
        <div className="flex items-center gap-2">
          <span className={`text-xs ${
            cbState === 'CLOSED' ? 'text-accent-green' :
            cbState === 'OPEN' ? 'text-accent-red' : 'text-accent-yellow'
          }`}>
            CB: {cbState}
          </span>
          {results.length > 0 && (
            <span className="text-xs text-gray-500">
              {passCount}/{results.length}
            </span>
          )}
          {lastCheck && (
            <span className="text-xs text-gray-500">
              {new Date(lastCheck).toLocaleTimeString('en-US', { hour12: false })}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {KNOWN_ASSERTIONS.map((name) => {
          const result = resultMap[name];
          const passed = result?.passed ?? result?.pass;
          const hasResult = result != null;
          const message = result?.message || '';

          let bgColor = 'bg-gray-800/50';
          let textColor = 'text-gray-500';
          let indicator = '--';

          if (hasResult) {
            if (passed === null) {
              bgColor = 'bg-gray-800/50';
              textColor = 'text-gray-500';
              indicator = 'WAIT';
            } else if (passed) {
              bgColor = 'bg-green-900/30';
              textColor = 'text-accent-green';
              indicator = 'PASS';
            } else {
              bgColor = 'bg-red-900/30';
              textColor = 'text-accent-red';
              indicator = 'FAIL';
            }
          }

          return (
            <div
              key={name}
              className={`${bgColor} rounded px-3 py-2 flex items-center justify-between`}
              title={message}
            >
              <span className="text-xs text-gray-300">{ASSERTION_LABELS[name] || name}</span>
              <span className={`text-xs font-semibold ${textColor}`}>{indicator}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
