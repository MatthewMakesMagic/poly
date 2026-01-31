# Story 6.1: Strategy Component Registry

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **strategy components versioned and registered**,
So that **I can track what logic each strategy uses (FR31, FR32)**.

## Acceptance Criteria

### AC1: Component Type Structure

**Given** strategy components exist (probability, entry, exit, sizing)
**When** they are stored in the codebase
**Then** each component type has its own directory under `src/modules/strategy/components/{type}/`
**And** component types include: `probability/`, `entry/`, `exit/`, `sizing/`
**And** each component exports a standard interface

### AC2: Component Version ID Generation

**Given** a component is created or updated
**When** it is registered in the system
**Then** it receives a unique version ID (e.g., "prob-v1", "entry-spot-lag-v2")
**And** the version ID includes: component type prefix, name, and version number
**And** version IDs are immutable once created

### AC3: Strategy Instances Table

**Given** the `strategy_instances` table schema exists per architecture.md
**When** a strategy is registered
**Then** it records: id, name, probability_component, entry_component, exit_component, sizing_component
**And** each component field contains the version ID
**And** base_strategy_id is NULL for original strategies
**And** config contains JSON strategy parameters

### AC4: Component Version Immutability

**Given** a component has been versioned
**When** the version ID is assigned
**Then** that version cannot be modified (immutable)
**And** changes create a NEW version with incremented version number
**And** existing strategies using old version continue unchanged

### AC5: Registry Query Operations

**Given** the registry is queried
**When** asking "what components does strategy X use?"
**Then** complete version information is returned
**And** includes: component type, version ID, created_at
**And** the response is structured for programmatic consumption

### AC6: Component Discovery

**Given** components exist in the filesystem
**When** the registry initializes
**Then** it discovers all components in `src/modules/strategy/components/`
**And** validates each component exports required interface
**And** builds an in-memory catalog of available components

### AC7: Registry Module Interface

**Given** the strategy module follows project conventions
**When** inspecting its interface
**Then** it exports: `init()`, `getState()`, `shutdown()`
**And** registry-specific functions: `registerStrategy()`, `getStrategy()`, `getComponent()`, `listComponents()`
**And** version query: `getStrategyComponents(strategyId)`

## Tasks / Subtasks

- [x] **Task 1: Create Strategy Module Structure** (AC: 1, 7)
  - [x] 1.1 Create `src/modules/strategy/` directory with standard files
  - [x] 1.2 Create `index.js` with standard module interface (init, getState, shutdown)
  - [x] 1.3 Create `types.js` with error codes and type definitions
  - [x] 1.4 Create `state.js` for module state management
  - [x] 1.5 Create `logic.js` for business logic functions
  - [x] 1.6 Create `__tests__/` directory with test stubs

- [x] **Task 2: Create Component Directory Structure** (AC: 1)
  - [x] 2.1 Create `src/modules/strategy/components/probability/` directory
  - [x] 2.2 Create `src/modules/strategy/components/entry/` directory
  - [x] 2.3 Create `src/modules/strategy/components/exit/` directory
  - [x] 2.4 Create `src/modules/strategy/components/sizing/` directory
  - [x] 2.5 Create `_template.js` in each directory as component interface template

- [x] **Task 3: Create Database Migration for strategy_instances** (AC: 3)
  - [x] 3.1 Create migration file for strategy_instances table
  - [x] 3.2 Include all columns per architecture.md schema
  - [x] 3.3 Add indexes on `active` column
  - [x] 3.4 Test migration runs successfully

- [x] **Task 4: Implement Component Registry Logic** (AC: 2, 4, 6)
  - [x] 4.1 Implement `generateVersionId(type, name, version)` function
  - [x] 4.2 Implement `discoverComponents()` to scan filesystem
  - [x] 4.3 Implement `validateComponentInterface(component)`
  - [x] 4.4 Implement in-memory component catalog initialization
  - [x] 4.5 Ensure version IDs are unique and immutable

- [x] **Task 5: Implement Registry CRUD Operations** (AC: 5, 7)
  - [x] 5.1 Implement `registerStrategy(name, components, config)`
  - [x] 5.2 Implement `getStrategy(strategyId)`
  - [x] 5.3 Implement `getComponent(versionId)`
  - [x] 5.4 Implement `listComponents(type?)` for catalog listing
  - [x] 5.5 Implement `getStrategyComponents(strategyId)` for version query

- [x] **Task 6: Write Comprehensive Tests** (AC: all)
  - [x] 6.1 Test version ID generation format and uniqueness
  - [x] 6.2 Test strategy_instances table CRUD operations
  - [x] 6.3 Test component discovery from filesystem
  - [x] 6.4 Test version immutability enforcement
  - [x] 6.5 Test registry query operations
  - [x] 6.6 Test module init/getState/shutdown lifecycle
  - [x] 6.7 Integration test: full strategy registration flow

## Dev Notes

### Architecture Compliance

This is the **first story in Epic 6** (Strategy Composition) which implements FR30-34 for composable, versioned strategy components.

**Functional Requirements Addressed:**
- **FR31:** Components can be versioned independently
- **FR32:** System can track which component versions a strategy uses

**From architecture.md:**
```
src/modules/
  strategy/
    index.js          # Public interface
    composer.js       # Strategy composition logic (Story 6.2)
    registry.js       # Component version registry (THIS STORY)
    components/
      probability/    # Probability logic components
      entry/          # Entry condition components
      exit/           # Exit rule components
      sizing/         # Position sizing components
```

**From architecture.md - Database Schema (strategy_instances table):**
```sql
CREATE TABLE strategy_instances (
    id TEXT PRIMARY KEY,              -- strategy instance ID
    name TEXT NOT NULL,               -- human-readable name
    base_strategy_id TEXT,            -- NULL if original, otherwise forked from
    probability_component TEXT NOT NULL,  -- component version ID
    entry_component TEXT NOT NULL,
    exit_component TEXT NOT NULL,
    sizing_component TEXT NOT NULL,
    config TEXT NOT NULL,             -- JSON strategy config
    created_at TEXT NOT NULL,
    active INTEGER DEFAULT 1          -- is this strategy currently active?
);

CREATE INDEX idx_strategy_active ON strategy_instances(active);
```

### Project Structure Notes

**New Files to Create:**
```
src/modules/strategy/
├── index.js          # Public interface - init, getState, shutdown, registry functions
├── registry.js       # Component registry logic (discoverComponents, registerStrategy, etc.)
├── state.js          # Module state management
├── types.js          # Error codes and type definitions
└── __tests__/
    ├── index.test.js
    └── registry.test.js

src/modules/strategy/components/
├── probability/
│   └── _template.js  # Component interface template
├── entry/
│   └── _template.js
├── exit/
│   └── _template.js
└── sizing/
    └── _template.js

src/persistence/migrations/
└── 002-strategy-instances.sql  # New migration for strategy_instances table
```

**Existing Patterns to Follow:**

From `src/modules/_template/index.js`:
- Export `init(config)`, `getState()`, `shutdown()`
- Use `PolyError` for errors with `code`, `message`, `context`
- Module state pattern with `initialized` flag

From `src/modules/trade-event/index.js` (900+ lines):
- Child logger pattern: `log = child({ module: 'strategy' })`
- State management via separate `state.js` file
- Logic functions in `logic.js`
- Typed errors in `types.js`

### Component Interface Contract

Each component MUST export:

```javascript
// src/modules/strategy/components/{type}/_template.js

/**
 * Component Template - Standard interface for strategy components
 *
 * Copy this file to create a new component:
 *   cp _template.js my-component.js
 */

export const metadata = {
  name: 'template',           // Human-readable name
  version: 1,                 // Semantic version number
  type: 'probability',        // Component type: probability|entry|exit|sizing
  description: 'Template component for strategy composition',
  author: 'Matthew',
  createdAt: '2026-01-31',
};

/**
 * Evaluate the component logic
 *
 * @param {Object} context - Market and strategy context
 * @param {Object} config - Component-specific configuration
 * @returns {Object} Evaluation result (structure depends on component type)
 */
export function evaluate(context, config) {
  // Component-specific logic
  return {
    // Result structure depends on component type
  };
}

/**
 * Validate component configuration
 *
 * @param {Object} config - Configuration to validate
 * @returns {Object} Validation result { valid: boolean, errors?: string[] }
 */
export function validateConfig(config) {
  return { valid: true };
}
```

### Version ID Format

Format: `{type}-{name}-v{version}`

Examples:
- `prob-spot-lag-v1` - Probability component "spot-lag" version 1
- `entry-threshold-v2` - Entry component "threshold" version 2
- `exit-stop-loss-v1` - Exit component "stop-loss" version 1
- `sizing-liquidity-aware-v3` - Sizing component "liquidity-aware" version 3

**Rules:**
- Type prefix: `prob`, `entry`, `exit`, `sizing`
- Name: kebab-case, descriptive
- Version: incrementing integer starting at 1
- Immutable: once created, cannot be modified

### Database Migration Pattern

Create `src/persistence/migrations/002-strategy-instances.sql`:

```sql
-- Migration: 002-strategy-instances
-- Strategy composition registry (Epic 6, Story 6.1)
-- Covers FR31 (version components independently) and FR32 (track component versions)

CREATE TABLE IF NOT EXISTS strategy_instances (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_strategy_id TEXT,
    probability_component TEXT NOT NULL,
    entry_component TEXT NOT NULL,
    exit_component TEXT NOT NULL,
    sizing_component TEXT NOT NULL,
    config TEXT NOT NULL,
    created_at TEXT NOT NULL,
    active INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_strategy_active ON strategy_instances(active);
```

### Registry Functions Specification

```javascript
// src/modules/strategy/registry.js

/**
 * Generate a unique version ID for a component
 *
 * @param {string} type - Component type (probability, entry, exit, sizing)
 * @param {string} name - Component name (kebab-case)
 * @param {number} version - Version number
 * @returns {string} Version ID (e.g., "prob-spot-lag-v1")
 */
export function generateVersionId(type, name, version) {
  const typePrefix = {
    probability: 'prob',
    entry: 'entry',
    exit: 'exit',
    sizing: 'sizing',
  };
  return `${typePrefix[type]}-${name}-v${version}`;
}

/**
 * Discover all components in the filesystem
 *
 * Scans src/modules/strategy/components/{type}/ directories
 * and validates each .js file exports required interface.
 *
 * @returns {Object} Component catalog by type
 */
export function discoverComponents() {
  // Implementation: scan filesystem, validate exports
}

/**
 * Validate a component exports required interface
 *
 * @param {Object} component - Imported component module
 * @returns {Object} { valid: boolean, errors?: string[] }
 */
export function validateComponentInterface(component) {
  const errors = [];

  if (!component.metadata) errors.push('Missing metadata export');
  if (!component.metadata?.name) errors.push('Missing metadata.name');
  if (!component.metadata?.version) errors.push('Missing metadata.version');
  if (!component.metadata?.type) errors.push('Missing metadata.type');
  if (typeof component.evaluate !== 'function') errors.push('Missing evaluate function');
  if (typeof component.validateConfig !== 'function') errors.push('Missing validateConfig function');

  return { valid: errors.length === 0, errors };
}

/**
 * Register a new strategy with specified components
 *
 * @param {Object} params - Strategy parameters
 * @param {string} params.name - Human-readable strategy name
 * @param {Object} params.components - Component version IDs
 * @param {string} params.components.probability - Probability component version ID
 * @param {string} params.components.entry - Entry component version ID
 * @param {string} params.components.exit - Exit component version ID
 * @param {string} params.components.sizing - Sizing component version ID
 * @param {Object} params.config - Strategy configuration JSON
 * @param {string} [params.baseStrategyId] - For forks: parent strategy ID
 * @returns {string} New strategy ID
 */
export function registerStrategy({ name, components, config, baseStrategyId = null }) {
  // Generate unique strategy ID
  // Insert into strategy_instances table
  // Return strategy ID
}

/**
 * Get strategy by ID with full component details
 *
 * @param {string} strategyId - Strategy instance ID
 * @returns {Object|null} Strategy instance or null if not found
 */
export function getStrategy(strategyId) {
  // Query strategy_instances table
  // Return full strategy object with parsed config
}

/**
 * Get component by version ID
 *
 * @param {string} versionId - Component version ID (e.g., "prob-spot-lag-v1")
 * @returns {Object|null} Component metadata and module reference
 */
export function getComponent(versionId) {
  // Look up in in-memory catalog
  // Return component details
}

/**
 * List all available components, optionally filtered by type
 *
 * @param {string} [type] - Filter by component type
 * @returns {Object[]} Array of component metadata
 */
export function listComponents(type) {
  // Return from in-memory catalog
}

/**
 * Get all components used by a strategy
 *
 * @param {string} strategyId - Strategy instance ID
 * @returns {Object} Component details for each type
 */
export function getStrategyComponents(strategyId) {
  // Query strategy, then look up each component
}
```

### Testing Approach

```javascript
// src/modules/strategy/__tests__/registry.test.js

describe('Strategy Component Registry (Story 6.1)', () => {
  describe('AC2: Version ID Generation', () => {
    it('should generate correct format for probability component', () => {
      const id = generateVersionId('probability', 'spot-lag', 1);
      expect(id).toBe('prob-spot-lag-v1');
    });

    it('should generate unique IDs for different versions', () => {
      const v1 = generateVersionId('entry', 'threshold', 1);
      const v2 = generateVersionId('entry', 'threshold', 2);
      expect(v1).not.toBe(v2);
    });
  });

  describe('AC3: Strategy Instances Table', () => {
    it('should register strategy with all component fields', async () => {
      const strategyId = await registerStrategy({
        name: 'Test Strategy',
        components: {
          probability: 'prob-test-v1',
          entry: 'entry-test-v1',
          exit: 'exit-test-v1',
          sizing: 'sizing-test-v1',
        },
        config: { threshold: 0.5 },
      });

      const strategy = await getStrategy(strategyId);
      expect(strategy.probability_component).toBe('prob-test-v1');
      expect(strategy.entry_component).toBe('entry-test-v1');
      expect(strategy.exit_component).toBe('exit-test-v1');
      expect(strategy.sizing_component).toBe('sizing-test-v1');
      expect(strategy.base_strategy_id).toBeNull();
    });
  });

  describe('AC5: Registry Query Operations', () => {
    it('should return complete component info for strategy', async () => {
      const components = await getStrategyComponents(strategyId);

      expect(components.probability).toHaveProperty('versionId');
      expect(components.probability).toHaveProperty('type');
      expect(components.probability).toHaveProperty('createdAt');
    });
  });

  describe('AC6: Component Discovery', () => {
    it('should discover components in filesystem', () => {
      const catalog = discoverComponents();

      expect(catalog).toHaveProperty('probability');
      expect(catalog).toHaveProperty('entry');
      expect(catalog).toHaveProperty('exit');
      expect(catalog).toHaveProperty('sizing');
    });

    it('should validate component interface', () => {
      const validComponent = {
        metadata: { name: 'test', version: 1, type: 'probability' },
        evaluate: () => {},
        validateConfig: () => ({ valid: true }),
      };

      const result = validateComponentInterface(validComponent);
      expect(result.valid).toBe(true);
    });
  });
});
```

### Edge Cases

1. **Duplicate version IDs:** Prevent registration of duplicate version IDs
2. **Invalid component type:** Reject components with unknown type
3. **Missing component files:** Handle gracefully during discovery
4. **Malformed component exports:** Clear error messages for invalid interfaces
5. **Empty strategy config:** Allow empty config object `{}`
6. **Strategy with inactive components:** Warn but allow (for historical queries)
7. **Database migration failures:** Rollback gracefully

### NFR Compliance

- **NFR9:** 100% of registry operations produce structured logs
- **FR35:** Strategy parameters configurable via config JSON
- **FR31:** Components versioned independently
- **FR32:** System tracks component versions per strategy

### Cross-Story Dependencies

**This Story Enables:**
- **Story 6.2 (Strategy Composition):** Uses registry to compose strategies
- **Story 6.3 (Strategy Forking):** Uses registry to create forks with base_strategy_id
- **Story 6.4 (Central Component Updates):** Uses registry for version management
- **Story 6.5 (Strategy Configuration):** Uses config JSON field

**Prerequisites (All Complete):**
- Epic 1-5 complete (foundation, trading, execution, safety, monitoring)
- Database persistence layer with migration support

### Critical Implementation Notes

1. **Follow existing patterns** - Use `_template` module as base, follow trade-event module patterns
2. **Immutable versions** - Once created, version IDs cannot change
3. **In-memory catalog** - Discover on init, keep in memory for performance
4. **Database persistence** - strategy_instances table stores all registered strategies
5. **Child logger** - Use `child({ module: 'strategy' })` pattern
6. **Error codes** - Define `StrategyError` and `StrategyErrorCodes` in types.js

### References

- [Source: architecture.md#Module-Architecture] - Folder-per-module pattern
- [Source: architecture.md#Database-Schema] - strategy_instances table schema
- [Source: architecture.md#Project-Structure] - Component directory structure
- [Source: prd.md#FR31-FR32] - Component versioning requirements
- [Source: epics.md#Story-6.1] - Story requirements and acceptance criteria
- [Source: src/modules/_template/index.js] - Module interface pattern
- [Source: src/modules/trade-event/index.js] - Large module implementation example

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- All 80 strategy module tests pass
- Full test suite (1415 tests) passes with no regressions

### Completion Notes List

- Implemented strategy module following existing module patterns (trade-event, _template)
- Created component directory structure with template files for probability, entry, exit, sizing
- Database migration (005-strategy-instances.js) includes all schema columns from architecture.md
- Version ID format: {type-prefix}-{name}-v{version} (e.g., prob-spot-lag-v1)
- Component discovery scans filesystem on init, validates interface, builds in-memory catalog
- Registry supports strategy registration, querying, forking (via baseStrategyId), and deactivation
- All acceptance criteria verified through comprehensive unit and integration tests

### Change Log

- 2026-01-31: Implemented Story 6.1 - Strategy Component Registry

### File List

**New Files Created:**
- src/modules/strategy/index.js
- src/modules/strategy/types.js
- src/modules/strategy/state.js
- src/modules/strategy/logic.js
- src/modules/strategy/__tests__/index.test.js
- src/modules/strategy/__tests__/registry.test.js
- src/modules/strategy/__tests__/integration.test.js
- src/modules/strategy/components/probability/_template.js
- src/modules/strategy/components/entry/_template.js
- src/modules/strategy/components/exit/_template.js
- src/modules/strategy/components/sizing/_template.js
- src/persistence/migrations/005-strategy-instances.js

**Modified Files:**
- _bmad-output/implementation-artifacts/sprint-status.yaml (status: in-progress → review)
