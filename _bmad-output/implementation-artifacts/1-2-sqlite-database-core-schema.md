# Story 1.2: SQLite Database & Core Schema

Status: done

## Story

As a **system operator**,
I want **a SQLite database initialized with the trade_intents table**,
So that **the system can persist state and recover from crashes (FR16)**.

## Acceptance Criteria

### AC1: Database Creation and Location

**Given** the application starts for the first time
**When** the persistence layer initializes
**Then** SQLite database is created at `data/poly.db`
**And** the database file is created with proper permissions
**And** the data/ directory is used (already exists from Story 1.1)

### AC2: Trade Intents Table Created

**Given** the database is initialized
**When** the schema is applied
**Then** the `trade_intents` table exists with columns:
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `intent_type` TEXT NOT NULL (values: 'open_position', 'close_position', 'place_order', 'cancel_order')
- `window_id` TEXT NOT NULL
- `payload` TEXT NOT NULL (JSON)
- `status` TEXT NOT NULL DEFAULT 'pending' (values: 'pending', 'executing', 'completed', 'failed')
- `created_at` TEXT NOT NULL (ISO timestamp)
- `completed_at` TEXT (NULL until resolved)
- `result` TEXT (JSON with outcome or error)

**And** indexes exist on `status` and `window_id`

### AC3: Database Survives Restart

**Given** the database already exists with data
**When** the application starts
**Then** the existing database is used without data loss
**And** no duplicate table creation errors occur
**And** existing data remains intact

### AC4: Schema Migration Support

**Given** the schema may need updates in the future
**When** schema changes are needed
**Then** migration infrastructure exists in `src/persistence/migrations/`
**And** migrations run in order if needed
**And** migration history is tracked

### AC5: Database Errors Are Typed

**Given** a database operation fails
**When** the error is caught
**Then** a typed `PersistenceError` is thrown with:
- `code` property (e.g., 'DB_CONNECTION_FAILED', 'DB_QUERY_FAILED', 'DB_SCHEMA_ERROR')
- `message` describing what failed
- `context` with relevant details (query, table, etc.)

**And** errors are NEVER swallowed silently

### AC6: Persistence Module Interface

**Given** the persistence module is created
**When** inspecting its interface
**Then** it exports the standard module contract:
- `init(config)` - async initialization, creates DB and applies schema
- `getState()` - returns connection status, database path
- `shutdown()` - async close of database connection

**And** additional database operations:
- `run(sql, params)` - execute SQL that modifies data
- `get(sql, params)` - get single row
- `all(sql, params)` - get all matching rows

## Tasks / Subtasks

- [x] **Task 1: Create Persistence Module Structure** (AC: 6)
  - [x] 1.1 Create `src/persistence/index.js` with standard module interface
  - [x] 1.2 Create `src/persistence/database.js` for SQLite connection management
  - [x] 1.3 Create `src/persistence/migrations/` directory structure
  - [x] 1.4 Add `PersistenceError` class to `src/types/errors.js` if not present

- [x] **Task 2: Implement Database Connection** (AC: 1, 3)
  - [x] 2.1 Install `better-sqlite3` package (synchronous, faster than sqlite3)
  - [x] 2.2 Implement database connection in `database.js`
  - [x] 2.3 Create database file at configured path (`data/poly.db`)
  - [x] 2.4 Handle existing database gracefully (no overwrites)
  - [x] 2.5 Implement connection state tracking

- [x] **Task 3: Create Schema Definition** (AC: 2)
  - [x] 3.1 Create `src/persistence/schema.sql` with trade_intents table
  - [x] 3.2 Add id, intent_type, window_id, payload, status, created_at, completed_at, result columns
  - [x] 3.3 Add CHECK constraints for status and intent_type values
  - [x] 3.4 Create index on `status` column
  - [x] 3.5 Create index on `window_id` column

- [x] **Task 4: Implement Schema Application** (AC: 2, 3)
  - [x] 4.1 Create `src/persistence/schema-manager.js` to handle schema application
  - [x] 4.2 Implement CREATE TABLE IF NOT EXISTS pattern
  - [x] 4.3 Implement CREATE INDEX IF NOT EXISTS pattern
  - [x] 4.4 Apply schema on module init

- [x] **Task 5: Implement Migration Infrastructure** (AC: 4)
  - [x] 5.1 Create `src/persistence/migrations/001-initial-schema.js`
  - [x] 5.2 Create migration runner that tracks applied migrations
  - [x] 5.3 Create `schema_migrations` table to track migration history
  - [x] 5.4 Migrations run in numerical order

- [x] **Task 6: Implement Query Methods** (AC: 5, 6)
  - [x] 6.1 Implement `run(sql, params)` for INSERT/UPDATE/DELETE
  - [x] 6.2 Implement `get(sql, params)` for single row SELECT
  - [x] 6.3 Implement `all(sql, params)` for multiple row SELECT
  - [x] 6.4 Wrap all operations in try-catch with typed PersistenceError
  - [x] 6.5 Log all errors before throwing

- [x] **Task 7: Write Tests** (AC: all)
  - [x] 7.1 Create `src/persistence/__tests__/database.test.js`
  - [x] 7.2 Test database creation in temp directory
  - [x] 7.3 Test schema application creates expected tables/indexes
  - [x] 7.4 Test database survives "restart" (close and reopen)
  - [x] 7.5 Test error handling produces typed errors

## Dev Notes

### Architecture Compliance

This story implements the **State Persistence** pattern from the Architecture Decision Document:

**Write-Ahead Logging Pattern (from architecture.md):**
The `trade_intents` table is the foundation for "no orphaned state" guarantee. Every state-changing operation will:
1. Log intent to SQLite (e.g., "opening position X") - status='pending'
2. Execute action (place order) - status='executing'
3. Log result (success/failure with details) - status='completed' or 'failed'
4. On restart: Check for incomplete intents (status='executing') → reconcile

**Recovery Query:**
```sql
SELECT * FROM trade_intents WHERE status = 'executing'
```

### Database Schema (EXACT from architecture.md)

```sql
CREATE TABLE trade_intents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_type TEXT NOT NULL,        -- 'open_position', 'close_position', 'place_order', 'cancel_order'
    window_id TEXT NOT NULL,          -- which 15-min window
    payload TEXT NOT NULL,            -- JSON with intent details
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'executing', 'completed', 'failed'
    created_at TEXT NOT NULL,         -- ISO timestamp
    completed_at TEXT,                -- NULL until resolved
    result TEXT                       -- JSON with outcome or error
);

CREATE INDEX idx_intents_status ON trade_intents(status);
CREATE INDEX idx_intents_window ON trade_intents(window_id);
```

### Module Interface (MANDATORY from architecture.md)

```javascript
// src/persistence/index.js
export default {
  // Standard module interface
  init: async (config) => {},      // Create DB, apply schema
  getState: () => {},              // Return { connected, path }
  shutdown: async () => {},        // Close connection

  // Database operations
  run: (sql, params) => {},        // Execute modifying query
  get: (sql, params) => {},        // Get single row
  all: (sql, params) => {},        // Get all rows
};
```

### Error Pattern (MANDATORY from architecture.md)

```javascript
// Add to src/types/errors.js
export class PersistenceError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'PersistenceError';
  }
}

// Error codes:
// - DB_CONNECTION_FAILED
// - DB_QUERY_FAILED
// - DB_SCHEMA_ERROR
// - DB_NOT_INITIALIZED
```

### Library Choice: better-sqlite3

**Why better-sqlite3 over sqlite3:**
1. **Synchronous API** - simpler code, no callback hell
2. **Faster** - 2-3x performance improvement
3. **Better error messages** - easier debugging
4. **Smaller memory footprint**
5. **Works well with write-ahead logging pattern** (ironic name match)

**Installation:**
```bash
npm install better-sqlite3
```

**Usage Pattern:**
```javascript
import Database from 'better-sqlite3';

const db = new Database('data/poly.db');
db.pragma('journal_mode = WAL');  // Enable WAL for better concurrency

// Run returns { changes, lastInsertRowid }
const result = db.prepare('INSERT INTO ...').run(params);

// Get returns single row or undefined
const row = db.prepare('SELECT * FROM ... WHERE id = ?').get(id);

// All returns array of rows
const rows = db.prepare('SELECT * FROM ...').all();
```

### Configuration Integration

The database path comes from config (Story 1.1):

```javascript
// config/default.js already has:
database: {
  path: './data/poly.db',
}
```

### Project Structure Notes

**Files to Create:**
```
src/persistence/
├── index.js              # Public interface (init, getState, shutdown, run, get, all)
├── database.js           # SQLite connection management
├── schema.sql            # SQL schema definition
├── schema-manager.js     # Schema application logic
├── migrations/
│   ├── index.js          # Migration runner
│   └── 001-initial-schema.js
└── __tests__/
    ├── database.test.js
    └── schema-manager.test.js
```

**Naming Conventions (from architecture.md):**
- Files: kebab-case (`schema-manager.js`)
- Tables: snake_case (`trade_intents`)
- Columns: snake_case (`window_id`, `intent_type`)

### Previous Story Intelligence

**From Story 1.1:**
- Config system is in place and working
- ESM modules required (project uses `"type": "module"`)
- Types directory exists with error class patterns
- Standard module interface pattern established (`init`, `getState`, `shutdown`)
- PolyError base class exists in `src/types/errors.js`

**Key Learning:**
- All imports must use ESM syntax (`import`/`export`)
- Config loader available at `config/index.js`
- Standard error pattern: extend PolyError with code, message, context

### Git Intelligence

Recent commits show issues with state management:
- `ac53777` - CRITICAL FIX: Correct P&L calculation and position tracking
- `4ea3e7a` - Fix retry bug - check balance before retrying to prevent doubled positions

These are exactly the problems that write-ahead logging prevents. The `trade_intents` table will ensure:
- Every operation is logged BEFORE execution
- Crashed operations can be detected on restart
- No "doubled positions" from retry bugs - check intent status first

### Testing Requirements

**Test File:** `src/persistence/__tests__/database.test.js`

```javascript
// Test categories:
describe('Persistence Module', () => {
  describe('init', () => {
    it('creates database file at configured path');
    it('applies schema on first init');
    it('preserves existing data on subsequent init');
  });

  describe('trade_intents table', () => {
    it('has all required columns');
    it('has index on status');
    it('has index on window_id');
    it('enforces NOT NULL constraints');
  });

  describe('query methods', () => {
    it('run() inserts and returns lastInsertRowid');
    it('get() returns single row');
    it('all() returns array of rows');
  });

  describe('error handling', () => {
    it('throws PersistenceError on query failure');
    it('includes error code in thrown error');
    it('includes context in thrown error');
  });
});
```

**Test Utilities:**
- Use temp directory for test databases
- Clean up after each test
- Test both happy path and error scenarios

### References

- [Source: architecture.md#State-Persistence] - Write-ahead logging decision
- [Source: architecture.md#Database-Schema] - Complete schema definition
- [Source: architecture.md#trade_intents] - Table structure and indexes
- [Source: architecture.md#Module-Interface-Contract] - Required exports
- [Source: architecture.md#Error-Handling-Pattern] - Error class pattern
- [Source: prd.md#FR16] - State persistence requirement
- [Source: prd.md#FR19] - Crash recovery requirement
- [Source: epics.md#Story-1.2] - Story requirements

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

None - all tests passed on first run.

### Completion Notes List

1. **Persistence module structure created** with standard module interface (init, getState, shutdown) plus query methods (run, get, all)
2. **PersistenceError class added** to src/types/errors.js extending PolyError, with error codes: DB_CONNECTION_FAILED, DB_QUERY_FAILED, DB_SCHEMA_ERROR, DB_NOT_INITIALIZED, DB_MIGRATION_FAILED
3. **better-sqlite3 used** with WAL journal mode for crash recovery and better concurrency
4. **Schema defined in SQL file** with CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS for idempotent application
5. **CHECK constraints added** for intent_type (open_position, close_position, place_order, cancel_order) and status (pending, executing, completed, failed)
6. **Migration infrastructure created** with migration runner that discovers and runs migrations in order, tracked in schema_migrations table
7. **49 tests written and passing** covering: init behavior, table/index creation, query methods, error handling, state tracking, shutdown behavior, schema manager functions
8. **vitest added as test framework** with npm scripts: test, test:run

### Code Review Fixes Applied

1. **[HIGH] Added error logging** - All error paths in database.js now log via console.error before throwing (placeholder for Story 1-4 logger module)
2. **[HIGH] Created schema-manager.test.js** - Added 19 comprehensive tests for schema-manager functions
3. **[MEDIUM] Fixed getTableColumns()** - Replaced broken SQL parsing with proper PRAGMA table_info usage; added SQL injection protection for table names
4. **[MEDIUM] Removed double schema application** - Migration 001 no longer calls applySchema() since init() already applies it
5. **[LOW] Removed unused import** - Removed unused `exec` import from migrations/index.js
6. **[LOW] Fixed empty catch block** - getTableColumns() now properly throws PersistenceError for invalid table names instead of silently returning empty array

### Change Log

- 2026-01-30: Implemented complete persistence module with all 7 tasks and 27 subtasks
- 2026-01-30: Code review fixes - added logging, created schema-manager tests, fixed getTableColumns, removed double schema application

### File List

**Created:**
- src/persistence/index.js - Public module interface
- src/persistence/database.js - SQLite connection management (with error logging)
- src/persistence/schema.sql - Database schema definition
- src/persistence/schema-manager.js - Schema application logic (with fixed getTableColumns)
- src/persistence/migrations/index.js - Migration runner (removed unused import)
- src/persistence/migrations/001-initial-schema.js - Initial migration (no-op, records version only)
- src/persistence/__tests__/database.test.js - 30 comprehensive tests
- src/persistence/__tests__/schema-manager.test.js - 19 schema manager tests

**Modified:**
- src/types/errors.js - Added PersistenceError class and DB error codes
- package.json - Added test scripts, moved better-sqlite3 to dependencies, added vitest

