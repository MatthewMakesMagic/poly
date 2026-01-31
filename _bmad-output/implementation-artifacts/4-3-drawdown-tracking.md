# Story 4.3: Drawdown Tracking

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **daily drawdown tracked continuously**,
So that **I know my current risk exposure (FR28)**.

## Acceptance Criteria

### AC1: Daily Performance Record Creation

**Given** a new trading day begins (or system starts)
**When** the system initializes
**Then** a record is created in `daily_performance` table with today's date
**And** starting_balance is captured from current capital
**And** current_balance equals starting_balance initially
**And** all P&L fields initialized to 0
**And** if record already exists for today, it is used instead of creating duplicate

### AC2: Realized P&L Tracking

**Given** trades execute throughout the day
**When** positions close with realized P&L
**Then** realized_pnl is updated (incremented/decremented)
**And** current_balance is recalculated (starting_balance + realized_pnl)
**And** drawdown_pct = (starting_balance - current_balance) / starting_balance
**And** max_drawdown_pct is updated if current drawdown is worse

### AC3: Unrealized P&L Tracking

**Given** open positions exist
**When** position prices update
**Then** unrealized_pnl is recalculated (sum of all open position unrealized P&L)
**And** total drawdown includes unrealized losses for risk assessment
**And** updated_at timestamp is refreshed

### AC4: Drawdown Query Interface

**Given** the safety module or any component needs drawdown info
**When** querying current drawdown
**Then** current drawdown_pct is returned
**And** max_drawdown_pct (worst drawdown today) is returned
**And** response includes: realized_pnl, unrealized_pnl, current_balance, starting_balance

### AC5: Trade Count Tracking

**Given** trades execute throughout the day
**When** positions are opened and closed
**Then** trades_count is incremented
**And** wins is incremented for profitable closes (pnl > 0)
**And** losses is incremented for losing closes (pnl < 0)

### AC6: Database Schema

**Given** the daily_performance table schema
**When** inspecting the database
**Then** table exists with columns: id, date, starting_balance, current_balance, realized_pnl, unrealized_pnl, drawdown_pct, max_drawdown_pct, trades_count, wins, losses, updated_at
**And** date column has UNIQUE constraint
**And** appropriate indexes exist for queries

## Tasks / Subtasks

- [x] **Task 1: Create Daily Performance Database Migration** (AC: 6)
  - [x] 1.1 Create migration file `src/persistence/migrations/003-daily-performance-table.js`
  - [x] 1.2 Define `daily_performance` table with all columns from architecture.md
  - [x] 1.3 Add UNIQUE constraint on date column
  - [x] 1.4 Add index on date for quick lookups
  - [x] 1.5 Run migration and verify table creation

- [x] **Task 2: Create Safety Module Structure** (AC: 1, 4)
  - [x] 2.1 Create `src/modules/safety/` directory structure following module pattern
  - [x] 2.2 Create `src/modules/safety/index.js` - Public interface (init, getState, shutdown)
  - [x] 2.3 Create `src/modules/safety/drawdown.js` - Drawdown calculation logic
  - [x] 2.4 Create `src/modules/safety/state.js` - State tracking for safety module
  - [x] 2.5 Create `src/modules/safety/types.js` - Error types and constants
  - [x] 2.6 Create `src/modules/safety/__tests__/` directory

- [x] **Task 3: Implement Daily Performance Record Management** (AC: 1)
  - [x] 3.1 Create function to get or create today's daily_performance record
  - [x] 3.2 Query for existing record by date (YYYY-MM-DD format)
  - [x] 3.3 If no record exists, create with starting_balance from config or position manager
  - [x] 3.4 Handle date rollover at midnight (new day = new record)
  - [x] 3.5 Cache today's record in memory for fast access

- [x] **Task 4: Implement Realized P&L Tracking** (AC: 2, 5)
  - [x] 4.1 Create function `recordRealizedPnl(pnl)` to update daily performance
  - [x] 4.2 Increment trades_count on each call
  - [x] 4.3 Increment wins if pnl > 0, losses if pnl < 0
  - [x] 4.4 Update realized_pnl (cumulative)
  - [x] 4.5 Recalculate current_balance = starting_balance + realized_pnl
  - [x] 4.6 Recalculate drawdown_pct
  - [x] 4.7 Update max_drawdown_pct if current is worse
  - [x] 4.8 Persist to database

- [x] **Task 5: Implement Unrealized P&L Tracking** (AC: 3)
  - [x] 5.1 Create function `updateUnrealizedPnl(unrealizedPnl)` to update daily performance
  - [x] 5.2 Accept total unrealized P&L from position manager
  - [x] 5.3 Update unrealized_pnl column
  - [x] 5.4 Calculate effective_balance = current_balance + unrealized_pnl
  - [x] 5.5 Calculate total_drawdown including unrealized
  - [x] 5.6 Update updated_at timestamp
  - [x] 5.7 Persist to database (debounced, not on every tick)

- [x] **Task 6: Implement Drawdown Query Interface** (AC: 4)
  - [x] 6.1 Create `getDrawdownStatus()` function returning current drawdown info
  - [x] 6.2 Return: drawdown_pct, max_drawdown_pct, realized_pnl, unrealized_pnl
  - [x] 6.3 Return: current_balance, starting_balance, trades_count, wins, losses
  - [x] 6.4 Include effective_balance (current + unrealized)
  - [x] 6.5 Include total_drawdown_pct (including unrealized)
  - [x] 6.6 Use cached record for fast access

- [x] **Task 7: Integrate with Position Manager** (AC: 2, 3, 5)
  - [x] 7.1 Call safety.recordRealizedPnl() when position closes with pnl
  - [x] 7.2 Provide interface for orchestrator to trigger unrealized P&L updates
  - [x] 7.3 Ensure integration doesn't block position close operations

- [x] **Task 8: Add Configuration** (AC: all)
  - [x] 8.1 Verify `config.risk.dailyDrawdownLimit` exists (already 0.05)
  - [x] 8.2 Add `config.safety.unrealizedUpdateIntervalMs` (default: 5000)
  - [x] 8.3 Add `config.safety.startingCapital` (default from env or 1000)

- [x] **Task 9: Write Tests** (AC: all)
  - [x] 9.1 Test daily record creation for new day
  - [x] 9.2 Test daily record reuse for same day
  - [x] 9.3 Test realized P&L tracking increments correctly
  - [x] 9.4 Test drawdown calculation: (starting - current) / starting
  - [x] 9.5 Test max_drawdown_pct updates only when drawdown worsens
  - [x] 9.6 Test unrealized P&L updates correctly
  - [x] 9.7 Test wins/losses counting
  - [x] 9.8 Test getDrawdownStatus() returns complete info
  - [x] 9.9 Integration test: open position → price drops → check unrealized drawdown
  - [x] 9.10 Integration test: close position at loss → check realized drawdown

## Dev Notes

### Architecture Compliance

This story implements FR28 (enforce configurable drawdown limits) by tracking daily drawdown. Story 4.4 will use this data to enforce limits and trigger auto-stop.

**From architecture.md#Database-Schema:**
```sql
CREATE TABLE daily_performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,        -- YYYY-MM-DD
    starting_balance REAL NOT NULL,
    current_balance REAL NOT NULL,
    realized_pnl REAL DEFAULT 0,
    unrealized_pnl REAL DEFAULT 0,
    drawdown_pct REAL DEFAULT 0,      -- (starting - current) / starting
    max_drawdown_pct REAL DEFAULT 0,  -- worst drawdown today
    trades_count INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL
);
```

**From architecture.md#Project-Structure:**
```
src/modules/
  safety/
    index.js          # Public interface
    drawdown.js       # Drawdown limit logic
    exposure.js       # Exposure limit logic
    __tests__/
        drawdown.test.js
        exposure.test.js
```

### Project Structure Notes

**New files to create:**
```
src/modules/safety/
├── index.js          # Public interface (init, getState, shutdown)
├── drawdown.js       # Drawdown tracking and calculation logic
├── state.js          # In-memory state (cached daily record)
├── types.js          # Error types, constants
└── __tests__/
    ├── drawdown.test.js     # Unit tests for drawdown logic
    └── index.test.js        # Module interface tests

src/persistence/migrations/
└── 003-daily-performance-table.js   # Database migration
```

**Existing files to modify:**
- `config/default.js` - Add safety configuration section
- `src/modules/position-manager/logic.js` - Call safety.recordRealizedPnl() on position close
- `src/modules/orchestrator/index.js` - Initialize safety module, trigger unrealized updates

### Module Interface

```javascript
// src/modules/safety/index.js

export async function init(config) { ... }
export function getState() { ... }
export async function shutdown() { ... }

// Drawdown tracking
export async function recordRealizedPnl(pnl) { ... }
export async function updateUnrealizedPnl(unrealizedPnl) { ... }
export function getDrawdownStatus() { ... }

// For Story 4.4 (drawdown enforcement)
export function checkDrawdownLimit() { ... }  // Returns { breached, current, limit }
export function isAutoStopped() { ... }       // Returns boolean
```

### Drawdown Calculation

**Realized Drawdown:**
```javascript
drawdown_pct = (starting_balance - current_balance) / starting_balance

// Where:
current_balance = starting_balance + realized_pnl
```

**Total Drawdown (including unrealized):**
```javascript
effective_balance = current_balance + unrealized_pnl
total_drawdown_pct = (starting_balance - effective_balance) / starting_balance
```

**Example:**
- Starting balance: $1000
- Realized P&L: -$20 (lost on closed trades)
- Current balance: $980
- Unrealized P&L: -$30 (open positions are down)
- Effective balance: $950
- Realized drawdown: (1000 - 980) / 1000 = 2%
- Total drawdown: (1000 - 950) / 1000 = 5%

### Implementation Approach

**Database Migration (003-daily-performance-table.js):**
```javascript
export default {
  version: '003',
  name: 'daily-performance-table',

  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS daily_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        starting_balance REAL NOT NULL,
        current_balance REAL NOT NULL,
        realized_pnl REAL DEFAULT 0,
        unrealized_pnl REAL DEFAULT 0,
        drawdown_pct REAL DEFAULT 0,
        max_drawdown_pct REAL DEFAULT 0,
        trades_count INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_daily_performance_date
        ON daily_performance(date);
    `);
  },

  async down(db) {
    await db.exec('DROP TABLE IF EXISTS daily_performance');
  },
};
```

**Daily Record Management:**
```javascript
// src/modules/safety/drawdown.js

import db from '../../persistence/index.js';

let cachedRecord = null;
let cachedDate = null;

export async function getOrCreateTodayRecord(startingCapital) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // Check cache first
  if (cachedRecord && cachedDate === today) {
    return cachedRecord;
  }

  // Query database
  let record = await db.get(
    'SELECT * FROM daily_performance WHERE date = ?',
    [today]
  );

  if (!record) {
    // Create new record for today
    const now = new Date().toISOString();
    await db.run(`
      INSERT INTO daily_performance
        (date, starting_balance, current_balance, updated_at)
      VALUES (?, ?, ?, ?)
    `, [today, startingCapital, startingCapital, now]);

    record = await db.get(
      'SELECT * FROM daily_performance WHERE date = ?',
      [today]
    );
  }

  // Update cache
  cachedRecord = record;
  cachedDate = today;

  return record;
}

export async function recordRealizedPnl(pnl, startingCapital) {
  const record = await getOrCreateTodayRecord(startingCapital);

  const newRealizedPnl = record.realized_pnl + pnl;
  const newCurrentBalance = record.starting_balance + newRealizedPnl;
  const newDrawdownPct = (record.starting_balance - newCurrentBalance) / record.starting_balance;
  const newMaxDrawdown = Math.max(record.max_drawdown_pct, newDrawdownPct);
  const newTradesCount = record.trades_count + 1;
  const newWins = pnl > 0 ? record.wins + 1 : record.wins;
  const newLosses = pnl < 0 ? record.losses + 1 : record.losses;

  await db.run(`
    UPDATE daily_performance
    SET realized_pnl = ?,
        current_balance = ?,
        drawdown_pct = ?,
        max_drawdown_pct = ?,
        trades_count = ?,
        wins = ?,
        losses = ?,
        updated_at = ?
    WHERE id = ?
  `, [
    newRealizedPnl,
    newCurrentBalance,
    newDrawdownPct,
    newMaxDrawdown,
    newTradesCount,
    newWins,
    newLosses,
    new Date().toISOString(),
    record.id,
  ]);

  // Update cache
  cachedRecord = {
    ...record,
    realized_pnl: newRealizedPnl,
    current_balance: newCurrentBalance,
    drawdown_pct: newDrawdownPct,
    max_drawdown_pct: newMaxDrawdown,
    trades_count: newTradesCount,
    wins: newWins,
    losses: newLosses,
    updated_at: new Date().toISOString(),
  };

  return cachedRecord;
}

export async function updateUnrealizedPnl(unrealizedPnl, startingCapital) {
  const record = await getOrCreateTodayRecord(startingCapital);

  await db.run(`
    UPDATE daily_performance
    SET unrealized_pnl = ?,
        updated_at = ?
    WHERE id = ?
  `, [unrealizedPnl, new Date().toISOString(), record.id]);

  // Update cache
  cachedRecord = {
    ...record,
    unrealized_pnl: unrealizedPnl,
    updated_at: new Date().toISOString(),
  };

  return cachedRecord;
}

export function getDrawdownStatus(startingCapital) {
  if (!cachedRecord) {
    return {
      initialized: false,
      drawdown_pct: 0,
      max_drawdown_pct: 0,
      total_drawdown_pct: 0,
    };
  }

  const effectiveBalance = cachedRecord.current_balance + cachedRecord.unrealized_pnl;
  const totalDrawdownPct = (cachedRecord.starting_balance - effectiveBalance) / cachedRecord.starting_balance;

  return {
    initialized: true,
    date: cachedRecord.date,
    starting_balance: cachedRecord.starting_balance,
    current_balance: cachedRecord.current_balance,
    effective_balance: effectiveBalance,
    realized_pnl: cachedRecord.realized_pnl,
    unrealized_pnl: cachedRecord.unrealized_pnl,
    drawdown_pct: cachedRecord.drawdown_pct,
    max_drawdown_pct: cachedRecord.max_drawdown_pct,
    total_drawdown_pct: totalDrawdownPct,
    trades_count: cachedRecord.trades_count,
    wins: cachedRecord.wins,
    losses: cachedRecord.losses,
    updated_at: cachedRecord.updated_at,
  };
}
```

### Configuration Updates

```javascript
// config/default.js - add safety section

safety: {
  startingCapital: parseFloat(process.env.STARTING_CAPITAL) || 1000,
  unrealizedUpdateIntervalMs: 5000,  // Update unrealized P&L every 5 seconds
  drawdownWarningPct: 0.03,          // 3% - warn when approaching limit
},
```

### Integration with Position Manager

When a position closes, the position manager should notify the safety module:

```javascript
// src/modules/position-manager/logic.js - in closePosition()

// After calculating pnl and updating position status:
const pnl = position.pnl; // Already calculated

// Notify safety module about realized P&L
// This is a fire-and-forget - don't block position close
try {
  await safety.recordRealizedPnl(pnl);
} catch (err) {
  log.warn('safety_pnl_record_failed', { error: err.message, pnl });
  // Don't throw - position close is the primary operation
}
```

### Integration with Orchestrator

The orchestrator should periodically update unrealized P&L:

```javascript
// src/modules/orchestrator/index.js

// In tick loop or periodic update:
async function updateUnrealizedPnl() {
  const positions = positionManager.getPositions();
  const totalUnrealized = positions.reduce((sum, pos) => {
    return sum + (pos.unrealized_pnl || 0);
  }, 0);

  await safety.updateUnrealizedPnl(totalUnrealized);
}

// Call this every config.safety.unrealizedUpdateIntervalMs
```

### Previous Story Intelligence

**From Story 4.2 (State Snapshot on Kill):**
- Orchestrator has periodic update mechanism (every 5s) - can reuse pattern
- Non-blocking async writes pattern established
- State caching pattern for fast access

**From Story 4.1 (Kill Switch Watchdog):**
- Independent module pattern with simple interface
- Config-driven timeouts
- Graceful error handling without blocking main operations

**Integration points from previous stories:**
- Kill switch can read drawdown status from state snapshot
- Watchdog can include drawdown info in kill summary
- State snapshot should include current drawdown status

### Git Commit Patterns (from recent commits)

- `ce15014` - Implement story 4-2-state-snapshot-on-kill
- `d0f579f` - Implement story 4-1-kill-switch-watchdog-process
- `c43bb92` - Implement story 3-6-window-expiry-handling

All follow pattern: "Implement story {story-key}"

### Testing Approach

**Unit tests for drawdown.js:**
```javascript
// src/modules/safety/__tests__/drawdown.test.js

describe('Drawdown Tracking', () => {
  describe('getOrCreateTodayRecord', () => {
    it('should create new record for new day', async () => {
      const record = await getOrCreateTodayRecord(1000);
      expect(record.starting_balance).toBe(1000);
      expect(record.current_balance).toBe(1000);
      expect(record.realized_pnl).toBe(0);
    });

    it('should reuse existing record for same day', async () => {
      const record1 = await getOrCreateTodayRecord(1000);
      const record2 = await getOrCreateTodayRecord(1000);
      expect(record1.id).toBe(record2.id);
    });
  });

  describe('recordRealizedPnl', () => {
    it('should update realized P&L and drawdown', async () => {
      await getOrCreateTodayRecord(1000);
      const result = await recordRealizedPnl(-50, 1000);

      expect(result.realized_pnl).toBe(-50);
      expect(result.current_balance).toBe(950);
      expect(result.drawdown_pct).toBeCloseTo(0.05);
    });

    it('should track max drawdown', async () => {
      await getOrCreateTodayRecord(1000);
      await recordRealizedPnl(-50, 1000);  // 5% drawdown
      await recordRealizedPnl(30, 1000);   // Back to 2% drawdown

      const status = getDrawdownStatus();
      expect(status.drawdown_pct).toBeCloseTo(0.02);
      expect(status.max_drawdown_pct).toBeCloseTo(0.05);
    });

    it('should count wins and losses', async () => {
      await getOrCreateTodayRecord(1000);
      await recordRealizedPnl(10, 1000);   // Win
      await recordRealizedPnl(-5, 1000);   // Loss
      await recordRealizedPnl(20, 1000);   // Win

      const status = getDrawdownStatus();
      expect(status.trades_count).toBe(3);
      expect(status.wins).toBe(2);
      expect(status.losses).toBe(1);
    });
  });

  describe('updateUnrealizedPnl', () => {
    it('should update unrealized P&L', async () => {
      await getOrCreateTodayRecord(1000);
      await updateUnrealizedPnl(-30, 1000);

      const status = getDrawdownStatus();
      expect(status.unrealized_pnl).toBe(-30);
    });

    it('should calculate total drawdown including unrealized', async () => {
      await getOrCreateTodayRecord(1000);
      await recordRealizedPnl(-20, 1000);   // Realized loss
      await updateUnrealizedPnl(-30, 1000); // Unrealized loss

      const status = getDrawdownStatus();
      expect(status.drawdown_pct).toBeCloseTo(0.02);       // 2% realized
      expect(status.total_drawdown_pct).toBeCloseTo(0.05); // 5% total
    });
  });
});
```

### NFR Compliance

- **FR28** (Enforce configurable drawdown limits): This story tracks drawdown; Story 4.4 enforces limits
- **NFR9** (100% diagnostic coverage): All drawdown changes are tracked and queryable
- **NFR8** (State persisted): Drawdown persisted to database before acknowledging

### Critical Implementation Notes

1. **Date Handling:** Use YYYY-MM-DD format consistently. Handle timezone correctly (use local date for trading day boundaries).

2. **Cache Invalidation:** When date changes (midnight rollover), cache should be invalidated and new record created.

3. **Atomic Updates:** Use database transactions for updates to prevent race conditions.

4. **Non-Blocking:** P&L recording should not block position close operations.

5. **Negative Drawdown:** If profit exceeds starting balance, drawdown is negative (which is good). Handle this gracefully.

6. **Starting Capital:** Can come from config, environment variable, or calculated from current positions + cash.

7. **Initialization Order:** Safety module should init after persistence and position-manager (needs to read positions for unrealized P&L).

### Story 4.4 Preview

Story 4.4 (Drawdown Limit Enforcement & Auto-Stop) will:
- Add `checkDrawdownLimit()` that compares current drawdown to `config.risk.dailyDrawdownLimit`
- Add `isAutoStopped()` flag
- Integrate with orchestrator to check drawdown before each trade
- Trigger kill switch when limit breached

### References

- [Source: architecture.md#Database-Schema] - daily_performance table schema
- [Source: architecture.md#Project-Structure] - src/modules/safety/ location
- [Source: epics.md#Story-4.3] - Story requirements and acceptance criteria
- [Source: prd.md#FR28] - System can enforce configurable drawdown limits
- [Source: config/default.js:30] - risk.dailyDrawdownLimit = 0.05 (5%)
- [Source: src/modules/position-manager/logic.js] - Position close with P&L calculation
- [Source: src/modules/orchestrator/index.js] - Module initialization and tick loop

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

No debug log issues encountered.

### Completion Notes List

- Created database migration 003-daily-performance-table.js with full schema per architecture.md
- Implemented safety module following standard module pattern (init, getState, shutdown)
- Added drawdown.js with getOrCreateTodayRecord, recordRealizedPnl, updateUnrealizedPnl, getDrawdownStatus
- Implemented in-memory caching for fast drawdown queries with date-based cache invalidation
- Integrated with position-manager to record realized P&L on position close (fire-and-forget pattern)
- Added safety configuration section to config/default.js (startingCapital, unrealizedUpdateIntervalMs)
- Created comprehensive test suite with 37 tests covering all acceptance criteria
- All 1081 tests pass (1044 existing + 37 new safety module tests)

### File List

**New Files:**
- src/persistence/migrations/003-daily-performance-table.js
- src/modules/safety/index.js
- src/modules/safety/drawdown.js
- src/modules/safety/state.js
- src/modules/safety/types.js
- src/modules/safety/__tests__/drawdown.test.js
- src/modules/safety/__tests__/index.test.js

**Modified Files:**
- config/default.js (added safety configuration section)
- src/modules/position-manager/logic.js (added safety.recordRealizedPnl integration)

### Change Log

- 2026-01-31: Implemented Story 4.3 - Drawdown Tracking (FR28)

