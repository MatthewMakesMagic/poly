/**
 * Module-specific type definitions
 *
 * Define types that are specific to this module here.
 * Shared types should go in src/types/
 */

// Example: Module-specific status enum
const ModuleStatus = {
  IDLE: 'idle',
  PROCESSING: 'processing',
  ERROR: 'error',
};

// Example: Module-specific data structure
function createModuleData(params) {
  return {
    id: params.id,
    createdAt: new Date().toISOString(),
    // Add module-specific fields
  };
}

export { ModuleStatus, createModuleData };
