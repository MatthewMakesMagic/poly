# Story 1.4: Logger Module

Status: review

## Story

As a **developer**,
I want **a structured JSON logging module**,
So that **every trade event produces complete, queryable logs (FR20, NFR9)**.

## Acceptance Criteria

### AC1: JSON Log Entry Structure

**Given** any module needs to log an event
**When** logger.info/warn/error is called
**Then** a JSON log entry is produced with required fields: timestamp, level, module, event
**And** optional fields (data, context, error) are included when provided
**And** the JSON is valid and parseable

### AC2: Timestamp and Level Format

**Given** a log entry is created
**When** the entry is written
**Then** the timestamp is ISO format (e.g., "2026-01-30T10:15:30.123Z")
**And** the level is one of: info, warn, error
**And** field names use snake_case convention

### AC3: Module Interface Contract

**Given** the logger module is initialized
**When** init(config) is called
**Then** the logger respects the configured log level (info, warn, error)
**And** logs are written to `logs/` directory
**And** the module exports: init(), info(), warn(), error(), getState(), shutdown()
**And** the module follows the standard interface pattern from architecture

### AC4: Credential Redaction

**Given** sensitive data might be logged
**When** credentials or API keys appear in log data
**Then** they are redacted or never included (NFR12)
**And** common patterns are automatically detected and redacted:
  - Fields containing 'key', 'secret', 'password', 'token', 'credential', 'auth'
  - Environment variable values matching these patterns

### AC5: Log Level Filtering

**Given** the logger is configured with a log level
**When** a log entry is created at a lower priority level
**Then** the entry is NOT written
**And** the filtering follows: error > warn > info (error always logged, info only if level=info)

### AC6: Module Context Binding

**Given** a module wants to create a child logger
**When** logger.child({ module: 'position-manager' }) is called
**Then** all subsequent logs from that child include the module field automatically
**And** the child inherits configuration from parent logger

### AC7: File Output with Rotation

**Given** the logger is writing to files
**When** logs are written
**Then** logs are written to `logs/poly-{date}.log` (daily rotation)
**And** log files are append-only (not overwritten on restart)
**And** each line is a single JSON object (newline-delimited JSON)

### AC8: Console Output in Development

**Given** the environment is development
**When** logs are written
**Then** logs are also output to console with readable formatting
**And** production mode outputs JSON-only to files (no console)

## Tasks / Subtasks

- [x] **Task 1: Create Logger Module Structure** (AC: 3)
  - [x] 1.1 Create `src/modules/logger/index.js` as public interface
  - [x] 1.2 Create `src/modules/logger/formatter.js` for JSON formatting
  - [x] 1.3 Create `src/modules/logger/writer.js` for file output
  - [x] 1.4 Create `src/modules/logger/redactor.js` for credential sanitization
  - [x] 1.5 Ensure `logs/` directory exists in project root

- [x] **Task 2: Implement Core Logging Functions** (AC: 1, 2, 5)
  - [x] 2.1 Implement init(config) to configure log level and output
  - [x] 2.2 Implement info(event, data?, context?) function
  - [x] 2.3 Implement warn(event, data?, context?) function
  - [x] 2.4 Implement error(event, data?, context?, errorObj?) function
  - [x] 2.5 Implement log level filtering logic
  - [x] 2.6 Ensure timestamp is ISO 8601 format with milliseconds

- [x] **Task 3: Implement JSON Formatter** (AC: 1, 2)
  - [x] 3.1 Create formatLogEntry(level, module, event, data?, context?, error?) function
  - [x] 3.2 Ensure all field names are snake_case
  - [x] 3.3 Handle circular references in objects gracefully
  - [x] 3.4 Serialize Date objects to ISO strings
  - [x] 3.5 Handle BigInt values (convert to string)

- [x] **Task 4: Implement Credential Redaction** (AC: 4)
  - [x] 4.1 Create SENSITIVE_PATTERNS list for field name detection
  - [x] 4.2 Implement redactSensitive(obj) recursive function
  - [x] 4.3 Replace sensitive values with '[REDACTED]'
  - [x] 4.4 Handle nested objects and arrays
  - [x] 4.5 Add tests for edge cases (deep nesting, arrays of objects)

- [x] **Task 5: Implement File Writer** (AC: 7)
  - [x] 5.1 Implement writeToFile(logLine) function
  - [x] 5.2 Implement daily file rotation (logs/poly-YYYY-MM-DD.log)
  - [x] 5.3 Use append mode for file writes
  - [x] 5.4 Ensure newline-delimited JSON format
  - [x] 5.5 Handle file system errors gracefully (don't crash on write failure)

- [x] **Task 6: Implement Child Logger** (AC: 6)
  - [x] 6.1 Implement child(defaultFields) method
  - [x] 6.2 Child logger inherits parent config
  - [x] 6.3 Child logger merges defaultFields into every log entry
  - [x] 6.4 Support nested children (child of child)

- [x] **Task 7: Implement Console Output** (AC: 8)
  - [x] 7.1 Detect environment (development vs production)
  - [x] 7.2 In development: output pretty-printed logs to console
  - [x] 7.3 In production: JSON-only to files, no console output
  - [x] 7.4 Use color coding for log levels in console (optional enhancement)

- [x] **Task 8: Implement Module State and Shutdown** (AC: 3)
  - [x] 8.1 Implement getState() returning current config and stats
  - [x] 8.2 Implement shutdown() to flush pending writes and close file handles
  - [x] 8.3 Track basic stats: total logs written, errors count, last write time

- [x] **Task 9: Write Tests** (AC: all)
  - [x] 9.1 Create `src/modules/logger/__tests__/index.test.js`
  - [x] 9.2 Test JSON structure has required fields
  - [x] 9.3 Test timestamp is valid ISO format
  - [x] 9.4 Test level filtering (warn level filters out info)
  - [x] 9.5 Test credential redaction for various patterns
  - [x] 9.6 Test child logger inherits and merges fields
  - [x] 9.7 Test file output is newline-delimited JSON
  - [x] 9.8 Test shutdown flushes and closes cleanly
  - [x] 9.9 Test circular reference handling
  - [x] 9.10 Test getState returns expected structure

## Dev Notes

### Architecture Compliance

This story implements the **Structured Logging** pattern from the Architecture Decision Document.

**From architecture.md#Structured-Log-Format:**
> Every log entry MUST include:
> ```json
> {
>   "timestamp": "2026-01-30T10:15:30.123Z",
>   "level": "info|warn|error",
>   "module": "position-manager",
>   "event": "position_opened",
>   "data": {
>     "window_id": "...",
>     "expected": { ... },
>     "actual": { ... }
>   },
>   "context": {
>     "strategy": "spot-lag-v1",
>     "session_id": "..."
>   }
> }
> ```
> **Required fields:** timestamp, level, module, event
> **Optional fields:** data, context, error

**From architecture.md#Module-Interface-Contract:**
```javascript
module.exports = {
  init: async (config) => {},
  // Main operations (module-specific)
  getState: () => {},
  shutdown: async () => {}
};
```

**From architecture.md#Project-Structure:**
```
src/modules/
  logger/
    index.js          # Public interface
    formatter.js      # JSON log formatting
    schema.js         # Log schema validation
    __tests__/
        formatter.test.js
```

### Configuration Pattern

From config/default.js:
```javascript
module.exports = {
  // ...
  logging: {
    level: 'info',      // 'info' | 'warn' | 'error'
    outputDir: 'logs',
    console: process.env.NODE_ENV !== 'production',
  }
};
```

### Log Level Priority

```javascript
const LOG_LEVELS = {
  error: 0,   // Always logged
  warn: 1,    // Logged when level is 'warn' or 'info'
  info: 2,    // Only logged when level is 'info'
};
```

### Sensitive Field Patterns

```javascript
const SENSITIVE_PATTERNS = [
  /key/i,
  /secret/i,
  /password/i,
  /token/i,
  /credential/i,
  /auth/i,
  /private/i,
  /api.?key/i,
];
```

### Expected Module Interface

```javascript
// src/modules/logger/index.js

let config = null;
let fileHandle = null;

export async function init(cfg) {
  config = cfg.logging || {};
  // Open file handle, create logs/ directory if needed
}

export function info(event, data = {}, context = {}) {
  log('info', event, data, context);
}

export function warn(event, data = {}, context = {}) {
  log('warn', event, data, context);
}

export function error(event, data = {}, context = {}, err = null) {
  log('error', event, data, context, err);
}

export function child(defaultFields) {
  // Return a logger that includes defaultFields in every log
}

export function getState() {
  return {
    config,
    stats: {
      totalLogs: 0,
      errorCount: 0,
      lastWriteTime: null,
    },
    initialized: config !== null,
  };
}

export async function shutdown() {
  // Flush pending writes, close file handle
}
```

### Usage Pattern (How Other Modules Will Use This)

```javascript
import * as logger from './modules/logger/index.js';

// In orchestrator/index.js
await logger.init(config);

// Create module-specific child logger
const log = logger.child({ module: 'position-manager' });

// Log events
log.info('position_opened', {
  window_id: 'window-123',
  expected: { price: 0.45 },
  actual: { price: 0.46 },
}, {
  strategy: 'spot-lag-v1',
});

log.warn('position_limit_approaching', {
  current: 8,
  max: 10,
});

log.error('order_failed', {
  order_id: 'order-456',
}, {}, new Error('API timeout'));

// Shutdown
await logger.shutdown();
```

### File Output Format

Each log file line is a complete JSON object:

```
{"timestamp":"2026-01-30T10:15:30.123Z","level":"info","module":"orchestrator","event":"startup_complete","data":{"modules_loaded":5}}
{"timestamp":"2026-01-30T10:15:31.456Z","level":"info","module":"position-manager","event":"position_opened","data":{"window_id":"w-1"},"context":{"strategy":"spot-lag"}}
```

### Project Structure Notes

**Files to Create:**
```
src/modules/logger/
├── index.js          # Public interface (init, info, warn, error, child, getState, shutdown)
├── formatter.js      # JSON formatting with snake_case
├── writer.js         # File output with daily rotation
├── redactor.js       # Credential sanitization
└── __tests__/
    ├── index.test.js     # Integration tests
    ├── formatter.test.js # Formatter unit tests
    └── redactor.test.js  # Redaction unit tests
```

**Ensure Directory Exists:**
```
logs/
└── .gitkeep          # Keep empty directory in git
```

### Previous Story Intelligence

**From Story 1.3 (Write-Ahead Logging):**
- All imports must use ESM syntax (`import`/`export`)
- Error classes extend PolyError with code, message, context
- Test files go in `__tests__/` folder within module
- vitest is the test framework (`npm test` to run)
- Follow the established error logging pattern (console.error before throw)

**From Story 1.2 (SQLite Database):**
- Module interface pattern: init(), getState(), shutdown()
- Async functions return Promises
- Configuration passed via init(config)

### Git Intelligence

**Recent commits relevant to this story:**
- `fd40e59` - "Add write-ahead logging module for crash recovery" - Established module pattern
- Previous stories established the folder-per-module structure

### Testing Requirements

**Test File:** `src/modules/logger/__tests__/index.test.js`

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('Logger Module', () => {
  describe('init', () => {
    it('initializes with default config');
    it('respects configured log level');
    it('creates logs directory if not exists');
  });

  describe('info/warn/error', () => {
    it('produces JSON with required fields');
    it('timestamp is valid ISO 8601');
    it('level field matches method called');
    it('includes optional data and context');
    it('error method includes error object details');
  });

  describe('log level filtering', () => {
    it('info level logs all levels');
    it('warn level filters out info');
    it('error level filters out info and warn');
  });

  describe('credential redaction', () => {
    it('redacts fields containing "key"');
    it('redacts fields containing "secret"');
    it('redacts nested sensitive fields');
    it('handles arrays with sensitive data');
  });

  describe('child logger', () => {
    it('includes default fields in all logs');
    it('merges with per-log fields');
    it('inherits parent configuration');
  });

  describe('file output', () => {
    it('writes newline-delimited JSON');
    it('uses daily rotation filename');
    it('appends to existing file');
  });

  describe('getState', () => {
    it('returns config and stats');
    it('tracks total logs written');
  });

  describe('shutdown', () => {
    it('flushes pending writes');
    it('closes file handle');
  });
});
```

### NFR Compliance

- **NFR9** (100% diagnostic coverage): Logger ensures every trade event can be logged with complete structure
- **NFR12** (credentials never logged): Automatic redaction of sensitive fields

### Error Handling

The logger should NEVER throw errors that crash the application. Log failures should:
1. Attempt to write to console as fallback
2. Track failure count in stats
3. Continue operation (fail-open for logging)

### References

- [Source: architecture.md#Structured-Log-Format] - JSON schema definition
- [Source: architecture.md#Module-Interface-Contract] - Module interface pattern
- [Source: architecture.md#Project-Structure] - File locations
- [Source: architecture.md#Naming-Patterns] - snake_case for log fields
- [Source: epics.md#Story-1.4] - Story requirements and acceptance criteria
- [Source: prd.md#FR20] - Structured JSON logs requirement
- [Source: prd.md#NFR9] - 100% diagnostic coverage requirement
- [Source: prd.md#NFR12] - Credentials never logged requirement
- [Source: 1-3-write-ahead-logging.md] - Previous story patterns and learnings

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

None - implementation proceeded without errors.

### Completion Notes List

- Implemented structured JSON logging module following architecture specification
- Logger produces JSON entries with required fields: timestamp, level, module, event
- Optional fields (data, context, error) included when provided
- Timestamps are ISO 8601 format with milliseconds (e.g., "2026-01-30T19:45:30.123Z")
- Log level filtering implemented: error > warn > info priority
- Credential redaction automatically detects and redacts sensitive fields (key, secret, password, token, credential, auth, private)
- Child logger pattern implemented for module-specific logging with inherited configuration
- File writer uses daily rotation (logs/poly-YYYY-MM-DD.log) with newline-delimited JSON
- Console output in development with color-coded log levels
- Module follows standard interface: init(), info(), warn(), error(), child(), getState(), shutdown()
- Graceful error handling - logger never crashes application on write failures
- 81 tests added covering all acceptance criteria

### Change Log

- 2026-01-30: Initial implementation of logger module (Story 1.4)
  - Created module structure with index.js, formatter.js, writer.js, redactor.js
  - Implemented all 8 acceptance criteria
  - Added comprehensive test suite (81 tests)
  - All tests passing, no regressions

### File List

**New Files:**
- src/modules/logger/index.js
- src/modules/logger/formatter.js
- src/modules/logger/writer.js
- src/modules/logger/redactor.js
- src/modules/logger/__tests__/index.test.js
- src/modules/logger/__tests__/formatter.test.js
- src/modules/logger/__tests__/redactor.test.js
- logs/.gitkeep

**Modified Files:**
- _bmad-output/implementation-artifacts/sprint-status.yaml
