# Things To Backtest

## 1. Calibrate Black-Scholes Sigma

**Current**: fallback sigma = 0.5 (50% annualized vol)

**Problem**: Model is systematically biased in the mid-range. When model says p_up=0.35, actual resolution rate is 51.5%. When it says 0.55, reality is 75.7%. The model underestimates persistence of oracle direction at T-60s by 15-20 percentage points.

**Proposed**: Lower sigma to 0.30-0.35 to push probabilities further from 0.50, matching observed resolution rates.

**Risk**: Current miscalibration may actually help by generating more tail trades (model says 0.15, CLOB prices at 0.10, fires DOWN trade that wins 70%). Fixing calibration might reduce trade count without improving EV on the trades that actually matter (the cheap, fat-tailed ones).

**Backtest design**: Run the BS model with sigma = [0.25, 0.30, 0.35, 0.40, 0.45, 0.50] on all 5,502 historical windows. For each sigma, compute: trade count, win rate, total PnL, EV per trade, and critically — EV in the cheap entry bucket ($0-$0.20). Compare.

**Data**: `window_close_events` table — has oracle_price_at_close, strike_price (reference), resolved_direction, window_close_time for all windows.

## 2. Stop Loss vs Hold-to-Expiry

**Current**: All EV analysis assumes hold-to-expiry. Every loss = full -$2.00.

**Question**: Does a stop loss (e.g., exit at -50% of entry cost) improve EV, or does it cut off the recovery potential (price dips then resolves in our direction)?

**Backtest design**: Replay CLOB price history within each window for all 5,502 windows. For each trade, check if a stop loss at [-30%, -50%, -70%] would have triggered before expiry. Compare: (a) how many losses does the stop save, (b) how many eventual wins does it kill, (c) net EV impact. Pay special attention to the cheap entry bucket ($0-$0.20) where mid-window price swings are extreme.

**Data**: `clob_price_snapshots` or `price_ticks` tables for intra-window CLOB prices, joined with `window_close_events` for resolution.

## 3. VWAP/CoinGecko as Confirmation Signal

**Current**: The BS model uses a single Chainlink oracle snapshot to estimate p_up. No VWAP or exchange composite data is used in the probability model.

**Thesis**: Chainlink is itself a VWAP — aggregated from exchanges with ~2s smoothing half-life. Raw VWAP (or CoinGecko's broader composite) shows the direction Chainlink is *about to move* before it gets there. This is a 2-8 second lookahead on the settlement oracle.

**Prior evidence**: Paper trading showed VWAP-disagrees-with-CLOB at T-60s → 85.7% win rate. BS model alone → 85.4% on same windows. Similar overall, but likely wrong on *different* trades. Combining (model edge + VWAP confirms direction) should filter false signals where model sees edge but underlying price is reverting.

**Backtest design**: For each historical window at T-60s, compute: (a) BS model edge (current), (b) VWAP direction (CoinGecko or composite vs open), (c) whether they agree. Compare EV for: model-only, VWAP-only, model+VWAP-agree, model-fires-but-VWAP-disagrees. The last bucket is the key — if those trades lose disproportionately, VWAP confirmation is worth adding.

**Data**: `paper_trades_v2` has `vwap_price`, `vwap_direction`, `chainlink_price` per signal. `window_close_events` has oracle prices and resolutions. RTDS ticks in `price_ticks` have CoinGecko composite history.
