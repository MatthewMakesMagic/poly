# Live Trading Bugs — 2026-02-28

Production bugs discovered and fixed during first live trading session.

## Bug 1: SSL Check Blocks Railway Internal DB
**Commit:** `9177f80`
**Symptom:** Crash loop — `LIVE mode requires DATABASE_URL with SSL enabled`
**Root Cause:** Railway internal networking (`postgres-xxx.railway.internal`) doesn't use SSL params in the URL. Our SSL validation rejected it.
**Fix:** Skip SSL check when hostname ends with `.railway.internal`.
**File:** `config/index.js`

## Bug 2: Missing `await` on `writeAhead.logIntent()`
**Commit:** `d1c6f89`
**Symptom:** `invalid input syntax for type integer: "{}"`
**Root Cause:** `logIntent()` is async but was called without `await` in 4 places — Promise objects passed as integer DB params.
**Fix:** Added `await` to all 4 call sites.
**Files:** `src/modules/order-manager/logic.js`, `src/modules/position-manager/logic.js`

## Bug 3: Logger Never Initialized in Production
**Commit:** `5fdb09c`
**Symptom:** All log lines showed `[logger not initialized]` and `module: undefined`
**Root Cause:** `logger.init()` was only called in test setup, never in the production entry point.
**Fix:** Added `await initLogger()` in `scripts/run_live_trading.mjs` before any child loggers.
**File:** `scripts/run_live_trading.mjs`

## Bug 4: `orderId` Property Name Mismatch
**Commit:** `9901353`
**Symptom:** `null value in column "order_id"` — orders succeeded on Polymarket but DB had null order_id.
**Root Cause:** Polymarket client returns `result.orderId` (camelCase) but code read `result.orderID` (uppercase ID).
**Fix:** Changed all references to `result.orderId`.
**File:** `src/modules/order-manager/logic.js`

## Bug 5: Duplicate Window Entries (7x BTC Trade) — CRITICAL
**Commit:** `e048a0b`
**Symptom:** Same BTC window entered 7 times at ~$2 each. Safeguard system failed to prevent re-entry.
**Root Cause:** Order succeeded on Polymarket but DB INSERT failed (null order_id from Bug 4) → threw exception → catch block released safeguard reservation → next execution tick re-entered the same window.
**Fix:**
- Separated DB write errors from API errors — DB failure no longer throws
- Added `orderSubmittedToExchange` flag to return value
- Outer catch block now CONFIRMS (never releases) safeguard if order reached exchange
- Position tracking failure also confirms entry instead of releasing
**File:** `src/modules/orchestrator/execution-loop.js`, `src/modules/order-manager/logic.js`

## Bug 6: `openPosition` is not a Function
**Commit:** `99647c7`
**Symptom:** `this.modules.position-manager.openPosition is not a function` → circuit breaker tripped → all trading halted for 1.5+ hours.
**Root Cause:** Execution loop called `position-manager.openPosition()` but the actual exported function is `addPosition()`.
**Fix:** Changed to `addPosition()`.
**File:** `src/modules/orchestrator/execution-loop.js`

## Bug 7: Stale Circuit Breaker Kills Redeploys
**Commit:** `312bc21`
**Symptom:** After redeploying with Bug 6 fix, the app immediately shut down again. CB was OPEN in DB from the old process, escalation timer showed 30+ min elapsed, first tick hit SHUTDOWN stage.
**Root Cause:** CB persists OPEN state in PostgreSQL. On startup, it reads the stale trip, calculates elapsed time from the old `tripped_at`, and escalates to shutdown before new code can run.
**Fix:** Auto-reset stale CB trips on fresh process startup with audit trail. A trip from a dead process should not block a new deployment.
**File:** `src/modules/circuit-breaker/index.js`

## Bug 8: High-Frequency Log Noise → Railway Rate Limiting
**Commit:** `d1c6f89`
**Symptom:** Railway rate-limiting logs (`Dropped N logs`), obscuring real errors.
**Root Cause:** `oracle_update_detected`, `batch_inserted`, `buffer_flushed`, `reference_price_parse_failed` all logged at INFO level, firing hundreds of times per minute.
**Fix:** Downgraded to DEBUG level.
**Files:** `src/modules/oracle-tracker/index.js`, `src/modules/tick-logger/index.js`, `src/modules/lag-tracker/index.js`, `src/modules/window-manager/index.js`

## Unresolved: Oracle Resolution Mismatch
**Doc:** `docs/potentialResolutionOracle.md`
**Symptom:** ETH showed DOWN in our DB but Polymarket settled UP. `onchain_resolved_direction` always NULL.
**Root Cause:** `oracle_price_at_close` captures last cached RTDS tick (0-3s stale). `conditionId` often missing so on-chain check never runs.
**Status:** Documented, solution proposed, not yet implemented.
