# Story E.3: Scout Paper Mode Signal Clarity

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader monitoring via Scout**,
I want **clear visual distinction between paper signals and live trades**,
So that **I immediately know if I'm watching simulation or real money**.

## Acceptance Criteria

### AC1: PAPER Mode Log Parsing

**Given** Scout is running in Railway mode
**When** a log entry contains `trading_mode: "PAPER"` or event type `paper_mode_signal`
**Then** Scout identifies this as a paper mode signal (not a real trade)

### AC2: LIVE Mode Log Parsing

**Given** Scout is running in Railway mode
**When** a log entry contains `trading_mode: "LIVE"` and event type `order_placed`
**Then** Scout identifies this as a live trade execution

### AC3: Mode Badge in Status Bar

**Given** Scout has received at least one event with trading_mode
**When** the status bar is rendered
**Then** it displays a prominent mode badge: `[PAPER]` or `[LIVE]`
**And** PAPER badge is yellow, LIVE badge is red with warning indicator

### AC4: Separate Signal vs Order Counters

**Given** Scout is tracking events
**When** the summary/stats are displayed
**Then** it shows separate counts: "Paper signals: N" and "Live orders: N"
**And** these counters are visible in both the status bar and shutdown summary

### AC5: Mode Field in Translations

**Given** an event contains `trading_mode` field
**When** Scout translates the event
**Then** the translation includes mode context (e.g., "[PAPER] Signal fired" vs "[LIVE] Order placed")

### AC6: Mode Detection from Multiple Sources

**Given** Railway logs may use different field names
**When** Scout parses logs
**Then** it detects mode from:
  - `trading_mode` field (primary)
  - `paper_mode_signal` event type (paper indicator)
  - `order_placed` / `entry_executed` events without paper marker (live indicator)

## Tasks / Subtasks

- [x] **Task 1: Extend Railway Log Parser for Trading Mode** (AC: 1, 2, 6)
  - [x] 1.1 Add `trading_mode` field extraction in `extractEventData()`
  - [x] 1.2 Detect paper mode from `paper_mode_signal` event type
  - [x] 1.3 Detect live mode from `order_placed` with `trading_mode: "LIVE"`
  - [x] 1.4 Add tests for paper/live mode detection (6 tests)

- [x] **Task 2: Track Paper vs Live Counts in Scout State** (AC: 4)
  - [x] 2.1 Add `paperSignalCount` and `liveOrderCount` to state.js
  - [x] 2.2 Add `incrementPaperSignal()` and `incrementLiveOrder()` functions
  - [x] 2.3 Update `handleEvent()` in index.js to categorize and count
  - [x] 2.4 Expose counts in `getStateSnapshot()`
  - [x] 2.5 Add tests for counter management (13 tests in state.test.js)

- [x] **Task 3: Add Mode Badge to Status Bar** (AC: 3)
  - [x] 3.1 Add `tradingMode` state variable (null until detected, then 'PAPER'/'LIVE')
  - [x] 3.2 Update `renderStatusBar()` to show mode badge
  - [x] 3.3 Use Colors.YELLOW for PAPER, Colors.RED for LIVE
  - [x] 3.4 Show "Mode unknown" until first event with mode received
  - [x] 3.5 Add tests for status bar mode rendering (3 tests)

- [x] **Task 4: Update Translator for Mode Context** (AC: 5)
  - [x] 4.1 Update `translateSignal()` to prefix with mode when available
  - [x] 4.2 Update `translateEntry()` to show `[PAPER]` or `[LIVE]` prefix
  - [x] 4.3 Add helper `formatModePrefix(mode)` function
  - [x] 4.4 Add tests for mode-prefixed translations (7 tests)

- [x] **Task 5: Update Shutdown Summary** (AC: 4)
  - [x] 5.1 Add paper/live counts to `renderShutdown()` stats display
  - [x] 5.2 Format as "Paper signals: N | Live orders: N"
  - [x] 5.3 Add test for shutdown summary with mode counts (2 tests)

- [x] **Task 6: Integration Test** (AC: all)
  - [x] 6.1 Test full flow: paper_mode_signal → state update → badge display
  - [x] 6.2 Test full flow: live order → state update → badge display
  - [x] 6.3 Test mode detection from Railway logs with real log samples

## Dev Notes

### Existing Infrastructure (From Story 8-8)

Story 8-8 already added `trading_mode` field to key log events:

**Log events with `trading_mode` field:**
- `paper_mode_signal` - Logged in execution-loop.js:369-381 with `trading_mode: 'PAPER'`
- `order_placed` - Logged in execution-loop.js with `trading_mode: 'LIVE'`
- `entry_signals_generated` - Logged with `trading_mode` field
- `tick_complete` - Summary log with `trading_mode` field

**Example log entries Scout will parse:**
```json
// PAPER mode signal
{
  "level": "info",
  "event": "paper_mode_signal",
  "window_id": "btc-15m-1769949000",
  "direction": "UP",
  "confidence": 0.85,
  "size": 2,
  "would_have_traded": true,
  "trading_mode": "PAPER",
  "message": "Order blocked - PAPER mode active"
}

// LIVE mode order
{
  "level": "info",
  "event": "order_placed",
  "window_id": "btc-15m-1769949000",
  "direction": "UP",
  "size": 2,
  "price": 0.421,
  "trading_mode": "LIVE"
}
```

### Scout Module Structure Reference

```
src/modules/scout/
├── index.js           # handleEvent() - categorize paper vs live
├── types.js           # Add TRADING_MODE enum if needed
├── state.js           # Add paperSignalCount, liveOrderCount
├── translator.js      # Add mode prefix to translations
├── renderer.js        # Add mode badge to status bar
├── railway-log-parser.js  # Extract trading_mode from logs
└── __tests__/
    ├── railway-log-parser.test.js  # Add mode detection tests
    ├── translator.test.js          # Add mode prefix tests
    └── index.test.js               # Add mode counting tests
```

### Visual Design

**Status Bar with PAPER mode:**
```
┌─────────────────────────────────────────────────────────────────────┐
│ SCOUT [PAPER]                                        ▲ 2 need review│
│ Paper signals: 12 | Live orders: 0 · Last check: 5s ago            │
├─────────────────────────────────────────────────────────────────────┤
```

**Status Bar with LIVE mode:**
```
┌─────────────────────────────────────────────────────────────────────┐
│ SCOUT [🔴 LIVE]                                      ▲ 0 need review│
│ Paper signals: 0 | Live orders: 3 · Last check: 2s ago              │
├─────────────────────────────────────────────────────────────────────┤
```

**Event translations with mode prefix:**
```
14:32:01  ✓ [PAPER] Signal fired (entry)
          Scout: "Entry conditions met. Would have traded at 0.421."

14:32:01  ✓ [LIVE] Filled @ 0.421 (expected 0.420, slippage: 0.2%)
          Scout: "Position open. Real money on the line."
```

### Project Structure Notes

- Follow existing Scout module patterns from Story E-1
- Use existing Colors and Icons from types.js
- No new files needed - extend existing files
- Tests go in existing `__tests__/` folders

### Testing Standards

From architecture.md:
- Tests co-located in `__tests__` folder within each module
- Use Jest for testing
- Estimated 19 new tests total

### References

- [Source: _bmad-output/implementation-artifacts/E-1-scout-core-module.md] - Scout base implementation
- [Source: _bmad-output/implementation-artifacts/8-8-live-trading-gate.md] - Trading mode infrastructure
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-02-01-safeguards.md#Story-E-3] - Story definition
- [Source: src/modules/scout/index.js] - Scout module entry point
- [Source: src/modules/scout/renderer.js] - Terminal rendering
- [Source: src/modules/scout/translator.js] - Event translation
- [Source: src/modules/scout/railway-log-parser.js] - Railway log parsing
- [Source: src/modules/scout/state.js] - State management
- [Source: src/modules/orchestrator/execution-loop.js:355-381] - Paper mode signal logging

### Previous Story Intelligence

**From E-1 (Scout Core Module):**
- Scout uses handleEvent({ type, data }) pattern
- state.js manages incrementEventCount() and tracks stats
- renderer.js has renderStatusBar() and renderShutdown()
- translator.js has translate(type, data) returning { summary, explanation, icon, level }
- All 88 tests passing before this story

**From E-2 (Scout Railway Mode):**
- railway-log-parser.js extractEventData() extracts fields from log JSON
- LOG_PATTERNS maps event types to TradeEventType constants
- Parser already extracts: windowId, positionId, strategyId, symbol

### Git Intelligence

Recent relevant commits:
- `81b9f60` Fix: Fetch opening price from Binance for Up/Down markets
- `2717bab` Implement Scout Railway mode for log parsing (Story E.2)
- `f7b8631` Add Railway environment auto-detection and preflight verification
- `26604cd` Fix: Post-incident review - edge calculation pipeline and safeguards

### Critical Implementation Notes

1. **Mode Detection Priority:**
   - Check `trading_mode` field first (explicit)
   - Fall back to event type detection (implicit)
   - `paper_mode_signal` → always PAPER
   - `order_placed`/`entry_executed` without paper flag → assume LIVE

2. **State Tracking:**
   - Track mode per-event, not globally (system might log both)
   - Display the most recent mode in status bar
   - Count paper and live separately

3. **Color Coding:**
   - PAPER: `Colors.YELLOW` - attention but not alarm
   - LIVE: `Colors.RED` - real money warning

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- All Scout module tests passing: 125 tests
- Full regression suite passing: 3049 tests
- No regressions introduced

### Completion Notes List

- Implemented trading mode detection in Railway log parser with priority: explicit field > event type > implicit live mode
- Added PAPER_MODE_EVENTS and LIVE_MODE_EVENTS sets for event type detection
- Created detectTradingMode() method with fallback logic per AC6
- Added paperSignalCount and liveOrderCount to stats with increment functions
- Added tradingMode state tracking with setTradingMode/getTradingMode
- Created formatModeBadge() for status bar mode display (yellow PAPER, red LIVE with 🔴)
- Updated renderStatusBar() to show mode badge and paper/live counts
- Created formatModePrefix() helper for translation prefixes
- Updated translateSignal() and translateEntry() to include mode prefix
- Updated renderShutdown() to display paper/live counts

### File List

**Modified:**
- src/modules/scout/railway-log-parser.js - Added trading mode detection, PAPER/LIVE_MODE_EVENTS sets, detectTradingMode()
- src/modules/scout/state.js - Added paperSignalCount, liveOrderCount, tradingMode tracking
- src/modules/scout/renderer.js - Added formatModeBadge(), updated renderStatusBar() and renderShutdown()
- src/modules/scout/translator.js - Added formatModePrefix(), updated translateSignal() and translateEntry()
- src/modules/scout/index.js - Updated handleEvent() to track trading mode and counts

**Added:**
- src/modules/scout/__tests__/state.test.js - 13 new tests for paper/live count and mode tracking

**Test Files Updated:**
- src/modules/scout/__tests__/railway-log-parser.test.js - 6 new tests for mode detection
- src/modules/scout/__tests__/renderer.test.js - 5 new tests for mode badge and shutdown counts
- src/modules/scout/__tests__/translator.test.js - 7 new tests for mode prefix
- src/modules/scout/__tests__/index.test.js - 3 new tests for integration

## Change Log

| Date | Change |
|------|--------|
| 2026-02-01 | Story E.3 implementation complete - Added paper/live mode detection, visual badges, counters, and translations. 34 new tests added. |
