/**
 * Backtest Data Loader
 *
 * Loads historical tick data from the database for replay.
 * Supports filtering by date range, symbol, and topic.
 * Uses streaming to handle large datasets efficiently.
 */

import { getDb } from '../persistence/database.js';
import { child } from '../modules/logger/index.js';

const log = child({ module: 'backtest:data-loader' });

/**
 * @typedef {Object} TickRow
 * @property {number} id - Row ID
 * @property {string} timestamp - ISO timestamp
 * @property {string} topic - Feed topic (e.g., 'binance', 'chainlink')
 * @property {string} symbol - Symbol (e.g., 'BTC', 'ETH')
 * @property {number} price - Price value
 * @property {string|null} raw_payload - Raw JSON payload
 */

/**
 * @typedef {Object} LoadOptions
 * @property {string} startDate - Start date ISO string
 * @property {string} endDate - End date ISO string
 * @property {string[]} [symbols] - Filter to specific symbols
 * @property {string[]} [topics] - Filter to specific topics
 * @property {number} [batchSize=10000] - Number of rows per batch
 */

/**
 * Load ticks by date range with optional filters
 *
 * Returns an iterator for memory-efficient processing of large datasets.
 *
 * @param {LoadOptions} options - Query options
 * @returns {Generator<TickRow[]>} Generator yielding batches of ticks
 */
export function* loadTicksBatched(options) {
  const { startDate, endDate, symbols, topics, batchSize = 10000 } = options;

  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  const db = getDb();

  // Build query with optional filters
  let sql = `
    SELECT id, timestamp, topic, symbol, price, raw_payload
    FROM rtds_ticks
    WHERE timestamp >= ? AND timestamp <= ?
  `;
  const params = [startDate, endDate];

  if (symbols && symbols.length > 0) {
    sql += ` AND symbol IN (${symbols.map(() => '?').join(',')})`;
    params.push(...symbols);
  }

  if (topics && topics.length > 0) {
    sql += ` AND topic IN (${topics.map(() => '?').join(',')})`;
    params.push(...topics);
  }

  sql += ' ORDER BY timestamp ASC, id ASC';

  // Use pagination for memory efficiency
  let offset = 0;
  let hasMore = true;

  log.info('load_ticks_start', {
    startDate,
    endDate,
    symbols: symbols || 'all',
    topics: topics || 'all',
    batchSize,
  });

  while (hasMore) {
    const batchSql = `${sql} LIMIT ? OFFSET ?`;
    const batchParams = [...params, batchSize, offset];

    const stmt = db.prepare(batchSql);
    const rows = stmt.all(...batchParams);

    if (rows.length > 0) {
      yield rows;
      offset += rows.length;
    }

    hasMore = rows.length === batchSize;
  }

  log.info('load_ticks_complete', { totalRows: offset });
}

/**
 * Load all ticks as a single array (use for smaller datasets)
 *
 * @param {LoadOptions} options - Query options
 * @returns {TickRow[]} Array of tick rows
 */
export function loadTicks(options) {
  const result = [];
  for (const batch of loadTicksBatched(options)) {
    result.push(...batch);
  }
  return result;
}

/**
 * Get tick count for a date range (for progress estimation)
 *
 * @param {LoadOptions} options - Query options
 * @returns {number} Count of matching ticks
 */
export function getTickCount(options) {
  const { startDate, endDate, symbols, topics } = options;

  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  const db = getDb();

  let sql = `
    SELECT COUNT(*) as count
    FROM rtds_ticks
    WHERE timestamp >= ? AND timestamp <= ?
  `;
  const params = [startDate, endDate];

  if (symbols && symbols.length > 0) {
    sql += ` AND symbol IN (${symbols.map(() => '?').join(',')})`;
    params.push(...symbols);
  }

  if (topics && topics.length > 0) {
    sql += ` AND topic IN (${topics.map(() => '?').join(',')})`;
    params.push(...topics);
  }

  const stmt = db.prepare(sql);
  const result = stmt.get(...params);
  return result?.count || 0;
}

/**
 * Load oracle updates by date range
 *
 * @param {Object} options - Query options
 * @param {string} options.startDate - Start date ISO string
 * @param {string} options.endDate - End date ISO string
 * @param {string[]} [options.symbols] - Filter to specific symbols
 * @returns {Object[]} Array of oracle update rows
 */
export function loadOracleUpdates(options) {
  const { startDate, endDate, symbols } = options;

  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  const db = getDb();

  let sql = `
    SELECT id, timestamp, symbol, price, previous_price,
           deviation_from_previous_pct, time_since_previous_ms
    FROM oracle_updates
    WHERE timestamp >= ? AND timestamp <= ?
  `;
  const params = [startDate, endDate];

  if (symbols && symbols.length > 0) {
    sql += ` AND symbol IN (${symbols.map(() => '?').join(',')})`;
    params.push(...symbols);
  }

  sql += ' ORDER BY timestamp ASC';

  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

/**
 * Load trade events by date range
 *
 * @param {Object} options - Query options
 * @param {string} options.startDate - Start date ISO string
 * @param {string} options.endDate - End date ISO string
 * @param {string} [options.strategyId] - Filter to specific strategy
 * @returns {Object[]} Array of trade event rows
 */
export function loadTradeEvents(options) {
  const { startDate, endDate, strategyId } = options;

  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  const db = getDb();

  let sql = `
    SELECT *
    FROM trade_events
    WHERE created_at >= ? AND created_at <= ?
  `;
  const params = [startDate, endDate];

  if (strategyId) {
    sql += ' AND strategy_id = ?';
    params.push(strategyId);
  }

  sql += ' ORDER BY created_at ASC';

  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

/**
 * Load lag signals by date range
 *
 * @param {Object} options - Query options
 * @param {string} options.startDate - Start date ISO string
 * @param {string} options.endDate - End date ISO string
 * @param {string[]} [options.symbols] - Filter to specific symbols
 * @returns {Object[]} Array of lag signal rows
 */
export function loadLagSignals(options) {
  const { startDate, endDate, symbols } = options;

  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  const db = getDb();

  let sql = `
    SELECT *
    FROM lag_signals
    WHERE timestamp >= ? AND timestamp <= ?
  `;
  const params = [startDate, endDate];

  if (symbols && symbols.length > 0) {
    sql += ` AND symbol IN (${symbols.map(() => '?').join(',')})`;
    params.push(...symbols);
  }

  sql += ' ORDER BY timestamp ASC';

  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

/**
 * Get available date range for tick data
 *
 * @returns {{ earliest: string|null, latest: string|null }} Date range
 */
export function getTickDateRange() {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest
    FROM rtds_ticks
  `);

  const result = stmt.get();
  return {
    earliest: result?.earliest || null,
    latest: result?.latest || null,
  };
}

/**
 * Get available symbols in tick data
 *
 * @returns {string[]} Array of unique symbols
 */
export function getAvailableSymbols() {
  const db = getDb();

  const stmt = db.prepare('SELECT DISTINCT symbol FROM rtds_ticks ORDER BY symbol');
  const rows = stmt.all();
  return rows.map(r => r.symbol);
}

/**
 * Get available topics in tick data
 *
 * @returns {string[]} Array of unique topics
 */
export function getAvailableTopics() {
  const db = getDb();

  const stmt = db.prepare('SELECT DISTINCT topic FROM rtds_ticks ORDER BY topic');
  const rows = stmt.all();
  return rows.map(r => r.topic);
}
