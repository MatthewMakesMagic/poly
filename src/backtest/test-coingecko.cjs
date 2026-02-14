/**
 * Test CoinGecko API and compare prices against our VWAP + Chainlink.
 *
 * Fetches current CG prices for BTC, ETH, SOL, XRP and compares with
 * the latest vwap_snapshots data to see the spreads.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local') });
const https = require('https');
const { Client } = require('pg');

const CG_API_KEY = process.env.COINGECKO_API_KEY;
const CG_BASE = 'pro-api.coingecko.com';

// CoinGecko IDs for our instruments
const CG_IDS = {
  btc: 'bitcoin',
  eth: 'ethereum',
  sol: 'solana',
  xrp: 'ripple',
};

function cgFetch(path) {
  return new Promise((resolve, reject) => {
    const url = `https://${CG_BASE}${path}`;
    const opts = {
      headers: {
        'x-cg-pro-api-key': CG_API_KEY,
        'Accept': 'application/json',
      },
    };
    https.get(url, opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`CG API ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }
          resolve(JSON.parse(data));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('Testing CoinGecko API...\n');

  // 1. Test simple/price endpoint
  const ids = Object.values(CG_IDS).join(',');
  const priceData = await cgFetch(`/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_last_updated_at=true&precision=full`);
  console.log('CoinGecko /simple/price response:');

  const cgPrices = {};
  for (const [sym, cgId] of Object.entries(CG_IDS)) {
    const p = priceData[cgId];
    if (p) {
      cgPrices[sym] = p.usd;
      const updatedAt = new Date(p.last_updated_at * 1000).toISOString();
      console.log(`  ${sym.toUpperCase()}: $${p.usd} (updated: ${updatedAt})`);
    }
  }

  // 2. Compare with our latest VWAP snapshots
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('COMPARISON: CoinGecko vs Our VWAP vs Chainlink');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const pg = new Client(process.env.DATABASE_URL);
  await pg.connect();

  const latestVwap = await pg.query(`
    SELECT DISTINCT ON (symbol)
      symbol, timestamp, composite_vwap, chainlink_price, vwap_cl_spread, exchange_count
    FROM vwap_snapshots
    ORDER BY symbol, timestamp DESC
  `);

  console.log('Symbol │ CoinGecko      │ Our VWAP       │ Chainlink      │ CG-VWAP Δ   │ CG-CL Δ     │ VWAP-CL Δ');
  console.log('───────┼────────────────┼────────────────┼────────────────┼─────────────┼─────────────┼──────────────');

  for (const row of latestVwap.rows) {
    const sym = row.symbol;
    const vwap = parseFloat(row.composite_vwap);
    const cl = row.chainlink_price ? parseFloat(row.chainlink_price) : null;
    const cg = cgPrices[sym];

    if (!cg) continue;

    const cgVwapDelta = cg - vwap;
    const cgClDelta = cl ? cg - cl : null;
    const vwapClDelta = cl ? vwap - cl : null;

    const fmtPrice = (p, sym) => {
      if (p == null) return 'N/A'.padStart(14);
      if (sym === 'xrp') return ('$' + p.toFixed(6)).padStart(14);
      if (sym === 'sol') return ('$' + p.toFixed(4)).padStart(14);
      return ('$' + p.toFixed(2)).padStart(14);
    };
    const fmtDelta = (d, sym) => {
      if (d == null) return 'N/A'.padStart(11);
      const sign = d >= 0 ? '+' : '';
      if (sym === 'xrp') return (sign + '$' + d.toFixed(6)).padStart(11);
      if (sym === 'sol') return (sign + '$' + d.toFixed(4)).padStart(11);
      return (sign + '$' + d.toFixed(2)).padStart(11);
    };

    console.log(
      `${sym.toUpperCase().padEnd(6)} │ ${fmtPrice(cg, sym)} │ ${fmtPrice(vwap, sym)} │ ${fmtPrice(cl, sym)} │ ${fmtDelta(cgVwapDelta, sym)} │ ${fmtDelta(cgClDelta, sym)} │ ${fmtDelta(vwapClDelta, sym)}`
    );
  }

  // 3. Test per-exchange ticker data for one instrument (SOL) to see CG's exchange coverage
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('CoinGecko Exchange Coverage — SOL tickers (top 20 by volume)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  try {
    const tickers = await cgFetch('/api/v3/coins/solana/tickers?include_exchange_logo=false&depth=false&order=volume_desc');
    if (tickers && tickers.tickers) {
      console.log(`Total tickers: ${tickers.tickers.length}`);
      console.log('\nExchange             │ Pair         │ Price (USD)    │ Volume (USD 24h)    │ Spread');
      console.log('─────────────────────┼──────────────┼────────────────┼─────────────────────┼───────');
      for (const t of tickers.tickers.slice(0, 20)) {
        const price = t.converted_last?.usd || 0;
        const vol = t.converted_volume?.usd || 0;
        const spread = t.bid_ask_spread_percentage != null ? t.bid_ask_spread_percentage.toFixed(3) + '%' : 'N/A';
        console.log(
          `${(t.market?.name || '?').padEnd(20)} │ ${(t.base + '/' + t.target).padEnd(12)} │ $${price.toFixed(4).padStart(13)} │ $${vol.toFixed(0).padStart(18)} │ ${spread}`
        );
      }

      // Count unique exchanges
      const uniqueExchanges = new Set(tickers.tickers.map(t => t.market?.name));
      console.log(`\nUnique exchanges in response: ${uniqueExchanges.size}`);
    }
  } catch (e) {
    console.log('Ticker fetch failed:', e.message);
  }

  // 4. Check API plan/limits
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('API Status');
  console.log('═══════════════════════════════════════════════════════════════\n');

  try {
    const ping = await cgFetch('/api/v3/ping');
    console.log('Ping:', JSON.stringify(ping));
  } catch (e) {
    console.log('Ping failed:', e.message);
  }

  await pg.end();
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
