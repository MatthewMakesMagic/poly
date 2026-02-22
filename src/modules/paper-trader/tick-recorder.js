/**
 * Tick Recorder — Continuous L2 book tick persistence
 *
 * Records every CLOB WebSocket book update for active windows.
 * Buffers ticks in memory and flushes to l2_book_ticks table every second.
 *
 * @module modules/paper-trader/tick-recorder
 */

import persistence from '../../persistence/index.js';
import { child } from '../logger/index.js';

let log = null;

// Buffer: Map<tokenId, tick[]>
const buffers = new Map();

// Unsubscribe functions: Map<tokenId, Function>
const unsubscribes = new Map();

// Recording metadata: Map<tokenId, { symbol, windowId }>
const metadata = new Map();

// Flush interval handle
let flushIntervalId = null;

// Stats
const stats = {
  ticksBuffered: 0,
  ticksFlushed: 0,
  ticksDropped: 0,
  flushErrors: 0,
};

const BUFFER_CAP = 5000;
const FLUSH_INTERVAL_MS = 1000;
const BATCH_SIZE = 200;

/**
 * Start recording ticks for a token
 *
 * @param {string} tokenId - CLOB token ID
 * @param {string} symbol - Crypto symbol (btc, eth, xrp)
 * @param {string} windowId - Window identifier (e.g. btc-15m-1771521300)
 * @param {Object} clobWs - CLOB WebSocket client module
 */
export function startRecording(tokenId, symbol, windowId, clobWs) {
  if (!log) log = child({ module: 'tick-recorder' });

  // Already recording this token
  if (unsubscribes.has(tokenId)) return;

  buffers.set(tokenId, []);
  metadata.set(tokenId, { symbol, windowId });

  const unsub = clobWs.subscribe(tokenId, ({ eventType }) => {
    const snapshot = clobWs.getBookSnapshot(tokenId);
    if (!snapshot) return;

    const meta = metadata.get(tokenId);
    if (!meta) return;

    const tick = {
      timestamp: new Date(),
      tokenId,
      symbol: meta.symbol,
      windowId: meta.windowId,
      eventType,
      bestBid: snapshot.bestBid,
      bestAsk: snapshot.bestAsk,
      mid: snapshot.mid,
      spread: snapshot.spread,
      bidDepth1pct: snapshot.bidDepth1pct,
      askDepth1pct: snapshot.askDepth1pct,
      topLevels: {
        bids: snapshot.bids.slice(0, 5).map(([p, s]) => [p, s]),
        asks: snapshot.asks.slice(0, 5).map(([p, s]) => [p, s]),
      },
    };

    const buf = buffers.get(tokenId);
    if (!buf) return;

    if (buf.length >= BUFFER_CAP) {
      // Drop oldest ticks
      const dropCount = Math.floor(BUFFER_CAP * 0.1);
      buf.splice(0, dropCount);
      stats.ticksDropped += dropCount;
      if (log) log.warn('tick_buffer_overflow', { tokenId: tokenId.substring(0, 16), dropped: dropCount });
    }

    buf.push(tick);
    stats.ticksBuffered++;
  });

  unsubscribes.set(tokenId, unsub);

  // Start flush interval if not running
  if (!flushIntervalId) {
    flushIntervalId = setInterval(() => {
      flushAllBuffers().catch(err => {
        if (log) log.warn('tick_flush_error', { error: err.message });
      });
    }, FLUSH_INTERVAL_MS);
    if (flushIntervalId.unref) flushIntervalId.unref();
  }
}

/**
 * Stop recording ticks for a token, flush remaining buffer
 *
 * @param {string} tokenId - CLOB token ID
 */
export async function stopRecording(tokenId) {
  const unsub = unsubscribes.get(tokenId);
  if (unsub) {
    unsub();
    unsubscribes.delete(tokenId);
  }

  // Flush remaining ticks for this token
  await flushBuffer(tokenId);

  buffers.delete(tokenId);
  metadata.delete(tokenId);

  // Stop flush interval if no more recordings
  if (unsubscribes.size === 0 && flushIntervalId) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
  }
}

/**
 * Flush all pending buffers (called on shutdown)
 */
export async function flushAll() {
  for (const tokenId of buffers.keys()) {
    await flushBuffer(tokenId);
  }
}

/**
 * Get recording stats
 *
 * @returns {{ ticksBuffered: number, ticksFlushed: number, ticksDropped: number, flushErrors: number, activeRecordings: number }}
 */
export function getStats() {
  return {
    ...stats,
    activeRecordings: unsubscribes.size,
  };
}

/**
 * Flush all non-empty buffers
 */
async function flushAllBuffers() {
  for (const tokenId of buffers.keys()) {
    await flushBuffer(tokenId);
  }
}

/**
 * Flush buffer for a single token
 *
 * @param {string} tokenId
 */
async function flushBuffer(tokenId) {
  const buf = buffers.get(tokenId);
  if (!buf || buf.length === 0) return;

  // Take all ticks and clear buffer
  const ticks = buf.splice(0, buf.length);

  // Insert in batches
  for (let i = 0; i < ticks.length; i += BATCH_SIZE) {
    const batch = ticks.slice(i, i + BATCH_SIZE);
    try {
      await insertBatch(batch);
      stats.ticksFlushed += batch.length;
    } catch (err) {
      stats.flushErrors++;
      if (log && (stats.flushErrors <= 5 || stats.flushErrors % 60 === 0)) {
        log.warn('tick_batch_insert_failed', {
          tokenId: tokenId.substring(0, 16),
          batchSize: batch.length,
          error: err.message,
          errorCount: stats.flushErrors,
        });
      }
    }
  }
}

/**
 * Insert a batch of ticks using multi-row VALUES
 *
 * @param {Object[]} ticks
 */
async function insertBatch(ticks) {
  const COLS = 12;
  const values = [];
  const params = [];

  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    const offset = i * COLS;
    values.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, ` +
      `$${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, ` +
      `$${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12})`
    );
    params.push(
      t.timestamp,
      t.tokenId,
      t.symbol,
      t.windowId,
      t.eventType,
      t.bestBid,
      t.bestAsk,
      t.mid,
      t.spread,
      t.bidDepth1pct,
      t.askDepth1pct,
      JSON.stringify(t.topLevels),
    );
  }

  const sql = `
    INSERT INTO l2_book_ticks (
      timestamp, token_id, symbol, window_id, event_type,
      best_bid, best_ask, mid_price, spread,
      bid_depth_1pct, ask_depth_1pct, top_levels
    ) VALUES ${values.join(', ')}
  `;

  await persistence.run(sql, params);
}

/**
 * Reset module state (for testing)
 */
export function _reset() {
  for (const unsub of unsubscribes.values()) {
    unsub();
  }
  unsubscribes.clear();
  buffers.clear();
  metadata.clear();
  if (flushIntervalId) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
  }
  stats.ticksBuffered = 0;
  stats.ticksFlushed = 0;
  stats.ticksDropped = 0;
  stats.flushErrors = 0;
  log = null;
}
