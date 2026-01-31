/**
 * Scout Review Queue
 *
 * Manages items that need follow-up review.
 * Items are added when events have warn/error level.
 */

// Maximum queue size (oldest items are dropped when exceeded)
const MAX_QUEUE_SIZE = 100;

// In-memory queue
let queue = [];
let nextId = 1;

/**
 * Add an item to the review queue
 *
 * @param {Object} item - Item to add
 * @param {string} item.type - Event type (entry, exit, alert, etc.)
 * @param {string} item.level - Log level (warn or error)
 * @param {string} item.windowId - Window identifier
 * @param {string} item.summary - Short summary
 * @param {string} item.explanation - Scout's explanation
 * @param {Object} item.data - Full event data
 * @returns {number} Queue item ID
 */
export function addItem(item) {
  const queueItem = {
    id: nextId++,
    addedAt: new Date().toISOString(),
    ...item,
  };

  queue.push(queueItem);

  // Trim queue if too large
  if (queue.length > MAX_QUEUE_SIZE) {
    queue = queue.slice(-MAX_QUEUE_SIZE);
  }

  return queueItem.id;
}

/**
 * Get all items in the queue
 *
 * @returns {Object[]} Queue items (oldest first)
 */
export function getItems() {
  return [...queue];
}

/**
 * Get queue count
 *
 * @returns {number} Number of items in queue
 */
export function getCount() {
  return queue.length;
}

/**
 * Get item by ID
 *
 * @param {number} id - Queue item ID
 * @returns {Object|null} Queue item or null if not found
 */
export function getItem(id) {
  return queue.find(item => item.id === id) || null;
}

/**
 * Remove item from queue (acknowledged)
 *
 * @param {number} id - Queue item ID
 * @returns {boolean} True if item was removed
 */
export function removeItem(id) {
  const index = queue.findIndex(item => item.id === id);
  if (index !== -1) {
    queue.splice(index, 1);
    return true;
  }
  return false;
}

/**
 * Clear all items from queue
 */
export function clearQueue() {
  queue = [];
}

/**
 * Get items by level
 *
 * @param {string} level - Level to filter by (warn or error)
 * @returns {Object[]} Filtered items
 */
export function getItemsByLevel(level) {
  return queue.filter(item => item.level === level);
}

/**
 * Get error count
 *
 * @returns {number} Number of error-level items
 */
export function getErrorCount() {
  return queue.filter(item => item.level === 'error').length;
}

/**
 * Get warning count
 *
 * @returns {number} Number of warning-level items
 */
export function getWarningCount() {
  return queue.filter(item => item.level === 'warn').length;
}

/**
 * Reset queue state
 */
export function reset() {
  queue = [];
  nextId = 1;
}

/**
 * Get queue summary for display
 *
 * @returns {Object} Summary with counts and latest items
 */
export function getSummary() {
  return {
    total: queue.length,
    errors: getErrorCount(),
    warnings: getWarningCount(),
    oldest: queue[0] || null,
    newest: queue[queue.length - 1] || null,
  };
}
