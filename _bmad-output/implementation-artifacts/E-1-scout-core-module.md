# Story E.1: Scout Core Module & Terminal Renderer

Status: done

## Story

As a **trader**,
I want **a terminal-based monitor that shows real-time trading activity**,
So that **I can see what's happening and build trust in the system**.

## Acceptance Criteria

### AC1: EventEmitter Integration with Trade Event Module

**Given** the trade-event module records events
**When** `recordSignal()`, `recordEntry()`, `recordExit()`, or `recordAlert()` is called
**Then** an event is emitted via EventEmitter with the event data
**And** external subscribers (Scout) can listen for these events

### AC2: Scout Module Core Interface

**Given** Scout is initialized
**When** inspecting its interface
**Then** it exports: `init()`, `start()`, `stop()`, `getState()`, `shutdown()`
**And** follows the standard module pattern

### AC3: Terminal Renderer

**Given** Scout is running
**When** events are received
**Then** they are rendered to the terminal with ANSI formatting
**And** the display includes: status bar, event stream, review queue
**And** the output works in Claude Code terminal

### AC4: Event Translation (Scout's Voice)

**Given** a trade event is received
**When** Scout processes it
**Then** the technical data is translated to plain English
**And** the translation uses Scout's personality (friendly, ELI5, reassuring)
**And** issues are explained without panic

### AC5: Review Queue

**Given** an event has level='warn' or level='error'
**When** Scout processes it
**Then** the event is added to the review queue
**And** the queue is displayed in the terminal
**And** items include: timestamp, type, summary, window_id

### AC6: Status Bar

**Given** Scout is running
**When** the display updates
**Then** the status bar shows: active strategies, open positions, last update time
**And** shows review queue count if items exist

### AC7: CLI Integration

**Given** the CLI scout command exists
**When** user runs `node cli/scout.js start`
**Then** Scout initializes and begins displaying events
**And** Ctrl+C triggers graceful shutdown

## Tasks / Subtasks

- [x] **Task 1: Add EventEmitter to Trade Event Module** (AC: 1)
  - [x] 1.1 Create EventEmitter instance in trade-event/state.js
  - [x] 1.2 Export `subscribe()` and `subscribeAll()` functions from index.js
  - [x] 1.3 Emit events in recordSignal(), recordEntry(), recordExit(), recordAlert()
  - [x] 1.4 Add tests for event emission (11 tests)

- [x] **Task 2: Create Scout Module Structure** (AC: 2)
  - [x] 2.1 Create `src/modules/scout/` directory
  - [x] 2.2 Create `index.js` with standard module interface
  - [x] 2.3 Create `types.js` with Scout constants and error codes
  - [x] 2.4 Create `state.js` for internal state management

- [x] **Task 3: Implement Translator** (AC: 4)
  - [x] 3.1 Create `translator.js` with event-to-English functions
  - [x] 3.2 Implement signal translation
  - [x] 3.3 Implement entry translation with slippage/latency context
  - [x] 3.4 Implement exit translation with P&L context
  - [x] 3.5 Implement alert/divergence translation
  - [x] 3.6 Add Scout personality to all translations

- [x] **Task 4: Implement Terminal Renderer** (AC: 3, 5, 6)
  - [x] 4.1 Create `renderer.js` with ANSI-based terminal output
  - [x] 4.2 Implement status bar rendering
  - [x] 4.3 Implement event stream rendering
  - [x] 4.4 Implement review queue rendering
  - [x] 4.5 Handle terminal resize gracefully

- [x] **Task 5: Implement Review Queue** (AC: 5)
  - [x] 5.1 Create `review-queue.js` for queue management
  - [x] 5.2 Add items on warn/error events
  - [x] 5.3 Store queue in memory (persistence in Story E.3)
  - [x] 5.4 Expose queue via getState()

- [x] **Task 6: Create CLI Entry Point** (AC: 7)
  - [x] 6.1 Create `cli/scout.js` as standalone entry point
  - [x] 6.2 Handle command line arguments (--mode=local|railway)
  - [x] 6.3 Implement graceful shutdown on SIGINT/SIGTERM
  - [x] 6.4 Initialize required modules (logger, trade-event)

- [x] **Task 7: Write Tests** (AC: all)
  - [x] 7.1 Test EventEmitter integration with trade-event (11 tests)
  - [x] 7.2 Test translator produces expected output (20 tests)
  - [x] 7.3 Test review queue management (16 tests)
  - [x] 7.4 Test Scout module integration (17 tests)
  - [x] 7.5 Integration test: event flow from trade-event to Scout display

## Dev Notes

### Architecture Compliance

Scout is a new module that extends the monitoring capabilities from Epic 5. It follows the standard module interface and integrates with trade-event via EventEmitter.

**Module Structure:**
```
src/modules/scout/
├── index.js          # Public interface
├── types.js          # Constants, error codes
├── state.js          # Internal state management
├── translator.js     # Event-to-English translations
├── renderer.js       # Terminal UI rendering
├── review-queue.js   # Review queue management
└── __tests__/
    ├── translator.test.js
    ├── renderer.test.js
    └── review-queue.test.js
```

### Scout's Personality

Scout is friendly, helpful, and explains things simply:

- **On clean entry:** "In at 0.421. Expected 0.420. That's clean."
- **On high slippage:** "Filled at 0.445 but wanted 0.420. That's 6% slippage—queued for review."
- **On exit with profit:** "Closed for +8.1%. Entry to exit: 47 minutes. Nice."
- **On latency spike:** "That took 340ms. Usually we're under 100ms. Queued for review."
- **On silent operation:** "All quiet. Everything's working as expected."

### Terminal Output Format

```
┌─────────────────────────────────────────────────────────────────────┐
│ SCOUT                                              ▲ 3 need review  │
│ Watching 2 strategies · 1 open position · Last check: 2s ago       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ 14:32:01  ✓ Signal fired on BTC-UP (prob: 0.72)                    │
│           Scout: "Entry conditions met. Submitting order..."       │
│                                                                     │
│ 14:32:02  ✓ Filled @ 0.421 (expected 0.420, slippage: 0.2%)        │
│           Scout: "Position open. This looks clean."                │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│ REVIEW QUEUE (oldest first)                                         │
│ [1] 15:02:17 · Latency spike · window_abc123                        │
└─────────────────────────────────────────────────────────────────────┘
```

### EventEmitter Pattern

```javascript
// In trade-event/state.js
import { EventEmitter } from 'events';
export const eventEmitter = new EventEmitter();

// In trade-event/index.js
export function subscribe(eventType, callback) {
  eventEmitter.on(eventType, callback);
  return () => eventEmitter.off(eventType, callback);
}

// When recording events
eventEmitter.emit('entry', { ...eventData, translation: null });
```

### References

- [Source: architecture.md#Module-Interface-Contract] - Standard module interface
- [Source: ENHANCEMENTS.md#Monitoring-Philosophy] - "Silence = Trust" philosophy
- [Source: src/modules/trade-event/index.js] - Trade event module to extend

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Completion Notes List

- Added EventEmitter to trade-event module for real-time event subscriptions
- Created Scout module with standard interface (init, start, stop, getState, shutdown)
- Implemented translator with Scout's friendly ELI5 personality
- Implemented ANSI-based terminal renderer that works in Claude Code
- Implemented review queue for items needing attention (warn/error level events)
- Created CLI entry point at cli/scout.js with graceful shutdown handling
- All 88 new tests pass (11 event-emitter + 20 translator + 16 review-queue + 17 index + 24 renderer)
- Total test count: 1640 (all passing)

**Post-Review Fixes:**
- Fixed renderer resize handler leak (stored reference for cleanup in reset())
- Added renderer.test.js with 24 tests for utility functions
- Exported formatTime, getIcon, stripAnsi for testability

### File List

**New files:**
- src/modules/scout/index.js - Public interface
- src/modules/scout/types.js - Constants and error codes
- src/modules/scout/state.js - Internal state management
- src/modules/scout/translator.js - Event-to-English translations
- src/modules/scout/renderer.js - Terminal UI rendering
- src/modules/scout/review-queue.js - Review queue management
- src/modules/scout/__tests__/translator.test.js - 20 tests
- src/modules/scout/__tests__/review-queue.test.js - 16 tests
- src/modules/scout/__tests__/index.test.js - 17 tests
- src/modules/scout/__tests__/renderer.test.js - 24 tests
- src/modules/trade-event/__tests__/event-emitter.test.js - 11 tests
- cli/scout.js - CLI entry point
- _bmad-output/planning-artifacts/epic-extra-scout.md - Epic definition
- _bmad-output/implementation-artifacts/E-1-scout-core-module.md - Story file

**Modified files:**
- src/modules/trade-event/state.js - Added EventEmitter and subscribe functions
- src/modules/trade-event/index.js - Added event emission and exports
- _bmad-output/implementation-artifacts/sprint-status.yaml - Added Scout epic

## Change Log

- 2026-01-31: Created story E-1-scout-core-module
- 2026-01-31: Post-review fixes - added renderer.test.js, fixed resize handler leak
