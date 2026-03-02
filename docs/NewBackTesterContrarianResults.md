# Backtester Rebuild — Contrarian Strategy Results

**Date**: 2026-03-02
**Ground Truth**: Gamma API outcomePrices (6,472 windows backfilled)
**Engine**: Parallel backtester (parallel-engine.js)

## Resolution Source Audit

| Source | Coverage | Accuracy vs Gamma | Notes |
|--------|----------|-------------------|-------|
| RTDS (resolved_direction) | 89.0% (5,758/6,468) | 98.09% | BTC worst at 96.7% (47 errors) |
| Onchain (onchain_resolved_direction) | 40.0% (2,588/6,468) | 99.38% | All 16 errors are "down when Gamma says up" |
| Gamma (gamma_resolved_direction) | 100% | Definitive | Actual Polymarket settlement |

## Strategy Results — BTC (1,628 windows)

| Strategy | Trades | Win Rate | PnL$ | Sharpe | EV/Trade | AvgEntry |
|----------|--------|----------|------|--------|----------|----------|
| edge-c-asymmetry | 40,079 | 94.7% | $18,219 | 1.95 | $0.4546 | 0.4927 |
| contested-contrarian | 1,585 | 91.6% | $667 | 14.76 | $0.4207 | 0.4954 |
| cl-direction-follower | 1,075 | 91.7% | $455 | 11.14 | $0.4235 | 0.4937 |
| exchange-consensus | 1,620 | 87.2% | $609 | 12.83 | $0.3758 | 0.4959 |
| clob-value-buyer | 1,126 | 86.2% | $414 | 9.41 | $0.3677 | 0.4946 |
| exchange-oracle-divergence | 4 | 25% | $-1 | -0.39 | $-0.2550 | 0.5050 |
| late-momentum-reversal | 9 | 33.3% | $-1 | -0.30 | $-0.1272 | 0.4606 |
| clob-reversal | 1 | 100% | $0.5 | 0.39 | $0.4750 | 0.5250 |

## Strategy Results — ETH (1,630 windows)

| Strategy | Trades | Win Rate | PnL$ | Sharpe | EV/Trade |
|----------|--------|----------|------|--------|----------|
| contested-contrarian | 81 | 100% | $42.50 | 3.61 | $0.5249 |
| exchange-consensus | 42 | 100% | $22.08 | 2.57 | $0.5257 |
| exchange-oracle-divergence | 7 | 100% | $3.68 | 1.04 | $0.5258 |
| cl-direction-follower | 1,157 | 50.6% | $-7.93 | -0.14 | — |
| clob-value-buyer | 1,153 | 50.7% | $-5.21 | -0.08 | — |

SOL and XRP: No strategy profitable. All near 50% WR or 0 trades.

## Top Strategies Ranked by Risk-Adjusted Return

| Rank | Strategy | Sharpe | Win Rate | Symbols | Trades | EV/Trade |
|------|----------|--------|----------|---------|--------|----------|
| 1 | contested-contrarian | 14.76 | 91.6% | BTC + ETH | 1,666 | $0.42 |
| 2 | exchange-consensus | 12.83 | 87.2% | BTC + ETH | 1,662 | $0.38 |
| 3 | cl-direction-follower | 11.14 | 91.7% | BTC only | 1,075 | $0.42 |
| 4 | clob-value-buyer | 9.41 | 86.2% | BTC only | 1,126 | $0.37 |
| 5 | edge-c-asymmetry | 1.95 | 94.7% | BTC only | 40,079 | $0.45 |

## L2 Data Impact (Feb 22+ windows)

| Variant | Trades | Win Rate | PnL$ | EV/Trade |
|---------|--------|----------|------|----------|
| BTC L1-only (baseline) | 659 | 93.9% | $294.07 | $0.4462 |
| BTC L2: imbalance >= 0.2 | 620 | 95.0% | $285.99 | $0.4613 |
| BTC L2: imbalance >= 0.5 | 570 | 95.6% | $266.63 | $0.4678 |

**L2 Conclusion**: Marginal improvement (+1.7pp WR) but reduces trade volume 14%. Better as tiebreaker than primary signal.

## Key Insights

1. **contested-contrarian is the winner** — highest Sharpe, profitable on BTC + ETH
2. **The edge is contrarian**: betting AGAINST CLOB's 50/50 price when exchanges already signal direction. MMs reprice with ~5s lag.
3. **BTC dominates** — structural CL deficit makes it the primary alpha source
4. **ETH is secondary** — contested-contrarian 100% WR on 81 trades
5. **SOL/XRP show zero edge** — sparser exchange coverage, less liquid CLOB
6. **L2 data is marginal** — use as tiebreaker, not primary signal

## Not Yet Accounted For

- **Stop-loss**: Current results are hold-to-resolution. Adding stop-loss (e.g., exit at $0.15) would reduce loss severity on the 8.4% of losers.
- **Take-profit**: Early exit at e.g. $0.85 would lock in profits but cap upside.
- **Position sizing**: Results assume $1 per trade. With $2 position sizing, returns scale with entry price (e.g., $2 at $0.10 entry = $20 payout on win = 10x return).
- **CLOB liquidity**: Backtest assumes instant fill at CLOB price. Real execution depends on book depth.

## Why Contrarian Works

Polymarket CLOB prices reflect MM risk assessment, not oracle reality. When exchanges signal a clear direction but CLOB is still contested (near 50/50), the MMs haven't fully repriced yet. The exchange signal arrives ~5s before the oracle settles, giving a window where "true" probability is much higher than CLOB price reflects.
