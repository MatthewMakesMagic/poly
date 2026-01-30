# Story 1.1: Project Structure & Configuration

Status: done

## Story

As a **developer (human or AI agent)**,
I want **a consistent folder-per-module project structure with configuration loading**,
So that **I can work on isolated modules with clear boundaries and externalized settings**.

## Acceptance Criteria

### AC1: Directory Structure Established

**Given** the project is initialized
**When** I inspect the directory structure
**Then** I see the following directories exist:
- `src/modules/` (for bounded modules)
- `src/types/` (for shared type definitions)
- `src/persistence/` (for database layer)
- `src/clients/` (for external API clients)
- `config/` (for configuration files)
- `cli/` (for CLI commands)
- `kill-switch/` (for watchdog process)
- `data/` (for SQLite database - gitignored)
- `logs/` (for log files - gitignored)

**And** each module folder contains `index.js` as the public interface

### AC2: Configuration Loading Works

**Given** configuration files exist in `config/`
**When** the application starts
**Then** configuration is loaded from `config/default.js`
**And** environment-specific overrides are applied (`development.js` or `production.js`)
**And** `.env` values are available for credentials (FR37)
**And** configuration is validated before use

### AC3: Shared Types Defined

**Given** shared types are needed
**When** I import from `src/types/`
**Then** I have access to:
- Position types (`src/types/position.js`)
- Order types (`src/types/order.js`)
- Trade log types (`src/types/trade-log.js`)
- Error type definitions (`src/types/errors.js`)

**And** error classes include `code`, `message`, and `context` properties

### AC4: Module Interface Template Created

**Given** modules will be created
**When** I examine the module template
**Then** each module `index.js` exports:
- `init(config)` - async initialization
- `getState()` - returns current module state
- `shutdown()` - async graceful shutdown

**And** all public functions return Promises (async)
**And** errors are thrown via typed error classes

### AC5: Gitignore Configured

**Given** the project has sensitive/generated files
**When** I check `.gitignore`
**Then** the following are ignored:
- `.env` (credentials)
- `data/` (SQLite database)
- `logs/` (log files)
- `node_modules/`

## Tasks / Subtasks

- [x] **Task 1: Create Directory Structure** (AC: 1)
  - [x] 1.1 Create `src/modules/` directory
  - [x] 1.2 Create `src/types/` directory
  - [x] 1.3 Create `src/persistence/` directory
  - [x] 1.4 Create `src/clients/polymarket/` and `src/clients/spot/` directories
  - [x] 1.5 Create `config/` directory
  - [x] 1.6 Create `cli/commands/` directory
  - [x] 1.7 Create `kill-switch/` directory
  - [x] 1.8 Create `data/` directory with `.gitkeep`
  - [x] 1.9 Create `logs/` directory with `.gitkeep`

- [x] **Task 2: Create Configuration Files** (AC: 2)
  - [x] 2.1 Create `config/default.js` with base configuration structure
  - [x] 2.2 Create `config/development.js` with dev overrides
  - [x] 2.3 Create `config/production.js` with prod overrides
  - [x] 2.4 Create `.env.example` documenting required environment variables
  - [x] 2.5 Create config loader utility that merges configs and validates

- [x] **Task 3: Create Shared Type Definitions** (AC: 3)
  - [x] 3.1 Create `src/types/index.js` as export hub
  - [x] 3.2 Create `src/types/position.js` with Position type
  - [x] 3.3 Create `src/types/order.js` with Order type
  - [x] 3.4 Create `src/types/trade-log.js` with structured log schema
  - [x] 3.5 Create `src/types/errors.js` with typed error classes

- [x] **Task 4: Create Module Template** (AC: 4)
  - [x] 4.1 Create example module structure in `src/modules/_template/`
  - [x] 4.2 Create `src/modules/_template/index.js` with standard interface
  - [x] 4.3 Create `src/modules/_template/types.js` for module-specific types
  - [x] 4.4 Create `src/modules/_template/__tests__/` directory
  - [x] 4.5 Document module contract in `src/modules/README.md`

- [x] **Task 5: Update Gitignore and Project Files** (AC: 5)
  - [x] 5.1 Update `.gitignore` with required exclusions
  - [x] 5.2 Verify sensitive paths are ignored
  - [x] 5.3 Add `.gitkeep` files to empty directories

## Dev Notes

### Architecture Compliance

This story establishes the **folder-per-module** architecture from the Architecture Decision Document. Key patterns:

1. **Module Structure** (from architecture.md):
```
src/modules/
  {module-name}/
    index.js          # Public interface only
    state.js          # Internal state management
    logic.js          # Business logic
    types.js          # Type definitions/contracts
    __tests__/        # Co-located tests
```

2. **Module Interface Contract** (MANDATORY):
```javascript
module.exports = {
  init: async (config) => {},    // Initialize with config
  getState: () => {},            // Return current state
  shutdown: async () => {}       // Graceful shutdown
};
```

3. **Error Handling Pattern**:
```javascript
class ModuleError extends Error {
  constructor(code, message, context) {
    super(message);
    this.code = code;      // e.g., 'POSITION_LIMIT_EXCEEDED'
    this.context = context; // { position_id, limit, attempted }
  }
}
```

### Naming Conventions (STRICT)

| Category | Convention | Example |
|----------|------------|---------|
| Files | kebab-case | `position-manager.js` |
| Folders | kebab-case | `position-manager/` |
| Functions | camelCase | `getPosition()` |
| Constants | UPPER_SNAKE | `MAX_POSITION_SIZE` |
| DB Tables | snake_case | `trade_intents` |
| Log Fields | snake_case | `expected_price` |

### Configuration Structure

```javascript
// config/default.js
module.exports = {
  polymarket: {
    apiUrl: process.env.POLYMARKET_API_URL,
    apiKey: process.env.POLYMARKET_API_KEY,
    apiSecret: process.env.POLYMARKET_API_SECRET,
  },
  spot: {
    provider: 'pyth',
    endpoint: process.env.SPOT_ENDPOINT,
  },
  risk: {
    maxPositionSize: 100,
    maxExposure: 500,
    dailyDrawdownLimit: 0.05,  // 5%
  },
  logging: {
    level: 'info',
    directory: './logs',
  },
  database: {
    path: './data/poly.db',
  },
};
```

### Required Environment Variables

```
# .env.example
POLYMARKET_API_URL=
POLYMARKET_API_KEY=
POLYMARKET_API_SECRET=
POLYMARKET_PASSPHRASE=
SPOT_ENDPOINT=
NODE_ENV=development
```

### Project Structure Notes

**New Structure (this story creates):**
```
poly/
├── config/
│   ├── default.js
│   ├── development.js
│   └── production.js
├── src/
│   ├── types/
│   │   ├── index.js
│   │   ├── position.js
│   │   ├── order.js
│   │   ├── trade-log.js
│   │   └── errors.js
│   ├── modules/
│   │   ├── README.md
│   │   └── _template/
│   │       ├── index.js
│   │       ├── types.js
│   │       └── __tests__/
│   ├── persistence/
│   └── clients/
│       ├── polymarket/
│       └── spot/
├── cli/
│   └── commands/
├── kill-switch/
├── data/
│   └── .gitkeep
├── logs/
│   └── .gitkeep
├── .env.example
└── .gitignore
```

**Existing Code Awareness:**

The existing codebase has these relevant files that may be referenced but NOT modified:
- `src/execution/` - existing execution engine (will be replaced by new modules)
- `src/quant/` - existing strategy code (will inform new strategy modules)
- `src/db/` - existing database code (will be replaced by new persistence layer)

This is a **brownfield rebuild** - we're creating new architecture alongside existing code, not modifying existing files.

### Git Intelligence

Recent commits show active development on:
- Position sizing and exposure limits
- Price source selection (Pyth over Binance)
- Retry logic and balance checking
- P&L calculation fixes

These are the exact issues the new architecture addresses.

### Testing Requirements

No tests required for this foundation story. Testing infrastructure will be validated in future stories when modules have logic to test.

### References

- [Source: architecture.md#Module-Architecture] - Module structure decision
- [Source: architecture.md#Implementation-Patterns-Consistency-Rules] - Naming conventions
- [Source: architecture.md#Configuration-Pattern] - Config loading pattern
- [Source: architecture.md#Module-Interface-Contract] - Required exports
- [Source: architecture.md#Error-Handling-Pattern] - Error class pattern
- [Source: prd.md#FR35-37] - Configuration requirements

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Completion Notes List

1. All directories created per AC1 requirements
2. Configuration system implemented with ESM modules (project uses `"type": "module"`)
3. Config loader supports deep merging of environment-specific overrides
4. All type definitions created with proper JSDoc documentation
5. Module template provides standard interface pattern (init/getState/shutdown)
6. ESM conversion required - original implementation used CommonJS but project uses ES modules

### Change Log

- 2026-01-30: Initial implementation of all tasks
- 2026-01-30: Converted all files from CommonJS to ESM to match project configuration
- 2026-01-30: Verified config loads correctly and types work as expected

### File List

**Created:**
- `config/default.js` - Base configuration with all settings
- `config/development.js` - Development environment overrides
- `config/production.js` - Production environment overrides
- `config/index.js` - Configuration loader with validation
- `.env.example` - Environment variable documentation
- `src/types/index.js` - Type export hub
- `src/types/errors.js` - Typed error classes (PolyError, PositionError, OrderError, etc.)
- `src/types/position.js` - Position types and utilities
- `src/types/order.js` - Order types and utilities
- `src/types/trade-log.js` - Structured logging types
- `src/modules/_template/index.js` - Module interface template
- `src/modules/_template/types.js` - Module-specific types template
- `src/modules/_template/__tests__/.gitkeep` - Test directory placeholder
- `src/modules/README.md` - Module architecture documentation
- `src/persistence/.gitkeep` - Directory placeholder
- `src/clients/polymarket/.gitkeep` - Directory placeholder
- `src/clients/spot/.gitkeep` - Directory placeholder
- `cli/commands/.gitkeep` - Directory placeholder
- `kill-switch/.gitkeep` - Directory placeholder
- `data/.gitkeep` - Directory placeholder
- `logs/.gitkeep` - Directory placeholder

**Modified:**
- `.gitignore` - Added data/last-known-state.json exclusion
