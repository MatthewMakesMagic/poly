/**
 * Strategy Lineage — Schema and Persistence (Story 4.1)
 *
 * Tracks strategy evolution: parent-child relationships, mutation types,
 * and reasoning for each variant. Supports the full mutation workflow
 * (perturbation, structural, crossover) with queryable lineage chains.
 *
 * Table: strategy_lineage
 * Naming convention:
 *   - {base}-v{N} for manual version iterations
 *   - {base}-m{N} for mutations
 *
 * Covers: FR14 (version lineage tracking), FR15 (mutation reasoning capture)
 */

import persistence from '../persistence/index.js';

// ─── Schema DDL ───

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS strategy_lineage (
    id SERIAL PRIMARY KEY,
    strategy_name TEXT NOT NULL UNIQUE,
    parent_name TEXT,
    mutation_type TEXT NOT NULL,
    mutation_reasoning TEXT,
    yaml_definition TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by TEXT NOT NULL DEFAULT 'claude'
  );

  CREATE INDEX IF NOT EXISTS idx_strategy_lineage_name ON strategy_lineage(strategy_name);
  CREATE INDEX IF NOT EXISTS idx_strategy_lineage_parent ON strategy_lineage(parent_name);
`;

let schemaInitialized = false;

/**
 * Ensure the strategy_lineage table exists. Idempotent.
 */
export async function ensureLineageSchema() {
  if (schemaInitialized) return;
  try {
    await persistence.exec(CREATE_TABLE_SQL);
    schemaInitialized = true;
  } catch (err) {
    if (err.message?.includes('not initialized')) {
      return;
    }
    throw err;
  }
}

/**
 * Reset schema initialization state (for testing).
 */
export function resetLineageSchemaState() {
  schemaInitialized = false;
}

// ─── Lineage Recording ───

/**
 * Record a mutation in the lineage table.
 *
 * @param {string} parentName - Parent strategy name (null for originals)
 * @param {string} childName - Child strategy name
 * @param {Object} options
 * @param {string} options.mutationType - 'original' | 'param_perturb' | 'structural' | 'crossover'
 * @param {string} [options.reasoning] - Why this variant was created
 * @param {string} [options.yamlDefinition] - Full YAML definition string
 * @param {string} [options.createdBy='claude'] - Who created it
 * @returns {Promise<number>} Lineage record ID
 */
export async function recordMutation(parentName, childName, {
  mutationType,
  reasoning = null,
  yamlDefinition = null,
  createdBy = 'claude',
} = {}) {
  const validTypes = ['original', 'param_perturb', 'structural', 'crossover'];
  if (!validTypes.includes(mutationType)) {
    throw new Error(
      `Invalid mutation type '${mutationType}'. ` +
      `Valid types: ${validTypes.join(', ')}. ` +
      `This is a lineage recording issue — check the mutation engine call site.`
    );
  }

  if (!childName || typeof childName !== 'string') {
    throw new Error(
      'Child strategy name is required for lineage recording. ' +
      'Each mutation must produce a named variant.'
    );
  }

  await ensureLineageSchema();

  const row = await persistence.get(
    `INSERT INTO strategy_lineage (strategy_name, parent_name, mutation_type, mutation_reasoning, yaml_definition, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [childName, parentName || null, mutationType, reasoning || null, yamlDefinition || null, createdBy]
  );

  return row.id;
}

// ─── Lineage Queries ───

/**
 * Get the full ancestor chain for a strategy, from root to the given strategy.
 *
 * @param {string} strategyName - Strategy to trace
 * @returns {Promise<Object[]>} Array of lineage records from root to the given strategy
 */
export async function getLineage(strategyName) {
  await ensureLineageSchema();

  // Walk up the parent chain
  const chain = [];
  let current = strategyName;

  while (current) {
    const row = await persistence.get(
      `SELECT id, strategy_name, parent_name, mutation_type, mutation_reasoning, yaml_definition, created_at, created_by
       FROM strategy_lineage WHERE strategy_name = $1`,
      [current]
    );

    if (!row) break;
    chain.unshift(row); // Prepend so root is first
    current = row.parent_name;
  }

  return chain;
}

/**
 * Get all direct children of a strategy.
 *
 * @param {string} strategyName - Parent strategy name
 * @returns {Promise<Object[]>} Array of child lineage records
 */
export async function getChildren(strategyName) {
  await ensureLineageSchema();

  return persistence.all(
    `SELECT id, strategy_name, parent_name, mutation_type, mutation_reasoning, yaml_definition, created_at, created_by
     FROM strategy_lineage WHERE parent_name = $1
     ORDER BY created_at ASC`,
    [strategyName]
  );
}

/**
 * Get a single lineage record by strategy name.
 *
 * @param {string} strategyName
 * @returns {Promise<Object|undefined>}
 */
export async function getLineageRecord(strategyName) {
  await ensureLineageSchema();

  return persistence.get(
    `SELECT id, strategy_name, parent_name, mutation_type, mutation_reasoning, yaml_definition, created_at, created_by
     FROM strategy_lineage WHERE strategy_name = $1`,
    [strategyName]
  );
}

// ─── Naming Conventions ───

/**
 * Generate the next mutation name for a strategy.
 * Naming: {base}-m{N} where N increments from existing children.
 *
 * @param {string} baseName - Parent strategy name
 * @param {Object[]} existingChildren - Already-known children (to avoid extra DB queries)
 * @returns {string} Next mutation name
 */
export function nextMutationName(baseName, existingChildren = []) {
  // Find highest existing mutation number for this base
  const mutationPattern = new RegExp(`^${escapeRegex(baseName)}-m(\\d+)$`);
  let maxN = 0;

  for (const child of existingChildren) {
    const name = typeof child === 'string' ? child : child.strategy_name;
    const match = name.match(mutationPattern);
    if (match) {
      maxN = Math.max(maxN, parseInt(match[1], 10));
    }
  }

  return `${baseName}-m${maxN + 1}`;
}

/**
 * Generate N sequential mutation names for a strategy.
 *
 * @param {string} baseName - Parent strategy name
 * @param {number} count - Number of names to generate
 * @param {Object[]} existingChildren - Already-known children
 * @returns {string[]} Array of mutation names
 */
export function generateMutationNames(baseName, count, existingChildren = []) {
  const mutationPattern = new RegExp(`^${escapeRegex(baseName)}-m(\\d+)$`);
  let maxN = 0;

  for (const child of existingChildren) {
    const name = typeof child === 'string' ? child : child.strategy_name;
    const match = name.match(mutationPattern);
    if (match) {
      maxN = Math.max(maxN, parseInt(match[1], 10));
    }
  }

  const names = [];
  for (let i = 1; i <= count; i++) {
    names.push(`${baseName}-m${maxN + i}`);
  }
  return names;
}

/**
 * Escape special regex characters in a string.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
