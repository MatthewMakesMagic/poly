# Story 6.2: Strategy Composition

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **strategies composed from reusable components**,
So that **I can mix and match logic without rewriting (FR30)**.

## Acceptance Criteria

### AC1: Create Strategy from Components

**Given** components exist in the registry
**When** creating a new strategy using `createStrategy()`
**Then** I specify which component version IDs to use
**And** strategy is instantiated with those components
**And** strategy is persisted to strategy_instances table

### AC2: Strategy Execution Flow

**Given** a strategy is composed
**When** it executes via `executeStrategy(strategyId, context)`
**Then** it calls the specified component versions in order: probability → entry → sizing → exit
**And** each component receives the results from previous components
**And** the execution flow produces a structured trade decision

### AC3: Component Reuse Across Strategies

**Given** components are reusable
**When** two strategies share a component (same version ID)
**Then** they reference the same component version
**And** component logic executes identically for both strategies
**And** the shared component is loaded once from the catalog

### AC4: Component Result Pipeline

**Given** strategy execution begins
**When** components are executed in sequence
**Then** probability component outputs probability estimate
**And** entry component receives probability and outputs entry decision
**And** sizing component receives entry decision and outputs position size
**And** exit component receives sizing and outputs exit conditions
**And** final result aggregates all component outputs

### AC5: Strategy Configuration Passing

**Given** a strategy has a config JSON
**When** components execute
**Then** each component receives the full strategy config
**And** components extract their relevant configuration sections
**And** components validate their configuration via `validateConfig()`

### AC6: Error Handling in Composition

**Given** strategy execution is in progress
**When** any component fails (throws error or returns invalid result)
**Then** execution halts with a structured error
**And** error includes: failed component, error details, partial results
**And** error is logged with full execution context

### AC7: Composer Module Interface

**Given** the composer follows project conventions
**When** inspecting its interface
**Then** it exports: `createStrategy()`, `executeStrategy()`, `validateStrategy()`
**And** integrates with registry via `getComponent()` and `getStrategy()`
**And** follows existing module patterns from registry.js and logic.js

## Tasks / Subtasks

- [x] **Task 1: Create Composer Logic File** (AC: 7)
  - [x] 1.1 Create `src/modules/strategy/composer.js` with core composition functions
  - [x] 1.2 Export `createStrategy(name, components, config)` function
  - [x] 1.3 Export `executeStrategy(strategyId, context)` function
  - [x] 1.4 Export `validateStrategy(strategyId)` function
  - [x] 1.5 Add proper JSDoc documentation following project patterns

- [x] **Task 2: Implement createStrategy Function** (AC: 1, 3, 5)
  - [x] 2.1 Validate all component version IDs exist in catalog
  - [x] 2.2 Validate component types match expected slots (probability, entry, exit, sizing)
  - [x] 2.3 Validate strategy config against each component's validateConfig()
  - [x] 2.4 Delegate to registry.registerStrategy() for persistence
  - [x] 2.5 Return the new strategy ID

- [x] **Task 3: Implement Component Execution Pipeline** (AC: 2, 4)
  - [x] 3.1 Create `executeComponent(component, context, config, prevResults)` helper
  - [x] 3.2 Implement probability component execution returning `{ probability, confidence, reasoning }`
  - [x] 3.3 Implement entry component execution returning `{ shouldEnter, direction, signal }`
  - [x] 3.4 Implement sizing component execution returning `{ size, adjustedSize, reason }`
  - [x] 3.5 Implement exit component execution returning `{ stopLoss, takeProfit, expiry }`
  - [x] 3.6 Aggregate results into final trade decision structure

- [x] **Task 4: Implement executeStrategy Function** (AC: 2, 4, 5, 6)
  - [x] 4.1 Load strategy by ID from registry
  - [x] 4.2 Load all four component modules from catalog
  - [x] 4.3 Execute components in order: probability → entry → sizing → exit
  - [x] 4.4 Pass previous component results to next component
  - [x] 4.5 Pass strategy config to each component
  - [x] 4.6 Handle component errors with structured error responses
  - [x] 4.7 Return aggregated execution result

- [x] **Task 5: Implement validateStrategy Function** (AC: 6)
  - [x] 5.1 Validate strategy exists and is active
  - [x] 5.2 Validate all component version IDs exist in catalog
  - [x] 5.3 Validate component interfaces are correct
  - [x] 5.4 Validate strategy config passes each component's validateConfig()
  - [x] 5.5 Return validation result with details

- [x] **Task 6: Update Module Index** (AC: 7)
  - [x] 6.1 Import composer functions in `src/modules/strategy/index.js`
  - [x] 6.2 Export `createStrategy`, `executeStrategy`, `validateStrategy` from index
  - [x] 6.3 Add logging for composition operations
  - [x] 6.4 Ensure consistent error handling with StrategyError

- [x] **Task 7: Write Comprehensive Tests** (AC: all)
  - [x] 7.1 Test createStrategy with valid components
  - [x] 7.2 Test createStrategy rejects invalid component IDs
  - [x] 7.3 Test executeStrategy runs all components in order
  - [x] 7.4 Test component result pipeline passes data correctly
  - [x] 7.5 Test shared component reuse across strategies
  - [x] 7.6 Test error handling when component fails
  - [x] 7.7 Test validateStrategy catches missing components
  - [x] 7.8 Integration test: full strategy creation and execution flow

## Dev Notes

### Architecture Compliance

This is **Story 6.2 in Epic 6** (Strategy Composition) implementing FR30: "Strategies can be composed from reusable components."

**CRITICAL: This story BUILDS ON Story 6.1** which already implemented:
- Component registry with version IDs
- Strategy registration in strategy_instances table
- Component discovery and catalog
- `registerStrategy()`, `getStrategy()`, `getComponent()` functions

**This story ADDS:**
- `composer.js` file with composition/execution logic
- `createStrategy()` - wrapper that validates then registers
- `executeStrategy()` - runs the component pipeline
- `validateStrategy()` - validates strategy before execution

### File to Create

**Create:** `src/modules/strategy/composer.js`

This file implements the strategy composition and execution logic. It uses the registry functions from `logic.js` for persistence and catalog access.

### Component Execution Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Probability │ ──► │   Entry     │ ──► │   Sizing    │ ──► │    Exit     │
│  Component  │     │  Component  │     │  Component  │     │  Component  │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
      │                   │                   │                   │
      ▼                   ▼                   ▼                   ▼
 { probability,     { shouldEnter,     { size,           { stopLoss,
   confidence,        direction,         adjustedSize,     takeProfit,
   reasoning }        signal }           reason }          expiry }
```

Each component:
1. Receives `context` (market data, position state)
2. Receives `config` (strategy configuration)
3. Receives `prevResults` (outputs from previous components)
4. Returns structured result for next component

### Component Interface Contract (from Story 6.1)

```javascript
// Each component exports:
export const metadata = {
  name: 'component-name',
  version: 1,
  type: 'probability|entry|exit|sizing',
  description: '...',
};

export function evaluate(context, config) {
  // Returns component-specific result object
}

export function validateConfig(config) {
  return { valid: true, errors: [] };
}
```

### Expected Result Structures

**Probability Component Output:**
```javascript
{
  probability: 0.65,        // 0.0 - 1.0
  confidence: 0.8,          // 0.0 - 1.0
  reasoning: 'spot lag detected',
  metadata: { ... }         // component-specific
}
```

**Entry Component Output:**
```javascript
{
  shouldEnter: true,
  direction: 'long',        // 'long' | 'short' | null
  signal: {
    strength: 0.7,
    trigger: 'threshold_crossed',
    expectedPrice: 0.42
  }
}
```

**Sizing Component Output:**
```javascript
{
  size: 100,                // requested size
  adjustedSize: 85,         // after liquidity/limits
  reason: 'reduced_for_liquidity',
  riskMetrics: { ... }
}
```

**Exit Component Output:**
```javascript
{
  stopLoss: {
    price: 0.38,
    percentage: 0.05
  },
  takeProfit: {
    price: 0.55,
    percentage: 0.15
  },
  expiry: {
    windowEnd: '2026-01-31T10:15:00Z',
    minutesRemaining: 12
  }
}
```

### Execution Result Structure

```javascript
{
  strategyId: 'strat-xxx',
  executedAt: '2026-01-31T10:03:00Z',
  decision: {
    action: 'enter' | 'hold' | 'exit' | 'no_action',
    direction: 'long' | 'short' | null,
    size: 85,
    stopLoss: 0.38,
    takeProfit: 0.55
  },
  components: {
    probability: { ... },
    entry: { ... },
    sizing: { ... },
    exit: { ... }
  },
  context: {
    windowId: 'btc-15m-xxx',
    spotPrice: 42500,
    marketPrice: 0.42
  }
}
```

### Integration with Registry (from Story 6.1)

```javascript
// Use these from logic.js:
import { getStrategy, getComponent, registerStrategy } from './logic.js';
import { getCatalog } from './state.js';

// In createStrategy:
// 1. Validate components exist in catalog
// 2. Call registerStrategy() for persistence
// 3. Return strategy ID

// In executeStrategy:
// 1. Call getStrategy(strategyId) to load strategy
// 2. Call getComponent(versionId) for each component
// 3. Execute component.module.evaluate() for each
```

### Error Codes to Add

Add to `types.js`:
```javascript
export const StrategyErrorCodes = {
  // ... existing codes from Story 6.1 ...
  COMPONENT_EXECUTION_FAILED: 'COMPONENT_EXECUTION_FAILED',
  INVALID_COMPONENT_OUTPUT: 'INVALID_COMPONENT_OUTPUT',
  STRATEGY_VALIDATION_FAILED: 'STRATEGY_VALIDATION_FAILED',
  CONFIG_VALIDATION_FAILED: 'CONFIG_VALIDATION_FAILED',
};
```

### Existing Code Patterns to Follow

From `src/modules/strategy/logic.js` (Story 6.1):
- Function documentation style with JSDoc
- Error handling with StrategyError
- Use `getComponent()` for catalog access
- Use `getStrategy()` for database access

From `src/modules/strategy/index.js`:
- Export wrapper functions that add logging
- Use `ensureInitialized()` check
- Log operations with child logger

### Testing Approach

```javascript
// src/modules/strategy/__tests__/composer.test.js

describe('Strategy Composer (Story 6.2)', () => {
  describe('AC1: Create Strategy from Components', () => {
    it('should create strategy with valid components', async () => {
      const strategyId = await createStrategy('Test Strategy', {
        probability: 'prob-template-v1',
        entry: 'entry-template-v1',
        exit: 'exit-template-v1',
        sizing: 'sizing-template-v1',
      }, { threshold: 0.5 });

      expect(strategyId).toMatch(/^strat-/);
    });

    it('should reject strategy with missing component', async () => {
      await expect(createStrategy('Test', {
        probability: 'prob-nonexistent-v1',
        entry: 'entry-template-v1',
        exit: 'exit-template-v1',
        sizing: 'sizing-template-v1',
      }, {})).rejects.toThrow('COMPONENT_NOT_FOUND');
    });
  });

  describe('AC2: Strategy Execution Flow', () => {
    it('should execute components in correct order', async () => {
      const result = await executeStrategy(testStrategyId, mockContext);

      expect(result.components.probability).toBeDefined();
      expect(result.components.entry).toBeDefined();
      expect(result.components.sizing).toBeDefined();
      expect(result.components.exit).toBeDefined();
    });
  });

  describe('AC4: Component Result Pipeline', () => {
    it('should pass previous results to next component', async () => {
      // Create mock components that verify they receive prev results
      const result = await executeStrategy(testStrategyId, mockContext);

      // Entry component should have received probability output
      expect(result.components.entry.receivedProbability).toBe(true);
    });
  });
});
```

### NFR Compliance

- **NFR9:** All composition operations produce structured logs
- **FR30:** Strategies composed from reusable components
- **FR35:** Strategy parameters configurable via config JSON

### Cross-Story Dependencies

**Prerequisites (Story 6.1 - COMPLETE):**
- Component registry with version IDs ✓
- Strategy registration in database ✓
- Component discovery and catalog ✓
- Template components in each type directory ✓

**This Story Enables:**
- **Story 6.3 (Strategy Forking):** Uses composer to create forked strategies
- **Story 6.4 (Central Component Updates):** Uses composer to test updated components
- **Story 6.5 (Strategy Configuration):** Uses composer's config validation

### Critical Implementation Notes

1. **Build on Story 6.1** - Use existing registry functions, don't duplicate
2. **Component loading** - Components already in catalog from discovery
3. **Config validation** - Call each component's validateConfig() before registration
4. **Structured results** - Each component returns typed result object
5. **Error context** - Include which component failed and partial results
6. **Logging** - Log each component execution with input/output summary

### References

- [Source: architecture.md#Module-Architecture] - Folder-per-module pattern
- [Source: architecture.md#Database-Schema] - strategy_instances table
- [Source: epics.md#Story-6.2] - Story requirements and acceptance criteria
- [Source: prd.md#FR30] - Compose strategies from reusable components
- [Source: 6-1-strategy-component-registry.md] - Previous story implementation
- [Source: src/modules/strategy/logic.js] - Registry functions to use
- [Source: src/modules/strategy/types.js] - Error codes and types
- [Source: src/modules/strategy/components/_template.js] - Component interface

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - No debug issues encountered

### Completion Notes List

- Implemented `composer.js` with three main functions: `createStrategy()`, `executeStrategy()`, and `validateStrategy()`
- createStrategy validates components exist in catalog, validates types match expected slots, validates config against each component's validateConfig(), and delegates to registerStrategy() for persistence
- executeStrategy loads strategy from DB, loads components from catalog, executes in order (probability → entry → sizing → exit), passes prevResults through pipeline, and aggregates results into trade decision
- validateStrategy checks strategy exists/active, components in catalog, interface validity, and config validation
- Added 4 new error codes to types.js: COMPONENT_EXECUTION_FAILED, INVALID_COMPONENT_OUTPUT, STRATEGY_VALIDATION_FAILED, CONFIG_VALIDATION_FAILED
- Updated index.js with wrapper functions that add logging for all composition operations
- Created comprehensive test suite (32 tests) covering all 7 acceptance criteria
- All 1447 project tests pass with no regressions

### Change Log

- 2026-01-31: Implemented Story 6.2 Strategy Composition (Claude Opus 4.5)

### File List

**New Files:**
- src/modules/strategy/composer.js (core composition logic)
- src/modules/strategy/__tests__/composer.test.js (32 tests)

**Modified Files:**
- src/modules/strategy/types.js (added 4 error codes)
- src/modules/strategy/index.js (added composer exports with logging)
