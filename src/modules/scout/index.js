/**
 * Scout Module
 *
 * Real-time trading monitor with plain-English explanations.
 *
 * Scout is a friendly terminal-based monitor that watches trading activity
 * and explains what's happening in plain English. It surfaces issues for
 * review without panic, confirms when things work as expected, and maintains
 * a review queue for later analysis.
 *
 * Philosophy: "Silence = Trust" - when things are working, Scout confirms
 * briefly. When something's off, Scout explains clearly without jargon.
 *
 * @module modules/scout
 */

import { child } from '../logger/index.js';
import { subscribeAll } from '../trade-event/index.js';
import { ScoutError, ScoutErrorCodes, ScoutMode } from './types.js';
import {
  isInitialized,
  setInitialized,
  isRunning,
  setRunning,
  setConfig,
  getConfig,
  setMode,
  getMode,
  setUnsubscribe,
  getUnsubscribe,
  resetState,
  getStateSnapshot,
  incrementEventCount,
  trackStrategy,
  trackPosition,
  removePosition,
} from './state.js';
import { translate } from './translator.js';
import * as renderer from './renderer.js';
import * as reviewQueue from './review-queue.js';

// Module state
let log = null;

/**
 * Initialize the Scout module
 *
 * @param {Object} config - Configuration object
 * @param {string} [config.mode='local'] - Operating mode ('local' or 'railway')
 * @returns {Promise<void>}
 */
export async function init(config = {}) {
  if (isInitialized()) {
    throw new ScoutError(
      ScoutErrorCodes.ALREADY_INITIALIZED,
      'Scout module already initialized',
      {}
    );
  }

  // Create child logger
  log = child({ module: 'scout' });
  log.info('module_init_start');

  // Store configuration
  setConfig(config);

  // Set mode
  const mode = config.mode || ScoutMode.LOCAL;
  if (mode !== ScoutMode.LOCAL && mode !== ScoutMode.RAILWAY) {
    throw new ScoutError(
      ScoutErrorCodes.INVALID_MODE,
      `Invalid mode: ${mode}. Use 'local' or 'railway'.`,
      { mode }
    );
  }
  setMode(mode);

  // Initialize renderer
  renderer.init();

  setInitialized(true);
  log.info('module_initialized', { mode });
}

/**
 * Start Scout monitoring
 *
 * @returns {Promise<void>}
 */
export async function start() {
  ensureInitialized();

  if (isRunning()) {
    throw new ScoutError(
      ScoutErrorCodes.ALREADY_RUNNING,
      'Scout is already running',
      {}
    );
  }

  const mode = getMode();
  log.info('scout_starting', { mode });

  // Render startup message
  renderer.renderStartup(mode);

  if (mode === ScoutMode.LOCAL) {
    // Subscribe to trade events
    const unsubscribe = subscribeAll(handleEvent);
    setUnsubscribe(unsubscribe);
  } else if (mode === ScoutMode.RAILWAY) {
    // Railway mode: log stream parsing (Story E.2)
    log.warn('railway_mode_not_implemented', {
      message: 'Railway mode will be implemented in Story E.2',
    });
  }

  setRunning(true);
  log.info('scout_started', { mode });
}

/**
 * Stop Scout monitoring
 *
 * @returns {Promise<void>}
 */
export async function stop() {
  ensureInitialized();

  if (!isRunning()) {
    throw new ScoutError(
      ScoutErrorCodes.NOT_RUNNING,
      'Scout is not running',
      {}
    );
  }

  log.info('scout_stopping');

  // Unsubscribe from events
  const unsubscribe = getUnsubscribe();
  if (unsubscribe) {
    unsubscribe();
    setUnsubscribe(null);
  }

  // Render shutdown message
  const stats = getStateSnapshot().stats;
  renderer.renderShutdown(stats);

  setRunning(false);
  log.info('scout_stopped');
}

/**
 * Handle incoming trade event
 *
 * @param {Object} event - Event object with type and data
 */
function handleEvent({ type, data }) {
  // Increment stats
  incrementEventCount(type);

  // Track strategy and position
  if (data.strategyId) {
    trackStrategy(data.strategyId);
  }

  if (type === 'entry' && data.positionId) {
    trackPosition(data.positionId, data);
  }

  if (type === 'exit' && data.positionId) {
    removePosition(data.positionId);
  }

  // Translate event
  const translation = translate(type, data);

  // Add to review queue if warn/error
  if (translation.level === 'warn' || translation.level === 'error') {
    reviewQueue.addItem({
      type,
      level: translation.level,
      windowId: data.windowId,
      summary: translation.summary,
      explanation: translation.explanation,
      data,
    });
  }

  // Add to renderer history
  renderer.addEvent({
    type,
    ...translation,
    data,
  });

  // Render event
  renderer.renderEvent({
    type,
    translation,
    data,
  });
}

/**
 * Get current module state
 *
 * @returns {Object} Current state
 */
export function getState() {
  return {
    ...getStateSnapshot(),
    reviewQueue: reviewQueue.getSummary(),
  };
}

/**
 * Get review queue items
 *
 * @returns {Object[]} Queue items
 */
export function getReviewQueue() {
  return reviewQueue.getItems();
}

/**
 * Acknowledge and remove a review queue item
 *
 * @param {number} id - Queue item ID
 * @returns {boolean} True if item was removed
 */
export function acknowledgeReviewItem(id) {
  return reviewQueue.removeItem(id);
}

/**
 * Shutdown the module gracefully
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (log) {
    log.info('module_shutdown_start');
  }

  // Stop if running
  if (isRunning()) {
    const unsubscribe = getUnsubscribe();
    if (unsubscribe) {
      unsubscribe();
    }
  }

  // Reset state
  reviewQueue.reset();
  renderer.reset();
  resetState();

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

/**
 * Internal: Ensure module is initialized
 */
function ensureInitialized() {
  if (!isInitialized()) {
    throw new ScoutError(
      ScoutErrorCodes.NOT_INITIALIZED,
      'Scout module not initialized. Call init() first.',
      {}
    );
  }
}

// Re-export types
export { ScoutError, ScoutErrorCodes, ScoutMode } from './types.js';
