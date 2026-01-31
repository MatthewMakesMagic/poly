# Story 6.3: Strategy Forking

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **to fork a strategy to test variations**,
So that **I can run experiments without affecting the original (FR33)**.

## Acceptance Criteria

### AC1: Fork Strategy Creates New Instance

**Given** an existing strategy
**When** user forks it via `forkStrategy(strategyId, name, modifications)`
**Then** a new strategy instance is created
**And** `base_strategy_id` points to the original strategy
**And** the new strategy has its own unique ID and name
**And** the fork is persisted to `strategy_instances` table

### AC2: Fork with Modified Component

**Given** a forked strategy
**When** I modify one component (e.g., swap entry component)
**Then** only the fork uses the new component version
**And** original strategy is unchanged
**And** the fork inherits unmodified components from parent

### AC3: Fork Inherits Configuration

**Given** a strategy with configuration
**When** forking without config modifications
**Then** the fork inherits the original's config JSON
**And** config modifications can be applied on top
**And** `deepMerge` behavior for config overrides

### AC4: Fork Lineage Tracking

**Given** the fork relationship is stored
**When** viewing strategy lineage via `getStrategyLineage(strategyId)`
**Then** I can see: original → fork → modifications
**And** the complete ancestry chain is returned
**And** this enables "what did I change?" analysis

### AC5: Multiple Forks from Same Parent

**Given** a parent strategy exists
**When** multiple forks are created from the same parent
**Then** each fork is independent (sibling relationship)
**And** parent's fork count can be queried
**And** all forks share the same `base_strategy_id`

### AC6: Diff Between Fork and Parent

**Given** a forked strategy exists
**When** calling `diffStrategies(forkId, parentId)` or `diffFromParent(forkId)`
**Then** I can see which components differ
**And** I can see config differences
**And** the diff is structured for programmatic consumption

### AC7: Fork Validation

**Given** a fork is being created
**When** modified components are specified
**Then** all component version IDs are validated against catalog
**And** component types must match their slots
**And** config is validated against all components (original + modified)

## Tasks / Subtasks

- [x] **Task 1: Add Forking Error Codes** (AC: 7)
  - [x] 1.1 Add `FORK_PARENT_NOT_FOUND` to StrategyErrorCodes in `types.js`
  - [x] 1.2 Add `FORK_PARENT_INACTIVE` to StrategyErrorCodes
  - [x] 1.3 Add `INVALID_FORK_MODIFICATION` to StrategyErrorCodes

- [x] **Task 2: Implement forkStrategy Function in composer.js** (AC: 1, 2, 3, 7)
  - [x] 2.1 Create `forkStrategy(strategyId, name, modifications)` function
  - [x] 2.2 Load parent strategy and validate it exists and is active
  - [x] 2.3 Build new component set (parent components + modifications)
  - [x] 2.4 Validate all modified component version IDs exist in catalog
  - [x] 2.5 Validate modified component types match expected slots
  - [x] 2.6 Deep merge parent config with modification config
  - [x] 2.7 Call `registerStrategy()` with `baseStrategyId` set to parent
  - [x] 2.8 Return the new fork's strategy ID

- [x] **Task 3: Implement getStrategyLineage Function** (AC: 4)
  - [x] 3.1 Create `getStrategyLineage(strategyId)` in `logic.js`
  - [x] 3.2 Recursively follow `base_strategy_id` chain to root
  - [x] 3.3 Return ancestry array: `[{ id, name, createdAt, depth }]`
  - [x] 3.4 Handle circular references (defensive, should never occur)
  - [x] 3.5 Return empty array if strategy has no parent

- [x] **Task 4: Implement getStrategyForks Function** (AC: 5)
  - [x] 4.1 Create `getStrategyForks(strategyId)` in `logic.js`
  - [x] 4.2 Query all strategies where `base_strategy_id = strategyId`
  - [x] 4.3 Return array of fork summaries with id, name, createdAt
  - [x] 4.4 Support optional `activeOnly` filter

- [x] **Task 5: Implement diffStrategies Function** (AC: 6)
  - [x] 5.1 Create `diffStrategies(strategyIdA, strategyIdB)` in `composer.js`
  - [x] 5.2 Compare component version IDs for each slot
  - [x] 5.3 Compare config using deep object diff
  - [x] 5.4 Return structured diff: `{ components: {...}, config: {...} }`
  - [x] 5.5 Create `diffFromParent(forkId)` convenience wrapper

- [x] **Task 6: Update Module Index** (AC: all)
  - [x] 6.1 Import new functions in `index.js`
  - [x] 6.2 Export `forkStrategy` with logging wrapper
  - [x] 6.3 Export `getStrategyLineage` with logging wrapper
  - [x] 6.4 Export `getStrategyForks` with logging wrapper
  - [x] 6.5 Export `diffStrategies` and `diffFromParent` with logging

- [x] **Task 7: Write Comprehensive Tests** (AC: all)
  - [x] 7.1 Test forkStrategy creates new instance with correct base_strategy_id
  - [x] 7.2 Test fork with modified component only affects fork
  - [x] 7.3 Test fork inherits parent config correctly
  - [x] 7.4 Test config modifications are deep merged
  - [x] 7.5 Test getStrategyLineage returns correct ancestry
  - [x] 7.6 Test multiple forks from same parent are independent
  - [x] 7.7 Test diffStrategies shows component and config differences
  - [x] 7.8 Test fork validation rejects invalid components
  - [x] 7.9 Test fork of inactive parent is rejected
  - [x] 7.10 Integration test: fork → modify → execute flow

## Dev Notes

### Architecture Compliance

This is **Story 6.3 in Epic 6** (Strategy Composition) implementing FR33: "User can fork a strategy to create a variation with modified components."

**CRITICAL: This story BUILDS ON Story 6.1 and 6.2** which already implemented:
- Story 6.1: Component registry, version IDs, strategy registration with `base_strategy_id` field, `registerStrategy()`, `getStrategy()`
- Story 6.2: Strategy composition, `createStrategy()`, `executeStrategy()`, `validateStrategy()`

**This story ADDS:**
- `forkStrategy()` - create a new strategy based on an existing one
- `getStrategyLineage()` - trace ancestry from fork to original
- `getStrategyForks()` - find all forks of a strategy
- `diffStrategies()` - compare two strategies
- `diffFromParent()` - convenience diff between fork and its parent

### File Modifications

**Modify:** `src/modules/strategy/types.js`
- Add 3 new error codes for fork-related errors

**Modify:** `src/modules/strategy/composer.js`
- Add `forkStrategy()` function
- Add `diffStrategies()` function
- Add `diffFromParent()` function
- Add `deepMerge()` utility for config merging

**Modify:** `src/modules/strategy/logic.js`
- Add `getStrategyLineage()` function
- Add `getStrategyForks()` function

**Modify:** `src/modules/strategy/index.js`
- Export new functions with logging wrappers

**Create:** `src/modules/strategy/__tests__/forking.test.js`
- Comprehensive test suite for forking functionality

### Fork Strategy Function Signature

```javascript
/**
 * Fork an existing strategy with modifications
 *
 * @param {string} parentId - Strategy ID to fork from
 * @param {string} name - Name for the new fork
 * @param {Object} [modifications={}] - Optional modifications
 * @param {Object} [modifications.components] - Component overrides
 * @param {string} [modifications.components.probability] - Override probability component
 * @param {string} [modifications.components.entry] - Override entry component
 * @param {string} [modifications.components.exit] - Override exit component
 * @param {string} [modifications.components.sizing] - Override sizing component
 * @param {Object} [modifications.config] - Config overrides (deep merged)
 * @returns {string} New strategy ID
 * @throws {StrategyError} If parent not found, inactive, or modifications invalid
 */
export function forkStrategy(parentId, name, modifications = {}) {
  // 1. Load parent strategy
  // 2. Validate parent exists and is active
  // 3. Build component set: parent + modifications
  // 4. Validate modified components exist in catalog
  // 5. Deep merge configs: parentConfig + modifications.config
  // 6. Register with baseStrategyId = parentId
  // 7. Return new strategy ID
}
```

### Deep Merge Configuration Pattern

```javascript
/**
 * Deep merge two config objects
 * Second object values override first
 *
 * @param {Object} base - Base configuration
 * @param {Object} override - Override configuration
 * @returns {Object} Merged configuration
 */
function deepMerge(base, override) {
  const result = { ...base };

  for (const key of Object.keys(override)) {
    if (
      typeof override[key] === 'object' &&
      override[key] !== null &&
      !Array.isArray(override[key]) &&
      typeof result[key] === 'object' &&
      result[key] !== null
    ) {
      result[key] = deepMerge(result[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }

  return result;
}
```

### Lineage Query Example

```javascript
// For a fork chain: original → fork1 → fork2
const lineage = getStrategyLineage('fork2-id');
// Returns:
[
  { id: 'fork2-id', name: 'Fork 2', createdAt: '2026-01-31T12:00:00Z', depth: 0 },
  { id: 'fork1-id', name: 'Fork 1', createdAt: '2026-01-31T10:00:00Z', depth: 1 },
  { id: 'original-id', name: 'Original', createdAt: '2026-01-30T08:00:00Z', depth: 2 },
]
```

### Diff Result Structure

```javascript
// Example diff result
{
  sameBase: true,  // Both have same root ancestor
  components: {
    probability: { match: true },
    entry: {
      match: false,
      a: 'entry-threshold-v1',
      b: 'entry-threshold-v2'
    },
    exit: { match: true },
    sizing: { match: true },
  },
  config: {
    added: { newParam: 42 },
    removed: { oldParam: 10 },
    changed: {
      threshold: { from: 0.5, to: 0.6 }
    },
  },
}
```

### Existing Code Patterns to Follow

From `src/modules/strategy/composer.js` (Story 6.2):
- Use `getStrategy()` from logic.js to load strategies
- Use `getComponent()` to validate components exist in catalog
- Use `registerStrategy()` for persistence with `baseStrategyId`
- Throw `StrategyError` with appropriate error codes

From `src/modules/strategy/logic.js` (Story 6.1):
- Database queries use `get()`, `all()`, `run()` from persistence
- Functions include JSDoc with param and return types
- Errors wrapped in `StrategyError` with context

From `src/modules/strategy/index.js`:
- Export wrapper functions that add logging
- Use `ensureInitialized()` check
- Log operations with child logger

### Testing Approach

```javascript
// src/modules/strategy/__tests__/forking.test.js

describe('Strategy Forking (Story 6.3)', () => {
  let parentId;

  beforeAll(async () => {
    // Create a parent strategy for fork tests
    parentId = createStrategy('Parent Strategy', {
      probability: 'prob-template-v1',
      entry: 'entry-template-v1',
      exit: 'exit-template-v1',
      sizing: 'sizing-template-v1',
    }, { threshold: 0.5, param1: 'value1' });
  });

  describe('AC1: Fork Creates New Instance', () => {
    it('should create fork with base_strategy_id pointing to parent', () => {
      const forkId = forkStrategy(parentId, 'Test Fork', {});
      const fork = getStrategy(forkId);

      expect(fork.id).not.toBe(parentId);
      expect(fork.baseStrategyId).toBe(parentId);
      expect(fork.name).toBe('Test Fork');
    });
  });

  describe('AC2: Fork with Modified Component', () => {
    it('should use modified component only in fork', () => {
      const forkId = forkStrategy(parentId, 'Modified Fork', {
        components: {
          entry: 'entry-other-v1', // Different entry component
        },
      });

      const fork = getStrategy(forkId);
      const parent = getStrategy(parentId);

      expect(fork.components.entry).toBe('entry-other-v1');
      expect(parent.components.entry).toBe('entry-template-v1'); // Unchanged
      expect(fork.components.probability).toBe(parent.components.probability);
    });
  });

  describe('AC3: Fork Inherits Configuration', () => {
    it('should inherit parent config when not modified', () => {
      const forkId = forkStrategy(parentId, 'Inherit Fork', {});
      const fork = getStrategy(forkId);

      expect(fork.config.threshold).toBe(0.5);
      expect(fork.config.param1).toBe('value1');
    });

    it('should deep merge config modifications', () => {
      const forkId = forkStrategy(parentId, 'Config Fork', {
        config: { threshold: 0.7, param2: 'new' },
      });
      const fork = getStrategy(forkId);

      expect(fork.config.threshold).toBe(0.7); // Overridden
      expect(fork.config.param1).toBe('value1'); // Inherited
      expect(fork.config.param2).toBe('new'); // Added
    });
  });

  describe('AC4: Fork Lineage Tracking', () => {
    it('should return correct ancestry chain', () => {
      const fork1Id = forkStrategy(parentId, 'Fork 1', {});
      const fork2Id = forkStrategy(fork1Id, 'Fork 2', {});

      const lineage = getStrategyLineage(fork2Id);

      expect(lineage).toHaveLength(3);
      expect(lineage[0].id).toBe(fork2Id);
      expect(lineage[1].id).toBe(fork1Id);
      expect(lineage[2].id).toBe(parentId);
    });
  });

  describe('AC5: Multiple Forks from Same Parent', () => {
    it('should create independent sibling forks', () => {
      const forkAId = forkStrategy(parentId, 'Fork A', {});
      const forkBId = forkStrategy(parentId, 'Fork B', {});

      const forkA = getStrategy(forkAId);
      const forkB = getStrategy(forkBId);

      expect(forkA.baseStrategyId).toBe(parentId);
      expect(forkB.baseStrategyId).toBe(parentId);
      expect(forkAId).not.toBe(forkBId);
    });

    it('should list all forks of parent', () => {
      const forks = getStrategyForks(parentId);
      expect(forks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('AC6: Diff Between Fork and Parent', () => {
    it('should show component differences', () => {
      const forkId = forkStrategy(parentId, 'Diff Fork', {
        components: { sizing: 'sizing-other-v1' },
      });

      const diff = diffFromParent(forkId);

      expect(diff.components.sizing.match).toBe(false);
      expect(diff.components.probability.match).toBe(true);
    });

    it('should show config differences', () => {
      const forkId = forkStrategy(parentId, 'Config Diff Fork', {
        config: { threshold: 0.8 },
      });

      const diff = diffFromParent(forkId);

      expect(diff.config.changed.threshold.from).toBe(0.5);
      expect(diff.config.changed.threshold.to).toBe(0.8);
    });
  });

  describe('AC7: Fork Validation', () => {
    it('should reject fork with non-existent parent', () => {
      expect(() => forkStrategy('non-existent-id', 'Bad Fork', {}))
        .toThrow('FORK_PARENT_NOT_FOUND');
    });

    it('should reject fork with invalid component', () => {
      expect(() => forkStrategy(parentId, 'Invalid Fork', {
        components: { entry: 'non-existent-component' },
      })).toThrow('COMPONENT_NOT_FOUND');
    });

    it('should reject fork with wrong component type', () => {
      expect(() => forkStrategy(parentId, 'Wrong Type Fork', {
        components: { entry: 'prob-template-v1' }, // Probability in entry slot
      })).toThrow('INVALID_COMPONENT_TYPE');
    });
  });
});
```

### Database Considerations

The `strategy_instances` table already has the `base_strategy_id` column from Story 6.1:

```sql
CREATE TABLE strategy_instances (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_strategy_id TEXT,  -- NULL if original, otherwise forked from
    probability_component TEXT NOT NULL,
    entry_component TEXT NOT NULL,
    exit_component TEXT NOT NULL,
    sizing_component TEXT NOT NULL,
    config TEXT NOT NULL,
    created_at TEXT NOT NULL,
    active INTEGER DEFAULT 1
);
```

For `getStrategyForks()`, query:
```sql
SELECT * FROM strategy_instances
WHERE base_strategy_id = ?
ORDER BY created_at DESC;
```

For lineage queries, use recursive CTEs for efficiency on deep chains:
```sql
WITH RECURSIVE lineage AS (
  SELECT id, name, base_strategy_id, created_at, 0 as depth
  FROM strategy_instances WHERE id = ?
  UNION ALL
  SELECT s.id, s.name, s.base_strategy_id, s.created_at, l.depth + 1
  FROM strategy_instances s
  JOIN lineage l ON s.id = l.base_strategy_id
)
SELECT * FROM lineage ORDER BY depth;
```

Note: SQLite supports recursive CTEs, but a simple iterative approach in JS is also acceptable for MVP since deep fork chains are rare.

### Error Codes to Add

Add to `types.js`:
```javascript
export const StrategyErrorCodes = {
  // ... existing codes ...
  // Story 6.3: Strategy Forking error codes
  FORK_PARENT_NOT_FOUND: 'FORK_PARENT_NOT_FOUND',
  FORK_PARENT_INACTIVE: 'FORK_PARENT_INACTIVE',
  INVALID_FORK_MODIFICATION: 'INVALID_FORK_MODIFICATION',
};
```

### NFR Compliance

- **NFR9:** All fork operations produce structured logs
- **FR33:** User can fork a strategy to create a variation with modified components
- **FR32:** System tracks component versions per strategy (including forks)

### Cross-Story Dependencies

**Prerequisites (COMPLETE):**
- **Story 6.1:** Component registry, strategy registration with `base_strategy_id` ✓
- **Story 6.2:** Strategy composition, `createStrategy()`, validation ✓

**This Story Enables:**
- **Story 6.4 (Central Component Updates):** Uses fork/diff to understand update impact
- **Story 6.5 (Strategy Configuration):** Uses fork's config inheritance

### Critical Implementation Notes

1. **Build on Stories 6.1/6.2** - Use existing `registerStrategy()` with `baseStrategyId` param
2. **Component inheritance** - Fork inherits parent's components unless explicitly overridden
3. **Config deep merge** - Override specific values, preserve inherited structure
4. **Lineage tracking** - Follow `base_strategy_id` chain, not stored separately
5. **Validation reuse** - Leverage existing component validation from composer
6. **Logging** - Log fork creation with parent reference for audit trail

### Project Structure Notes

**Alignment with Architecture:**
- All new functions added to existing files (composer.js, logic.js)
- No new files except test file
- Follows existing module patterns from Stories 6.1/6.2

**Files to Modify:**
```
src/modules/strategy/
├── types.js           # Add 3 error codes
├── composer.js        # Add forkStrategy, diffStrategies, diffFromParent, deepMerge
├── logic.js           # Add getStrategyLineage, getStrategyForks
├── index.js           # Export new functions with logging
└── __tests__/
    └── forking.test.js  # NEW: Comprehensive fork tests
```

### References

- [Source: architecture.md#Database-Schema] - strategy_instances table with base_strategy_id
- [Source: architecture.md#Module-Architecture] - Folder-per-module pattern
- [Source: epics.md#Story-6.3] - Story requirements and acceptance criteria
- [Source: prd.md#FR33] - Fork strategies for variations
- [Source: 6-1-strategy-component-registry.md] - Registry implementation details
- [Source: 6-2-strategy-composition.md] - Composer implementation details
- [Source: src/modules/strategy/composer.js] - Existing composition functions
- [Source: src/modules/strategy/logic.js] - Registry functions including registerStrategy
- [Source: src/modules/strategy/types.js] - Existing error codes

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - Implementation proceeded without issues requiring debug logs.

### Completion Notes List

- Implemented 3 new error codes in `types.js` for fork-related errors (FORK_PARENT_NOT_FOUND, FORK_PARENT_INACTIVE, INVALID_FORK_MODIFICATION)
- Added `forkStrategy()` function in `composer.js` that creates new strategy instances based on existing ones with component/config overrides
- Added `deepMerge()` utility for deep merging configuration objects (handles nested objects, arrays override rather than merge)
- Added `diffStrategies()` and `diffFromParent()` functions for comparing strategies
- Added `getStrategyLineage()` in `logic.js` for tracing ancestry chain from fork to root
- Added `getStrategyForks()` in `logic.js` for finding all forks of a parent strategy
- Exported all new functions through `index.js` with logging wrappers
- Created comprehensive test suite with 31 tests covering all 7 acceptance criteria
- All 1478 tests in the codebase pass including the new forking tests

### File List

- src/modules/strategy/types.js (modified - added 3 error codes)
- src/modules/strategy/composer.js (modified - added forkStrategy, deepMerge, diffStrategies, diffFromParent, diffConfigs, findRootAncestor)
- src/modules/strategy/logic.js (modified - added getStrategyLineage, getStrategyForks)
- src/modules/strategy/index.js (modified - exported new functions with logging wrappers)
- src/modules/strategy/__tests__/forking.test.js (created - 31 comprehensive tests)

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-01-31 | Implemented Story 6.3: Strategy Forking - added forkStrategy, getStrategyLineage, getStrategyForks, diffStrategies, diffFromParent | Claude Opus 4.5 |
