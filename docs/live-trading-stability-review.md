# Live Trading Stability Review — 2026-02-28

System shut down after catastrophic position sizing. Full post-mortem for review.

## Incident Timeline (Feb 28, ET)

### 1. VWAP Contrarian + BS Fat-Tail deployed (~9:15 AM)
- Dual strategy system went live: VWAP contrarian (all window) + BS fat-tail (final 90s, 10% edge)
- DB migration 039 allowed multi-strategy positions per window

### 2. SOL DOWN entry — correct signal, bad outcome (~9:30 AM)
- VWAP fired on SOL 9:30-9:45 window: 45 DOWN shares at 9.5¢ ($4.26)
- Market moved hard UP (97%), position lost 84% (-$3.58)
- **This was the strategy working as designed** — it just lost

### 3. Future window bug — entered positions on unopened markets (~9:44 AM)
- System entered XRP/BTC/SOL/ETH UP positions on the **9:45-10:00 AM window before it opened**
- CLOB at ~50¢ default pricing, VWAP at real exchange price → false disagreement signal
- XRP: 23.9 UP shares at 48.3¢ ($11.57) — 6x intended position size
- BTC: 3.9 UP shares at 49¢ ($1.93)
- SOL: 3.9 UP shares at 50¢ ($1.97)
- ETH: 3.9 UP shares at 48¢ ($1.89)

### 4. Massive ETH position — system drained account (~9:48 AM)
- 183 ETH UP shares at 26.8¢ ($49.03) on 9:45-10:00 window
- Cash dropped from ~$122 to $0.49
- Portfolio value collapsed to ~$74
- **System shut down via `railway down`**

## Root Causes

### Bug 1: No upper time bound on VWAP strategy
- VWAP iterated ALL windows including future ones (not yet opened)
- Only had `timeRemainingMs < 5000` lower bound, no upper bound
- Future 15-min window has `time_remaining_ms` ~900+ seconds, passes the check
- **Fixed in commit ee64cac**: skip windows where `timeRemainingMs > 900000`

### Bug 2: No per-trade or per-session dollar cap
- Nothing prevents the system from spending all available cash
- 183 shares × 26.8¢ = $49 in a single position — far exceeds the $2 base size
- Position sizing may be multiplying or the safeguard isn't capping properly
- **NOT YET FIXED**

### Bug 3: XRP got 6x position size (23.9 shares vs ~4 for others)
- Expected ~$2 position, got $11.57
- May be multiple rapid entries before duplicate_window_entry safeguard caught it
- Or position sizing calculation used wrong price
- **NOT YET INVESTIGATED**

### Bug 4: VWAP open cache set on future windows
- Cache snapshots "VWAP at open" on first encounter of a window
- For future windows, this is BEFORE the window opens — meaningless reference price
- The future-window skip fix prevents this, but cache logic is still fragile
- **MITIGATED by Bug 1 fix, not independently fixed**

### Bug 5: order_id null constraint violation (pre-existing)
- Orders succeed on exchange but DB write fails: `null value in column 'order_id'`
- Means position tracking is broken — we think we have no position, so we enter again
- Could explain the 183-share ETH position (repeated entries not blocked)
- **NOT YET FIXED — likely the biggest contributor to the $49 position**

### Bug 6: IOC max price uses wrong field for VWAP signals
- `maxPrice = signal.confidence || signal.market_price || signal.expected_price`
- For VWAP: `confidence` = `absVwapDeltaPct` (~0.08-0.13), a tiny truthy number
- This means IOC orders go in with maxPrice of 8-13¢ regardless of actual token price
- For DOWN tokens at ~9¢ this accidentally works
- For UP tokens at ~50¢ it should fail (can't buy at 8¢)... unless it falls through
- **NOT YET INVESTIGATED — may explain weird fill prices**

## Required Fixes Before Restarting

### P0 — Must fix
1. **Hard cash floor**: Refuse all entries if available balance < $10 (or configurable)
2. **Per-position dollar cap**: No single position > $5 regardless of sizing calculation
3. **Fix order_id null**: Investigate why exchange returns no order_id, fix DB write
4. **Fix IOC maxPrice for VWAP**: Use actual token mid price, not `signal.confidence`

### P1 — Should fix
5. **Per-window entry count limit**: Max 1 entry attempt per window per strategy per tick
6. **Rate limit orders**: No more than N orders per minute across all strategies
7. **VWAP open cache**: Only cache after confirming window has actually started
8. **Position size validation**: Log warning if calculated size > 2x base size

### P2 — Nice to have
9. **Kill switch endpoint**: API endpoint to halt all trading without redeploying
10. **Balance monitoring**: Alert (log) when balance drops below threshold
11. **Shutdown cleanup**: Fix tick-logger buffer flush after pool close (noisy but harmless)

## Commits This Session
- `595243e` — Make position verifier airtight: scope to current active window only
- `c13a2de` — Fix expired position close: coerce DB string price to Number
- `de3bf6e` — Dual strategy: VWAP contrarian + BS fat-tail (final 90s)
- `eb952e0` — Fix VWAP signal direction: use 'long' not 'up'/'down'
- `ee64cac` — HOTFIX: Prevent VWAP strategy from trading on future windows

## Verification Plan Before Restarting

Zero trust in safeguard assurances. System must prove itself before touching money.

1. **Dry-run mode**: Deploy with a flag that does everything — signals, sizing, safeguard checks — but logs the order instead of submitting it. Watch logs for a few windows and confirm: only 1 entry per window per strategy, ~$2 each, no future windows.
2. **Hard assertions that crash the process**: Add `throw` statements — if position size > $5, crash. If time_remaining > 900s, crash. If cash < $10, crash. Visible immediately in Railway.
3. **Replay against Feb 28 data**: Run execution loop code against today's windows offline, verify outputs match expectations. No real money.
4. **Manual code review of safeguard paths**: Read the actual 3-4 functions that enforce limits and verify the logic end-to-end.

None of these involve trusting assurances. The system proves itself or stays off.

## Current State
- **Live trading: OFF** (railway down)
- **Portfolio: ~$74** ($0.49 cash, rest in losing positions)
- **Open positions**: ETH UP 183 shares, XRP UP 23.9 shares, SOL DOWN 45 shares, plus smaller BTC/SOL/ETH UP positions
- **These positions will resolve** — some may recover, most likely losses
