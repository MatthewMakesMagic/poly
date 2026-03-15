/**
 * Mutation Engine (Stories 4.2, 4.3, 4.4)
 *
 * Generates strategy variants via three mutation types:
 * 1. Parameter perturbation — vary numeric params within semantic bounds
 * 2. Structural mutation — add/remove signals and filters
 * 3. Strategy crossover — combine elements from two strategies
 *
 * All mutations produce valid YAML definitions that pass parser validation.
 * Each variant gets a unique name and lineage is recorded.
 *
 * CRITICAL: Semantic param bounds enforced per Cassandra's spec:
 *   - Prices (0-1 range like maxPrice, side probabilities) stay in [0, 1]
 *   - Thresholds stay within [0.2x, 5x] of original value
 *   - Counts/integers stay positive integers
 *   - Time values (ms) stay positive
 *   - Capital values stay positive
 *
 * Covers: FR10 (param perturbation), FR11 (structural mutation),
 *         FR12 (crossover), FR13 (batch generation), FR14 (lineage), FR15 (reasoning)
 */

import yaml from 'js-yaml';
import { parseStrategyYaml } from './parser.js';
import { listBlocks, isInitialized, loadBlocks } from './registry.js';
import { validateDefinition } from './compose.js';
import {
  recordMutation,
  getChildren,
  generateMutationNames,
} from './lineage.js';

import { createPrng } from './utils/prng.js';

// ─── Param Bound Classification ───

/**
 * Known parameter names that represent prices in [0, 1] range (binary market probabilities).
 */
const PRICE_PARAMS = new Set([
  'maxPrice', 'minPrice', 'maxAsk', 'minBid',
  'fvGateThreshold', 'absoluteFloor', 'absoluteCeiling',
]);

/**
 * Known parameter names that must be positive integers.
 */
const INTEGER_PARAMS = new Set([
  'count', 'minCount', 'maxCount', 'lookback', 'minDataPoints',
  'windowCount', 'resamples',
]);

/**
 * Known parameter names that represent time in milliseconds (must be positive).
 */
const TIME_PARAMS = new Set([
  'entryWindowMs', 'cooldownMs', 'minTimeSec', 'windowDurationMs',
  'checkIntervalMs',
]);

/**
 * Known parameter names that represent capital/dollar amounts (must be positive).
 */
const CAPITAL_PARAMS = new Set([
  'capitalPerTrade', 'maxCapital', 'minCapital', 'bankroll',
  'baseSizeDollars', 'minSizeDollars',
]);

/**
 * Classify a parameter and return its semantic bounds.
 *
 * @param {string} name - Parameter name
 * @param {number} originalValue - Current value
 * @returns {{ min: number, max: number, isInteger: boolean }}
 */
function getParamBounds(name, originalValue) {
  // Price parameters: [0, 1]
  if (PRICE_PARAMS.has(name)) {
    return { min: 0, max: 1, isInteger: false };
  }

  // Detect price-like values heuristically (value in 0-1 range with name hints)
  if (originalValue > 0 && originalValue <= 1 &&
      (name.toLowerCase().includes('price') || name.toLowerCase().includes('prob'))) {
    return { min: 0, max: 1, isInteger: false };
  }

  // Integer parameters
  if (INTEGER_PARAMS.has(name)) {
    return { min: 1, max: Math.max(originalValue * 5, 1), isInteger: true };
  }

  // Time parameters: must be positive
  if (TIME_PARAMS.has(name)) {
    return { min: 1, max: originalValue * 5, isInteger: true };
  }

  // Capital parameters: must be positive
  if (CAPITAL_PARAMS.has(name)) {
    return { min: 0.01, max: originalValue * 5, isInteger: false };
  }

  // General numeric threshold: [0.2x, 5x] of original
  if (originalValue > 0) {
    return { min: originalValue * 0.2, max: originalValue * 5, isInteger: false };
  }

  // Negative or zero values — apply symmetric bounds
  if (originalValue < 0) {
    return { min: originalValue * 5, max: originalValue * 0.2, isInteger: false };
  }

  // Zero: allow small positive range
  return { min: 0, max: 1, isInteger: false };
}

/**
 * Clamp a value within semantic bounds.
 *
 * @param {number} value - Value to clamp
 * @param {{ min: number, max: number, isInteger: boolean }} bounds
 * @returns {number}
 */
function clampToBounds(value, bounds) {
  let clamped = Math.max(bounds.min, Math.min(bounds.max, value));
  if (bounds.isInteger) {
    clamped = Math.round(clamped);
    clamped = Math.max(1, clamped); // Integers must be at least 1
  }
  return clamped;
}

// ─── Story 4.2: Parameter Perturbation ───

/**
 * Generate N parameter-perturbed variants of a YAML strategy definition.
 *
 * @param {string} yamlDef - YAML strategy definition string
 * @param {Object} options
 * @param {number} [options.count=10] - Number of variants to generate
 * @param {number[]} [options.perturbPct=[0.1, 0.2, 0.5]] - Perturbation percentages
 * @param {number} [options.seed=42] - PRNG seed for reproducibility
 * @param {boolean} [options.recordLineage=false] - Whether to record lineage in DB
 * @param {string} [options.createdBy='claude'] - Who created the variants
 * @returns {Promise<{ variants: Object[], errors: string[] }>}
 *   Each variant: { name, yamlString, definition, changes: { param, from, to }[] }
 */
export async function perturbParams(yamlDef, options = {}) {
  const {
    count = 10,
    perturbPct = [0.1, 0.2, 0.5],
    seed = 42,
    recordLineage = false,
    createdBy = 'claude',
  } = options;

  if (!isInitialized()) {
    await loadBlocks();
  }

  // Parse the source strategy
  const { definition } = parseStrategyYaml(yamlDef);
  const parentName = definition.name;

  // Collect all numeric parameters that can be perturbed
  const numericParams = collectNumericParams(definition);

  if (numericParams.length === 0) {
    return {
      variants: [],
      errors: [`Strategy '${parentName}' has no numeric parameters to perturb`],
    };
  }

  // Get existing children for naming
  let existingChildren = [];
  if (recordLineage) {
    try {
      existingChildren = await getChildren(parentName);
    } catch {
      // DB may not be available
    }
  }
  const names = generateMutationNames(parentName, count, existingChildren);

  const rng = createPrng(seed);
  const variants = [];
  const errors = [];

  for (let i = 0; i < count; i++) {
    try {
      const variant = generatePerturbedVariant(
        definition, yamlDef, names[i], numericParams, perturbPct, rng
      );

      // Validate the variant passes parser
      try {
        parseStrategyYaml(variant.yamlString);
      } catch (parseErr) {
        errors.push(`Variant '${names[i]}' failed parser validation: ${parseErr.message}`);
        continue;
      }

      variants.push(variant);

      // Record lineage if enabled
      if (recordLineage) {
        try {
          const reasoning = variant.changes
            .map(c => `${c.param}: ${c.from} -> ${c.to}`)
            .join(', ');
          await recordMutation(parentName, variant.name, {
            mutationType: 'param_perturb',
            reasoning: `Parameter perturbation: ${reasoning}`,
            yamlDefinition: variant.yamlString,
            createdBy,
          });
        } catch {
          // Don't fail variant generation on lineage errors
        }
      }
    } catch (err) {
      errors.push(`Failed to generate variant ${i + 1}: ${err.message}`);
    }
  }

  return { variants, errors };
}

/**
 * Collect all numeric parameters from a strategy definition.
 * Returns array of { path, name, value } for each numeric param found.
 *
 * @param {Object} definition
 * @returns {{ path: string, name: string, value: number }[]}
 */
function collectNumericParams(definition) {
  const params = [];

  // Signal params
  if (Array.isArray(definition.signals)) {
    for (let si = 0; si < definition.signals.length; si++) {
      const sig = definition.signals[si];
      if (sig.params) {
        for (const [key, val] of Object.entries(sig.params)) {
          if (typeof val === 'number') {
            params.push({ path: `signals[${si}].params.${key}`, name: key, value: val });
          }
        }
      }
    }
  }

  // Filter params
  if (Array.isArray(definition.filters)) {
    for (let fi = 0; fi < definition.filters.length; fi++) {
      const f = definition.filters[fi];
      if (f.params) {
        for (const [key, val] of Object.entries(f.params)) {
          if (typeof val === 'number') {
            params.push({ path: `filters[${fi}].params.${key}`, name: key, value: val });
          }
        }
      }
    }
  }

  // Sizer params
  if (definition.sizer?.params) {
    for (const [key, val] of Object.entries(definition.sizer.params)) {
      if (typeof val === 'number') {
        params.push({ path: `sizer.params.${key}`, name: key, value: val });
      }
    }
  }

  // Top-level params
  if (definition.params) {
    for (const [key, val] of Object.entries(definition.params)) {
      if (typeof val === 'number') {
        params.push({ path: `params.${key}`, name: key, value: val });
      }
    }
  }

  return params;
}

/**
 * Generate a single perturbed variant.
 */
function generatePerturbedVariant(definition, originalYaml, variantName, numericParams, perturbPct, rng) {
  // Deep clone the definition
  const variant = JSON.parse(JSON.stringify(definition));
  variant.name = variantName;

  const changes = [];

  // For each numeric param, randomly decide whether to perturb it
  for (const param of numericParams) {
    // 70% chance to perturb each param (keeps some variants with fewer changes)
    if (rng() > 0.7) continue;

    // Pick a random perturbation percentage
    const pctIdx = Math.floor(rng() * perturbPct.length);
    const pct = perturbPct[pctIdx];

    // Direction: up or down
    const direction = rng() > 0.5 ? 1 : -1;
    const delta = param.value * pct * direction;

    const bounds = getParamBounds(param.name, param.value);
    const newValue = clampToBounds(param.value + delta, bounds);

    // Only record a change if it actually changed
    if (newValue !== param.value) {
      setNestedParam(variant, param.path, newValue);
      changes.push({
        param: param.path,
        from: param.value,
        to: roundSig(newValue, 6),
      });
    }
  }

  // If no params were changed (unlikely but possible), force at least one
  if (changes.length === 0 && numericParams.length > 0) {
    const param = numericParams[Math.floor(rng() * numericParams.length)];
    const pct = perturbPct[Math.floor(rng() * perturbPct.length)];
    const direction = rng() > 0.5 ? 1 : -1;
    const bounds = getParamBounds(param.name, param.value);
    const newValue = clampToBounds(param.value + param.value * pct * direction, bounds);

    setNestedParam(variant, param.path, newValue);
    changes.push({ param: param.path, from: param.value, to: roundSig(newValue, 6) });
  }

  // Build YAML string from variant definition
  const yamlString = definitionToYaml(variant);

  return {
    name: variantName,
    yamlString,
    definition: variant,
    changes,
  };
}

/**
 * Set a nested parameter value using dot-path notation.
 * Supports paths like "signals[0].params.threshold"
 */
function setNestedParam(obj, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = /^\d+$/.test(parts[i]) ? parseInt(parts[i], 10) : parts[i];
    current = current[part];
  }
  const lastPart = /^\d+$/.test(parts[parts.length - 1])
    ? parseInt(parts[parts.length - 1], 10)
    : parts[parts.length - 1];
  current[lastPart] = roundSig(value, 6);
}

/**
 * Round a number to N significant figures.
 */
function roundSig(num, sigFigs) {
  if (num === 0) return 0;
  const d = Math.ceil(Math.log10(Math.abs(num)));
  const power = sigFigs - d;
  const magnitude = Math.pow(10, power);
  return Math.round(num * magnitude) / magnitude;
}

// ─── Story 4.3: Structural Mutations ───

/**
 * Generate a structural mutation of a strategy (add/remove signal or filter).
 *
 * @param {string} yamlDef - YAML strategy definition string
 * @param {Object} options
 * @param {string} [options.action] - 'add-signal' | 'remove-signal' | 'add-filter' | 'remove-filter' (random if not specified)
 * @param {string} [options.blockName] - Specific block to add (random from registry if not specified)
 * @param {number} [options.seed=42] - PRNG seed
 * @param {boolean} [options.recordLineage=false]
 * @param {string} [options.createdBy='claude']
 * @param {string} [options.variantName] - Override variant name
 * @returns {Promise<{ variant: Object|null, error: string|null }>}
 */
export async function structuralMutate(yamlDef, options = {}) {
  const {
    action: requestedAction,
    blockName,
    seed = 42,
    recordLineage = false,
    createdBy = 'claude',
    variantName,
  } = options;

  if (!isInitialized()) {
    await loadBlocks();
  }

  const { definition } = parseStrategyYaml(yamlDef);
  const parentName = definition.name;
  const rng = createPrng(seed);
  const blocks = listBlocks();

  // Determine action
  const possibleActions = getPossibleStructuralActions(definition, blocks);
  if (possibleActions.length === 0) {
    return { variant: null, error: 'No valid structural mutations available for this strategy' };
  }

  // If a specific action was requested but is not possible, return error
  if (requestedAction && !possibleActions.includes(requestedAction)) {
    return { variant: null, error: `Requested action '${requestedAction}' is not possible for this strategy` };
  }

  const action = requestedAction || possibleActions[Math.floor(rng() * possibleActions.length)];

  // Deep clone
  const variant = JSON.parse(JSON.stringify(definition));

  let reasoning;

  switch (action) {
    case 'add-signal': {
      const existingTypes = new Set(variant.signals.map(s => s.type));
      const available = blocks.signal.filter(b => !existingTypes.has(b.name));
      if (available.length === 0) {
        return { variant: null, error: 'All available signals already in strategy' };
      }
      const chosen = blockName
        ? available.find(b => b.name === blockName)
        : available[Math.floor(rng() * available.length)];
      if (!chosen) {
        return { variant: null, error: `Signal block '${blockName}' not available or already in strategy` };
      }

      // Build default params from schema
      const params = buildDefaultParams(chosen.paramSchema);
      variant.signals.push({ type: chosen.name, ...(Object.keys(params).length > 0 ? { params } : {}) });
      reasoning = `Added signal '${chosen.name}' to explore additional market edge`;
      break;
    }

    case 'remove-signal': {
      if (variant.signals.length <= 1) {
        return { variant: null, error: 'Cannot remove last signal — strategy must have at least one' };
      }
      const idx = Math.floor(rng() * variant.signals.length);
      const removed = variant.signals.splice(idx, 1)[0];
      reasoning = `Removed signal '${removed.type}' to simplify strategy and reduce overfitting risk`;
      break;
    }

    case 'add-filter': {
      const existingFilterTypes = new Set((variant.filters || []).map(f => f.type));
      const availableFilters = blocks.filter.filter(b => !existingFilterTypes.has(b.name));
      if (availableFilters.length === 0) {
        return { variant: null, error: 'All available filters already in strategy' };
      }
      const chosen = blockName
        ? availableFilters.find(b => b.name === blockName)
        : availableFilters[Math.floor(rng() * availableFilters.length)];
      if (!chosen) {
        return { variant: null, error: `Filter block '${blockName}' not available or already in strategy` };
      }

      const params = buildDefaultParams(chosen.paramSchema);
      if (!variant.filters) variant.filters = [];
      variant.filters.push({ type: chosen.name, ...(Object.keys(params).length > 0 ? { params } : {}) });
      reasoning = `Added filter '${chosen.name}' to improve entry quality`;
      break;
    }

    case 'remove-filter': {
      if (!variant.filters || variant.filters.length === 0) {
        return { variant: null, error: 'No filters to remove' };
      }
      const idx = Math.floor(rng() * variant.filters.length);
      const removed = variant.filters.splice(idx, 1)[0];
      reasoning = `Removed filter '${removed.type}' to increase trade frequency`;
      break;
    }

    default:
      return { variant: null, error: `Unknown structural action '${action}'` };
  }

  // Assign name
  let name;
  if (variantName) {
    name = variantName;
  } else {
    let existingChildren = [];
    if (recordLineage) {
      try { existingChildren = await getChildren(parentName); } catch { /* DB may not be available */ }
    }
    name = generateMutationNames(parentName, 1, existingChildren)[0];
  }
  variant.name = name;

  // Validate
  try {
    validateDefinition(variant);
  } catch (err) {
    return { variant: null, error: `Structural variant failed validation: ${err.message}` };
  }

  const yamlString = definitionToYaml(variant);

  // Verify YAML round-trips
  try {
    parseStrategyYaml(yamlString);
  } catch (err) {
    return { variant: null, error: `Structural variant YAML failed round-trip: ${err.message}` };
  }

  // Record lineage
  if (recordLineage) {
    try {
      await recordMutation(parentName, name, {
        mutationType: 'structural',
        reasoning,
        yamlDefinition: yamlString,
        createdBy,
      });
    } catch { /* Don't fail on lineage errors */ }
  }

  return {
    variant: { name, yamlString, definition: variant, action, reasoning },
    error: null,
  };
}

/**
 * Get possible structural actions for a definition.
 */
function getPossibleStructuralActions(definition, blocks) {
  const actions = [];

  // Can always add signals if there are unused ones
  const existingSignals = new Set(definition.signals.map(s => s.type));
  if (blocks.signal.some(b => !existingSignals.has(b.name))) {
    actions.push('add-signal');
  }

  // Can remove signal if there's more than one
  if (definition.signals.length > 1) {
    actions.push('remove-signal');
  }

  // Can always add filters if there are unused ones
  const existingFilters = new Set((definition.filters || []).map(f => f.type));
  if (blocks.filter.some(b => !existingFilters.has(b.name))) {
    actions.push('add-filter');
  }

  // Can remove filter if there are any
  if (definition.filters && definition.filters.length > 0) {
    actions.push('remove-filter');
  }

  return actions;
}

/**
 * Build default parameter object from a block's paramSchema.
 */
function buildDefaultParams(paramSchema) {
  const params = {};
  for (const [key, schema] of Object.entries(paramSchema || {})) {
    if (schema.default != null) {
      params[key] = schema.default;
    }
  }
  return params;
}

// ─── Story 4.4: Strategy Crossover ───

/**
 * Cross over two strategies: combine signals from A with filters from B,
 * or mix-and-match elements.
 *
 * @param {string} yamlDefA - First strategy YAML
 * @param {string} yamlDefB - Second strategy YAML
 * @param {Object} options
 * @param {string} [options.mode='signals-filters'] - 'signals-filters' (A signals + B filters) or 'mix' (random mix)
 * @param {number} [options.seed=42]
 * @param {boolean} [options.recordLineage=false]
 * @param {string} [options.createdBy='claude']
 * @param {string} [options.variantName] - Override name
 * @returns {Promise<{ variant: Object|null, error: string|null }>}
 */
export async function crossover(yamlDefA, yamlDefB, options = {}) {
  const {
    mode = 'signals-filters',
    seed = 42,
    recordLineage = false,
    createdBy = 'claude',
    variantName,
  } = options;

  if (!isInitialized()) {
    await loadBlocks();
  }

  const { definition: defA } = parseStrategyYaml(yamlDefA);
  const { definition: defB } = parseStrategyYaml(yamlDefB);
  const rng = createPrng(seed);

  let crossoverDef;
  let reasoning;

  if (mode === 'signals-filters') {
    // Take signals from A, filters from B, sizer from A
    crossoverDef = {
      name: '', // Set below
      description: `Crossover: signals from ${defA.name}, filters from ${defB.name}`,
      version: 1,
      hypothesis: `Combining ${defA.name} signal logic with ${defB.name} entry controls`,
      signals: JSON.parse(JSON.stringify(defA.signals)),
      filters: JSON.parse(JSON.stringify(defB.filters || [])),
      sizer: JSON.parse(JSON.stringify(defA.sizer)),
      combine: defA.combine || 'all-of',
      params: {},
    };
    reasoning = `Crossover: signals from '${defA.name}' (${defA.signals.map(s => s.type).join(', ')}) ` +
      `with filters from '${defB.name}' (${(defB.filters || []).map(f => f.type).join(', ') || 'none'})`;

  } else if (mode === 'mix') {
    // Random mix: for each component, pick from A or B
    const useASignals = rng() > 0.5;
    const useAFilters = rng() > 0.5;
    const useASizer = rng() > 0.5;

    crossoverDef = {
      name: '',
      description: `Mixed crossover from ${defA.name} and ${defB.name}`,
      version: 1,
      hypothesis: `Mixed recombination exploring novel signal-filter-sizer combinations`,
      signals: JSON.parse(JSON.stringify(useASignals ? defA.signals : defB.signals)),
      filters: JSON.parse(JSON.stringify(useAFilters ? (defA.filters || []) : (defB.filters || []))),
      sizer: JSON.parse(JSON.stringify(useASizer ? defA.sizer : defB.sizer)),
      combine: (rng() > 0.5 ? defA.combine : defB.combine) || 'all-of',
      params: {},
    };
    reasoning = `Mixed crossover: signals from '${useASignals ? defA.name : defB.name}', ` +
      `filters from '${useAFilters ? defA.name : defB.name}', ` +
      `sizer from '${useASizer ? defA.name : defB.name}'`;

  } else if (mode === 'sizer-swap') {
    // Take everything from A but swap in B's sizer
    crossoverDef = {
      name: '',
      description: `Sizer swap: ${defA.name} with ${defB.name}'s sizer`,
      version: 1,
      hypothesis: `Testing ${defA.name} with different position sizing`,
      signals: JSON.parse(JSON.stringify(defA.signals)),
      filters: JSON.parse(JSON.stringify(defA.filters || [])),
      sizer: JSON.parse(JSON.stringify(defB.sizer)),
      combine: defA.combine || 'all-of',
      params: {},
    };
    reasoning = `Sizer swap: '${defA.name}' logic with '${defB.name}' sizer (${defB.sizer.type})`;

  } else {
    return { variant: null, error: `Unknown crossover mode '${mode}'. Valid: signals-filters, mix, sizer-swap` };
  }

  // Generate name
  const baseName = `${simplifyName(defA.name)}-x-${simplifyName(defB.name)}`;
  let name;
  if (variantName) {
    name = variantName;
  } else {
    let existingChildren = [];
    if (recordLineage) {
      try { existingChildren = await getChildren(baseName); } catch { /* */ }
    }
    name = generateMutationNames(baseName, 1, existingChildren)[0];
  }
  crossoverDef.name = name;

  // Validate
  try {
    validateDefinition(crossoverDef);
  } catch (err) {
    return { variant: null, error: `Crossover variant failed validation: ${err.message}` };
  }

  const yamlString = definitionToYaml(crossoverDef);

  // Verify YAML round-trips
  try {
    parseStrategyYaml(yamlString);
  } catch (err) {
    return { variant: null, error: `Crossover variant YAML failed round-trip: ${err.message}` };
  }

  // Record lineage for both parents
  if (recordLineage) {
    try {
      await recordMutation(defA.name, name, {
        mutationType: 'crossover',
        reasoning: `${reasoning} (parent B: ${defB.name})`,
        yamlDefinition: yamlString,
        createdBy,
      });
    } catch { /* Don't fail on lineage errors */ }
  }

  return {
    variant: {
      name,
      yamlString,
      definition: crossoverDef,
      parents: [defA.name, defB.name],
      mode,
      reasoning,
    },
    error: null,
  };
}

/**
 * Simplify a strategy name for crossover naming.
 * "edge-c-asymmetry" -> "edge-c"
 */
function simplifyName(name) {
  // Take first two segments
  const parts = name.split('-');
  return parts.slice(0, Math.min(2, parts.length)).join('-');
}

// ─── Story 4.5: Batch Mutation Generation ───

/**
 * Generate a batch of mutations of mixed types.
 *
 * @param {string} yamlDef - Source strategy YAML
 * @param {Object} options
 * @param {number} [options.count=20] - Total variants to generate
 * @param {string} [options.type='perturb'] - 'perturb' | 'structural' | 'mixed'
 * @param {number} [options.seed=42] - PRNG seed
 * @param {boolean} [options.recordLineage=false]
 * @param {string} [options.createdBy='claude']
 * @param {string} [options.crossoverYaml] - Second strategy YAML for crossovers (used in 'mixed' mode)
 * @returns {Promise<{ variants: Object[], summary: Object[], errors: string[] }>}
 */
export async function batchMutate(yamlDef, options = {}) {
  const {
    count = 20,
    type = 'perturb',
    seed = 42,
    recordLineage = false,
    createdBy = 'claude',
    crossoverYaml = null,
  } = options;

  if (!isInitialized()) {
    await loadBlocks();
  }

  const variants = [];
  const errors = [];

  if (type === 'perturb') {
    const result = await perturbParams(yamlDef, {
      count,
      seed,
      recordLineage,
      createdBy,
    });
    variants.push(...result.variants);
    errors.push(...result.errors);

  } else if (type === 'structural') {
    for (let i = 0; i < count; i++) {
      const result = await structuralMutate(yamlDef, {
        seed: seed + i,
        recordLineage,
        createdBy,
      });
      if (result.variant) {
        variants.push(result.variant);
      }
      if (result.error) {
        errors.push(result.error);
      }
    }

  } else if (type === 'mixed') {
    // Distribute: 60% perturb, 25% structural, 15% crossover
    const perturbCount = Math.max(1, Math.round(count * 0.6));
    const structuralCount = Math.max(1, Math.round(count * 0.25));
    const crossoverCount = Math.max(0, count - perturbCount - structuralCount);

    // Perturbations
    const perturbResult = await perturbParams(yamlDef, {
      count: perturbCount,
      seed,
      recordLineage,
      createdBy,
    });
    variants.push(...perturbResult.variants);
    errors.push(...perturbResult.errors);

    // Structural
    for (let i = 0; i < structuralCount; i++) {
      const result = await structuralMutate(yamlDef, {
        seed: seed + 1000 + i,
        recordLineage,
        createdBy,
      });
      if (result.variant) variants.push(result.variant);
      if (result.error) errors.push(result.error);
    }

    // Crossovers (only if a second strategy is provided)
    if (crossoverYaml && crossoverCount > 0) {
      const modes = ['signals-filters', 'mix', 'sizer-swap'];
      for (let i = 0; i < crossoverCount; i++) {
        const result = await crossover(yamlDef, crossoverYaml, {
          mode: modes[i % modes.length],
          seed: seed + 2000 + i,
          recordLineage,
          createdBy,
        });
        if (result.variant) variants.push(result.variant);
        if (result.error) errors.push(result.error);
      }
    } else if (!crossoverYaml && crossoverCount > 0) {
      // Fill crossover slots with more perturbations
      const extraPerturb = await perturbParams(yamlDef, {
        count: crossoverCount,
        seed: seed + 3000,
        recordLineage,
        createdBy,
      });
      variants.push(...extraPerturb.variants);
      errors.push(...extraPerturb.errors);
    }

  } else {
    errors.push(`Unknown mutation type '${type}'. Valid: perturb, structural, mixed`);
  }

  // Build summary
  const summary = variants.map(v => ({
    name: v.name,
    mutationType: v.action ? 'structural' : (v.parents ? 'crossover' : 'param_perturb'),
    keyChanges: formatKeyChanges(v),
  }));

  return { variants, summary, errors };
}

/**
 * Format key changes for summary display.
 */
function formatKeyChanges(variant) {
  if (variant.changes) {
    // Parameter perturbation
    return variant.changes.map(c => `${c.param}: ${c.from} -> ${c.to}`).join(', ');
  }
  if (variant.action) {
    // Structural
    return variant.reasoning || variant.action;
  }
  if (variant.parents) {
    // Crossover
    return `${variant.parents[0]} x ${variant.parents[1]} (${variant.mode})`;
  }
  return '';
}

// ─── YAML Serialization ───

/**
 * Convert a definition object back to a clean YAML string.
 *
 * @param {Object} definition - Strategy definition
 * @returns {string} YAML string
 */
export function definitionToYaml(definition) {
  // Build a clean object for YAML output (exclude empty/default fields)
  const output = {
    name: definition.name,
  };

  if (definition.description) output.description = definition.description;
  if (definition.version != null) output.version = definition.version;
  if (definition.hypothesis) output.hypothesis = definition.hypothesis;

  output.signals = definition.signals.map(s => {
    const sig = { type: s.type };
    if (s.params && Object.keys(s.params).length > 0) {
      sig.params = { ...s.params };
    }
    return sig;
  });

  if (definition.combine && definition.combine !== 'all-of') {
    output.combine = definition.combine;
  } else if (definition.combine === 'all-of') {
    output.combine = 'all-of';
  }

  if (definition.filters && definition.filters.length > 0) {
    output.filters = definition.filters.map(f => {
      const filter = { type: f.type };
      if (f.params && Object.keys(f.params).length > 0) {
        filter.params = { ...f.params };
      }
      return filter;
    });
  }

  output.sizer = { type: definition.sizer.type };
  if (definition.sizer.params && Object.keys(definition.sizer.params).length > 0) {
    output.sizer.params = { ...definition.sizer.params };
  }

  if (definition.params && Object.keys(definition.params).length > 0) {
    output.params = { ...definition.params };
  }

  return yaml.dump(output, {
    lineWidth: -1, // Don't wrap long lines
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
  });
}

// ─── Exports ───

export {
  collectNumericParams,
  getParamBounds,
  clampToBounds,
  getPossibleStructuralActions,
  buildDefaultParams,
};
