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
