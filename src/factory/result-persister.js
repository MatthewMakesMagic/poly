/**
 * Result Persister — PostgreSQL (Story 3.3)
 *
 * Persists factory backtest results to PostgreSQL.
 * Tables: factory_runs, factory_results
 * Creates tables if they don't exist. Indexes on strategy_name, symbol, created_at.
 * Failed runs persist with error_message.
 *
 * Uses existing src/persistence/index.js for all DB operations.
 *
 * Covers: FR26 (historical results queryable), NFR10 (no silent failures)
 */

import persistence from '../persistence/index.js';

// ─── Schema DDL ───

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS factory_runs (
    run_id SERIAL PRIMARY KEY,
    manifest_name TEXT,
    manifest_json JSONB,
    status TEXT NOT NULL DEFAULT 'running',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    wall_clock_ms INTEGER,
    total_runs INTEGER,
    completed_runs INTEGER DEFAULT 0,
    summary JSONB,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS factory_results (
    id SERIAL PRIMARY KEY,
    run_id INTEGER REFERENCES factory_runs(run_id),
    strategy_name TEXT NOT NULL,
    strategy_yaml TEXT,
    strategy_source TEXT NOT NULL DEFAULT 'js',
    symbol TEXT NOT NULL,
    config JSONB,
    sample_size INTEGER,
    sample_seed INTEGER,
    metrics JSONB,
    regime JSONB,
    sharpe_ci JSONB,
    trades_summary JSONB,
    elapsed_ms INTEGER,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_factory_results_strategy ON factory_results(strategy_name);
  CREATE INDEX IF NOT EXISTS idx_factory_results_symbol ON factory_results(symbol);
  CREATE INDEX IF NOT EXISTS idx_factory_results_created ON factory_results(created_at);
  CREATE INDEX IF NOT EXISTS idx_factory_runs_created ON factory_runs(created_at);
`;

let schemaInitialized = false;

/**
 * Ensure factory tables exist. Idempotent.
 */
export async function ensureSchema() {
  if (schemaInitialized) return;
  try {
    await persistence.exec(CREATE_TABLES_SQL);
    schemaInitialized = true;
  } catch (err) {
    // If persistence isn't initialized, skip silently (test mode, offline)
    if (err.message?.includes('not initialized')) {
      return;
    }
    throw err;
  }
}

/**
 * Reset schema initialization state (for testing).
 */
export function resetSchemaState() {
  schemaInitialized = false;
}

// ─── Run Lifecycle ───

/**
 * Create a factory run record. Returns the run ID.
 *
 * @param {Object} params
 * @param {string} [params.manifestName] - Name/label for the run
 * @param {Object} [params.manifestJson] - Full manifest as JSON
 * @param {number} [params.totalRuns] - Expected total sub-runs
 * @returns {Promise<number>} run ID
 */
export async function createRun({ manifestName, manifestJson, totalRuns } = {}) {
  await ensureSchema();
  const row = await persistence.get(
    `INSERT INTO factory_runs (manifest_name, manifest_json, status, total_runs)
     VALUES ($1, $2, 'running', $3)
     RETURNING run_id`,
    [manifestName || null, manifestJson ? JSON.stringify(manifestJson) : null, totalRuns || 0]
  );
  return row.run_id;
}

/**
 * Mark a run as completed.
 *
 * @param {number} runId
 * @param {Object} summary - Summary metrics
 * @param {number} wallClockMs - Total wall clock time
 * @param {number} completedRuns - Number of completed sub-runs
 */
export async function completeRun(runId, { summary, wallClockMs, completedRuns }) {
  await persistence.run(
    `UPDATE factory_runs
     SET status = 'completed', completed_at = NOW(), wall_clock_ms = $1,
         summary = $2, completed_runs = $3
     WHERE run_id = $4`,
    [wallClockMs, JSON.stringify(summary), completedRuns, runId]
  );
}

/**
 * Mark a run as failed.
 *
 * @param {number} runId
 * @param {string} errorMessage
 */
export async function failRun(runId, errorMessage) {
  await persistence.run(
    `UPDATE factory_runs
     SET status = 'failed', completed_at = NOW(), error_message = $1
     WHERE run_id = $2`,
    [errorMessage, runId]
  );
}

// ─── Result Persistence ───

/**
 * Persist a single strategy/symbol result.
 *
 * @param {Object} params
 * @param {number} [params.runId] - Parent run ID
 * @param {string} params.strategyName
 * @param {string} [params.strategyYaml]
 * @param {string} [params.strategySource='js'] - 'yaml' or 'js'
 * @param {string} params.symbol
 * @param {Object} [params.config] - Strategy config params
 * @param {number} [params.sampleSize]
 * @param {number} [params.sampleSeed]
 * @param {Object} params.metrics - Computed metrics
 * @param {Object} [params.regime] - Regime breakdown
 * @param {Object} [params.sharpeCi] - Bootstrap CI
 * @param {Object} [params.tradesSummary] - Summarized trade info
 * @param {number} [params.elapsedMs]
 * @param {string} [params.errorMessage]
 * @returns {Promise<number>} result ID
 */
export async function persistResult({
  runId,
  strategyName,
  strategyYaml,
  strategySource = 'js',
  symbol,
  config,
  sampleSize,
  sampleSeed,
  metrics,
  regime,
  sharpeCi,
  tradesSummary,
  elapsedMs,
  errorMessage,
}) {
  await ensureSchema();
  const row = await persistence.get(
    `INSERT INTO factory_results
       (run_id, strategy_name, strategy_yaml, strategy_source, symbol,
        config, sample_size, sample_seed, metrics, regime, sharpe_ci,
        trades_summary, elapsed_ms, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      runId || null,
      strategyName,
      strategyYaml || null,
      strategySource,
      symbol,
      config ? JSON.stringify(config) : null,
      sampleSize || null,
      sampleSeed || null,
      metrics ? JSON.stringify(metrics) : null,
      regime ? JSON.stringify(regime) : null,
      sharpeCi ? JSON.stringify(sharpeCi) : null,
      tradesSummary ? JSON.stringify(tradesSummary) : null,
      elapsedMs || null,
      errorMessage || null,
    ]
  );
  return row.id;
}

/**
 * Persist a failed result (error captured, not thrown).
 */
export async function persistFailedResult({
  runId,
  strategyName,
  symbol,
  errorMessage,
}) {
  return persistResult({
    runId,
    strategyName,
    symbol,
    metrics: null,
    errorMessage,
    strategySource: 'unknown',
  });
}

/**
 * Convenience: persist a complete backtest result from runFactoryBacktest output.
 *
 * @param {number|null} runId
 * @param {Object} result - Output from runFactoryBacktest
 * @returns {Promise<number[]>} Array of result IDs (one per variant)
 */
export async function persistBacktestResult(runId, result) {
  const ids = [];

  for (const variant of result.variants) {
    // Strip equityCurve and windowResults from metrics to reduce storage
    const { equityCurve, ...metricsClean } = variant.metrics;
    const tradesSummary = {
      totalTrades: variant.metrics.trades,
      winRate: variant.metrics.winRate,
      totalPnl: variant.metrics.totalPnl,
    };

    const id = await persistResult({
      runId,
      strategyName: result.strategy,
      symbol: result.symbol,
      config: variant.params,
      sampleSize: result.sampleSize,
      sampleSeed: result.seed,
      metrics: metricsClean,
      regime: variant.regime,
      sharpeCi: variant.sharpeCi,
      tradesSummary,
      elapsedMs: result.wallClockMs,
    });
    ids.push(id);
  }

  return ids;
}
