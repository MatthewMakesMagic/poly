#!/usr/bin/env node

/**
 * Backfill on-chain resolution for all BTC windows.
 *
 * Reads condition_id from Postgres, calls the CTF contract on Polygon
 * to get payoutNumerators, and writes onchain_resolved_direction into SQLite.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node scripts/backfill-onchain-resolution.mjs
 *   node scripts/backfill-onchain-resolution.mjs --symbol=btc --dry-run
 */

import https from 'https';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import pg from 'pg';

const { Pool } = pg;

// ─── Config ───

const SYMBOL = process.argv.find(a => a.startsWith('--symbol='))?.split('=')[1]?.toLowerCase() || 'btc';
const DRY_RUN = process.argv.includes('--dry-run');
const SQLITE_PATH = process.env.SQLITE_PATH || resolve(process.cwd(), 'data', 'backtest.sqlite');
const CTF_ADDRESS = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const DENOM_SELECTOR = '0xdd34de67';
const NUM_SELECTOR = '0x0504c814';
const BATCH_SIZE = 5; // concurrent RPC calls (keep low to avoid rate limits)
const DELAY_BETWEEN_BATCHES_MS = 500;
const RETRY_RPCS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://1rpc.io/matic',
];

// ─── RPC helpers ───

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function polygonRpc(method, params, rpcUrl = RETRY_RPCS[0]) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const url = new URL(rpcUrl);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(JSON.stringify(parsed.error)));
          else resolve(parsed.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function encodeBytes32(hex) {
  return hex.replace(/^0x/, '').padStart(64, '0');
}

function encodeUint256(n) {
  return n.toString(16).padStart(64, '0');
}

async function readOnchainResolution(conditionId) {
  const condBytes = encodeBytes32(conditionId);

  for (const rpcUrl of RETRY_RPCS) {
    try {
      const denomResult = await polygonRpc('eth_call', [
        { to: CTF_ADDRESS, data: DENOM_SELECTOR + condBytes }, 'latest'
      ], rpcUrl);

      const denom = BigInt(denomResult);
      if (denom === 0n) return { resolved: false, direction: null };

      const [num0Result, num1Result] = await Promise.all([
        polygonRpc('eth_call', [{ to: CTF_ADDRESS, data: NUM_SELECTOR + condBytes + encodeUint256(0) }, 'latest'], rpcUrl),
        polygonRpc('eth_call', [{ to: CTF_ADDRESS, data: NUM_SELECTOR + condBytes + encodeUint256(1) }, 'latest'], rpcUrl),
      ]);

      const p0 = BigInt(num0Result);
      const p1 = BigInt(num1Result);
      return { resolved: true, direction: p0 > p1 ? 'up' : 'down' };
    } catch (err) {
      // Try next RPC
      continue;
    }
  }
  return { resolved: false, direction: null, error: 'all RPCs failed' };
}

// ─── Main ───

async function main() {
  const t0 = Date.now();
  console.log(`=== On-Chain Resolution Backfill ===`);
  console.log(`Symbol: ${SYMBOL.toUpperCase()} | Dry run: ${DRY_RUN}`);

  // 1. Get condition_ids from Postgres
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query(
    `SELECT window_close_time, condition_id FROM window_close_events
     WHERE symbol = $1 AND condition_id IS NOT NULL
     ORDER BY window_close_time ASC`,
    [SYMBOL]
  );
  await pool.end();
  console.log(`Fetched ${rows.length} condition_ids from Postgres\n`);

  // 2. Open SQLite for writing
  const db = new Database(SQLITE_PATH);

  // Add onchain_resolved_direction column if missing (idempotent)
  const cols = db.prepare('PRAGMA table_info(window_close_events)').all();
  if (!cols.find(c => c.name === 'onchain_resolved_direction')) {
    db.exec('ALTER TABLE window_close_events ADD COLUMN onchain_resolved_direction TEXT');
    console.log('Added onchain_resolved_direction column to SQLite');
  }

  const updateStmt = db.prepare(
    `UPDATE window_close_events SET onchain_resolved_direction = ?
     WHERE window_close_time = ? AND symbol = ?`
  );

  // 3. Process in batches
  let resolved = 0, unresolved = 0, errors = 0, updated = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (row) => {
        try {
          const result = await readOnchainResolution(row.condition_id);
          return { row, result };
        } catch (err) {
          return { row, result: { resolved: false, direction: null, error: err.message } };
        }
      })
    );

    for (const { row, result } of results) {
      if (result.resolved && result.direction) {
        resolved++;
        if (!DRY_RUN) {
          const closeTimeStr = row.window_close_time instanceof Date
            ? row.window_close_time.toISOString()
            : row.window_close_time;
          const changes = updateStmt.run(result.direction, closeTimeStr, SYMBOL);
          if (changes.changes > 0) updated++;
        }
      } else if (result.error) {
        errors++;
        if (errors <= 3) console.log('\n  Error sample:', result.error);
      } else {
        unresolved++;
      }
    }

    const pct = Math.min(100, Math.round((i + batch.length) / rows.length * 100));
    process.stdout.write(`\r  ${i + batch.length}/${rows.length} (${pct}%) — resolved: ${resolved}, unresolved: ${unresolved}, errors: ${errors}`);

    // Throttle to avoid rate limits
    if (i + BATCH_SIZE < rows.length) await sleep(DELAY_BETWEEN_BATCHES_MS);
  }

  console.log('\n');

  // 4. Verify: compare onchain vs gamma vs CL formula
  if (!DRY_RUN) {
    console.log('=== Verification ===');
    const all = db.prepare(`
      SELECT window_close_time, gamma_resolved_direction, onchain_resolved_direction,
             chainlink_price_at_close, oracle_price_at_open
      FROM window_close_events WHERE symbol = ? AND onchain_resolved_direction IS NOT NULL
    `).all(SYMBOL);

    let gammaMatch = 0, gammaMismatch = 0;
    let clMatch = 0, clMismatch = 0, clCantCheck = 0;

    for (const w of all) {
      const onchain = w.onchain_resolved_direction.toUpperCase();
      const gamma = (w.gamma_resolved_direction || '').toUpperCase();
      if (gamma) {
        if (gamma === onchain) gammaMatch++;
        else gammaMismatch++;
      }

      const clClose = Number(w.chainlink_price_at_close);
      const clOpen = Number(w.oracle_price_at_open);
      if (clClose && clOpen) {
        const computed = clClose >= clOpen ? 'UP' : 'DOWN';
        if (computed === onchain) clMatch++;
        else clMismatch++;
      } else {
        clCantCheck++;
      }
    }

    console.log(`Onchain vs Gamma: ${gammaMatch} match, ${gammaMismatch} mismatch (${(gammaMatch/(gammaMatch+gammaMismatch)*100).toFixed(1)}% agree)`);
    console.log(`Onchain vs CL formula: ${clMatch} match, ${clMismatch} mismatch (${(clMatch/(clMatch+clMismatch)*100).toFixed(1)}% agree)`);
  }

  db.close();
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s — resolved: ${resolved}, updated: ${updated}, unresolved: ${unresolved}, errors: ${errors}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
