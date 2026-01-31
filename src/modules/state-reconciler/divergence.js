/**
 * State Divergence Detection Module
 *
 * Contains logic for detecting divergence between memory and database state.
 * Separated from logic.js per architecture specification.
 *
 * @see architecture.md#Project-Structure for file organization
 */

/**
 * Detect divergence between memory and database state
 *
 * Compares position arrays and identifies:
 * - Positions in memory but not in DB (MEMORY_ONLY)
 * - Positions in DB but not in memory (DB_ONLY)
 * - Positions with mismatched field values (STATE_MISMATCH)
 *
 * @param {Array<Object>} memoryPositions - Positions from memory state
 * @param {Array<Object>} dbPositions - Positions from database
 * @returns {Array<Object>} List of divergences found
 */
export function detectDivergence(memoryPositions, dbPositions) {
  const divergences = [];

  // Handle null/undefined inputs gracefully
  const memoryArray = memoryPositions || [];
  const dbArray = dbPositions || [];

  // Check for positions in memory not in DB
  for (const memPos of memoryArray) {
    const dbPos = dbArray.find((p) => p.id === memPos.id);
    if (!dbPos) {
      divergences.push({
        type: 'MEMORY_ONLY',
        position_id: memPos.id,
        memory_state: memPos,
        db_state: null,
      });
    } else {
      // Check for field mismatches
      if (memPos.size !== dbPos.size) {
        divergences.push({
          type: 'STATE_MISMATCH',
          position_id: memPos.id,
          field: 'size',
          memory_value: memPos.size,
          db_value: dbPos.size,
        });
      }
      if (memPos.status !== dbPos.status) {
        divergences.push({
          type: 'STATE_MISMATCH',
          position_id: memPos.id,
          field: 'status',
          memory_value: memPos.status,
          db_value: dbPos.status,
        });
      }
    }
  }

  // Check for positions in DB not in memory
  for (const dbPos of dbArray) {
    const memPos = memoryArray.find((p) => p.id === dbPos.id);
    if (!memPos) {
      divergences.push({
        type: 'DB_ONLY',
        position_id: dbPos.id,
        memory_state: null,
        db_state: dbPos,
      });
    }
  }

  return divergences;
}

/**
 * Format divergence for actionable logging
 *
 * @param {Object} divergence - Divergence object
 * @returns {Object} Formatted divergence with actionable description
 */
export function formatDivergenceForLog(divergence) {
  let actionableMessage;

  switch (divergence.type) {
    case 'MEMORY_ONLY':
      actionableMessage = `Position ${divergence.position_id} exists in memory but not in database. Check if database write failed or position was created without persistence.`;
      break;
    case 'DB_ONLY':
      actionableMessage = `Position ${divergence.position_id} exists in database but not in memory. Check if memory state was cleared or restart occurred without full reload.`;
      break;
    case 'STATE_MISMATCH':
      actionableMessage = `Position ${divergence.position_id} has mismatched ${divergence.field}: memory=${divergence.memory_value}, db=${divergence.db_value}. Investigate which value is correct.`;
      break;
    default:
      actionableMessage = `Unknown divergence type for position ${divergence.position_id}`;
  }

  return {
    ...divergence,
    actionable_message: actionableMessage,
  };
}

// Default export for module interface consistency
export default {
  detectDivergence,
  formatDivergenceForLog,
};
