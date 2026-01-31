# Story 6.4: Central Component Updates

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **trader**,
I want **to update a central component when the change is proven**,
So that **improvements propagate to all strategies using it (FR34)**.

## Acceptance Criteria

### AC1: Create New Component Version

**Given** a component improvement is validated
**When** updating the central component via `createComponentVersion(type, name, version, modulePath)`
**Then** a new version is created (not modified in place)
**And** the new version is added to the in-memory catalog
**And** the new version ID follows the format: `{type-prefix}-{name}-v{version}`
**And** the old version remains available in the catalog

### AC2: List Strategies Using Component

**Given** strategies reference component versions
**When** calling `getStrategiesUsingComponent(versionId)`
**Then** all strategies using that specific version are returned
**And** results include strategy ID, name, active status
**And** this enables impact assessment before upgrades

### AC3: Upgrade Strategy Component

**Given** a new component version exists
**When** calling `upgradeStrategyComponent(strategyId, componentType, newVersionId)`
**Then** the strategy is updated to use the new component version
**And** the strategy config is re-validated against the new component
**And** the strategy remains active
**And** the upgrade is persisted to the database

### AC4: Batch Upgrade Strategies

**Given** a "core fix" affects multiple strategies
**When** calling `batchUpgradeComponent(oldVersionId, newVersionId, options)`
**Then** all strategies using the old version are upgraded
**And** options allow filtering: `{ activeOnly: true, strategyIds: [...] }`
**And** upgrade results report success/failure per strategy
**And** partial failures don't roll back successful upgrades

### AC5: Component Version History

**Given** component updates occur
**When** calling `getComponentVersionHistory(type, name)`
**Then** all versions of that component are returned
**And** results ordered by version number descending (newest first)
**And** includes version ID, version number, created date
**And** enables "what versions exist?" analysis

### AC6: Version Diff Preview

**Given** considering an upgrade
**When** calling `previewComponentUpgrade(strategyId, componentType, newVersionId)`
**Then** a preview is returned without making changes
**And** preview includes: config validation result, component diff
**And** enables dry-run impact assessment before committing

### AC7: Upgrade Validation

**Given** an upgrade is being performed
**When** the new component is validated
**Then** the component version ID must exist in the catalog
**And** the component type must match the target slot
**And** the strategy config must pass the new component's `validateConfig()`
**And** validation failures prevent the upgrade with detailed error

## Tasks / Subtasks

- [ ] **Task 1: Add Component Update Error Codes** (AC: 7)
  - [ ] 1.1 Add `COMPONENT_VERSION_EXISTS` to StrategyErrorCodes in `types.js`
  - [ ] 1.2 Add `UPGRADE_VALIDATION_FAILED` to StrategyErrorCodes
  - [ ] 1.3 Add `COMPONENT_UPGRADE_FAILED` to StrategyErrorCodes

- [ ] **Task 2: Implement createComponentVersion Function** (AC: 1)
  - [ ] 2.1 Create `createComponentVersion(type, name, version, modulePath)` in `registry.js` (new file)
  - [ ] 2.2 Validate type is valid ComponentType
  - [ ] 2.3 Generate version ID and check for duplicates in catalog
  - [ ] 2.4 Dynamically import and validate component interface
  - [ ] 2.5 Add to in-memory catalog via `addToCatalog()`
  - [ ] 2.6 Return the new version ID

- [ ] **Task 3: Implement getStrategiesUsingComponent Function** (AC: 2)
  - [ ] 3.1 Create `getStrategiesUsingComponent(versionId)` in `logic.js`
  - [ ] 3.2 Query strategies where any component column matches versionId
  - [ ] 3.3 Return array of strategy summaries: { id, name, active, componentSlot }
  - [ ] 3.4 Support optional `{ activeOnly: boolean }` filter

- [ ] **Task 4: Implement upgradeStrategyComponent Function** (AC: 3, 7)
  - [ ] 4.1 Create `upgradeStrategyComponent(strategyId, componentType, newVersionId)` in `composer.js`
  - [ ] 4.2 Load strategy and validate it exists and is active
  - [ ] 4.3 Validate newVersionId exists in catalog
  - [ ] 4.4 Validate new component type matches the target slot
  - [ ] 4.5 Re-validate strategy config against new component's validateConfig()
  - [ ] 4.6 Update strategy in database with new component version
  - [ ] 4.7 Return updated strategy details

- [ ] **Task 5: Implement batchUpgradeComponent Function** (AC: 4)
  - [ ] 5.1 Create `batchUpgradeComponent(oldVersionId, newVersionId, options)` in `composer.js`
  - [ ] 5.2 Find all strategies using oldVersionId
  - [ ] 5.3 Apply filters from options (activeOnly, strategyIds)
  - [ ] 5.4 Upgrade each strategy, collecting results
  - [ ] 5.5 Return batch result: { upgraded: [...], failed: [...], total, successCount, failCount }
  - [ ] 5.6 Log each upgrade attempt with outcome

- [ ] **Task 6: Implement getComponentVersionHistory Function** (AC: 5)
  - [ ] 6.1 Create `getComponentVersionHistory(type, name)` in `logic.js`
  - [ ] 6.2 Query catalog for all versions matching type and name pattern
  - [ ] 6.3 Parse version numbers from version IDs
  - [ ] 6.4 Return sorted array: [{ versionId, version, createdAt }]

- [ ] **Task 7: Implement previewComponentUpgrade Function** (AC: 6)
  - [ ] 7.1 Create `previewComponentUpgrade(strategyId, componentType, newVersionId)` in `composer.js`
  - [ ] 7.2 Load strategy and current component version
  - [ ] 7.3 Load new component from catalog
  - [ ] 7.4 Validate new component without persisting
  - [ ] 7.5 Build preview: { canUpgrade, currentVersion, newVersion, validationResult }
  - [ ] 7.6 Include component metadata diff if available

- [ ] **Task 8: Update Module Index** (AC: all)
  - [ ] 8.1 Import new functions in `index.js`
  - [ ] 8.2 Export `createComponentVersion` with logging wrapper
  - [ ] 8.3 Export `getStrategiesUsingComponent` with logging wrapper
  - [ ] 8.4 Export `upgradeStrategyComponent` with logging wrapper
  - [ ] 8.5 Export `batchUpgradeComponent` with logging wrapper
  - [ ] 8.6 Export `getComponentVersionHistory` with logging wrapper
  - [ ] 8.7 Export `previewComponentUpgrade` with logging wrapper

- [ ] **Task 9: Write Comprehensive Tests** (AC: all)
  - [ ] 9.1 Test createComponentVersion adds to catalog without affecting existing
  - [ ] 9.2 Test createComponentVersion rejects duplicate version IDs
  - [ ] 9.3 Test getStrategiesUsingComponent returns correct strategies
  - [ ] 9.4 Test getStrategiesUsingComponent with activeOnly filter
  - [ ] 9.5 Test upgradeStrategyComponent updates single strategy
  - [ ] 9.6 Test upgradeStrategyComponent validates new component
  - [ ] 9.7 Test upgradeStrategyComponent rejects wrong component type
  - [ ] 9.8 Test batchUpgradeComponent upgrades multiple strategies
  - [ ] 9.9 Test batchUpgradeComponent partial failures don't rollback
  - [ ] 9.10 Test batchUpgradeComponent respects filters
  - [ ] 9.11 Test getComponentVersionHistory returns sorted versions
  - [ ] 9.12 Test previewComponentUpgrade returns correct preview
  - [ ] 9.13 Test previewComponentUpgrade doesn't persist changes
  - [ ] 9.14 Integration test: create version → find users → batch upgrade flow

## Dev Notes

### Architecture Compliance

This is **Story 6.4 in Epic 6** (Strategy Composition) implementing FR34: "User can update a central component when change is a core improvement."

**CRITICAL: This story BUILDS ON Stories 6.1, 6.2, and 6.3** which already implemented:
- Story 6.1: Component registry, version IDs, `registerStrategy()`, `getStrategy()`, `getComponent()`, `listComponents()`, catalog management
- Story 6.2: Strategy composition, `createStrategy()`, `executeStrategy()`, `validateStrategy()`
- Story 6.3: Strategy forking, `forkStrategy()`, `getStrategyLineage()`, `getStrategyForks()`, `diffStrategies()`, `diffFromParent()`

**This story ADDS:**
- `createComponentVersion()` - programmatically add new component version to catalog
- `getStrategiesUsingComponent()` - find all strategies using a specific component version
- `upgradeStrategyComponent()` - upgrade a single strategy to use a new component version
- `batchUpgradeComponent()` - upgrade multiple strategies from old to new component version
- `getComponentVersionHistory()` - list all versions of a component
- `previewComponentUpgrade()` - dry-run upgrade assessment

### File Modifications

**Modify:** `src/modules/strategy/types.js`
- Add 3 new error codes for component update/upgrade errors

**Create:** `src/modules/strategy/registry.js`
- Add `createComponentVersion()` function
- Separates runtime component registration from filesystem discovery

**Modify:** `src/modules/strategy/logic.js`
- Add `getStrategiesUsingComponent()` function
- Add `getComponentVersionHistory()` function
- Add `updateStrategyComponent()` database function (internal)

**Modify:** `src/modules/strategy/composer.js`
- Add `upgradeStrategyComponent()` function
- Add `batchUpgradeComponent()` function
- Add `previewComponentUpgrade()` function

**Modify:** `src/modules/strategy/index.js`
- Export new functions with logging wrappers

**Create:** `src/modules/strategy/__tests__/component-updates.test.js`
- Comprehensive test suite for component update functionality

### createComponentVersion Function Signature

```javascript
/**
 * Create a new component version and add to catalog
 *
 * @param {string} type - Component type (probability, entry, exit, sizing)
 * @param {string} name - Component name (kebab-case)
 * @param {number} version - Version number
 * @param {string} modulePath - Path to component module file
 * @returns {Promise<string>} New version ID
 * @throws {StrategyError} If type invalid, version exists, or interface invalid
 */
export async function createComponentVersion(type, name, version, modulePath) {
  // 1. Validate type is valid ComponentType
  // 2. Generate version ID: {prefix}-{name}-v{version}
  // 3. Check version ID doesn't already exist in catalog
  // 4. Dynamically import module from modulePath
  // 5. Validate component interface (metadata, evaluate, validateConfig)
  // 6. Add to catalog via addToCatalog()
  // 7. Return version ID
}
```

### getStrategiesUsingComponent Function Signature

```javascript
/**
 * Find all strategies using a specific component version
 *
 * @param {string} versionId - Component version ID
 * @param {Object} [options] - Query options
 * @param {boolean} [options.activeOnly=false] - Only return active strategies
 * @returns {Object[]} Array of strategy summaries
 */
export function getStrategiesUsingComponent(versionId, options = {}) {
  // Query: SELECT * FROM strategy_instances
  // WHERE probability_component = ? OR entry_component = ?
  //    OR exit_component = ? OR sizing_component = ?
}
```

### upgradeStrategyComponent Function Signature

```javascript
/**
 * Upgrade a strategy to use a new component version
 *
 * @param {string} strategyId - Strategy ID to upgrade
 * @param {string} componentType - Component slot to upgrade (probability, entry, exit, sizing)
 * @param {string} newVersionId - New component version ID
 * @returns {Object} Upgraded strategy details
 * @throws {StrategyError} If strategy not found, component invalid, or config fails validation
 */
export function upgradeStrategyComponent(strategyId, componentType, newVersionId) {
  // 1. Load strategy
  // 2. Validate newVersionId exists in catalog
  // 3. Validate component type matches slot
  // 4. Validate strategy config against new component
  // 5. Update database: UPDATE strategy_instances SET {type}_component = ? WHERE id = ?
  // 6. Return updated strategy
}
```

### batchUpgradeComponent Function Signature

```javascript
/**
 * Batch upgrade all strategies from old component to new
 *
 * @param {string} oldVersionId - Current component version to replace
 * @param {string} newVersionId - New component version
 * @param {Object} [options] - Batch options
 * @param {boolean} [options.activeOnly=true] - Only upgrade active strategies
 * @param {string[]} [options.strategyIds] - Specific strategies to upgrade (if omitted, all matching)
 * @returns {Object} Batch result { upgraded, failed, total, successCount, failCount }
 */
export function batchUpgradeComponent(oldVersionId, newVersionId, options = {}) {
  // 1. Parse oldVersionId to determine component type
  // 2. Find all strategies using oldVersionId
  // 3. Apply filters (activeOnly, strategyIds)
  // 4. For each strategy, attempt upgrade and collect result
  // 5. Return batch summary
}
```

### Database Queries

**Find strategies using a component:**
```sql
SELECT id, name, active,
  CASE
    WHEN probability_component = ? THEN 'probability'
    WHEN entry_component = ? THEN 'entry'
    WHEN exit_component = ? THEN 'exit'
    WHEN sizing_component = ? THEN 'sizing'
  END as component_slot
FROM strategy_instances
WHERE probability_component = ?
   OR entry_component = ?
   OR exit_component = ?
   OR sizing_component = ?;
```

**Update strategy component:**
```sql
-- For probability slot:
UPDATE strategy_instances SET probability_component = ? WHERE id = ?;

-- For entry slot:
UPDATE strategy_instances SET entry_component = ? WHERE id = ?;

-- Similar for exit, sizing
```

### Batch Upgrade Result Structure

```javascript
{
  total: 5,
  successCount: 4,
  failCount: 1,
  upgraded: [
    { strategyId: 'strat-001', name: 'Strategy A', previousVersion: 'prob-spot-lag-v1' },
    { strategyId: 'strat-002', name: 'Strategy B', previousVersion: 'prob-spot-lag-v1' },
    // ...
  ],
  failed: [
    { strategyId: 'strat-003', name: 'Strategy C', error: 'Config validation failed: missing required field' },
  ],
}
```

### Preview Upgrade Result Structure

```javascript
{
  canUpgrade: true,
  strategyId: 'strat-001',
  strategyName: 'My Strategy',
  componentType: 'probability',
  currentVersion: 'prob-spot-lag-v1',
  newVersion: 'prob-spot-lag-v2',
  validationResult: {
    valid: true,
    errors: undefined,
  },
  componentDiff: {
    name: { match: true },
    version: { match: false, current: 1, new: 2 },
    description: { match: false, current: 'Old desc', new: 'New desc' },
  },
}
```

### Existing Code Patterns to Follow

From `src/modules/strategy/logic.js` (Stories 6.1, 6.3):
- Database queries use `get()`, `all()`, `run()` from persistence
- Functions include JSDoc with param and return types
- Errors wrapped in `StrategyError` with context
- `getComponent()` retrieves from in-memory catalog
- `addToCatalog()` and `getFromCatalog()` manage catalog state

From `src/modules/strategy/composer.js` (Stories 6.2, 6.3):
- Use `getStrategy()` from logic.js to load strategies
- Use `getComponent()` to validate components exist in catalog
- Throw `StrategyError` with appropriate error codes
- Validate component types match expected slots
- Re-validate config against new components

From `src/modules/strategy/index.js`:
- Export wrapper functions that add logging
- Use `ensureInitialized()` check
- Log operations with child logger

From `src/modules/strategy/state.js`:
- `getCatalog()` - get full catalog
- `addToCatalog(type, versionId, componentData)` - add to catalog
- `getFromCatalog(versionId)` - get specific component

### Error Codes to Add

Add to `types.js`:
```javascript
export const StrategyErrorCodes = {
  // ... existing codes ...
  // Story 6.4: Central Component Updates error codes
  COMPONENT_VERSION_EXISTS: 'COMPONENT_VERSION_EXISTS',
  UPGRADE_VALIDATION_FAILED: 'UPGRADE_VALIDATION_FAILED',
  COMPONENT_UPGRADE_FAILED: 'COMPONENT_UPGRADE_FAILED',
};
```

### Testing Approach

```javascript
// src/modules/strategy/__tests__/component-updates.test.js

describe('Central Component Updates (Story 6.4)', () => {
  let testStrategyId;
  const initialVersionId = 'prob-template-v1';
  const newVersionId = 'prob-template-v2';

  beforeAll(async () => {
    // Create test strategy using template components
    testStrategyId = createStrategy('Update Test Strategy', {
      probability: initialVersionId,
      entry: 'entry-template-v1',
      exit: 'exit-template-v1',
      sizing: 'sizing-template-v1',
    }, { threshold: 0.5 });
  });

  describe('AC1: Create New Component Version', () => {
    it('should create new version without affecting existing', async () => {
      const newId = await createComponentVersion(
        'probability',
        'template',
        2,
        './components/probability/_template.js'
      );

      expect(newId).toBe('prob-template-v2');
      expect(getComponent('prob-template-v1')).not.toBeNull(); // Old still exists
      expect(getComponent('prob-template-v2')).not.toBeNull(); // New exists
    });

    it('should reject duplicate version ID', async () => {
      await expect(createComponentVersion(
        'probability', 'template', 1, './path'
      )).rejects.toThrow('COMPONENT_VERSION_EXISTS');
    });
  });

  describe('AC2: List Strategies Using Component', () => {
    it('should return all strategies using the component', () => {
      const strategies = getStrategiesUsingComponent(initialVersionId);

      expect(strategies.length).toBeGreaterThanOrEqual(1);
      expect(strategies.some(s => s.id === testStrategyId)).toBe(true);
    });

    it('should include component slot in results', () => {
      const strategies = getStrategiesUsingComponent(initialVersionId);
      const testStrat = strategies.find(s => s.id === testStrategyId);

      expect(testStrat.componentSlot).toBe('probability');
    });
  });

  describe('AC3: Upgrade Strategy Component', () => {
    it('should upgrade single strategy to new version', () => {
      const result = upgradeStrategyComponent(
        testStrategyId,
        'probability',
        newVersionId
      );

      expect(result.components.probability).toBe(newVersionId);
    });

    it('should reject wrong component type', () => {
      expect(() => upgradeStrategyComponent(
        testStrategyId,
        'probability',
        'entry-template-v1' // Wrong type
      )).toThrow('INVALID_COMPONENT_TYPE');
    });
  });

  describe('AC4: Batch Upgrade Strategies', () => {
    let batchStrategyIds;

    beforeAll(() => {
      // Create multiple strategies with same component
      batchStrategyIds = [
        createStrategy('Batch A', { probability: 'prob-batch-v1', ...otherComponents }),
        createStrategy('Batch B', { probability: 'prob-batch-v1', ...otherComponents }),
        createStrategy('Batch C', { probability: 'prob-batch-v1', ...otherComponents }),
      ];
    });

    it('should upgrade all matching strategies', () => {
      const result = batchUpgradeComponent('prob-batch-v1', 'prob-batch-v2');

      expect(result.successCount).toBe(3);
      expect(result.upgraded.length).toBe(3);
    });

    it('should continue on partial failure', () => {
      // One strategy has incompatible config
      const result = batchUpgradeComponent('prob-strict-v1', 'prob-strict-v2');

      expect(result.failCount).toBeGreaterThan(0);
      expect(result.upgraded.length).toBeGreaterThan(0); // Some succeeded
    });
  });

  describe('AC5: Component Version History', () => {
    it('should return all versions sorted by version descending', () => {
      const history = getComponentVersionHistory('probability', 'template');

      expect(history.length).toBeGreaterThanOrEqual(2);
      expect(history[0].version).toBeGreaterThan(history[1].version);
    });
  });

  describe('AC6: Preview Component Upgrade', () => {
    it('should return preview without making changes', () => {
      const preview = previewComponentUpgrade(testStrategyId, 'probability', newVersionId);

      expect(preview.canUpgrade).toBe(true);
      expect(preview.currentVersion).toBe(/* current */);
      expect(preview.newVersion).toBe(newVersionId);

      // Verify no change was made
      const strategy = getStrategy(testStrategyId);
      expect(strategy.components.probability).not.toBe(newVersionId);
    });
  });

  describe('AC7: Upgrade Validation', () => {
    it('should reject non-existent component version', () => {
      expect(() => upgradeStrategyComponent(
        testStrategyId, 'probability', 'prob-nonexistent-v99'
      )).toThrow('COMPONENT_NOT_FOUND');
    });

    it('should reject if config validation fails', () => {
      // Component v3 requires additional config field
      expect(() => upgradeStrategyComponent(
        testStrategyId, 'probability', 'prob-strict-v3'
      )).toThrow('UPGRADE_VALIDATION_FAILED');
    });
  });
});
```

### NFR Compliance

- **NFR9:** All upgrade operations produce structured logs
- **FR34:** User can update a central component when change is a core improvement
- **FR32:** System tracks component versions per strategy (enables impact assessment)

### Cross-Story Dependencies

**Prerequisites (COMPLETE):**
- **Story 6.1:** Component registry, version IDs, catalog management ✓
- **Story 6.2:** Strategy composition, config validation ✓
- **Story 6.3:** Strategy forking, lineage tracking ✓

**This Story Enables:**
- **Story 6.5 (Strategy Configuration):** Uses upgrade pattern for config-only changes
- Future: Automated component rollout workflows

### Critical Implementation Notes

1. **Non-destructive updates** - Creating new version never modifies existing version
2. **Batch failure handling** - Partial failures don't roll back successful upgrades
3. **Preview before commit** - Always offer dry-run assessment
4. **Config re-validation** - New component may have different config requirements
5. **Logging** - Log every upgrade attempt with outcome for audit trail
6. **Catalog sync** - New versions added to in-memory catalog immediately

### Project Structure Notes

**Alignment with Architecture:**
- New `registry.js` file for runtime component registration (separates from filesystem discovery in `logic.js`)
- Follows existing module patterns from Stories 6.1-6.3
- Tests co-located in `__tests__` folder

**Files to Modify:**
```
src/modules/strategy/
├── types.js           # Add 3 error codes
├── registry.js        # NEW: createComponentVersion
├── logic.js           # Add getStrategiesUsingComponent, getComponentVersionHistory, updateStrategyComponent
├── composer.js        # Add upgradeStrategyComponent, batchUpgradeComponent, previewComponentUpgrade
├── index.js           # Export new functions with logging
└── __tests__/
    └── component-updates.test.js  # NEW: Comprehensive update tests
```

### References

- [Source: architecture.md#Database-Schema] - strategy_instances table structure
- [Source: architecture.md#Module-Architecture] - Folder-per-module pattern
- [Source: epics.md#Story-6.4] - Story requirements and acceptance criteria
- [Source: prd.md#FR34] - Update central components when proven
- [Source: 6-1-strategy-component-registry.md] - Registry implementation details
- [Source: 6-2-strategy-composition.md] - Composer implementation details
- [Source: 6-3-strategy-forking.md] - Forking and diff implementation details
- [Source: src/modules/strategy/composer.js] - Existing composition functions
- [Source: src/modules/strategy/logic.js] - Registry functions including catalog management
- [Source: src/modules/strategy/types.js] - Existing error codes
- [Source: src/modules/strategy/state.js] - Catalog state management functions

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List

