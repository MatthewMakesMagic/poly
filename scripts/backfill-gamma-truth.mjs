/**
 * Backfill Gamma API ground truth for all window_close_events.
 *
 * For each window, calls Gamma API to get outcomePrices and determines
 * the resolved direction (UP/DOWN/UNRESOLVED).
 *
 * Adds gamma_resolved_direction and gamma_backfilled_at columns if missing.
 * Uses a concurrency pool of 20 with retry/backoff on 429s.
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local
const envPath = resolve(import.meta.dirname, '..', '.env.local');
const envContent = readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx);
  let val = trimmed.slice(eqIdx + 1);
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (!process.env[key]) process.env[key] = val;
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const CONCURRENCY = 20;
const MIN_DELAY_MS = 100;
const MAX_RETRIES = 3;
const PROGRESS_INTERVAL = 200;

async function ensureColumns() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE window_close_events
      ADD COLUMN IF NOT EXISTS gamma_resolved_direction TEXT,
      ADD COLUMN IF NOT EXISTS gamma_backfilled_at TIMESTAMPTZ
    `);
    console.log('Ensured gamma_resolved_direction and gamma_backfilled_at columns exist.');
  } finally {
    client.release();
  }
}

async function fetchGamma(slug, attempt = 0) {
  const url = `https://gamma-api.polymarket.com/markets?slug=${slug}`;
  try {
    const res = await fetch(url);
    if (res.status === 429) {
      if (attempt >= MAX_RETRIES) return null;
      const backoff = Math.pow(2, attempt + 1) * 500;
      await sleep(backoff);
      return fetchGamma(slug, attempt + 1);
    }
    if (!res.ok) {
      if (attempt >= MAX_RETRIES) return null;
      await sleep(1000);
      return fetchGamma(slug, attempt + 1);
    }
    return await res.json();
  } catch (err) {
    if (attempt >= MAX_RETRIES) return null;
    await sleep(1000 * (attempt + 1));
    return fetchGamma(slug, attempt + 1);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseDirection(data) {
  if (!data || !Array.isArray(data) || data.length === 0) return null;
  const market = data[0];
  if (!market.outcomePrices) return null;
  let prices;
  try {
    prices = typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices)
      : market.outcomePrices;
  } catch {
    return null;
  }
  if (prices[0] === '1' && prices[1] === '0') return 'up';
  if (prices[0] === '0' && prices[1] === '1') return 'down';
  return 'UNRESOLVED';
}

async function main() {
  const t0 = Date.now();
  await ensureColumns();

  // Load all windows
  const { rows: windows } = await pool.query(`
    SELECT id, window_id, symbol
    FROM window_close_events
    ORDER BY symbol, window_close_time
  `);

  console.log(`Total windows to process: ${windows.length}`);

  const stats = {
    total: windows.length,
    up: 0,
    down: 0,
    unresolved: 0,
    noData: 0,
    failed: 0,
    alreadyDone: 0,
  };
  const bySymbol = {};

  // Process with concurrency pool
  let idx = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= windows.length) return;

      const w = windows[i];
      const epoch = w.window_id.split('-').pop();
      const slug = `${w.symbol}-updown-15m-${epoch}`;

      // Enforce minimum delay between requests
      await sleep(MIN_DELAY_MS);

      const data = await fetchGamma(slug);
      const direction = parseDirection(data);

      if (!bySymbol[w.symbol]) {
        bySymbol[w.symbol] = { up: 0, down: 0, unresolved: 0, noData: 0, failed: 0, total: 0 };
      }
      bySymbol[w.symbol].total++;

      if (direction === null) {
        if (data === null) {
          stats.failed++;
          bySymbol[w.symbol].failed++;
        } else {
          stats.noData++;
          bySymbol[w.symbol].noData++;
        }
      } else if (direction === 'UNRESOLVED') {
        stats.unresolved++;
        bySymbol[w.symbol].unresolved++;
        // Still store as UNRESOLVED
        await pool.query(
          `UPDATE window_close_events
           SET gamma_resolved_direction = $1, gamma_backfilled_at = NOW()
           WHERE id = $2`,
          [direction, w.id]
        );
      } else {
        if (direction === 'up') { stats.up++; bySymbol[w.symbol].up++; }
        else { stats.down++; bySymbol[w.symbol].down++; }
        await pool.query(
          `UPDATE window_close_events
           SET gamma_resolved_direction = $1, gamma_backfilled_at = NOW()
           WHERE id = $2`,
          [direction, w.id]
        );
      }

      completed++;
      if (completed % PROGRESS_INTERVAL === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const rate = (completed / (Date.now() - t0) * 1000).toFixed(1);
        console.log(`  Progress: ${completed}/${windows.length} (${elapsed}s elapsed, ${rate}/s) — UP:${stats.up} DOWN:${stats.down} UNRESOLVED:${stats.unresolved} NODATA:${stats.noData} FAILED:${stats.failed}`);
      }
    }
  }

  // Launch worker pool
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Final report
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`GAMMA BACKFILL COMPLETE — ${elapsed}s`);
  console.log('='.repeat(60));
  console.log(`Total windows:   ${stats.total}`);
  console.log(`  UP resolved:   ${stats.up}`);
  console.log(`  DOWN resolved: ${stats.down}`);
  console.log(`  UNRESOLVED:    ${stats.unresolved}`);
  console.log(`  No data:       ${stats.noData}`);
  console.log(`  Failed:        ${stats.failed}`);

  console.log(`\n--- By Symbol ---`);
  for (const [sym, s] of Object.entries(bySymbol).sort()) {
    console.log(`  ${sym.toUpperCase()}: total=${s.total} UP=${s.up} DOWN=${s.down} UNRESOLVED=${s.unresolved} noData=${s.noData} failed=${s.failed}`);
  }

  await pool.end();
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
