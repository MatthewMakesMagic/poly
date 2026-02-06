# FINDTHEGOLD: Oracle Price Discovery & Edge Validation Research

**Created:** 2026-02-05
**Status:** Active Research
**Authors:** Matthew + BMAD Team (Marcus, Vera, Cassandra, Theo, Nadia, Mary)
**V3 Philosophy Reference:** [docs/v3philosophy.md](./v3philosophy.md)
**Tech Spec Reference:** [tech-spec-v3-philosophy-implementation.md](../_bmad-output/implementation-artifacts/tech-spec-v3-philosophy-implementation.md)

> **Purpose:** This document captures the critical findings from our data capture audit
> and reframes the trading edge thesis based on what we actually know about Polymarket's
> oracle resolution mechanism. Every assumption must be validated with data before trading.

---

## What We Got Wrong

### The Old Model (INCORRECT)

We built infrastructure on a fundamentally flawed understanding of how Polymarket resolves 15-minute markets:

```
OLD MENTAL MODEL:
  Binance spot (fast) ──moves──► Chainlink on-chain (slow) ──resolves──► Market
                                  │
                                  └─ Updates only on >0.5% deviation or 1hr heartbeat
                                  └─ RTDS re-broadcasts same stale on-chain price
                                  └─ Edge = trade the lag between fast and slow
```

**What we built on this wrong model:**
- `staleness-detector` with `chainlinkDeviationThresholdPct: 0.5%` — based on old Data Feeds model
- `oracle-predictor` — predicts when Chainlink will next update, assuming infrequent updates
- `lag-tracker` — measures Binance → Chainlink lag, assuming Binance is the source
- Edge 1 thesis: "Binance moves first, Chainlink follows, trade the gap"

**Why it's wrong:**
1. Polymarket uses **Chainlink Data Streams** (pull-based, sub-second), NOT Chainlink Data Feeds (push-based, deviation-triggered)
2. The Binance spot price is **hundreds of dollars away** from the Polymarket chart price for BTC — Binance is NOT the source
3. **Pyth tracks closer** to the Polymarket chart price than Binance does
4. The oracle price is a **consensus median across 16 independent operators** sourcing from multiple exchanges — it's its own price, not a delayed copy of any single exchange

### Infrastructure That May Need Rethinking

| Module | Built Assumption | Reality |
|--------|-----------------|---------|
| `staleness-detector` | Oracle updates on >0.5% deviation | Data Streams generates reports continuously |
| `oracle-predictor` | Infrequent updates, bucket by time-since-last | Update frequency model may be wrong |
| `lag-tracker` | Binance leads, Chainlink follows | Both are independent; relationship unclear |
| `oracle-tracker` (0.01% threshold) | Filters "re-broadcasts" of same price | May be filtering real micro-movements |

> **NOTE:** These modules are not necessarily useless. The staleness-detector may still detect
> real divergences — but for different reasons than we designed for. Validate with data first.

---

## What We Now Know

### Resolution Mechanism

Polymarket's 15-minute BTC/ETH/SOL/XRP Up or Down markets resolve using:

1. **Chainlink Data Streams** — not traditional Data Feeds
2. **Chainlink Automation** triggers resolution at window boundaries
3. At window start: Automation pulls a Data Streams report → captures start price
4. At window end: Automation pulls another report → captures end price
5. End >= Start → **Up**. End < Start → **Down**. (Ties go to Up.)

**Resolution source:** `https://data.chain.link/streams/btc-usd`
(Stream ID: `0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8`)

### Chainlink Data Streams Architecture

```
┌─────────────────────────────────────────────────────────┐
│              16 Independent Oracle Operators              │
│  (Chainlink Labs, LinkPool, ValidationCloud, etc.)       │
│                                                          │
│  Each operator independently:                            │
│    1. Fetches prices from MULTIPLE exchanges/providers   │
│    2. Signs their observation with private key            │
│    3. Shares via P2P network                             │
│                                                          │
│  Consensus:                                              │
│    - Leader elected periodically                         │
│    - Observations aggregated (MEDIAN)                    │
│    - Single signed report generated                      │
│                                                          │
│  Report contains:                                        │
│    - feedId, price (consensus median)                    │
│    - bid, ask (market spread from operators)             │
│    - observationsTimestamp, validFromTimestamp            │
│    - expiresAt                                           │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
          ┌─────────────────────────┐
          │   Aggregation Network    │
          │   (Off-Chain Storage)    │
          │                         │
          │  Reports stored here    │
          │  Pull on demand         │
          │  Sub-second latency     │
          └────────┬────────────────┘
                   │
          ┌────────┴─────────────────────────────────┐
          │                                          │
          ▼                                          ▼
  ┌───────────────────┐                  ┌────────────────────────┐
  │  Polymarket RTDS   │                  │  Chainlink Automation   │
  │  (what we receive) │                  │  (what resolves markets)│
  │                    │                  │                        │
  │  Broadcasts        │                  │  At window start/end:  │
  │  crypto_prices_    │                  │  pulls latest report,  │
  │  chainlink topic   │                  │  verifies on-chain,    │
  │                    │                  │  determines Up/Down    │
  └───────────────────┘                  └────────────────────────┘
```

### Key Observations from Live Streaming

- **Binance spot** is consistently hundreds of dollars away from the Polymarket chart for BTC
- **Pyth** tracks much closer to the Polymarket chart price
- Both Pyth and Chainlink Data Streams are multi-source aggregations — they naturally cluster
- Single-exchange prices (Binance) are the outlier, not the reference
- The CLOB participants pricing UP/DOWN tokens may be watching the wrong feed

### What Data We Currently Capture

| Data | Captured? | Where | Gap |
|------|-----------|-------|-----|
| Binance spot (via RTDS) | Yes, continuously | `rtds_ticks` (topic: crypto_prices) | None |
| Chainlink (via RTDS) | Yes, continuously | `rtds_ticks` (topic: crypto_prices_chainlink) | Many duplicate prices — unclear if real or re-broadcast |
| Oracle price changes | Yes, filtered >0.01% | `oracle_updates` | Threshold may filter real micro-movements |
| Pyth prices | Partial — `btc-quad-stream.js` streams but doesn't persist | In-memory only | **GAP: Not persisted to database** |
| UP/DOWN token prices (CLOB) | Last 60s only | `window_close_events` | **GAP: Missing first 14 minutes of each window** |
| CLOB order book depth | Never wired up | `order_book_snapshots` (empty) | **GAP: Module exists, never activated** |
| Raw Data Streams reports | No | Not captured | **GAP: Don't have bid/ask/observationsTimestamp from raw reports** |

---

## Reframed Edge Thesis

### Old Thesis (Edge 1: Multi-Feed Latency)

> "Binance moves first, Chainlink lags, trade the gap before oracle catches up"

**Status: UNVALIDATED — underlying model was wrong**

The lag may still exist, but between different things than we thought. The question is no longer "does Binance lead Chainlink?" but rather "can we predict the Data Streams aggregation better than the market?"

### New Thesis (To Validate)

> The Data Streams resolution price is a multi-source aggregation we don't fully understand.
> If we can model which inputs drive it and how it responds to market moves, we can predict
> the resolution price better than CLOB participants who may be watching the wrong feeds.

**Sub-theses to investigate:**

1. **Aggregation Edge:** If we understand what sources the 16 operators use and how the median behaves, we can model where the resolution price will be before it's captured
2. **Proxy Feed Edge:** If Pyth closely approximates Data Streams, we can use Pyth as a low-latency proxy for the resolution price — and compare against what CLOB participants seem to be pricing off of
3. **Automation Timing Edge:** The exact moment Chainlink Automation captures the report at window close may have small timing variations — understanding this could reveal edge cases
4. **Oracle Error Edge:** There's a documented case of incorrect resolution. Understanding when/why the oracle errs could be an edge in itself

### Edge 2 (Window Close Resolution) — Status

> "Predict oracle resolution in final seconds of the window"

**Status: STILL VIABLE but requires better data.** We only capture UP/DOWN prices in the last 60s. We need continuous CLOB data throughout the window to study how probability evolves and whether it's predictive.

---

## Research Priorities

### Priority 1: Understand the Aggregation Mechanism

**Goal:** Know exactly what goes into the Data Streams price that resolves our markets.

**Research questions:**
- Which exchanges and data providers do the 16 Chainlink operators source from?
- Is the aggregation a simple median or weighted? (Research indicates simple median)
- Can we access individual operator observations, or only the final consensus?
- Does Chainlink publish the methodology or operator data sources anywhere?
- How does the Data Streams `bid`/`ask` relate to the `price` field?

**Actions:**
- [ ] Deep dive into Chainlink Data Streams documentation for operator/source disclosure
- [ ] Check if `data.chain.link/streams/btc-usd` exposes any historical reports or source breakdown
- [ ] Research Chainlink node operator requirements — what data sources are they required/expected to use?
- [ ] Investigate whether Chainlink's Data Streams API (`getLatestReport()`) is accessible to us
- [ ] Check if the raw Data Streams report (with bid/ask/observationsTimestamp) can be pulled directly

**Inference approach (if direct access unavailable):**
- Cross-correlate our Chainlink RTDS prices with known exchange prices (Binance, Coinbase, Kraken, Bybit, OKX)
- Use regression to estimate which exchanges are inputs and their approximate weights
- Compare with Pyth (which publishes its sources) as a reference aggregation

### Priority 2: Empirical Validation with Existing Data

**Goal:** Understand what our existing `rtds_ticks` and `oracle_updates` data actually shows.

**Diagnostic queries to run:**

**Query A: Chainlink price change frequency**
```sql
-- How often does the Chainlink RTDS price ACTUALLY change?
WITH chainlink_ticks AS (
  SELECT
    symbol,
    timestamp,
    price,
    LAG(price) OVER (PARTITION BY symbol ORDER BY timestamp) AS prev_price,
    LAG(timestamp) OVER (PARTITION BY symbol ORDER BY timestamp) AS prev_timestamp
  FROM rtds_ticks
  WHERE topic = 'crypto_prices_chainlink'
    AND timestamp > NOW() - INTERVAL '24 hours'
)
SELECT
  symbol,
  COUNT(*) AS total_ticks,
  COUNT(*) FILTER (WHERE price != prev_price) AS price_changes,
  COUNT(*) FILTER (WHERE price = prev_price) AS identical_ticks,
  ROUND(100.0 * COUNT(*) FILTER (WHERE price = prev_price) / COUNT(*), 2) AS pct_identical,
  AVG(EXTRACT(EPOCH FROM (timestamp - prev_timestamp))) AS avg_tick_interval_sec
FROM chainlink_ticks
WHERE prev_price IS NOT NULL
GROUP BY symbol
ORDER BY symbol;
```

**Query B: Distribution of time between real price changes**
```sql
-- When the Chainlink price DOES change, how big is the change and how long between changes?
WITH changes AS (
  SELECT
    symbol,
    timestamp,
    price,
    LAG(price) OVER (PARTITION BY symbol ORDER BY timestamp) AS prev_price,
    LAG(timestamp) OVER (PARTITION BY symbol ORDER BY timestamp) AS prev_ts
  FROM rtds_ticks
  WHERE topic = 'crypto_prices_chainlink'
    AND timestamp > NOW() - INTERVAL '7 days'
)
SELECT
  symbol,
  COUNT(*) AS num_changes,
  AVG(EXTRACT(EPOCH FROM (timestamp - prev_ts))) AS avg_sec_between_changes,
  MIN(EXTRACT(EPOCH FROM (timestamp - prev_ts))) AS min_sec,
  MAX(EXTRACT(EPOCH FROM (timestamp - prev_ts))) AS max_sec,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (timestamp - prev_ts))) AS median_sec,
  AVG(ABS((price - prev_price) / prev_price) * 100) AS avg_change_pct
FROM changes
WHERE price != prev_price AND prev_price IS NOT NULL
GROUP BY symbol;
```

**Query C: Compare Binance vs Chainlink at the same timestamps**
```sql
-- Spread between Binance and Chainlink at close timestamps
WITH binance AS (
  SELECT symbol, timestamp, price AS binance_price
  FROM rtds_ticks
  WHERE topic = 'crypto_prices'
    AND timestamp > NOW() - INTERVAL '24 hours'
),
chainlink AS (
  SELECT symbol, timestamp, price AS chainlink_price
  FROM rtds_ticks
  WHERE topic = 'crypto_prices_chainlink'
    AND timestamp > NOW() - INTERVAL '24 hours'
)
SELECT
  b.symbol,
  DATE_TRUNC('minute', b.timestamp) AS minute,
  AVG(b.binance_price) AS avg_binance,
  AVG(c.chainlink_price) AS avg_chainlink,
  AVG(b.binance_price - c.chainlink_price) AS avg_spread,
  AVG(ABS(b.binance_price - c.chainlink_price) / c.chainlink_price * 100) AS avg_spread_pct
FROM binance b
JOIN chainlink c ON b.symbol = c.symbol
  AND DATE_TRUNC('second', b.timestamp) = DATE_TRUNC('second', c.timestamp)
WHERE b.symbol = 'btc'
GROUP BY b.symbol, DATE_TRUNC('minute', b.timestamp)
ORDER BY minute DESC
LIMIT 60;
```

**Query D: Oracle update frequency distribution**
```sql
-- What does the oracle_updates table actually show us?
SELECT
  symbol,
  COUNT(*) AS total_updates,
  AVG(time_since_previous_ms) / 1000 AS avg_sec_between,
  MIN(time_since_previous_ms) / 1000 AS min_sec,
  MAX(time_since_previous_ms) / 1000 AS max_sec,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY time_since_previous_ms) / 1000 AS median_sec,
  AVG(ABS(deviation_from_previous_pct)) AS avg_deviation_pct,
  MAX(ABS(deviation_from_previous_pct)) AS max_deviation_pct
FROM oracle_updates
WHERE timestamp > NOW() - INTERVAL '7 days'
GROUP BY symbol
ORDER BY symbol;
```

### Priority 3: Validate Data Streams Access & Pyth as Proxy

**Goal:** Determine if we can access Data Streams directly, and validate Pyth as a resolution proxy.

**Actions:**
- [ ] Research Chainlink Data Streams API access requirements (may require registration/payment)
- [ ] Check if `data.chain.link/streams/btc-usd` has a public API endpoint
- [ ] Start persisting Pyth prices to database (currently only streamed in `btc-quad-stream.js`)
- [ ] Compare Pyth vs Chainlink RTDS prices to quantify correlation
- [ ] If Pyth is a close proxy: use it as a low-latency estimate of Data Streams consensus

**Pyth integration path:**
- Pyth Hermes API is already referenced in `btc-quad-stream.js`
- Uses SSE (Server-Sent Events) — different from WebSocket but continuous
- Need to wire into tick-logger to persist alongside RTDS data
- Price IDs needed: BTC/USD, ETH/USD, SOL/USD, XRP/USD

---

## Data Capture Gaps to Fill

Based on this research, the minimum viable continuous data capture requires:

### Must Have (blocks edge validation)

1. **Persist Pyth prices continuously**
   - Currently only in `btc-quad-stream.js` (in-memory, not persisted)
   - Add to tick-logger alongside RTDS data
   - Enables Pyth vs Chainlink comparison and proxy validation

2. **Continuous CLOB UP/DOWN token prices**
   - Currently only last 60s of each window (6 snapshots)
   - Need every ~5s throughout the full 15-minute window
   - The execution loop already polls every ~5s — just persist it
   - This is the dependent variable for Edge 2

3. **Wire up order book collector**
   - Module exists, never activated (`addToken()` never called)
   - Need bid/ask/depth throughout window, not just at close
   - Depth collapse on one side may signal informed trading before resolution

### Should Have (improves analysis quality)

4. **Raw Data Streams reports (if accessible)**
   - bid/ask/observationsTimestamp from Chainlink directly
   - Would let us study aggregation behavior and consensus spread

5. **Additional exchange feeds for cross-correlation**
   - Coinbase, Kraken, Bybit spot prices
   - To reverse-engineer which sources drive the Data Streams median
   - Could use CCXT library or direct WebSocket connections

### Nice to Have (future enhancement)

6. **Individual Chainlink operator observations** (if exposed)
7. **Chainlink Automation trigger timestamps** (exact resolution moment)
8. **Historical Data Streams reports** (for backtesting)

---

## Validation Criteria

Before any trading based on the new thesis:

- [ ] **2+ weeks of continuous data** across all feeds (Binance, Chainlink RTDS, Pyth, CLOB)
- [ ] **Statistical model** of Data Streams aggregation behavior (which inputs, what weights)
- [ ] **Pyth proxy validation** — quantify how closely Pyth tracks Data Streams with confidence intervals
- [ ] **Edge quantification** — if an edge exists, what's the expected magnitude? Is it > transaction costs?
- [ ] **500+ window observations** with all feeds captured for backtesting
- [ ] **Staleness-detector audit** — validate or invalidate existing signals against real data
- [ ] **p < 0.05** for any claimed edge before risking capital

---

## Known Unknowns

1. How exactly does Polymarket pull from Chainlink's Aggregation Network for RTDS? Frequency? Caching?
2. What is the exact latency between a Data Streams report being generated and appearing on RTDS?
3. Do all 16 operators source from the same exchanges? Different ones? How much does the median vary?
4. What happened in the documented oracle error case? Can we reproduce the conditions?
5. Is the Chainlink Automation trigger perfectly synchronized with window close, or is there jitter?
6. Are there other market participants who already understand this aggregation mechanism?

---

## Appendix: Key Code References

| Purpose | File |
|---------|------|
| RTDS WebSocket client | `src/clients/rtds/client.js` |
| RTDS topics & symbols | `src/clients/rtds/types.js` |
| Oracle update detection | `src/modules/oracle-tracker/tracker.js` |
| Staleness detection | `src/modules/staleness-detector/detector.js` |
| Oracle prediction | `src/modules/oracle-predictor/predictor.js` |
| Tick logging to DB | `src/modules/tick-logger/index.js` |
| Quad-stream (all feeds) | `scripts/btc-quad-stream.js` |
| Backtest data loader | `src/backtest/data-loader.js` |
| RTDS ticks migration | `src/persistence/migrations/007-rtds-ticks-table.js` |
| Oracle updates migration | `src/persistence/migrations/008-oracle-updates-table.js` |

## Appendix: Resolution Source References

- Polymarket resolution source: `https://data.chain.link/streams/btc-usd`
- Data Stream ID: `0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8`
- Product: `BTC/USD-RefPrice-DS-Premium-Global-003`
- Powered by 16 oracle operators (Chainlink Labs, LinkPool, ValidationCloud, etc.)
- Documented oracle error: BTC 6:30-7:00 AM ET windows incorrectly resolved
- Chainlink Data Streams docs: `https://docs.chain.link/data-streams`
- Chainlink Data Streams architecture: `https://docs.chain.link/data-streams/architecture`
- Polymarket RTDS docs: `https://docs.polymarket.com/developers/RTDS/RTDS-crypto-prices`
