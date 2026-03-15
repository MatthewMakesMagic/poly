/**
 * YAML Strategy Parser with Sweep Syntax Extraction
 *
 * Parses YAML strategy definitions into structured objects,
 * extracts {sweep: [...]} syntax into a sweepGrid,
 * and validates against the block registry.
 *
 * Covers: FR3 (sweep syntax), FR4 (YAML parsing), NFR5 (<100ms), NFR17 (test coverage)
 */

import yaml from 'js-yaml';
import { getBlock, isInitialized } from './registry.js';

/** Top-level keys allowed in a strategy YAML */
const ALLOWED_TOP_KEYS = new Set([
  'name', 'description', 'version', 'hypothesis',
  'signals', 'filters', 'sizer', 'combine', 'params',
]);

/**
 * Parse a YAML strategy string into a definition object with sweep extraction.
 *
 * @param {string} yamlString - Raw YAML content
 * @returns {{ definition: Object, sweepGrid: Object, defaults: Object }}
 * @throws {Error} If YAML is invalid or validation fails
 */
export function parseStrategyYaml(yamlString) {
  if (typeof yamlString !== 'string' || yamlString.trim() === '') {
    throw new Error('YAML parser: input must be a non-empty string');
  }

  let raw;
  try {
    raw = yaml.load(yamlString);
  } catch (err) {
    throw new Error(`YAML parser: syntax error — ${err.message}`);
  }

  if (raw == null || typeof raw !== 'object') {
    throw new Error('YAML parser: document must be a YAML mapping (object), got ' + typeof raw);
  }

  const errors = [];

  // Check for unknown top-level keys
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      errors.push(`Unknown top-level key '${key}' — check for typos. Allowed keys: ${[...ALLOWED_TOP_KEYS].join(', ')}`);
    }
  }

  // Validate required fields
  if (!raw.name || typeof raw.name !== 'string') {
    errors.push("'name' is required and must be a string");
  }

  if (!Array.isArray(raw.signals) || raw.signals.length === 0) {
    errors.push("'signals' is required and must be a non-empty array");
  }

  if (!raw.sizer || typeof raw.sizer !== 'object') {
    errors.push("'sizer' is required and must be an object with a 'type' field");
  } else if (!raw.sizer.type || typeof raw.sizer.type !== 'string') {
    errors.push("'sizer.type' is required and must be a string");
  }

  // Validate combine operator
  if (raw.combine != null && !['all-of', 'any-of'].includes(raw.combine)) {
    errors.push(`'combine' must be 'all-of' or 'any-of', got '${raw.combine}'`);
  }

  // Validate signal entries
  if (Array.isArray(raw.signals)) {
    raw.signals.forEach((sig, i) => {
      if (!sig || typeof sig !== 'object') {
        errors.push(`signals[${i}] must be an object`);
      } else if (!sig.type || typeof sig.type !== 'string') {
        errors.push(`signals[${i}].type is required and must be a string`);
      }
    });
  }

  // Validate filter entries
  if (raw.filters != null) {
    if (!Array.isArray(raw.filters)) {
      errors.push("'filters' must be an array");
    } else {
      raw.filters.forEach((f, i) => {
        if (!f || typeof f !== 'object') {
          errors.push(`filters[${i}] must be an object`);
        } else if (!f.type || typeof f.type !== 'string') {
          errors.push(`filters[${i}].type is required and must be a string`);
        }
      });
    }
  }

  // Validate block references against registry (if initialized)
  if (isInitialized()) {
    if (Array.isArray(raw.signals)) {
      for (const sig of raw.signals) {
        if (sig?.type) {
          try { getBlock('signal', sig.type); }
          catch { errors.push(`Signal block '${sig.type}' not found in registry`); }
        }
      }
    }
    if (Array.isArray(raw.filters)) {
      for (const f of raw.filters) {
        if (f?.type) {
          try { getBlock('filter', f.type); }
          catch { errors.push(`Filter block '${f.type}' not found in registry`); }
        }
      }
    }
    if (raw.sizer?.type) {
      try { getBlock('sizer', raw.sizer.type); }
      catch { errors.push(`Sizer block '${raw.sizer.type}' not found in registry`); }
    }
  }

  if (errors.length > 0) {
    const name = raw.name || '<unnamed>';
    throw new Error(
      `YAML validation failed for strategy '${name}':\n  - ${errors.join('\n  - ')}`
    );
  }

  // Extract sweep grid and defaults
  const sweepGrid = {};
  const defaults = {};

  // Extract sweeps from signal params
  if (Array.isArray(raw.signals)) {
    for (const sig of raw.signals) {
      if (sig.params) {
        extractSweeps(sig.params, sweepGrid, defaults, errors, raw.name);
      }
    }
  }

  // Extract sweeps from filter params
  if (Array.isArray(raw.filters)) {
    for (const f of raw.filters) {
      if (f.params) {
        extractSweeps(f.params, sweepGrid, defaults, errors, raw.name);
      }
    }
  }

  // Extract sweeps from sizer params
  if (raw.sizer?.params) {
    extractSweeps(raw.sizer.params, sweepGrid, defaults, errors, raw.name);
  }

  // Extract sweeps from top-level params
  if (raw.params) {
    extractSweeps(raw.params, sweepGrid, defaults, errors, raw.name);
  }

  if (errors.length > 0) {
    throw new Error(
      `YAML sweep extraction failed for strategy '${raw.name}':\n  - ${errors.join('\n  - ')}`
    );
  }

  const definition = {
    name: raw.name,
    description: raw.description || '',
    version: raw.version || 1,
    hypothesis: raw.hypothesis || '',
    signals: raw.signals,
    filters: raw.filters || [],
    sizer: raw.sizer,
    combine: raw.combine || 'all-of',
    params: raw.params || {},
  };

  return { definition, sweepGrid, defaults };
}

/**
 * Extract {sweep: [...]} entries from a params object.
 * Replaces sweep entries with their first value (default).
 *
 * @param {Object} params - Parameter object to scan
 * @param {Object} sweepGrid - Accumulator for sweep definitions
 * @param {Object} defaults - Accumulator for default values
 * @param {string[]} errors - Accumulator for validation errors
 * @param {string} strategyName - For error context
 */
function extractSweeps(params, sweepGrid, defaults, errors, strategyName) {
  for (const [key, value] of Object.entries(params)) {
    if (value != null && typeof value === 'object' && !Array.isArray(value) && value.sweep != null) {
      if (!Array.isArray(value.sweep)) {
        errors.push(`Param '${key}' has sweep syntax but value is not an array`);
        continue;
      }
      if (value.sweep.length === 0) {
        errors.push(`Param '${key}' has empty sweep array`);
        continue;
      }

      // Validate all sweep values are the same type
      const firstType = typeof value.sweep[0];
      const mixedType = value.sweep.some(v => typeof v !== firstType);
      if (mixedType) {
        errors.push(`Param '${key}' sweep values must all be the same type (found mixed types)`);
        continue;
      }

      sweepGrid[key] = value.sweep;
      defaults[key] = value.sweep[0];
      params[key] = value.sweep[0]; // Replace sweep with default
    } else {
      defaults[key] = value;
    }
  }
}

/**
 * Validate a parsed definition without throwing.
 *
 * @param {string} yamlString - Raw YAML content
 * @returns {{ valid: boolean, errors: string[], definition?: Object, sweepGrid?: Object, defaults?: Object }}
 */
export function validateStrategyYaml(yamlString) {
  try {
    const result = parseStrategyYaml(yamlString);
    return { valid: true, errors: [], ...result };
  } catch (err) {
    return { valid: false, errors: [err.message] };
  }
}
