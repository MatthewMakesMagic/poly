/**
 * Backfill on-chain CTF resolutions for ALL instruments.
 *
 * For each window_close_event that has no onchain_resolved_direction:
 * 1. Fetch conditionId from Gamma API
 * 2. Read payoutNumerators from CTF contract on Polygon
 * 3. Update the DB row with the on-chain resolution
 *
 * Uses Multicall3 to batch RPC calls.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local') });
const { Client } = require('pg');
const https = require('https');
const { ethers } = require('ethers');

const CTF = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const abiCoder = ethers.AbiCoder.defaultAbiCoder();
const denomSelector = ethers.id('payoutDenominator(bytes32)').slice(0, 10);
const numSelector = ethers.id('payoutNumerators(bytes32,uint256)').slice(0, 10);

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = https.request('https://polygon-rpc.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
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
    req.write(body);
    req.end();
  });
}

function gammaFetch(slug) {
  return new Promise((resolve, reject) => {
    https.get('https://gamma-api.polymarket.com/markets?slug=' + slug, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function multicall(calls) {
  const aggregate3Selector = '0x82ad56cb';
  const encoded = abiCoder.encode(
    ['tuple(address target, bool allowFailure, bytes callData)[]'],
    [calls.map(c => ({ target: c.target, allowFailure: true, callData: c.data }))]
  );
  const calldata = aggregate3Selector + encoded.slice(2);
  const result = await rpc('eth_call', [{ to: MULTICALL3, data: calldata }, 'latest']);
  const decoded = abiCoder.decode(['tuple(bool success, bytes returnData)[]'], result);
  return decoded[0].map(r => ({ success: r[0], data: r[1] }));
}

async function main() {
  const pg = new Client(process.env.DATABASE_URL);
  await pg.connect();
  const t0 = Date.now();

  // Load all windows missing on-chain resolution
  const windowsRes = await pg.query(`
    SELECT id, window_id, symbol, condition_id
    FROM window_close_events
    WHERE onchain_resolved_direction IS NULL
    ORDER BY symbol, window_close_time
  `);

  console.log(`Found ${windowsRes.rows.length} windows missing on-chain resolution`);

  // Group by symbol
  const bySymbol = {};
  for (const w of windowsRes.rows) {
    if (!bySymbol[w.symbol]) bySymbol[w.symbol] = [];
    bySymbol[w.symbol].push(w);
  }

  for (const [sym, windows] of Object.entries(bySymbol)) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`${sym.toUpperCase()}: ${windows.length} windows to process`);
    console.log('═'.repeat(60));

    // Step 1: Fetch conditionIds from Gamma API where missing
    let needGamma = windows.filter(w => !w.condition_id);
    let haveCondition = windows.filter(w => w.condition_id);
    console.log(`  ${haveCondition.length} already have conditionId, ${needGamma.length} need Gamma API lookup`);

    for (let i = 0; i < needGamma.length; i++) {
      const w = needGamma[i];
      const epoch = parseInt(w.window_id.split('-').pop());
      // Polymarket slug format: {crypto}-updown-15m-{epoch}
      const slug = `${sym}-updown-15m-${epoch}`;

      try {
        const markets = await gammaFetch(slug);
        if (markets && markets.length > 0 && markets[0].conditionId) {
          w.condition_id = markets[0].conditionId;
          // Store conditionId in DB
          await pg.query(
            'UPDATE window_close_events SET condition_id = $1 WHERE id = $2',
            [markets[0].conditionId, w.id]
          );
        }
      } catch (e) {
        // skip
      }

      if ((i + 1) % 20 === 0) {
        process.stdout.write(`  Gamma API: ${i + 1}/${needGamma.length}\r`);
        await sleep(300);
      } else if ((i + 1) % 5 === 0) {
        await sleep(100);
      }
    }

    const withCondition = windows.filter(w => w.condition_id);
    console.log(`  ${withCondition.length}/${windows.length} have conditionId after Gamma lookup`);

    if (withCondition.length === 0) {
      console.log(`  SKIPPING — no conditionIds found (Polymarket may not have ${sym.toUpperCase()} 15m markets)`);
      continue;
    }

    // Step 2: Batch on-chain resolution queries
    console.log('  Querying on-chain CTF state via Multicall3...');
    const BATCH_SIZE = 30;
    let resolved = 0, notResolved = 0, errors = 0;

    for (let batch = 0; batch < withCondition.length; batch += BATCH_SIZE) {
      const chunk = withCondition.slice(batch, batch + BATCH_SIZE);
      const calls = [];

      for (const w of chunk) {
        calls.push({
          target: CTF,
          data: denomSelector + abiCoder.encode(['bytes32'], [w.condition_id]).slice(2),
        });
        calls.push({
          target: CTF,
          data: numSelector + abiCoder.encode(['bytes32', 'uint256'], [w.condition_id, 0]).slice(2),
        });
        calls.push({
          target: CTF,
          data: numSelector + abiCoder.encode(['bytes32', 'uint256'], [w.condition_id, 1]).slice(2),
        });
      }

      try {
        const results = await multicall(calls);

        for (let i = 0; i < chunk.length; i++) {
          const w = chunk[i];
          const denomR = results[i * 3];
          const num0R = results[i * 3 + 1];
          const num1R = results[i * 3 + 2];

          if (!denomR.success) { notResolved++; continue; }
          const denom = BigInt(denomR.data);
          if (denom === 0n) { notResolved++; continue; }

          const p0 = num0R.success ? BigInt(num0R.data) : 0n;
          const p1 = num1R.success ? BigInt(num1R.data) : 0n;
          const direction = p0 > p1 ? 'up' : 'down';

          await pg.query(
            'UPDATE window_close_events SET onchain_resolved_direction = $1 WHERE id = $2',
            [direction, w.id]
          );
          resolved++;
        }
      } catch (e) {
        console.log(`  Multicall error: ${e.message.substring(0, 100)}`);
        errors++;
        await sleep(5000);
      }

      process.stdout.write(`  On-chain: ${Math.min(batch + BATCH_SIZE, withCondition.length)}/${withCondition.length} (${resolved} resolved, ${notResolved} pending)\r`);
      await sleep(500);
    }

    console.log(`\n  ${sym.toUpperCase()} DONE: ${resolved} resolved, ${notResolved} not yet resolved on-chain, ${errors} errors`);
  }

  // Summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log('FINAL STATE');
  console.log('═'.repeat(60));

  const summary = await pg.query(`
    SELECT symbol,
           COUNT(*) as total,
           COUNT(onchain_resolved_direction) as has_onchain,
           COUNT(condition_id) as has_condition
    FROM window_close_events
    GROUP BY symbol
    ORDER BY symbol
  `);

  for (const r of summary.rows) {
    console.log(`${r.symbol.toUpperCase()}: ${r.has_onchain}/${r.total} on-chain resolutions (${r.has_condition} conditionIds)`);
  }

  await pg.end();
  console.log(`\nTotal time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(err => { console.error(err); process.exit(1); });
