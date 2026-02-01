/**
 * Strategy Module State Management
 *
 * In-memory state for the strategy registry module.
 * Maintains initialization state, configuration, and component catalog.
 */

// Module configuration
let moduleConfig = null;

// Initialization state
let initialized = false;

// In-memory component catalog
// Structure: { probability: { 'prob-name-v1': componentInfo, ... }, ... }
// Epic 6 types: probability, entry, exit, sizing
// Epic 7 types: price-source, analysis, signal-generator
let componentCatalog = {
  probability: {},
  entry: {},
  exit: {},
  sizing: {},
  // Epic 7: Oracle Edge Infrastructure types
  'price-source': {},
  analysis: {},
  'signal-generator': {},
};

// Statistics
let stats = {
  strategiesRegistered: 0,
  componentsDiscovered: 0,
};

/**
 * Check if module is initialized
 * @returns {boolean} True if initialized
 */
export function isInitialized() {
  return initialized;
}

/**
 * Set initialization state
 * @param {boolean} state - Initialization state
 */
export function setInitialized(state) {
  initialized = state;
}

/**
 * Store module configuration
 * @param {Object} config - Module configuration
 */
export function setConfig(config) {
  moduleConfig = config;
}

/**
 * Get module configuration
 * @returns {Object|null} Module configuration
 */
export function getConfig() {
  return moduleConfig;
}

/**
 * Get the component catalog
 * @returns {Object} Component catalog by type
 */
export function getCatalog() {
  return componentCatalog;
}

/**
 * Set the component catalog
 * @param {Object} catalog - Component catalog by type
 */
export function setCatalog(catalog) {
  componentCatalog = catalog;
  // Update discovered count
  stats.componentsDiscovered = Object.values(catalog).reduce(
    (sum, type) => sum + Object.keys(type).length,
    0
  );
}

/**
 * Add a component to the catalog
 * @param {string} type - Component type (probability, entry, exit, sizing)
 * @param {string} versionId - Component version ID
 * @param {Object} componentInfo - Component metadata and module reference
 */
export function addToCatalog(type, versionId, componentInfo) {
  if (!componentCatalog[type]) {
    componentCatalog[type] = {};
  }
  componentCatalog[type][versionId] = componentInfo;
  stats.componentsDiscovered++;
}

/**
 * Get a component from the catalog
 * @param {string} versionId - Component version ID
 * @returns {Object|null} Component info or null if not found
 */
export function getFromCatalog(versionId) {
  for (const type of Object.keys(componentCatalog)) {
    if (componentCatalog[type][versionId]) {
      return componentCatalog[type][versionId];
    }
  }
  return null;
}

/**
 * Increment strategy registration count
 */
export function incrementStrategyCount() {
  stats.strategiesRegistered++;
}

/**
 * Get current statistics
 * @returns {Object} Current stats
 */
export function getStats() {
  return { ...stats };
}

/**
 * Reset all state (for shutdown)
 */
export function resetState() {
  moduleConfig = null;
  initialized = false;
  componentCatalog = {
    probability: {},
    entry: {},
    exit: {},
    sizing: {},
    // Epic 7: Oracle Edge Infrastructure types
    'price-source': {},
    analysis: {},
    'signal-generator': {},
  };
  stats = {
    strategiesRegistered: 0,
    componentsDiscovered: 0,
  };
}

/**
 * Get module state snapshot
 * @returns {Object} Current state
 */
export function getStateSnapshot() {
  return {
    initialized,
    hasConfig: moduleConfig !== null,
    stats: getStats(),
    catalogSummary: {
      probability: Object.keys(componentCatalog.probability).length,
      entry: Object.keys(componentCatalog.entry).length,
      exit: Object.keys(componentCatalog.exit).length,
      sizing: Object.keys(componentCatalog.sizing).length,
      // Epic 7: Oracle Edge Infrastructure types
      'price-source': Object.keys(componentCatalog['price-source'] || {}).length,
      analysis: Object.keys(componentCatalog.analysis || {}).length,
      'signal-generator': Object.keys(componentCatalog['signal-generator'] || {}).length,
    },
  };
}
