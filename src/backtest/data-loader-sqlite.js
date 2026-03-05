/**
 * SQLite Backtest Data Loader
 *
 * Drop-in replacement for data-loader.js that reads from a local
 * SQLite file (data/backtest.sqlite) instead of remote Postgres.
 *
 * All function signatures match the Postgres version so that
 * parallel-engine.js and runner scripts work without changes.
 *
 * better-sqlite3 is synchronous, but callers use `await` so all
 * public functions return Promise-wrapped results.
 */

import { resolve } from 'path';
import Database from 'better-sqlite3';

const SQLITE_PATH = process.env.SQLITE_PATH || resolve(process.cwd(), 'data', 'backtest.sqlite');

let db = null;

function getDb() {
  if (!db) {
    db = new Database(SQLITE_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');
    db.pragma('cache_size = -256000'); // 256MB
    db.pragma('mmap_size = 2147483648'); // 2GB mmap for fast page access
  }
  return db;
}

/**
 * Close the database handle.
 */
export function close() {
  if (db) {
    db.close();
    db = null;
  }
}

// ─── Helpers ───

/**
 * Parse a row's timestamp fields from ISO strings back to Date objects
 * to match what Postgres pg driver returns.
 */
function parseDates(row, ...fields) {
  for (const f of fields) {
    if (row[f] != null && typeof row[f] === 'string') {
      row[f] = new Date(row[f]);
    }
  }
  return row;
}

// ─── RTDS Ticks ───

/**
 * Load rtds_ticks in batches (async generator).
 * For SQLite, we still yield batches for API compatibility,
 * but reads are fast enough that one query suffices.
 *
 * @param {Object} options
 * @param {string} options.startDate
 * @param {string} options.endDate
 * @param {string[]} [options.symbols]
 * @param {string[]} [options.topics]
 * @param {number} [options.batchSize=10000]
 * @yields {Object[]}
 */
export async function* loadRtdsTicksBatched(options) {
  const { startDate, endDate, batchSize = 10000 } = options;
  if (!startDate || !endDate) throw new Error('startDate and endDate are required');

  let sql = `SELECT id, timestamp, topic, symbol, price, received_at
             FROM rtds_ticks
             WHERE timestamp >= ? AND timestamp <= ?`;
  const params = [startDate, endDate];

  if (options.symbols?.length > 0) {
    sql += ` AND symbol IN (${options.symbols.map(() => '?').join(',')})`;
    params.push(...options.symbols);
  }
  if (options.topics?.length > 0) {
    sql += ` AND topic IN (${options.topics.map(() => '?').join(',')})`;
    params.push(...options.topics);
  }

  sql += ' ORDER BY id ASC';

  const rows = getDb().prepare(sql).all(...params);

  // Yield in batches
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    for (const r of batch) parseDates(r, 'timestamp', 'received_at');
    yield batch;
  }
}

/**
 * Load all rtds_ticks as a single array.
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
 */
export async function getTickCount(options) {
  const { startDate, endDate } = options;
  if (!startDate || !endDate) throw new Error('startDate and endDate are required');

  let sql = `SELECT COUNT(*) as count FROM rtds_ticks WHERE timestamp >= ? AND timestamp <= ?`;
  const params = [startDate, endDate];

  if (options.symbols?.length > 0) {
    sql += ` AND symbol IN (${options.symbols.map(() => '?').join(',')})`;
    params.push(...options.symbols);
  }
  if (options.topics?.length > 0) {
    sql += ` AND topic IN (${options.topics.map(() => '?').join(',')})`;
    params.push(...options.topics);
  }

  const row = getDb().prepare(sql).get(...params);
  return row?.count || 0;
}

// ─── CLOB Snapshots ───

/**
 * Load CLOB price snapshots.
 */
export async function loadClobSnapshots(options) {
  const { startDate, endDate, windowEpoch } = options;
  if (!startDate || !endDate) throw new Error('startDate and endDate are required');

  let sql = `SELECT timestamp, symbol, token_id, best_bid, best_ask,
                    mid_price, spread, bid_size_top, ask_size_top, window_epoch
             FROM clob_price_snapshots
             WHERE timestamp >= ? AND timestamp <= ?`;
  const params = [startDate, endDate];

  if (windowEpoch != null) {
    sql += ` AND window_epoch = ?`;
    params.push(windowEpoch);
  }

  if (options.symbols?.length > 0) {
    sql += ` AND symbol IN (${options.symbols.map(() => '?').join(',')})`;
    params.push(...options.symbols);
  }

  sql += ' ORDER BY timestamp ASC';

  const rows = getDb().prepare(sql).all(...params);
  for (const r of rows) parseDates(r, 'timestamp');
  return rows;
}

/**
 * Load ALL CLOB snapshots for a date range (used by parallel engine bulk load).
 */
function loadAllClobSnapshots(options) {
  const { startDate, endDate, symbolPrefix } = options;

  let sql = `SELECT id, timestamp, symbol, token_id, best_bid, best_ask,
                    mid_price, spread, bid_size_top, ask_size_top, window_epoch
             FROM clob_price_snapshots
             WHERE timestamp >= ? AND timestamp <= ?`;
  const params = [startDate, endDate];

  if (symbolPrefix) {
    sql += ` AND symbol LIKE ?`;
    params.push(`${symbolPrefix.toLowerCase()}%`);
  }

  sql += ' ORDER BY id ASC';

  const rows = getDb().prepare(sql).all(...params);
  for (const r of rows) parseDates(r, 'timestamp');
  return rows;
}

// ─── L2 Book Ticks ───

/**
 * Load L2 orderbook ticks.
 * Parses top_levels from JSON string to object.
 */
export async function loadL2BookTicks(options) {
  const { startDate, endDate } = options;
  if (!startDate || !endDate) throw new Error('startDate and endDate are required');

  let sql = `SELECT id, timestamp, token_id, symbol, window_id, event_type,
                    best_bid, best_ask, mid_price, spread,
                    bid_depth_1pct, ask_depth_1pct, top_levels
             FROM l2_book_ticks
             WHERE timestamp >= ? AND timestamp <= ?`;
  const params = [startDate, endDate];

  if (options.symbols?.length > 0) {
    sql += ` AND symbol IN (${options.symbols.map(() => '?').join(',')})`;
    params.push(...options.symbols);
  }

  sql += ' ORDER BY id ASC';

  let rows;
  try {
    rows = getDb().prepare(sql).all(...params);
  } catch {
    // Table may not exist yet
    return [];
  }

  for (const r of rows) {
    parseDates(r, 'timestamp');
    if (r.top_levels && typeof r.top_levels === 'string') {
      try {
        r.top_levels = JSON.parse(r.top_levels);
      } catch {
        r.top_levels = null;
      }
    }
  }
  return rows;
}

// ─── Exchange Ticks ───

/**
 * Load exchange ticks.
 */
export async function loadExchangeTicks(options) {
  const { startDate, endDate } = options;
  if (!startDate || !endDate) throw new Error('startDate and endDate are required');

  let sql = `SELECT id, timestamp, exchange, symbol, price, bid, ask
             FROM exchange_ticks
             WHERE timestamp >= ? AND timestamp <= ?`;
  const params = [startDate, endDate];

  if (options.symbols?.length > 0) {
    sql += ` AND symbol IN (${options.symbols.map(() => '?').join(',')})`;
    params.push(...options.symbols);
  }
  if (options.exchanges?.length > 0) {
    sql += ` AND exchange IN (${options.exchanges.map(() => '?').join(',')})`;
    params.push(...options.exchanges);
  }

  sql += ' ORDER BY id ASC';

  const rows = getDb().prepare(sql).all(...params);
  for (const r of rows) parseDates(r, 'timestamp');
  return rows;
}

// ─── Window Close Events ───

/**
 * Load window close events (ground truth for resolution).
 */
export async function loadWindowEvents(options) {
  const { startDate, endDate } = options;
  if (!startDate || !endDate) throw new Error('startDate and endDate are required');

  let sql = `SELECT window_close_time, symbol, strike_price,
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
             WHERE window_close_time >= ? AND window_close_time <= ?`;
  const params = [startDate, endDate];

  if (options.symbols?.length > 0) {
    sql += ` AND symbol IN (${options.symbols.map(() => '?').join(',')})`;
    params.push(...options.symbols);
  }

  sql += ' ORDER BY window_close_time ASC';

  const rows = getDb().prepare(sql).all(...params);
  for (const r of rows) parseDates(r, 'window_close_time');
  return rows;
}

// ─── Merged Timeline ───

/**
 * Load all data sources and merge into a single sorted timeline.
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
    if (topic === 'crypto_prices_chainlink') source = 'chainlink';
    else if (topic === 'crypto_prices') source = 'polyRef';
    else source = `rtds_${topic}`;
    timeline.push({ ...tick, source });
  }

  for (const snap of clobSnapshots) {
    const isDown = snap.symbol?.toLowerCase().includes('down');
    const source = isDown ? 'clobDown' : 'clobUp';
    timeline.push({ ...snap, source });
  }

  for (const tick of exchangeTicks) {
    timeline.push({ ...tick, source: `exchange_${tick.exchange}` });
  }

  // CoinGecko ticks
  let coingeckoTicks = [];
  try {
    const symbol = options.symbols?.[0] || options.symbol;
    if (symbol) {
      coingeckoTicks = getDb().prepare(`
        SELECT timestamp, symbol, price FROM coingecko_ticks
        WHERE timestamp >= ? AND timestamp <= ? AND symbol = ?
        ORDER BY timestamp ASC
      `).all(options.startDate, options.endDate, symbol.toLowerCase());
      for (const r of coingeckoTicks) parseDates(r, 'timestamp');
    }
  } catch { /* table may not exist */ }

  for (const tick of coingeckoTicks) {
    timeline.push({ ...tick, source: 'coingecko' });
  }

  timeline.sort((a, b) => {
    const tA = new Date(a.timestamp).getTime();
    const tB = new Date(b.timestamp).getTime();
    return tA - tB;
  });

  return timeline;
}

// ─── Bulk Data Loading (for parallel engine) ───

/**
 * Load all tick data for a date range in one pass.
 */
export async function loadAllData(options) {
  const { startDate, endDate, symbols } = options;
  if (!startDate || !endDate) throw new Error('startDate and endDate are required');

  const [rtdsTicks, clobSnapshots, exchangeTicks] = await Promise.all([
    loadRtdsTicks({
      startDate, endDate,
      topics: ['crypto_prices_chainlink', 'crypto_prices'],
    }),
    Promise.resolve(loadAllClobSnapshots({ startDate, endDate })),
    loadExchangeTicks({
      startDate, endDate,
      symbols: symbols ? symbols.map(s => s.toLowerCase()) : undefined,
    }),
  ]);

  return { rtdsTicks, clobSnapshots, exchangeTicks };
}

/**
 * Load all data for a single symbol.
 */
export async function loadAllDataForSymbol(options) {
  const { startDate, endDate, symbol, sharedRtds } = options;
  if (!startDate || !endDate || !symbol) {
    throw new Error('startDate, endDate, and symbol are required');
  }

  const rtdsTicks = sharedRtds || await loadRtdsTicks({
    startDate, endDate,
    topics: ['crypto_prices_chainlink', 'crypto_prices'],
    symbols: [symbol.toLowerCase()],
  });

  const clobSnapshots = loadAllClobSnapshots({ startDate, endDate, symbolPrefix: symbol });

  const exchangeTicks = await loadExchangeTicks({
    startDate, endDate,
    symbols: [symbol.toLowerCase()],
  });

  return { rtdsTicks, clobSnapshots, exchangeTicks };
}

// ─── Per-Window Data Loading ───

/**
 * Load tick data for a single window.
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
  // window_epoch in clob_price_snapshots is tagged with window OPEN time, not CLOSE time
  // 900 = 15 minutes (one window duration in seconds)
  const windowEpoch = Math.floor(closeMs / 1000) - 900;

  const d = getDb();

  const rtdsTicks = d.prepare(`
    SELECT timestamp, topic, symbol, price, received_at
    FROM rtds_ticks
    WHERE timestamp >= ? AND timestamp <= ?
      AND topic IN ('crypto_prices_chainlink', 'crypto_prices')
    ORDER BY timestamp ASC
  `).all(openDate, closeDate);
  for (const r of rtdsTicks) parseDates(r, 'timestamp', 'received_at');

  let clobSnapshots = d.prepare(`
    SELECT timestamp, symbol, token_id, best_bid, best_ask,
           mid_price, spread, bid_size_top, ask_size_top, window_epoch
    FROM clob_price_snapshots
    WHERE timestamp >= ? AND timestamp <= ?
      AND symbol LIKE ?
      AND window_epoch = ?
    ORDER BY timestamp ASC
  `).all(openDate, closeDate, `${symbol}%`, windowEpoch);
  for (const r of clobSnapshots) parseDates(r, 'timestamp');

  // Filter to active trading range — tokens converging to 0 or 1 are from adjacent windows
  clobSnapshots = clobSnapshots.filter(snap => {
    const mid = Number(snap.mid_price ?? snap.best_bid ?? snap.best_ask ?? 0);
    return mid >= 0.05 && mid <= 0.95;
  });

  const exchangeTicks = d.prepare(`
    SELECT timestamp, exchange, symbol, price, bid, ask
    FROM exchange_ticks
    WHERE timestamp >= ? AND timestamp <= ?
      AND symbol = ?
    ORDER BY timestamp ASC
  `).all(openDate, closeDate, symbol);
  for (const r of exchangeTicks) parseDates(r, 'timestamp');

  // L2 book ticks (if table exists)
  let l2BookTicks = [];
  try {
    l2BookTicks = d.prepare(`
      SELECT id, timestamp, token_id, symbol, window_id, event_type,
             best_bid, best_ask, mid_price, spread,
             bid_depth_1pct, ask_depth_1pct, top_levels
      FROM l2_book_ticks
      WHERE timestamp >= ? AND timestamp <= ?
        AND symbol LIKE ?
      ORDER BY timestamp ASC
    `).all(openDate, closeDate, `${symbol}%`);
    // Build token_id → direction lookup from CLOB snapshots (which have btc-up/btc-down symbols)
    const tokenDirMap = {};
    try {
      const clobTokens = d.prepare(
        `SELECT DISTINCT token_id, symbol FROM clob_price_snapshots WHERE symbol IN (?, ?)`,
      ).all(`${symbol}-up`, `${symbol}-down`);
      for (const t of clobTokens) {
        tokenDirMap[t.token_id] = t.symbol.includes('down') ? 'down' : 'up';
      }
    } catch { /* ignore */ }

    for (const r of l2BookTicks) {
      parseDates(r, 'timestamp');
      // Tag direction from CLOB token_id mapping
      r.direction = tokenDirMap[r.token_id] || null;
      if (r.top_levels && typeof r.top_levels === 'string') {
        try {
          r.top_levels = JSON.parse(r.top_levels);
        } catch {
          r.top_levels = null;
        }
      }
    }
  } catch { /* table may not exist */ }

  // CoinGecko ticks (if table exists)
  let coingeckoTicks = [];
  try {
    coingeckoTicks = d.prepare(`
      SELECT timestamp, symbol, price
      FROM coingecko_ticks
      WHERE timestamp >= ? AND timestamp <= ?
        AND symbol = ?
      ORDER BY timestamp ASC
    `).all(openDate, closeDate, symbol);
    for (const r of coingeckoTicks) parseDates(r, 'timestamp');
  } catch { /* table may not exist */ }

  return { rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks, coingeckoTicks };
}

/**
 * Load window close events with all ground truth columns.
 */
export async function loadWindowsWithGroundTruth(options) {
  const { startDate, endDate } = options;
  if (!startDate || !endDate) throw new Error('startDate and endDate are required');

  let sql = `SELECT window_close_time, symbol, strike_price,
                    chainlink_price_at_close, oracle_price_at_open,
                    resolved_direction, onchain_resolved_direction,
                    gamma_resolved_direction,
                    polymarket_binance_at_close, binance_price_at_close,
                    oracle_price_at_close, pyth_price_at_close,
                    market_up_price_60s, market_up_price_30s, market_up_price_10s,
                    market_up_price_5s, market_up_price_1s,
                    market_down_price_60s, market_down_price_30s, market_down_price_10s,
                    market_down_price_5s, market_down_price_1s,
                    market_consensus_direction, market_consensus_confidence,
                    surprise_resolution
             FROM window_close_events
             WHERE window_close_time >= ? AND window_close_time <= ?`;
  const params = [startDate, endDate];

  if (options.symbols?.length > 0) {
    sql += ` AND symbol IN (${options.symbols.map(() => '?').join(',')})`;
    params.push(...options.symbols);
  }

  sql += ' ORDER BY window_close_time ASC';

  const rows = getDb().prepare(sql).all(...params);
  for (const r of rows) parseDates(r, 'window_close_time');

  return rows;
}

// ─── Utility ───

/**
 * Get available date range for tick data.
 */
export async function getTickDateRange() {
  const row = getDb().prepare(`
    SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest FROM rtds_ticks
  `).get();
  return {
    earliest: row?.earliest || null,
    latest: row?.latest || null,
  };
}

/**
 * Get available symbols in tick data.
 */
export async function getAvailableSymbols() {
  const rows = getDb().prepare('SELECT DISTINCT symbol FROM rtds_ticks ORDER BY symbol').all();
  return rows.map(r => r.symbol);
}

/**
 * Get available topics in tick data.
 */
export async function getAvailableTopics() {
  const rows = getDb().prepare('SELECT DISTINCT topic FROM rtds_ticks ORDER BY topic').all();
  return rows.map(r => r.topic);
}
