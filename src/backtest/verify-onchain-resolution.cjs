/**
 * Cross-check our CL@close >= CL@open resolution against on-chain CTF state.
 *
 * For each BTC window:
 * 1. Get CL@open and CL@close from vwap_snapshots (like the backtest scripts)
 * 2. Get conditionId from Gamma API
 * 3. Read payoutNumerators from CTF contract on Polygon
 * 4. Compare our computed resolution vs on-chain truth
 *
 * Uses Polygon Multicall3 to batch all RPC calls into one request.
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

// Batch RPC calls via Multicall3
async function multicall(calls) {
  // aggregate3: (Call3[] calldata calls) returns (Result[] memory returnData)
  // Call3: { target, allowFailure, callData }
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

  // 1. Load all BTC windows and vwap_snapshots in parallel
  const [windowsRes, vwapRes] = await Promise.all([
    pg.query(`
      SELECT window_id, window_close_time, oracle_price_at_close
      FROM window_close_events
      WHERE symbol = 'btc' AND oracle_price_at_close IS NOT NULL
      ORDER BY window_close_time
    `),
    pg.query(`
      SELECT timestamp, chainlink_price
      FROM vwap_snapshots
      WHERE symbol = 'btc'
        AND chainlink_price IS NOT NULL
      ORDER BY timestamp
    `)
  ]);
  await pg.end();

  const windows = windowsRes.rows;
  const snaps = vwapRes.rows;
  console.log(`Loaded ${windows.length} windows + ${snaps.length} VWAP snapshots in ${Date.now() - t0}ms`);

  // 2. Index VWAP snapshots by epoch second for binary search
  const snapIdx = snaps.map(s => ({
    epoch: Math.round(s.timestamp.getTime() / 1000),
    cl: parseFloat(s.chainlink_price),
  }));

  function findCL(epochSec) {
    // Binary search for closest snapshot within ±5s
    let lo = 0, hi = snapIdx.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (snapIdx[mid].epoch < epochSec - 5) lo = mid + 1;
      else if (snapIdx[mid].epoch > epochSec + 5) hi = mid - 1;
      else {
        // Found in range, find closest
        let best = mid, bestDist = Math.abs(snapIdx[mid].epoch - epochSec);
        for (let i = mid - 1; i >= lo && Math.abs(snapIdx[i].epoch - epochSec) <= 5; i--) {
          const d = Math.abs(snapIdx[i].epoch - epochSec);
          if (d < bestDist) { best = i; bestDist = d; }
        }
        for (let i = mid + 1; i <= hi && Math.abs(snapIdx[i].epoch - epochSec) <= 5; i++) {
          const d = Math.abs(snapIdx[i].epoch - epochSec);
          if (d < bestDist) { best = i; bestDist = d; }
        }
        return snapIdx[best].cl;
      }
    }
    return null;
  }

  // 3. Get conditionIds from Gamma API (with rate limiting)
  console.log('\nFetching conditionIds from Gamma API...');
  const windowData = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const epoch = parseInt(w.window_id.split('-').pop());
    const slug = 'btc-updown-15m-' + epoch;
    const clClose = parseFloat(w.oracle_price_at_close);
    const clOpen = findCL(epoch);

    try {
      const markets = await gammaFetch(slug);
      if (markets && markets.length > 0 && markets[0].conditionId) {
        windowData.push({
          windowId: w.window_id,
          epoch,
          clOpen,
          clClose,
          conditionId: markets[0].conditionId,
          ourRes: clOpen != null ? (clClose >= clOpen ? 'up' : 'down') : null,
        });
      }
    } catch (e) {
      // skip
    }

    if ((i + 1) % 10 === 0) {
      process.stdout.write(`  ${i + 1}/${windows.length}\r`);
      await sleep(200); // Rate limit Gamma API
    }
  }
  console.log(`\nGot ${windowData.length} conditionIds from Gamma API`);

  // 4. Batch on-chain resolution queries via Multicall3
  // For each conditionId: 3 calls (payoutDenominator, payoutNumerators[0], payoutNumerators[1])
  console.log('Querying on-chain CTF state via Multicall3...');

  const BATCH_SIZE = 30; // 30 windows = 90 calls per multicall
  let checked = 0, matched = 0, mismatched = 0, notResolved = 0;
  const mismatches = [];

  for (let batch = 0; batch < windowData.length; batch += BATCH_SIZE) {
    const chunk = windowData.slice(batch, batch + BATCH_SIZE);
    const calls = [];

    for (const w of chunk) {
      // payoutDenominator
      calls.push({
        target: CTF,
        data: denomSelector + abiCoder.encode(['bytes32'], [w.conditionId]).slice(2),
      });
      // payoutNumerators[0]
      calls.push({
        target: CTF,
        data: numSelector + abiCoder.encode(['bytes32', 'uint256'], [w.conditionId, 0]).slice(2),
      });
      // payoutNumerators[1]
      calls.push({
        target: CTF,
        data: numSelector + abiCoder.encode(['bytes32', 'uint256'], [w.conditionId, 1]).slice(2),
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
        const onChain = p0 > p1 ? 'up' : 'down';

        if (w.ourRes == null) {
          // Can't compare, no CL@open
          continue;
        }

        checked++;
        if (w.ourRes === onChain) {
          matched++;
        } else {
          mismatched++;
          mismatches.push({
            ...w,
            onChain,
            p0: p0.toString(),
            p1: p1.toString(),
          });
        }
      }
    } catch (e) {
      console.log('Multicall error:', e.message.substring(0, 100));
      await sleep(5000);
    }

    await sleep(500); // Rate limit between batches
  }

  // 5. Print results
  console.log('');
  console.log('═'.repeat(60));
  console.log('ON-CHAIN CROSS-CHECK RESULTS');
  console.log('═'.repeat(60));
  console.log(`Total windows with CL@close: ${windows.length}`);
  console.log(`Gamma conditionIds found:     ${windowData.length}`);
  console.log(`Windows with CL@open (from vwap_snapshots): ${windowData.filter(w => w.ourRes != null).length}`);
  console.log(`Resolved on-chain:            ${checked + notResolved} (${notResolved} not resolved)`);
  console.log('');
  console.log(`MATCHED:    ${matched} / ${checked} (${checked > 0 ? (matched / checked * 100).toFixed(1) : 0}%)`);
  console.log(`MISMATCHED: ${mismatched}`);
  console.log('');

  if (mismatches.length > 0) {
    console.log('MISMATCHED WINDOWS:');
    for (const m of mismatches) {
      console.log(`  ${m.windowId} | ours: ${m.ourRes.toUpperCase()} | on-chain: ${m.onChain.toUpperCase()} | CL open: $${m.clOpen?.toFixed(2)} | CL close: $${m.clClose.toFixed(2)} | payouts: [${m.p0}, ${m.p1}]`);
    }
  } else if (checked > 0) {
    console.log(`ALL ${checked} WINDOWS MATCH ON-CHAIN RESOLUTION`);
  }

  console.log(`\nTotal time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(err => { console.error(err); process.exit(1); });
