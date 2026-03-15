/**
 * Backtest Data Loader
 *
 * Loads historical data from PostgreSQL for replay.
 * Supports rtds_ticks, clob_price_snapshots, exchange_ticks, and window_close_events.
 * Uses batched loading for large tables (rtds_ticks).
 */

import persistence from '../persistence/index.js';
import { child } from '../modules/logger/index.js';

const log = child({ module: 'backtest:data-loader' });

/**
 * @typedef {Object} LoadOptions
 * @property {string} startDate - Start date ISO string
 * @property {string} endDate - End date ISO string
 * @property {string[]} [symbols] - Filter to specific symbols
 * @property {string[]} [topics] - Filter to specific topics
 * @property {number} [batchSize=10000] - Number of rows per batch (rtds_ticks only)
 * @property {number} [windowEpoch] - Window start epoch for CLOB queries (filters to active window only)
 */

/**
 * Build WHERE clause fragments for optional filters.
 * Returns { clauses: string[], params: any[] } with $N placeholders starting from paramOffset.
 */
function buildFilters(options, paramOffset = 3) {
  const clauses = [];
  const params = [];
  let idx = paramOffset;

  if (options.symbols && options.symbols.length > 0) {
    const placeholders = options.symbols.map(() => `$${idx++}`);
    clauses.push(`symbol IN (${placeholders.join(',')})`);
    params.push(...options.symbols);
  }

  if (options.topics && options.topics.length > 0) {
    const placeholders = options.topics.map(() => `$${idx++}`);
    clauses.push(`topic IN (${placeholders.join(',')})`);
    params.push(...options.topics);
  }

  if (options.exchanges && options.exchanges.length > 0) {
    const placeholders = options.exchanges.map(() => `$${idx++}`);
    clauses.push(`exchange IN (${placeholders.join(',')})`);
    params.push(...options.exchanges);
  }

  return { clauses, params };
}

// ─── RTDS Ticks ───

/**
 * Load rtds_ticks in batches (async generator).
 * Largest table — uses LIMIT/OFFSET pagination.
 *
 * @param {LoadOptions} options
 * @yields {Object[]} Batches of tick rows
 */
export async function* loadRtdsTicksBatched(options) {
  const { startDate, endDate, batchSize = 10000 } = options;

  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  const { clauses, params: filterParams } = buildFilters(options);

  // Keyset pagination: WHERE id > $lastId ORDER BY id ASC LIMIT $batchSize
  // Eliminates O(n^2) OFFSET scanning on large tables
  let lastId = 0;
  let totalRows = 0;
  let hasMore = true;

  log.info('load_rtds_ticks_start', {
    startDate, endDate,
    symbols: options.symbols || 'all',
    topics: options.topics || 'all',
    batchSize,
  });

  while (hasMore) {
    const baseParams = [startDate, endDate, lastId];
    let sql = `
      SELECT id, timestamp, topic, symbol, price, received_at
      FROM rtds_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
        AND id > $3
    `;

    if (clauses.length > 0) {
      // Rebuild filter placeholders starting at $4
      const { clauses: rebuildClauses, params: rebuildParams } = buildFilters(options, 4);
      sql += ' AND ' + rebuildClauses.join(' AND ');
      baseParams.push(...rebuildParams);
    }

    const limitIdx = baseParams.length + 1;
    sql += ` ORDER BY id ASC LIMIT $${limitIdx}`;
    baseParams.push(batchSize);

    const rows = await persistence.all(sql, baseParams);

    if (rows.length > 0) {
      yield rows;
      lastId = rows[rows.length - 1].id;
      totalRows += rows.length;
    }

    hasMore = rows.length === batchSize;
  }

  log.info('load_rtds_ticks_complete', { totalRows });
}

/**
 * Load all rtds_ticks as a single array.
 *
 * @param {LoadOptions} options
 * @returns {Promise<Object[]>}
 */
export async function loadRtdsTicks(options) {
  const result = [];
  for await (const batch of loadRtdsTicksBatched(options)) {
    for (const row of batch) result.push(row);
  }
  return result;
}

/**
 * Get tick count for a date range.
 *
 * @param {LoadOptions} options
 * @returns {Promise<number>}
 */
export async function getTickCount(options) {
  const { startDate, endDate } = options;

  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  const { clauses, params: filterParams } = buildFilters(options);

  let sql = `
    SELECT COUNT(*) as count
    FROM rtds_ticks
    WHERE timestamp >= $1 AND timestamp <= $2
  `;
  const params = [startDate, endDate];

  if (clauses.length > 0) {
    sql += ' AND ' + clauses.join(' AND ');
  }

  const result = await persistence.get(sql, [...params, ...filterParams]);
  return parseInt(result?.count || '0', 10);
}

// ─── CLOB Snapshots ───

/**
 * Load CLOB price snapshots.
 *
 * @param {LoadOptions} options
 * @returns {Promise<Object[]>}
 */
export async function loadClobSnapshots(options) {
  const { startDate, endDate, windowEpoch } = options;

  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  const { clauses, params: filterParams } = buildFilters(options);

  let sql = `
    SELECT timestamp, symbol, token_id, best_bid, best_ask,
           mid_price, spread, bid_size_top, ask_size_top
    FROM clob_price_snapshots
    WHERE timestamp >= $1 AND timestamp <= $2
  `;
  const params = [startDate, endDate];

  // Filter to active window period only (excludes pre-window data at $0.50)
  if (windowEpoch) {
    sql += ` AND window_epoch = $${params.length + 1} AND timestamp >= to_timestamp($${params.length + 1})`;
    params.push(windowEpoch);
  }

  if (clauses.length > 0) {
    sql += ' AND ' + clauses.join(' AND ');
  }

  sql += ' ORDER BY timestamp ASC';

  return persistence.all(sql, [...params, ...filterParams]);
}

// ─── Exchange Ticks ───

/**
 * Load exchange ticks in batches using keyset pagination.
 * Yields batches of rows for memory-efficient processing.
 *
 * @param {Object} options
 * @param {string} options.startDate
 * @param {string} options.endDate
 * @param {string[]} [options.symbols]
 * @param {string[]} [options.exchanges]
 * @param {number} [options.batchSize=500000]
 * @yields {Object[]} Batches of tick rows
 */
async function* loadExchangeTicksBatched(options) {
  const { startDate, endDate, batchSize = 500000 } = options;

  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  let lastId = 0;
  let totalRows = 0;
  let hasMore = true;

  log.info('load_exchange_ticks_start', {
    startDate, endDate,
    symbols: options.symbols || 'all',
    batchSize,
  });

  while (hasMore) {
    const baseParams = [startDate, endDate, lastId];
    let sql = `
      SELECT id, timestamp, exchange, symbol, price, bid, ask
      FROM exchange_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
        AND id > $3
    `;

    const { clauses, params: filterParams } = buildFilters(options, 4);
    if (clauses.length > 0) {
      sql += ' AND ' + clauses.join(' AND ');
    }
    baseParams.push(...filterParams);

    const limitIdx = baseParams.length + 1;
    sql += ` ORDER BY id ASC LIMIT $${limitIdx}`;
    baseParams.push(batchSize);

    const rows = await persistence.all(sql, baseParams);

    if (rows.length > 0) {
      yield rows;
      lastId = rows[rows.length - 1].id;
      totalRows += rows.length;
    }

    hasMore = rows.length === batchSize;
  }

  log.info('load_exchange_ticks_complete', { totalRows });
}

/**
 * Load exchange ticks (binance, coinbase, kraken, bybit, okx).
 * Uses batched keyset pagination for large result sets.
 *
 * @param {Object} options
 * @param {string} options.startDate
 * @param {string} options.endDate
 * @param {string[]} [options.symbols]
 * @param {string[]} [options.exchanges] - Filter to specific exchanges
 * @param {number} [options.batchSize=500000] - Rows per batch
 * @returns {Promise<Object[]>}
 */
export async function loadExchangeTicks(options) {
  const result = [];
  for await (const batch of loadExchangeTicksBatched(options)) {
    for (const row of batch) result.push(row);
  }
  return result;
}

// ─── Window Close Events ───

/**
 * Load window close events (ground truth for resolution).
 *
 * @param {Object} options
 * @param {string} options.startDate
 * @param {string} options.endDate
 * @param {string[]} [options.symbols]
 * @returns {Promise<Object[]>}
 */
export async function loadWindowEvents(options) {
  const { startDate, endDate } = options;

  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  const { clauses, params: filterParams } = buildFilters(options);

  let sql = `
    SELECT window_close_time, symbol, strike_price,
           chainlink_price_at_close,
           COALESCE(resolved_direction,
             CASE WHEN chainlink_price_at_close > strike_price THEN 'UP' ELSE 'DOWN' END
           ) as resolved_direction,
           polymarket_binance_at_close, binance_price_at_close,
           oracle_price_at_close, pyth_price_at_close,
           market_up_price_60s, market_up_price_30s, market_up_price_10s,
           market_up_price_5s, market_up_price_1s,
           market_down_price_60s, market_down_price_30s, market_down_price_10s,
           market_down_price_5s, market_down_price_1s,
           market_consensus_direction, market_consensus_confidence,
           surprise_resolution
    FROM window_close_events
    WHERE window_close_time >= $1 AND window_close_time <= $2
  `;
  const params = [startDate, endDate];

  if (clauses.length > 0) {
    sql += ' AND ' + clauses.join(' AND ');
  }

  sql += ' ORDER BY window_close_time ASC';

  return persistence.all(sql, [...params, ...filterParams]);
}

// ─── Merged Timeline ───

/**
 * Load all data sources and merge into a single sorted timeline.
 * Each event is tagged with a `source` field.
 *
 * @param {LoadOptions} options
 * @returns {Promise<Object[]>} Sorted array of events
 */
export async function loadMergedTimeline(options) {
  const [rtdsTicks, clobSnapshots, exchangeTicks] = await Promise.all([
    loadRtdsTicks(options),
    loadClobSnapshots(options),
    loadExchangeTicks(options),
  ]);

  const timeline = [];

  for (const tick of rtdsTicks) {
    const topic = tick.topic;
    let source;
    if (topic === 'crypto_prices_chainlink') {
      source = 'chainlink';
    } else if (topic === 'crypto_prices_pyth') {
      source = 'pyth';
    } else if (topic === 'crypto_prices') {
      source = 'polyRef';
    } else {
      source = `rtds_${topic}`;
    }
    timeline.push({ ...tick, source });
  }

  for (const snap of clobSnapshots) {
    // symbol is 'btc-down' or 'btc-up' etc.
    const isDown = snap.symbol?.toLowerCase().includes('down');
    const source = isDown ? 'clobDown' : 'clobUp';
    timeline.push({ ...snap, source });
  }

  for (const tick of exchangeTicks) {
    timeline.push({ ...tick, source: `exchange_${tick.exchange}` });
  }

  // Sort by timestamp, stable
  timeline.sort((a, b) => {
    const tA = new Date(a.timestamp).getTime();
    const tB = new Date(b.timestamp).getTime();
    return tA - tB;
  });

  log.info('load_merged_timeline', {
    rtdsTicks: rtdsTicks.length,
    clobSnapshots: clobSnapshots.length,
    exchangeTicks: exchangeTicks.length,
    totalEvents: timeline.length,
  });

  return timeline;
}

// ─── Bulk Data Loading (for parallel engine) ───

/**
 * Load all tick data for a date range in one pass.
 * Returns pre-sorted arrays for binary-search slicing.
 *
 * Note: For remote databases, this may be slow for large date ranges.
 * Consider using loadWindowTickData() for per-window loading instead.
 *
 * @param {Object} options
 * @param {string} options.startDate
 * @param {string} options.endDate
 * @param {string[]} [options.symbols] - Filter exchange ticks to specific symbols
 * @returns {Promise<{ rtdsTicks: Object[], clobSnapshots: Object[], exchangeTicks: Object[] }>}
 */
export async function loadAllData(options) {
  const { startDate, endDate, symbols } = options;

  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  log.info('load_all_data_start', { startDate, endDate, symbols: symbols || 'all' });

  // Load all three data sources in parallel
  const [rtdsTicks, clobSnapshots, exchangeTicks] = await Promise.all([
    loadRtdsTicks({
      startDate,
      endDate,
      topics: ['crypto_prices_chainlink', 'crypto_prices', 'crypto_prices_pyth'],
    }),
    loadAllClobSnapshots({ startDate, endDate }),
    loadExchangeTicks({
      startDate,
      endDate,
      symbols: symbols ? symbols.map(s => s.toLowerCase()) : undefined,
    }),
  ]);

  log.info('load_all_data_complete', {
    rtdsTicks: rtdsTicks.length,
    clobSnapshots: clobSnapshots.length,
    exchangeTicks: exchangeTicks.length,
  });

  return { rtdsTicks, clobSnapshots, exchangeTicks };
}

/**
 * Load ALL CLOB snapshots for a date range using keyset pagination.
 * Used by the parallel engine which slices per-window in memory.
 *
 * @param {Object} options
 * @param {string} options.startDate
 * @param {string} options.endDate
 * @param {string} [options.symbolPrefix] - Filter by symbol prefix (e.g. 'btc')
 * @param {number} [options.batchSize=500000] - Rows per batch
 * @returns {Promise<Object[]>}
 */
async function loadAllClobSnapshots(options) {
  const { startDate, endDate, symbolPrefix, batchSize = 500000 } = options;

  const result = [];
  let lastId = 0;
  let hasMore = true;

  log.info('load_all_clob_snapshots_start', { startDate, endDate, symbolPrefix, batchSize });

  while (hasMore) {
    let sql;
    let params;

    if (symbolPrefix) {
      sql = `
        SELECT id, timestamp, symbol, token_id, best_bid, best_ask,
               mid_price, spread, bid_size_top, ask_size_top, window_epoch
        FROM clob_price_snapshots
        WHERE timestamp >= $1 AND timestamp <= $2
          AND symbol LIKE $3
          AND id > $4
        ORDER BY id ASC LIMIT $5
      `;
      params = [startDate, endDate, `${symbolPrefix.toLowerCase()}%`, lastId, batchSize];
    } else {
      sql = `
        SELECT id, timestamp, symbol, token_id, best_bid, best_ask,
               mid_price, spread, bid_size_top, ask_size_top, window_epoch
        FROM clob_price_snapshots
        WHERE timestamp >= $1 AND timestamp <= $2
          AND id > $3
        ORDER BY id ASC LIMIT $4
      `;
      params = [startDate, endDate, lastId, batchSize];
    }

    const rows = await persistence.all(sql, params);

    if (rows.length > 0) {
      for (const row of rows) result.push(row);
      lastId = rows[rows.length - 1].id;
    }

    hasMore = rows.length === batchSize;
  }

  log.info('load_all_clob_snapshots_complete', { totalRows: result.length });
  return result;
}

/**
 * Load all data for a single symbol. Memory-efficient alternative to loadAllData().
 * CLOB + exchange ticks are filtered to the symbol; rtds ticks are shared across symbols.
 *
 * @param {Object} options
 * @param {string} options.startDate
 * @param {string} options.endDate
 * @param {string} options.symbol - Symbol to filter (e.g. 'btc')
 * @param {Object} [options.sharedRtds] - Pre-loaded rtds ticks (avoids reloading)
 * @returns {Promise<{ rtdsTicks: Object[], clobSnapshots: Object[], exchangeTicks: Object[] }>}
 */
export async function loadAllDataForSymbol(options) {
  const { startDate, endDate, symbol, sharedRtds } = options;

  if (!startDate || !endDate || !symbol) {
    throw new Error('startDate, endDate, and symbol are required');
  }

  log.info('load_data_for_symbol_start', { startDate, endDate, symbol });

  const rtdsPromise = sharedRtds
    ? Promise.resolve(sharedRtds)
    : loadRtdsTicks({
        startDate, endDate,
        topics: ['crypto_prices_chainlink', 'crypto_prices', 'crypto_prices_pyth'],
        symbols: [symbol.toLowerCase()],
      });

  const [rtdsTicks, clobSnapshots, exchangeTicks] = await Promise.all([
    rtdsPromise,
    loadAllClobSnapshots({ startDate, endDate, symbolPrefix: symbol }),
    loadExchangeTicks({ startDate, endDate, symbols: [symbol.toLowerCase()] }),
  ]);

  log.info('load_data_for_symbol_complete', {
    symbol,
    rtdsTicks: rtdsTicks.length,
    clobSnapshots: clobSnapshots.length,
    exchangeTicks: exchangeTicks.length,
  });

  return { rtdsTicks, clobSnapshots, exchangeTicks };
}

// ─── Per-Window Data Loading (for remote databases) ───

/**
 * Load tick data for a single window.
 * Faster for remote databases since each query is small (5-min window).
 *
 * @param {Object} options
 * @param {Object} options.window - Window close event row
 * @param {number} [options.windowDurationMs=300000] - Window duration in ms
 * @returns {Promise<{ rtdsTicks: Object[], clobSnapshots: Object[], exchangeTicks: Object[] }>}
 */
export async function loadWindowTickData(options) {
  const { window: win, windowDurationMs = 5 * 60 * 1000 } = options;

  const closeMs = new Date(win.window_close_time).getTime();
  const openMs = closeMs - windowDurationMs;
  const openDate = new Date(openMs).toISOString();
  const closeDate = win.window_close_time instanceof Date
    ? win.window_close_time.toISOString()
    : win.window_close_time;

  const symbol = win.symbol?.toLowerCase() || 'btc';
  // window_epoch in clob_price_snapshots is the window CLOSE time epoch
  const windowEpoch = Math.floor(closeMs / 1000);

  const [rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks] = await Promise.all([
    // Oracle ticks for this window
    persistence.all(`
      SELECT timestamp, topic, symbol, price, received_at
      FROM rtds_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
        AND symbol = $3
        AND topic IN ('crypto_prices_chainlink', 'crypto_prices', 'crypto_prices_pyth')
      ORDER BY timestamp ASC
    `, [openDate, closeDate, symbol.toLowerCase()]),

    // CLOB snapshots for this window (filtered by window_epoch to exclude $0.50 data)
    persistence.all(`
      SELECT timestamp, symbol, token_id, best_bid, best_ask,
             mid_price, spread, bid_size_top, ask_size_top, window_epoch
      FROM clob_price_snapshots
      WHERE timestamp >= $1 AND timestamp <= $2
        AND symbol LIKE $3
        AND window_epoch = $4
      ORDER BY timestamp ASC
    `, [openDate, closeDate, `${symbol}%`, windowEpoch]),

    // Exchange ticks for this window
    persistence.all(`
      SELECT timestamp, exchange, symbol, price, bid, ask
      FROM exchange_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
        AND symbol = $3
      ORDER BY timestamp ASC
    `, [openDate, closeDate, symbol]),

    // L2 book ticks for this window (depth/liquidity data)
    persistence.all(`
      SELECT timestamp, symbol, side, top_levels, bid_depth_1pct, ask_depth_1pct
      FROM l2_book_ticks
      WHERE symbol = $1 AND timestamp >= $2 AND timestamp < $3
      ORDER BY timestamp
    `, [symbol, openDate, closeDate]).catch(() => []),
  ]);

  return { rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks };
}

/**
 * Load window close events with all ground truth columns.
 * Includes gamma_resolved_direction when available.
 *
 * @param {Object} options
 * @param {string} options.startDate
 * @param {string} options.endDate
 * @param {string[]} [options.symbols]
 * @returns {Promise<Object[]>}
 */
export async function loadWindowsWithGroundTruth(options) {
  const { startDate, endDate } = options;

  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  const { clauses, params: filterParams } = buildFilters(options);

  // Check if gamma_resolved_direction column exists
  const colCheck = await persistence.get(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'window_close_events' AND column_name = 'gamma_resolved_direction'
  `);
  const hasGamma = !!colCheck;

  let sql = `
    SELECT window_close_time, symbol, strike_price,
           chainlink_price_at_close, oracle_price_at_open,
           resolved_direction, onchain_resolved_direction,
           ${hasGamma ? 'gamma_resolved_direction,' : ''}
           polymarket_binance_at_close, binance_price_at_close,
           oracle_price_at_close, pyth_price_at_close,
           market_up_price_60s, market_up_price_30s, market_up_price_10s,
           market_up_price_5s, market_up_price_1s,
           market_down_price_60s, market_down_price_30s, market_down_price_10s,
           market_down_price_5s, market_down_price_1s,
           market_consensus_direction, market_consensus_confidence,
           surprise_resolution
    FROM window_close_events
    WHERE window_close_time >= $1 AND window_close_time <= $2
  `;
  const params = [startDate, endDate];

  if (clauses.length > 0) {
    sql += ' AND ' + clauses.join(' AND ');
  }

  sql += ' ORDER BY window_close_time ASC';

  const rows = await persistence.all(sql, [...params, ...filterParams]);

  log.info('load_windows_with_ground_truth', {
    count: rows.length,
    hasGamma,
    startDate,
    endDate,
  });

  return rows;
}

// ─── Utility ───

/**
 * Get available date range for tick data.
 *
 * @returns {Promise<{ earliest: string|null, latest: string|null }>}
 */
export async function getTickDateRange() {
  const result = await persistence.get(`
    SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest
    FROM rtds_ticks
  `);
  return {
    earliest: result?.earliest || null,
    latest: result?.latest || null,
  };
}

/**
 * Get available symbols in tick data.
 *
 * @returns {Promise<string[]>}
 */
export async function getAvailableSymbols() {
  const rows = await persistence.all('SELECT DISTINCT symbol FROM rtds_ticks ORDER BY symbol');
  return rows.map(r => r.symbol);
}

/**
 * Get available topics in tick data.
 *
 * @returns {Promise<string[]>}
 */
export async function getAvailableTopics() {
  const rows = await persistence.all('SELECT DISTINCT topic FROM rtds_ticks ORDER BY topic');
  return rows.map(r => r.topic);
}
