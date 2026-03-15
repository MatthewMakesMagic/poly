/**
 * Compose Engine — YAML to Strategy Object (Story 2.6)
 *
 * Compiles parsed YAML definitions into runnable strategy objects that match
 * the existing strategy interface contract: { name, evaluate, onWindowOpen, defaults, sweepGrid }
 *
 * Pipeline: YAML string → parseStrategyYaml → composeFromDefinition → strategy object
 *
 * Covers: FR4 (YAML parsing), FR5 (signal combination), NFR5 (<100ms), NFR12 (interface contract)
 */

import { parseStrategyYaml } from './parser.js';
import { getBlock, isInitialized, loadBlocks } from './registry.js';

/**
 * Compose a strategy object from a YAML string.
 *
 * @param {string} yamlString - Raw YAML strategy definition
 * @returns {Promise<{ name: string, evaluate: Function, onWindowOpen: Function, defaults: Object, sweepGrid: Object }>}
 * @throws {Error} If YAML is invalid or blocks are missing
 */
export async function composeFromYaml(yamlString) {
  if (!isInitialized()) {
    await loadBlocks();
  }

  const { definition, sweepGrid, defaults } = parseStrategyYaml(yamlString);
  return composeFromDefinition(definition, sweepGrid, defaults);
}

/**
 * Compose a strategy object from a parsed definition.
 *
 * @param {Object} definition - Parsed strategy definition
 * @param {Object} [sweepGrid] - Pre-extracted sweep grid (optional, extracted from definition.params if not provided)
 * @param {Object} [defaults] - Pre-extracted defaults (optional)
 * @returns {{ name: string, evaluate: Function, onWindowOpen: Function, defaults: Object, sweepGrid: Object }}
 * @throws {Error} If block references are invalid
 */
export function composeFromDefinition(definition, sweepGrid, defaults) {
  if (!isInitialized()) {
    throw new Error(
      'Compose engine: block registry not initialized — call loadBlocks() before composeFromDefinition(). ' +
      'This is a startup sequencing issue.'
    );
  }

  // Validate definition structure
  validateDefinition(definition);

  // Instantiate signal blocks
  const signalInstances = definition.signals.map((sigDef, i) => {
    const block = getBlock('signal', sigDef.type);
    const instance = block.create(sigDef.params || {});
    return { instance, def: sigDef, index: i };
  });

  // Instantiate filter blocks
  const filterInstances = (definition.filters || []).map((filterDef, i) => {
    const block = getBlock('filter', filterDef.type);
    const instance = block.create(filterDef.params || {});
    return { instance, def: filterDef, index: i };
  });

  // Instantiate sizer block
  const sizerBlock = getBlock('sizer', definition.sizer.type);
  const sizerInstance = sizerBlock.create(definition.sizer.params || {});

  // Determine combination operator
  const combineOp = definition.combine || 'all-of';

  // Build the strategy evaluate function
  function evaluate(state, config = {}) {
    // 1. Evaluate all signals
    const signalResults = signalInstances.map(({ instance }) => {
      return instance.evaluate(state, config);
    });

    // 2. Combine signals via operator
    const combined = combineSignals(signalResults, combineOp);
    if (!combined.direction) return [];

    // 3. Apply all filters (all must pass)
    for (const { instance } of filterInstances) {
      const passes = instance(state, config, combined);
      if (!passes) return [];
    }

    // 4. Size the position
    const sizing = sizerInstance(state, config, combined);

    // 5. Build standard signal output
    const symbol = state.window?.symbol || 'unknown';
    const token = `${symbol}-${combined.direction.toLowerCase()}`;

    return [{
      action: 'buy',
      token,
      capitalPerTrade: sizing.capitalPerTrade,
      reason: combined.reason,
      confidence: combined.strength,
    }];
  }

  // Build onWindowOpen — resets all stateful blocks
  function onWindowOpen(state, config) {
    for (const { instance } of signalInstances) {
      if (typeof instance.reset === 'function') {
        instance.reset();
      }
    }
    for (const { instance } of filterInstances) {
      if (typeof instance.reset === 'function') {
        instance.reset();
      }
    }
  }

  // Build defaults and sweepGrid from definition if not pre-extracted
  const strategyDefaults = defaults || extractDefaults(definition);
  const strategySweepGrid = sweepGrid || {};

  return {
    name: definition.name,
    evaluate,
    onWindowOpen,
    defaults: strategyDefaults,
    sweepGrid: strategySweepGrid,
    _definition: definition,  // Retained for timeline trimmer source analysis
  };
}

/**
 * Combine signal results using the specified operator.
 *
 * @param {Object[]} results - Array of { direction, strength, reason }
 * @param {string} operator - 'all-of' or 'any-of'
 * @returns {{ direction: string|null, strength: number, reason: string }}
 */
function combineSignals(results, operator) {
  if (results.length === 0) {
    return { direction: null, strength: 0, reason: 'no signals configured' };
  }

  if (operator === 'all-of') {
    // All signals must agree on direction (non-null)
    const activeResults = results.filter(r => r.direction != null);
    if (activeResults.length !== results.length) {
      // Not all signals fired
      const silentIndices = results
        .map((r, i) => r.direction == null ? i : -1)
        .filter(i => i >= 0);
      return {
        direction: null,
        strength: 0,
        reason: `all-of: ${silentIndices.length}/${results.length} signals inactive`,
      };
    }

    // Check direction consensus
    const directions = new Set(activeResults.map(r => r.direction));
    if (directions.size > 1) {
      return {
        direction: null,
        strength: 0,
        reason: 'all-of: signals disagree on direction',
      };
    }

    // All agree — combine strengths (average) and reasons
    const avgStrength = activeResults.reduce((sum, r) => sum + r.strength, 0) / activeResults.length;
    const reasons = activeResults.map(r => r.reason).join(' + ');

    return {
      direction: activeResults[0].direction,
      strength: avgStrength,
      reason: reasons,
    };
  }

  if (operator === 'any-of') {
    // Any signal with a non-null direction triggers
    // Pick the strongest
    let best = null;
    for (const r of results) {
      if (r.direction != null) {
        if (!best || r.strength > best.strength) {
          best = r;
        }
      }
    }

    if (!best) {
      return {
        direction: null,
        strength: 0,
        reason: 'any-of: no signals fired',
      };
    }

    return {
      direction: best.direction,
      strength: best.strength,
      reason: best.reason,
    };
  }

  throw new Error(`Unknown combine operator '${operator}'. Valid: all-of, any-of`);
}

/**
 * Validate a definition object has required structure.
 *
 * @param {Object} definition
 * @throws {Error} If validation fails
 */
export function validateDefinition(definition) {
  const errors = [];

  if (!definition || typeof definition !== 'object') {
    throw new Error('validateDefinition: definition must be a non-null object');
  }

  if (!definition.name || typeof definition.name !== 'string') {
    errors.push("'name' is required and must be a string");
  }

  if (!Array.isArray(definition.signals) || definition.signals.length === 0) {
    errors.push("'signals' is required and must be a non-empty array");
  }

  if (!definition.sizer || typeof definition.sizer !== 'object' || !definition.sizer.type) {
    errors.push("'sizer' is required with a 'type' field");
  }

  if (definition.combine != null && !['all-of', 'any-of'].includes(definition.combine)) {
    errors.push(`'combine' must be 'all-of' or 'any-of', got '${definition.combine}'`);
  }

  // Validate block references against registry
  if (isInitialized()) {
    if (Array.isArray(definition.signals)) {
      for (const sig of definition.signals) {
        if (sig?.type) {
          try { getBlock('signal', sig.type); }
          catch { errors.push(`Signal block '${sig.type}' not found in registry`); }
        }
      }
    }
    if (Array.isArray(definition.filters)) {
      for (const f of definition.filters) {
        if (f?.type) {
          try { getBlock('filter', f.type); }
          catch { errors.push(`Filter block '${f.type}' not found in registry`); }
        }
      }
    }
    if (definition.sizer?.type) {
      try { getBlock('sizer', definition.sizer.type); }
      catch { errors.push(`Sizer block '${definition.sizer.type}' not found in registry`); }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Definition validation failed for '${definition.name || '<unnamed>'}':\n  - ${errors.join('\n  - ')}`
    );
  }
}

/**
 * Extract default parameter values from a definition.
 *
 * @param {Object} definition
 * @returns {Object} Merged defaults
 */
function extractDefaults(definition) {
  const defaults = {};

  if (definition.params) {
    Object.assign(defaults, definition.params);
  }

  return defaults;
}
