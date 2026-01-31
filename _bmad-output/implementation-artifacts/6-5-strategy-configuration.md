# Story 6.5: Strategy Configuration

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **strategy parameters configurable without code changes**,
So that **I can tune strategies through config files (FR35)**.

## Acceptance Criteria

### AC1: Strategy Config Storage

**Given** a strategy instance
**When** it has configurable parameters
**Then** parameters are stored in the `config` JSON field of `strategy_instances`
**And** config includes: thresholds, percentages, timing values, and any component-specific settings

### AC2: Config-Only Update (No Component Change)

**Given** an existing strategy
**When** calling `updateStrategyConfig(strategyId, newConfig)`
**Then** the strategy's config JSON field is updated
**And** new config is validated against all component's `validateConfig()` functions
**And** no component versions are changed
**And** the strategy remains active

### AC3: Config Deep Merge with Defaults

**Given** a partial config update
**When** calling `updateStrategyConfig(strategyId, partialConfig, { merge: true })`
**Then** the partial config is deep-merged with existing config
**And** only the provided keys are updated
**And** unspecified keys retain their original values

### AC4: Config Replace Mode

**Given** a complete config replacement is needed
**When** calling `updateStrategyConfig(strategyId, newConfig, { merge: false })`
**Then** the entire config is replaced with newConfig
**And** validation still runs against all components
**And** this allows removing config keys that are no longer needed

### AC5: Config Validation at Startup

**Given** the system is starting up
**When** a strategy is loaded for execution
**Then** its config is validated against all component's `validateConfig()` functions
**And** invalid configs prevent strategy execution (fail-fast)
**And** validation errors are logged with details

### AC6: Config Hot-Reload

**Given** config changes are needed during runtime
**When** `updateStrategyConfig()` is called
**Then** changes take effect on the next execution cycle
**And** no restart is required
**And** the update is logged with old and new config summary

### AC7: Config Diff Preview

**Given** considering a config change
**When** calling `previewConfigUpdate(strategyId, newConfig)`
**Then** a preview is returned without making changes
**And** preview includes: validation result, diff of changed keys, affected thresholds
**And** enables review before committing config changes

### AC8: Config Validation Error Details

**Given** config validation fails
**When** attempting to update config
**Then** detailed validation errors are returned
**And** errors include which component failed and why
**And** the config update is rejected (not partially applied)

## Tasks / Subtasks

- [x] **Task 1: Add Config Update Error Codes** (AC: 8)
  - [x] 1.1 Add `CONFIG_UPDATE_FAILED` to StrategyErrorCodes in `types.js`
  - [x] 1.2 Add `CONFIG_MERGE_FAILED` to StrategyErrorCodes

- [x] **Task 2: Implement updateStrategyConfig Function** (AC: 2, 3, 4, 6, 8)
  - [x] 2.1 Create `updateStrategyConfig(strategyId, newConfig, options)` in `logic.js`
  - [x] 2.2 Load strategy and validate it exists
  - [x] 2.3 If `options.merge === true` (default), deep merge with existing config
  - [x] 2.4 If `options.merge === false`, replace entire config
  - [x] 2.5 Load all component modules from catalog
  - [x] 2.6 Validate merged/new config against all component's `validateConfig()`
  - [x] 2.7 If validation fails, throw with detailed errors
  - [x] 2.8 Update database: `UPDATE strategy_instances SET config = ? WHERE id = ?`
  - [x] 2.9 Return updated strategy with new config

- [x] **Task 3: Implement previewConfigUpdate Function** (AC: 7)
  - [x] 3.1 Create `previewConfigUpdate(strategyId, newConfig, options)` in `logic.js`
  - [x] 3.2 Load strategy and current config
  - [x] 3.3 Build proposed config (merged or replaced based on options)
  - [x] 3.4 Load all components and validate proposed config
  - [x] 3.5 Build config diff showing changed keys
  - [x] 3.6 Return preview without persisting: `{ canUpdate, currentConfig, proposedConfig, diff, validationResult }`

- [x] **Task 4: Implement validateStrategyConfig Function** (AC: 5, 8)
  - [x] 4.1 Create `validateStrategyConfig(strategyId)` in `logic.js`
  - [x] 4.2 Load strategy and its config
  - [x] 4.3 Load all component modules from catalog
  - [x] 4.4 Run `validateConfig()` on each component
  - [x] 4.5 Return validation result: `{ valid, errors, componentResults }`

- [x] **Task 5: Implement getStrategyConfig Function** (AC: 1)
  - [x] 5.1 Create `getStrategyConfig(strategyId)` in `logic.js`
  - [x] 5.2 Load strategy and return just the config JSON
  - [x] 5.3 Return null if strategy not found

- [x] **Task 6: Update Module Index** (AC: all)
  - [x] 6.1 Import new functions in `index.js`
  - [x] 6.2 Export `updateStrategyConfig` with logging wrapper
  - [x] 6.3 Export `previewConfigUpdate` with logging wrapper
  - [x] 6.4 Export `validateStrategyConfig` with logging wrapper
  - [x] 6.5 Export `getStrategyConfig` with logging wrapper

- [x] **Task 7: Write Comprehensive Tests** (AC: all)
  - [x] 7.1 Test updateStrategyConfig with merge mode (default)
  - [x] 7.2 Test updateStrategyConfig with replace mode
  - [x] 7.3 Test updateStrategyConfig validates against all components
  - [x] 7.4 Test updateStrategyConfig rejects invalid config
  - [x] 7.5 Test previewConfigUpdate returns correct diff
  - [x] 7.6 Test previewConfigUpdate doesn't persist changes
  - [x] 7.7 Test validateStrategyConfig detects invalid configs
  - [x] 7.8 Test getStrategyConfig returns correct config
  - [x] 7.9 Test config deep merge preserves unspecified keys
  - [x] 7.10 Test config replace removes old keys
  - [x] 7.11 Integration test: create strategy → update config → validate → execute

## Dev Notes

### Architecture Compliance

This is **Story 6.5 in Epic 6** (Strategy Composition) implementing FR35: "User can configure strategy parameters without code changes."

**CRITICAL: This story BUILDS ON Stories 6.1, 6.2, 6.3, and 6.4** which already implemented:
- Story 6.1: Component registry, version IDs, `registerStrategy()`, `getStrategy()`, catalog management
- Story 6.2: Strategy composition, `createStrategy()`, `executeStrategy()`, `validateStrategy()`, `deepMerge()`
- Story 6.3: Strategy forking, config inheritance and deep merging
- Story 6.4: Component updates, `getStrategiesUsingComponent()`, `updateStrategyComponent()`, upgrade patterns

**This story ADDS:**
- `updateStrategyConfig()` - update strategy config without changing components
- `previewConfigUpdate()` - dry-run preview of config changes
- `validateStrategyConfig()` - validate strategy config against all components
- `getStrategyConfig()` - retrieve strategy config JSON

### File Modifications

**Modify:** `src/modules/strategy/types.js`
- Add 2 new error codes for config update errors

**Modify:** `src/modules/strategy/logic.js`
- Add `updateStrategyConfig()` function
- Add `previewConfigUpdate()` function
- Add `validateStrategyConfig()` function
- Add `getStrategyConfig()` function

**Modify:** `src/modules/strategy/index.js`
- Export new functions with logging wrappers

**Create:** `src/modules/strategy/__tests__/config-updates.test.js`
- Comprehensive test suite for config update functionality

### updateStrategyConfig Function Signature

```javascript
/**
 * Update a strategy's configuration
 *
 * @param {string} strategyId - Strategy ID to update
 * @param {Object} newConfig - New configuration values
 * @param {Object} [options={}] - Update options
 * @param {boolean} [options.merge=true] - Deep merge with existing (true) or replace (false)
 * @returns {Object} Updated strategy with new config
 * @throws {StrategyError} If strategy not found or config validation fails
 */
export function updateStrategyConfig(strategyId, newConfig, options = {}) {
  // 1. Load strategy
  // 2. Build proposed config (merge or replace)
  // 3. Load all components from catalog
  // 4. Validate proposed config against all components
  // 5. Update database
  // 6. Return updated strategy
}
```

### previewConfigUpdate Function Signature

```javascript
/**
 * Preview a config update without making changes
 *
 * @param {string} strategyId - Strategy ID
 * @param {Object} newConfig - Proposed new configuration
 * @param {Object} [options={}] - Preview options
 * @param {boolean} [options.merge=true] - Deep merge with existing (true) or replace (false)
 * @returns {Object} Preview result { canUpdate, currentConfig, proposedConfig, diff, validationResult }
 */
export function previewConfigUpdate(strategyId, newConfig, options = {}) {
  // 1. Load strategy and current config
  // 2. Build proposed config (merge or replace)
  // 3. Load all components and validate
  // 4. Build config diff
  // 5. Return preview without persisting
}
```

### validateStrategyConfig Function Signature

```javascript
/**
 * Validate a strategy's current configuration against its components
 *
 * @param {string} strategyId - Strategy ID to validate
 * @returns {Object} Validation result { valid, errors, componentResults }
 */
export function validateStrategyConfig(strategyId) {
  // 1. Load strategy and config
  // 2. Load all component modules
  // 3. Run validateConfig() on each
  // 4. Return aggregated result
}
```

### getStrategyConfig Function Signature

```javascript
/**
 * Get a strategy's configuration JSON
 *
 * @param {string} strategyId - Strategy ID
 * @returns {Object|null} Strategy config or null if not found
 */
export function getStrategyConfig(strategyId) {
  // 1. Load strategy
  // 2. Return config or null
}
```

### Database Queries

**Update strategy config:**
```sql
UPDATE strategy_instances SET config = ? WHERE id = ?;
```

### Config Diff Structure

```javascript
{
  canUpdate: true,
  currentConfig: { threshold: 0.5, stopLoss: 0.05, ... },
  proposedConfig: { threshold: 0.6, stopLoss: 0.05, ... },
  diff: {
    changed: { threshold: { from: 0.5, to: 0.6 } },
    added: {},
    removed: {},
  },
  validationResult: {
    valid: true,
    componentResults: {
      probability: { valid: true },
      entry: { valid: true },
      exit: { valid: true },
      sizing: { valid: true },
    },
  },
}
```

### Existing Code Patterns to Follow

From `src/modules/strategy/logic.js` (Stories 6.1-6.4):
- Database queries use `get()`, `all()`, `run()` from persistence
- Functions include JSDoc with param and return types
- Errors wrapped in `StrategyError` with context
- `getStrategy()` retrieves full strategy including config

From `src/modules/strategy/composer.js` (Stories 6.2-6.3):
- `deepMerge()` already exists for config merging
- `validateStrategy()` pattern for validating against components
- Component loading and validateConfig() calling pattern

From `src/modules/strategy/index.js`:
- Export wrapper functions that add logging
- Use `ensureInitialized()` check
- Log operations with child logger

### Deep Merge Behavior

The existing `deepMerge()` function in `composer.js` provides:
- Objects are recursively merged
- Arrays are replaced (not merged)
- Primitive values from second object override first
- Keys not in second object are preserved from first

Example:
```javascript
const base = {
  threshold: 0.5,
  stopLoss: { percent: 0.05, enabled: true },
  targets: [0.1, 0.2]
};
const override = {
  threshold: 0.6,
  stopLoss: { percent: 0.03 }
};
const result = deepMerge(base, override);
// Result: {
//   threshold: 0.6,
//   stopLoss: { percent: 0.03, enabled: true },
//   targets: [0.1, 0.2]
// }
```

### Error Codes to Add

Add to `types.js`:
```javascript
export const StrategyErrorCodes = {
  // ... existing codes ...
  // Story 6.5: Strategy Configuration error codes
  CONFIG_UPDATE_FAILED: 'CONFIG_UPDATE_FAILED',
  CONFIG_MERGE_FAILED: 'CONFIG_MERGE_FAILED',
};
```

### Testing Approach

```javascript
// src/modules/strategy/__tests__/config-updates.test.js

describe('Strategy Configuration (Story 6.5)', () => {
  let testStrategyId;
  const initialConfig = {
    threshold: 0.5,
    stopLoss: { percent: 0.05, enabled: true },
    takeProfit: { percent: 0.1, enabled: true },
  };

  beforeAll(async () => {
    // Create test strategy with initial config
    testStrategyId = createStrategy('Config Test Strategy', {
      probability: 'prob-template-v1',
      entry: 'entry-template-v1',
      exit: 'exit-template-v1',
      sizing: 'sizing-template-v1',
    }, initialConfig);
  });

  describe('AC1: Config Storage', () => {
    it('should store config in strategy_instances table', () => {
      const config = getStrategyConfig(testStrategyId);

      expect(config).toEqual(initialConfig);
    });
  });

  describe('AC2: Config-Only Update', () => {
    it('should update config without changing components', () => {
      const strategyBefore = getStrategyById(testStrategyId);

      updateStrategyConfig(testStrategyId, { threshold: 0.6 });

      const strategyAfter = getStrategyById(testStrategyId);
      expect(strategyAfter.config.threshold).toBe(0.6);
      expect(strategyAfter.components).toEqual(strategyBefore.components);
    });
  });

  describe('AC3: Config Deep Merge', () => {
    it('should deep merge partial config updates', () => {
      updateStrategyConfig(testStrategyId, {
        stopLoss: { percent: 0.03 }
      }, { merge: true });

      const config = getStrategyConfig(testStrategyId);
      expect(config.stopLoss.percent).toBe(0.03);
      expect(config.stopLoss.enabled).toBe(true); // Preserved
      expect(config.takeProfit).toBeDefined(); // Preserved
    });
  });

  describe('AC4: Config Replace Mode', () => {
    it('should replace entire config when merge=false', () => {
      const newConfig = { threshold: 0.7 };

      updateStrategyConfig(testStrategyId, newConfig, { merge: false });

      const config = getStrategyConfig(testStrategyId);
      expect(config).toEqual(newConfig);
      expect(config.stopLoss).toBeUndefined(); // Removed
    });
  });

  describe('AC5: Config Validation at Load', () => {
    it('should validate config against all components', () => {
      const result = validateStrategyConfig(testStrategyId);

      expect(result.valid).toBe(true);
      expect(result.componentResults.probability.valid).toBe(true);
      expect(result.componentResults.entry.valid).toBe(true);
      expect(result.componentResults.exit.valid).toBe(true);
      expect(result.componentResults.sizing.valid).toBe(true);
    });
  });

  describe('AC7: Config Diff Preview', () => {
    it('should return preview without making changes', () => {
      const preview = previewConfigUpdate(testStrategyId, { threshold: 0.8 });

      expect(preview.canUpdate).toBe(true);
      expect(preview.diff.changed.threshold).toBeDefined();
      expect(preview.diff.changed.threshold.to).toBe(0.8);

      // Verify no change was made
      const config = getStrategyConfig(testStrategyId);
      expect(config.threshold).not.toBe(0.8);
    });
  });

  describe('AC8: Config Validation Errors', () => {
    it('should reject invalid config with detailed errors', () => {
      // Assuming component requires threshold between 0 and 1
      expect(() => updateStrategyConfig(
        testStrategyId,
        { threshold: 2.0 } // Invalid
      )).toThrow('CONFIG_UPDATE_FAILED');
    });

    it('should include which component failed', () => {
      try {
        updateStrategyConfig(testStrategyId, { threshold: 2.0 });
      } catch (err) {
        expect(err.context.componentType).toBeDefined();
        expect(err.context.errors).toBeDefined();
      }
    });
  });
});
```

### NFR Compliance

- **FR35:** User can configure strategy parameters without code changes
- **NFR9:** All config updates produce structured logs
- **NFR1:** Config updates take effect immediately without restart

### Cross-Story Dependencies

**Prerequisites (COMPLETE):**
- **Story 6.1:** Component registry, `getStrategy()` ✓
- **Story 6.2:** Strategy composition, `deepMerge()`, config validation pattern ✓
- **Story 6.3:** Config inheritance in forking ✓
- **Story 6.4:** Component update patterns ✓

**This Story Enables:**
- Runtime strategy tuning without code deployment
- Hot-reload of strategy parameters
- Config versioning and rollback (future enhancement)

### Critical Implementation Notes

1. **Validation before persistence** - Always validate config before database update
2. **Atomic updates** - Config update should be all-or-nothing (no partial apply)
3. **Deep merge by default** - Most updates are partial, so merge is default behavior
4. **Logging changes** - Log both old and new config for audit trail
5. **Component loading** - Must load actual component modules for validateConfig()
6. **Hot reload** - Changes affect next execution cycle, not currently running

### Project Structure Notes

**Alignment with Architecture:**
- All changes in `src/modules/strategy/` directory
- Follows existing module patterns from Stories 6.1-6.4
- Tests co-located in `__tests__` folder

**Files to Modify:**
```
src/modules/strategy/
├── types.js           # Add 2 error codes
├── logic.js           # Add updateStrategyConfig, previewConfigUpdate, validateStrategyConfig, getStrategyConfig
├── index.js           # Export new functions with logging
└── __tests__/
    └── config-updates.test.js  # NEW: Comprehensive config tests
```

### Component validateConfig Pattern

Components export a `validateConfig()` function that returns validation results:

```javascript
// Component's validateConfig function
export function validateConfig(config) {
  const errors = [];

  if (config.threshold !== undefined) {
    if (typeof config.threshold !== 'number' || config.threshold < 0 || config.threshold > 1) {
      errors.push('threshold must be a number between 0 and 1');
    }
  }

  // More validation...

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}
```

The config update function must call this on ALL components (not just one) to ensure the full strategy config is valid.

### References

- [Source: architecture.md#Database-Schema] - strategy_instances table with config column
- [Source: architecture.md#Configuration-Pattern] - Config loaded at startup
- [Source: epics.md#Story-6.5] - Story requirements and acceptance criteria
- [Source: prd.md#FR35] - User can configure strategy parameters without code changes
- [Source: 6-1-strategy-component-registry.md] - Registry implementation details
- [Source: 6-2-strategy-composition.md] - deepMerge and validation patterns
- [Source: 6-3-strategy-forking.md] - Config inheritance pattern
- [Source: 6-4-central-component-updates.md] - Update patterns
- [Source: src/modules/strategy/composer.js] - deepMerge function
- [Source: src/modules/strategy/logic.js] - getStrategy, database patterns
- [Source: src/modules/strategy/types.js] - Existing error codes
- [Source: src/modules/strategy/index.js] - Export patterns with logging

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - No debug issues encountered during implementation.

### Completion Notes List

- Implemented 4 new functions: `getStrategyConfig()`, `validateStrategyConfig()`, `previewConfigUpdate()`, `updateStrategyConfig()` in logic.js
- Added 2 new error codes: `CONFIG_UPDATE_FAILED`, `CONFIG_MERGE_FAILED` in types.js
- Reused existing `deepMerge()` function from composer.js for config merging
- All functions exported with logging wrappers in index.js following existing module patterns
- Comprehensive test suite with 41 tests covering all acceptance criteria
- All 184 tests pass in the strategy module (no regressions)
- Implementation follows red-green-refactor: tests written first, then implementation validated

### Change Log

- 2026-01-31: Implemented Story 6.5 - Strategy Configuration (all ACs complete)

### File List

**Modified:**
- src/modules/strategy/types.js (added 2 error codes)
- src/modules/strategy/logic.js (added 4 new functions: getStrategyConfig, validateStrategyConfig, previewConfigUpdate, updateStrategyConfig)
- src/modules/strategy/index.js (added imports and exports for 4 new functions with logging wrappers)

**Created:**
- src/modules/strategy/__tests__/config-updates.test.js (41 comprehensive tests)
