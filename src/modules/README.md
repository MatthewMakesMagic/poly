# Poly Modules

This directory contains bounded modules for the poly trading system.

## Module Architecture

Each module follows the **folder-per-module** pattern with a consistent structure:

```
module-name/
├── index.js        # Public interface (exports init, getState, shutdown)
├── logic.js        # Business logic (optional)
├── state.js        # Internal state management (optional)
├── types.js        # Module-specific types (optional)
└── __tests__/      # Co-located tests
    ├── index.test.js
    └── logic.test.js
```

## Module Interface Contract

**Every module MUST export these functions:**

```javascript
module.exports = {
  // Initialize with configuration
  init: async (config) => {},

  // Return current state (for debugging/reconciliation)
  getState: () => {},

  // Graceful shutdown
  shutdown: async () => {}
};
```

## Creating a New Module

1. Copy the template:
   ```bash
   cp -r src/modules/_template src/modules/your-module-name
   ```

2. Rename files and update imports

3. Implement your module logic

4. Write tests in `__tests__/`

## Rules

1. **Modules never import each other directly** - All coordination goes through the orchestrator

2. **All public functions return Promises** - Use async/await

3. **Errors are thrown, never swallowed** - Use typed errors from `src/types/errors.js`

4. **State is inspectable** - `getState()` returns a clean snapshot

5. **Shutdown is graceful** - Clean up resources in `shutdown()`

## Naming Conventions

| Category | Convention | Example |
|----------|------------|---------|
| Folders | kebab-case | `position-manager/` |
| Files | kebab-case | `order-logic.js` |
| Functions | camelCase | `getPosition()` |
| Constants | UPPER_SNAKE | `MAX_RETRIES` |

## Current Modules

- `_template/` - Template for creating new modules (do not deploy)
- *(Add modules as they are created)*

## Module Dependency Graph

```
                    Orchestrator
                         │
    ┌────────┬──────────┼──────────┬─────────┐
    │        │          │          │         │
    ▼        ▼          ▼          ▼         ▼
Position  Order     Stop-Loss  Take-Profit  Logger
Manager   Manager
    │        │
    └────────┴──────────┐
                        ▼
                   Persistence
```

All modules are called by the orchestrator. No direct module-to-module imports.
