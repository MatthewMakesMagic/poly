/**
 * Scout Module State Management
 *
 * In-memory state for the Scout module.
 */

import { ScoutMode } from './types.js';

// Initialization state
let initialized = false;
let running = false;

// Module configuration
let moduleConfig = null;

// Operating mode
let mode = ScoutMode.LOCAL;

// Event subscription cleanup function
let unsubscribe = null;

// Statistics
let stats = {
  eventsReceived: 0,
  signalCount: 0,
  entryCount: 0,
  exitCount: 0,
  alertCount: 0,
  paperSignalCount: 0, // Story E.3: Paper mode signals
  liveOrderCount: 0,   // Story E.3: Live orders
  startTime: null,
};

// Story E.3: Current trading mode (null until detected, then 'PAPER' or 'LIVE')
let tradingMode = null;

// Active strategies and positions (for status bar)
let activeStrategies = new Set();
let openPositions = new Map();
let lastEventTime = null;

/**
 * Check if module is initialized
 */
export function isInitialized() {
  return initialized;
}

/**
 * Set initialization state
 */
export function setInitialized(state) {
  initialized = state;
}

/**
 * Check if Scout is running
 */
export function isRunning() {
  return running;
}

/**
 * Set running state
 */
export function setRunning(state) {
  running = state;
  if (state) {
    stats.startTime = new Date().toISOString();
  }
}

/**
 * Store module configuration
 */
export function setConfig(config) {
  moduleConfig = config;
}

/**
 * Get module configuration
 */
export function getConfig() {
  return moduleConfig;
}

/**
 * Set operating mode
 */
export function setMode(newMode) {
  mode = newMode;
}

/**
 * Get operating mode
 */
export function getMode() {
  return mode;
}

/**
 * Store unsubscribe function
 */
export function setUnsubscribe(fn) {
  unsubscribe = fn;
}

/**
 * Get unsubscribe function
 */
export function getUnsubscribe() {
  return unsubscribe;
}

/**
 * Increment event count by type
 */
export function incrementEventCount(eventType) {
  stats.eventsReceived++;
  lastEventTime = new Date().toISOString();

  switch (eventType) {
    case 'signal':
      stats.signalCount++;
      break;
    case 'entry':
      stats.entryCount++;
      break;
    case 'exit':
      stats.exitCount++;
      break;
    case 'alert':
    case 'divergence':
      stats.alertCount++;
      break;
  }
}

/**
 * Story E.3: Increment paper signal count
 */
export function incrementPaperSignal() {
  stats.paperSignalCount++;
}

/**
 * Story E.3: Increment live order count
 */
export function incrementLiveOrder() {
  stats.liveOrderCount++;
}

/**
 * Story E.3: Set trading mode
 */
export function setTradingMode(newMode) {
  tradingMode = newMode;
}

/**
 * Story E.3: Get trading mode
 */
export function getTradingMode() {
  return tradingMode;
}

/**
 * Track active strategy
 */
export function trackStrategy(strategyId) {
  if (strategyId) {
    activeStrategies.add(strategyId);
  }
}

/**
 * Track open position
 */
export function trackPosition(positionId, data) {
  if (positionId) {
    openPositions.set(positionId, data);
  }
}

/**
 * Remove closed position
 */
export function removePosition(positionId) {
  openPositions.delete(positionId);
}

/**
 * Get current statistics
 */
export function getStats() {
  return { ...stats };
}

/**
 * Get active strategy count
 */
export function getActiveStrategyCount() {
  return activeStrategies.size;
}

/**
 * Get open position count
 */
export function getOpenPositionCount() {
  return openPositions.size;
}

/**
 * Get last event time
 */
export function getLastEventTime() {
  return lastEventTime;
}

/**
 * Reset all state
 */
export function resetState() {
  initialized = false;
  running = false;
  moduleConfig = null;
  mode = ScoutMode.LOCAL;
  unsubscribe = null;
  stats = {
    eventsReceived: 0,
    signalCount: 0,
    entryCount: 0,
    exitCount: 0,
    alertCount: 0,
    paperSignalCount: 0,
    liveOrderCount: 0,
    startTime: null,
  };
  activeStrategies.clear();
  openPositions.clear();
  lastEventTime = null;
  tradingMode = null; // Story E.3: Reset trading mode
}

/**
 * Get module state snapshot
 */
export function getStateSnapshot() {
  const currentStats = getStats();
  return {
    initialized,
    running,
    mode,
    hasConfig: moduleConfig !== null,
    stats: currentStats,
    activeStrategies: activeStrategies.size,
    openPositions: openPositions.size,
    lastEventTime,
    // Story E.3: Paper/Live counts at top level for convenience
    paperSignalCount: currentStats.paperSignalCount,
    liveOrderCount: currentStats.liveOrderCount,
    tradingMode,
  };
}
