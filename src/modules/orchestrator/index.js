/**
 * Orchestrator Module
 *
 * Central coordinator for all trading modules. Implements the orchestrator pattern
 * where modules never import each other directly - all coordination flows through here.
 *
 * Public interface:
 * - init(config) - Initialize all modules in dependency order
 * - start() - Start the execution loop
 * - stop() - Stop the execution loop
 * - pause() - Pause the execution loop
 * - resume() - Resume a paused execution loop
 * - getState() - Get orchestrator and module states
 * - shutdown() - Gracefully shutdown all modules
 *
 * @module modules/orchestrator
 */

import fs from 'fs';
import path from 'path';
import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import * as polymarket from '../../clients/polymarket/index.js';
import * as spot from '../../clients/spot/index.js';
import * as windowManager from '../window-manager/index.js';
import * as positionManager from '../position-manager/index.js';
import * as safeguards from '../position-manager/safeguards.js';
import * as orderManager from '../order-manager/index.js';
import * as safety from '../safety/index.js';
import * as strategyEvaluator from '../strategy-evaluator/index.js';
import * as positionSizer from '../position-sizer/index.js';
import * as stopLoss from '../stop-loss/index.js';
import * as takeProfit from '../take-profit/index.js';
import * as windowExpiry from '../window-expiry/index.js';
import * as tradeEvent from '../trade-event/index.js';
import * as launchConfig from '../launch-config/index.js';
import { writeSnapshot, buildSnapshot } from '../../../kill-switch/state-snapshot.js';
// Strategy composition integration (Story 7-12)
import {
  loadAllStrategies,
  getLoadedStrategy,
  setActiveStrategy as setActiveStrategyLoader,
  getActiveStrategy as getActiveStrategyLoader,
  getActiveStrategyName,
  listLoadedStrategies,
} from '../strategy/loader.js';
import { discoverComponents } from '../strategy/logic.js';
import { setCatalog, getCatalog } from '../strategy/state.js';

import {
  OrchestratorError,
  OrchestratorErrorCodes,
  OrchestratorState,
  ErrorCategory,
  categorizeError,
} from './types.js';
import {
  MODULE_INIT_ORDER,
  createInitialState,
  setModule,
  getModule,
  getAllModules,
  clearModules,
  recordError,
  getErrorCount1m,
} from './state.js';
import { ExecutionLoop } from './execution-loop.js';

// Module references mapping for dynamic initialization
const MODULE_MAP = {
  'launch-config': launchConfig,
  persistence: persistence,
  polymarket: polymarket,
  spot: spot,
  'window-manager': windowManager,
  'position-manager': positionManager,
  'safeguards': safeguards,
  'order-manager': orderManager,
  'safety': safety,
  'strategy-evaluator': strategyEvaluator,
  'position-sizer': positionSizer,
  'stop-loss': stopLoss,
  'take-profit': takeProfit,
  'window-expiry': windowExpiry,
  'trade-event': tradeEvent,
};

// PID file path for kill switch watchdog integration
const PID_FILE = './data/main.pid';

// Module-level state
let log = null;
let config = null;
let state = createInitialState();
let executionLoop = null;
let stateUpdateInterval = null;
let stateWriteInProgress = false;
let loadedManifest = null;  // Launch manifest loaded from config/launch.json
let activeComposedStrategy = null;  // Active composed strategy function (Story 7-12)

/**
 * Write the main process PID file for watchdog integration
 *
 * @private
 */
function writePidFile() {
  try {
    const dir = path.dirname(PID_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(PID_FILE, process.pid.toString(), 'utf-8');
    if (log) {
      log.info('pid_file_written', { path: PID_FILE, pid: process.pid });
    }
  } catch (err) {
    if (log) {
      log.warn('pid_file_write_failed', { path: PID_FILE, error: err.message });
    }
  }
}

/**
 * Remove the main process PID file on shutdown
 *
 * @private
 */
function removePidFile() {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
      if (log) {
        log.info('pid_file_removed', { path: PID_FILE });
      }
    }
  } catch (err) {
    if (log) {
      log.warn('pid_file_remove_failed', { path: PID_FILE, error: err.message });
    }
  }
}

/**
 * Start periodic state updates for kill switch recovery
 *
 * Writes state snapshot at regular intervals for use by the watchdog
 * in case of forced kill. Writes are non-blocking and failures
 * are logged but don't block trading.
 *
 * @private
 */
function startPeriodicStateUpdates() {
  const intervalMs = config?.killSwitch?.stateUpdateIntervalMs || 5000;

  stateUpdateInterval = setInterval(async () => {
    // Guard against overlapping writes
    if (stateWriteInProgress) {
      if (log) {
        log.debug('state_snapshot_skipped_in_progress');
      }
      return;
    }

    stateWriteInProgress = true;
    try {
      await writeStateSnapshot(false);
    } catch (err) {
      if (log) {
        log.warn('state_snapshot_write_failed', { error: err.message });
      }
      // Don't throw - non-blocking
    } finally {
      stateWriteInProgress = false;
    }
  }, intervalMs);

  if (log) {
    log.info('periodic_state_updates_started', { intervalMs });
  }
}

/**
 * Stop periodic state updates
 *
 * @private
 */
function stopPeriodicStateUpdates() {
  if (stateUpdateInterval) {
    clearInterval(stateUpdateInterval);
    stateUpdateInterval = null;
    stateWriteInProgress = false;
    if (log) {
      log.info('periodic_state_updates_stopped');
    }
  }
}

/**
 * Write a state snapshot to disk
 *
 * Collects state from all modules and writes to the configured state file.
 *
 * @param {boolean} isFinalSnapshot - Whether this is the final snapshot on shutdown
 * @returns {Promise<void>}
 * @private
 */
async function writeStateSnapshot(isFinalSnapshot = false) {
  const orchestratorState = {
    state: state.state,
    startedAt: state.startedAt,
    errorCount: state.errorCount,
  };

  // Get positions from position-manager
  const positionManagerModule = getModule('position-manager');
  let positions = [];
  if (positionManagerModule && typeof positionManagerModule.getState === 'function') {
    const pmState = positionManagerModule.getState();
    positions = pmState.openPositions || [];
  }

  // Get orders from order-manager
  const orderManagerModule = getModule('order-manager');
  let orders = [];
  if (orderManagerModule && typeof orderManagerModule.getState === 'function') {
    const omState = orderManagerModule.getState();
    orders = omState.openOrders || [];
  }

  const snapshot = buildSnapshot(orchestratorState, positions, orders);
  const stateFilePath = config?.killSwitch?.stateFilePath || './data/last-known-state.json';

  await writeSnapshot(snapshot, stateFilePath);

  if (log && isFinalSnapshot) {
    log.info('final_state_snapshot_written', {
      path: stateFilePath,
      positions_count: positions.length,
      orders_count: orders.length,
    });
  }
}

/**
 * Initialize the orchestrator and all managed modules
 *
 * @param {Object} cfg - Full application configuration
 * @returns {Promise<void>}
 * @throws {OrchestratorError} If already initialized or module init fails
 */
export async function init(cfg) {
  if (state.state !== OrchestratorState.STOPPED) {
    throw new OrchestratorError(
      OrchestratorErrorCodes.ALREADY_INITIALIZED,
      'Orchestrator already initialized',
      { currentState: state.state }
    );
  }

  // Create child logger
  log = child({ module: 'orchestrator' });
  config = cfg;
  state.state = OrchestratorState.INITIALIZING;

  log.info('orchestrator_init_start');

  // Write PID file for kill switch watchdog integration
  writePidFile();

  // Initialize modules in dependency order
  try {
    await initializeModules(cfg);
    state.state = OrchestratorState.INITIALIZED;
    state.startedAt = new Date().toISOString();

    // Initialize strategy composition framework (Story 7-12)
    await initializeStrategies(cfg);

    // Start periodic state updates for kill switch recovery
    startPeriodicStateUpdates();

    log.info('orchestrator_initialized', {
      moduleCount: state.initializationOrder.length,
      modules: state.initializationOrder,
      pid: process.pid,
      activeStrategy: getActiveStrategyName(),
    });
  } catch (err) {
    state.state = OrchestratorState.ERROR;
    state.lastError = {
      code: err.code || 'UNKNOWN',
      message: err.message,
      timestamp: new Date().toISOString(),
    };
    log.error('orchestrator_init_failed', {
      error: err.message,
      code: err.code,
      stack: err.stack,
    });
    throw err;
  }
}

/**
 * Initialize all modules in dependency order
 *
 * @param {Object} cfg - Full application configuration
 * @returns {Promise<void>}
 * @private
 */
async function initializeModules(cfg) {
  const timeoutMs = cfg.orchestrator?.moduleInitTimeoutMs || 5000;

  for (const entry of MODULE_INIT_ORDER) {
    const moduleInstance = MODULE_MAP[entry.name];
    if (!moduleInstance) {
      log.warn('module_not_found', { module: entry.name });
      continue;
    }

    log.info('module_init_start', { module: entry.name });

    try {
      // Build module-specific config
      const moduleConfig = entry.configKey ? { [entry.configKey]: cfg[entry.configKey] } : cfg;

      // Initialize with timeout
      await withTimeout(
        moduleInstance.init(moduleConfig),
        timeoutMs,
        `Module ${entry.name} initialization timeout after ${timeoutMs}ms`
      );

      // Store module reference
      setModule(entry.name, moduleInstance);
      state.initializationOrder.push(entry.name);

      // Special handling: capture launch manifest after launch-config init
      if (entry.name === 'launch-config') {
        try {
          loadedManifest = moduleInstance.loadManifest();
          log.info('launch_manifest_loaded', {
            strategies: loadedManifest.strategies,
            position_size_dollars: loadedManifest.position_size_dollars,
            max_exposure_dollars: loadedManifest.max_exposure_dollars,
            kill_switch_enabled: loadedManifest.kill_switch_enabled,
          });
        } catch (err) {
          log.warn('launch_manifest_load_failed', { error: err.message });
          loadedManifest = null;
        }
      }

      // Special handling: wire up safety module with order-manager for auto-stop
      if (entry.name === 'safety') {
        const orderManagerModule = getModule('order-manager');
        if (orderManagerModule && typeof moduleInstance.setOrderManager === 'function') {
          moduleInstance.setOrderManager(orderManagerModule);
          log.info('safety_order_manager_wired', { module: 'safety' });
        }
      }

      log.info('module_init_complete', { module: entry.name });
    } catch (err) {
      log.error('module_init_failed', {
        module: entry.name,
        error: err.message,
        code: err.code,
      });

      // Wrap in OrchestratorError with context
      throw new OrchestratorError(
        OrchestratorErrorCodes.MODULE_INIT_FAILED,
        `Failed to initialize module: ${entry.name}`,
        {
          module: entry.name,
          originalError: err.message,
          originalCode: err.code,
        }
      );
    }
  }
}

/**
 * Initialize strategy composition framework (Story 7-12)
 *
 * Discovers components, loads strategies from config/strategies/,
 * and sets the active strategy if specified in config or manifest.
 *
 * @param {Object} cfg - Full application configuration
 * @returns {Promise<void>}
 * @private
 */
async function initializeStrategies(cfg) {
  try {
    // 1. Discover all strategy components from filesystem
    const catalog = await discoverComponents();
    setCatalog(catalog);

    const totalComponents = Object.values(catalog).reduce(
      (sum, type) => sum + Object.keys(type).length,
      0
    );

    log.info('strategy_components_discovered', {
      total: totalComponents,
      probability: Object.keys(catalog.probability || {}).length,
      entry: Object.keys(catalog.entry || {}).length,
      exit: Object.keys(catalog.exit || {}).length,
      sizing: Object.keys(catalog.sizing || {}).length,
      'price-source': Object.keys(catalog['price-source'] || {}).length,
      analysis: Object.keys(catalog.analysis || {}).length,
      'signal-generator': Object.keys(catalog['signal-generator'] || {}).length,
    });

    // 2. Load all strategies from config/strategies/
    const loadResult = loadAllStrategies();
    log.info('strategies_loaded', {
      loaded: loadResult.loaded,
      failed: loadResult.failed.map(f => f.file),
    });

    // 3. Set active strategy if specified
    // Priority: config.strategy.active > manifest.strategies[0] > none
    const configActive = cfg?.strategy?.active;
    const manifestStrategies = loadedManifest?.strategies || [];
    const defaultStrategy = configActive || (manifestStrategies.length > 0 ? manifestStrategies[0] : null);

    if (defaultStrategy) {
      const strategyDef = getLoadedStrategy(defaultStrategy);
      if (strategyDef) {
        try {
          setActiveStrategyLoader(defaultStrategy);
          activeComposedStrategy = createComposedStrategyExecutor(strategyDef, catalog);
          log.info('active_strategy_set', {
            strategy: defaultStrategy,
            valid: strategyDef.validation.valid,
            componentCount: Object.keys(strategyDef.components).length,
          });
        } catch (err) {
          log.warn('active_strategy_set_failed', {
            strategy: defaultStrategy,
            error: err.message,
          });
        }
      } else {
        log.warn('configured_strategy_not_found', {
          strategy: defaultStrategy,
          available: listLoadedStrategies().map(s => s.name),
        });
      }
    }
  } catch (err) {
    log.warn('strategy_initialization_failed', {
      error: err.message,
    });
    // Continue without strategy composition - fall back to strategy-evaluator
  }
}

/**
 * Create a composed strategy executor function
 *
 * Wraps a strategy definition to provide a standardized execution interface
 * compatible with the execution loop.
 *
 * @param {Object} strategyDef - Strategy definition from loader
 * @param {Object} catalog - Component catalog
 * @returns {Function} Strategy executor function
 * @private
 */
function createComposedStrategyExecutor(strategyDef, catalog) {
  const { components, config: strategyConfig, pipeline } = strategyDef;

  // Initialize all components that have init() functions
  const order = pipeline?.order || Object.keys(components);
  for (const slot of order) {
    const versionIds = Array.isArray(components[slot]) ? components[slot] : [components[slot]];
    for (const versionId of versionIds) {
      if (!versionId) continue;
      const component = catalog[getComponentType(versionId)]?.[versionId];
      if (component?.module?.init && typeof component.module.init === 'function') {
        try {
          // Call init with strategy config merged with global config
          component.module.init(config);
          log.info('component_initialized', { strategy: strategyDef.name, component: versionId });
        } catch (err) {
          log.warn('component_init_failed', { strategy: strategyDef.name, component: versionId, error: err.message });
        }
      }
    }
  }

  return function executeComposedStrategy(marketContext) {
    const results = {
      strategyName: strategyDef.name,
      signals: [],
      componentResults: {},
    };

    // Extract windows and spot price from market context
    const windows = marketContext.windows || [];
    const spotPrice = marketContext.spot_price;

    // Evaluate each window through the component pipeline
    for (const window of windows) {
      // Story 7-14: Build per-window context with correct price types
      // - oracle_price: Crypto dollar price for Black-Scholes S (e.g., $95,000)
      // - reference_price: Strike price from market question for Black-Scholes K (e.g., $94,500)
      // - market_price: Token price (0-1) for edge calculation
      const tokenPrice = window.market_price || window.yes_price || 0.5;
      const referencePrice = window.reference_price;

      // Story 7-15: Skip windows without reference price (can't calculate probability)
      if (!referencePrice) {
        log.debug('window_skipped_no_reference_price', {
          window_id: window.window_id,
          question: window.question,
        });
        continue;
      }

      const windowContext = {
        // Probability model inputs (Black-Scholes)
        oracle_price: spotPrice,      // S: Crypto dollar price (e.g., $95,000)
        reference_price: referencePrice, // K: Strike from market question (e.g., $94,500)
        timeToExpiry: window.time_remaining_ms || window.timeRemaining || 0,
        symbol: (window.crypto || window.symbol || 'btc').toLowerCase(),

        // Edge calculation inputs
        market_price: tokenPrice,     // Token price (0-1) for comparing to model probability

        // Legacy fields for backwards compatibility
        spotPrice: spotPrice,         // Crypto dollar price (deprecated name)
        targetPrice: referencePrice,  // Strike price (deprecated name)

        // Window identification
        window_id: window.window_id || window.id,
        token_id: window.token_id_up || window.token_id,  // Use UP token for long entries
        token_id_up: window.token_id_up,
        token_id_down: window.token_id_down,
        market_id: window.market_id,
      };

      // Execute each component in pipeline order
      const componentOrder = pipeline?.order || Object.keys(components);
      let windowSignal = null;

      for (const slot of componentOrder) {
        const versionIds = Array.isArray(components[slot]) ? components[slot] : [components[slot]];

        for (const versionId of versionIds) {
          if (!versionId) continue;

          const component = catalog[getComponentType(versionId)]?.[versionId];
          if (!component?.module?.evaluate) continue;

          try {
            const componentResult = component.module.evaluate(windowContext, strategyConfig);
            results.componentResults[`${window.window_id}:${versionId}`] = componentResult;

            // Story 7-16: Edge-based signal generation
            // Only generate entry signal if there's positive edge (model > market)
            const modelProbability = componentResult?.probability;
            const marketPrice = windowContext.market_price;

            if (modelProbability != null && marketPrice != null) {
              const edge = modelProbability - marketPrice;
              const minEdgeThreshold = strategyConfig?.edge?.min_edge_threshold ?? 0.10;
              const maxEdgeThreshold = strategyConfig?.edge?.max_edge_threshold ?? 0.50;

              // Log edge calculation
              log.debug('edge_calculated', {
                window_id: windowContext.window_id,
                symbol: windowContext.symbol,
                model_probability: modelProbability,
                market_price: marketPrice,
                edge,
                min_threshold: minEdgeThreshold,
              });

              // Check for suspicious edge (too high = possible stale data)
              if (edge > maxEdgeThreshold) {
                log.warn('edge_suspicious', {
                  window_id: windowContext.window_id,
                  edge,
                  max_threshold: maxEdgeThreshold,
                  reason: 'Edge too high - possible stale data or market issue',
                });
                // Skip this window - edge is suspiciously high
                continue;
              }

              // Generate signal only if positive edge above threshold
              if (edge >= minEdgeThreshold) {
                windowSignal = {
                  window_id: windowContext.window_id,
                  token_id: windowContext.token_id,
                  market_id: windowContext.market_id,
                  direction: 'long',
                  confidence: modelProbability,
                  market_price: marketPrice,
                  edge,
                  strategy_id: strategyDef.name,
                  component: versionId,
                  oracle_price: windowContext.oracle_price,
                  reference_price: windowContext.reference_price,
                };

                log.info('edge_signal_generated', {
                  window_id: windowContext.window_id,
                  symbol: windowContext.symbol,
                  model_probability: modelProbability,
                  market_price: marketPrice,
                  edge,
                });
              }
            } else if (componentResult?.signal === 'entry') {
              // Fallback for components that don't return probability
              log.warn('legacy_signal_without_edge', {
                window_id: windowContext.window_id,
                component: versionId,
              });
            }
          } catch (err) {
            log.warn('component_execution_failed', {
              strategy: strategyDef.name,
              component: versionId,
              window_id: windowContext.window_id,
              error: err.message,
            });
          }
        }
      }

      // Add signal if generated for this window
      if (windowSignal) {
        results.signals.push(windowSignal);
      }
    }

    return results;
  };
}

/**
 * Get component type from version ID
 *
 * @param {string} versionId - Component version ID (e.g., "prob-spot-lag-v1")
 * @returns {string} Component type
 * @private
 */
function getComponentType(versionId) {
  const prefixMap = {
    prob: 'probability',
    entry: 'entry',
    exit: 'exit',
    sizing: 'sizing',
    src: 'price-source',
    anal: 'analysis',
    sig: 'signal-generator',
  };
  const prefix = versionId.split('-')[0];
  return prefixMap[prefix] || 'unknown';
}

/**
 * Start the execution loop
 *
 * @throws {OrchestratorError} If not initialized
 */
export function start() {
  ensureInitialized();

  if (state.state === OrchestratorState.RUNNING) {
    log.debug('orchestrator_already_running');
    return;
  }

  // Create execution loop if not exists
  if (!executionLoop) {
    executionLoop = new ExecutionLoop({
      config: config.orchestrator || { tickIntervalMs: 1000 },
      modules: getAllModules(),
      log: child({ module: 'execution-loop' }),
      onError: handleLoopError,
      // Story 7-12: Pass active composed strategy for multi-strategy support
      composedStrategy: activeComposedStrategy,
      composedStrategyName: getActiveStrategyName(),
    });
  }

  executionLoop.start();
  state.state = OrchestratorState.RUNNING;
  log.info('orchestrator_started');
}

/**
 * Stop the execution loop
 */
export function stop() {
  if (executionLoop) {
    executionLoop.stop();
  }
  if (state.state === OrchestratorState.RUNNING || state.state === OrchestratorState.PAUSED) {
    state.state = OrchestratorState.INITIALIZED;
  }
  log.info('orchestrator_stopped');
}

/**
 * Pause the execution loop
 */
export function pause() {
  ensureInitialized();
  if (executionLoop) {
    executionLoop.pause();
  }
  if (state.state === OrchestratorState.RUNNING) {
    state.state = OrchestratorState.PAUSED;
  }
  log.info('orchestrator_paused');
}

/**
 * Resume a paused execution loop
 */
export function resume() {
  ensureInitialized();
  if (executionLoop) {
    executionLoop.resume();
  }
  if (state.state === OrchestratorState.PAUSED) {
    state.state = OrchestratorState.RUNNING;
  }
  log.info('orchestrator_resumed');
}

/**
 * Get current orchestrator and module states
 *
 * @returns {Object} Complete state including all modules and loop metrics
 */
export function getState() {
  // Aggregate module states
  const modules = {};
  const allModules = getAllModules();
  for (const [name, moduleInstance] of Object.entries(allModules)) {
    if (moduleInstance && typeof moduleInstance.getState === 'function') {
      try {
        modules[name] = moduleInstance.getState();
      } catch {
        modules[name] = { error: 'Failed to get state' };
      }
    }
  }

  // Get loop state
  const loopState = executionLoop ? executionLoop.getState() : null;

  return {
    state: state.state,
    initialized: state.state !== OrchestratorState.STOPPED,
    running: state.state === OrchestratorState.RUNNING,
    paused: state.state === OrchestratorState.PAUSED,
    modules,
    loop: loopState,
    errorCount: state.errorCount,
    errorCount1m: getErrorCount1m(), // 1-minute error count for health endpoint
    recoveryCount: state.recoveryCount,
    lastError: state.lastError,
    startedAt: state.startedAt,
    // Launch manifest for health endpoint (Story 8-3)
    manifest: loadedManifest,
    loadedStrategies: loadedManifest?.strategies ?? [],
    // Strategy composition state (Story 7-12)
    activeStrategy: getActiveStrategyName(),
    availableStrategies: listLoadedStrategies().map(s => s.name),
  };
}

/**
 * Gracefully shutdown the orchestrator and all modules
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (state.state === OrchestratorState.STOPPED) {
    return;
  }

  state.state = OrchestratorState.SHUTTING_DOWN;
  log.info('orchestrator_shutdown_start');

  // 1. Stop periodic state updates
  stopPeriodicStateUpdates();

  // 2. Stop execution loop immediately
  if (executionLoop) {
    executionLoop.stop();
    executionLoop = null;
  }

  // 3. Wait for in-flight operations (if any)
  if (state.inFlightOperations > 0) {
    log.info('waiting_for_inflight', { count: state.inFlightOperations });
    const inflightTimeoutMs = config?.orchestrator?.inflightTimeoutMs || 10000;
    await waitForInflight(inflightTimeoutMs);
  }

  // 4. Write final state snapshot (forced_kill: false for graceful shutdown)
  try {
    await writeStateSnapshot(true);
  } catch (err) {
    log.warn('final_state_snapshot_failed', { error: err.message });
    // Continue with shutdown even if snapshot fails
  }

  // 5. Shutdown modules in reverse initialization order
  await shutdownModules();

  // 6. Remove PID file
  removePidFile();

  // 7. Clean up orchestrator state
  clearModules();
  state = createInitialState();
  state.stoppedAt = new Date().toISOString();
  loadedManifest = null;

  log.info('orchestrator_shutdown_complete');
  log = null;
  config = null;
}

/**
 * Shutdown all modules in reverse initialization order
 *
 * @returns {Promise<void>}
 * @private
 */
async function shutdownModules() {
  const timeoutMs = config?.orchestrator?.moduleShutdownTimeoutMs || 5000;
  const reverseOrder = [...state.initializationOrder].reverse();

  for (const name of reverseOrder) {
    const moduleInstance = getModule(name);
    if (!moduleInstance || typeof moduleInstance.shutdown !== 'function') {
      continue;
    }

    log.info('module_shutdown_start', { module: name });

    try {
      await withTimeout(
        moduleInstance.shutdown(),
        timeoutMs,
        `Module ${name} shutdown timeout after ${timeoutMs}ms`
      );
      log.info('module_shutdown_complete', { module: name });
    } catch (err) {
      log.warn('module_shutdown_timeout', {
        module: name,
        error: err.message,
      });
      // Continue with other modules - don't let one block the rest
    }
  }
}

/**
 * Handle errors from the execution loop
 *
 * @param {Error} err - Error from loop
 * @private
 */
function handleLoopError(err) {
  state.errorCount++;
  recordError(); // Track timestamp for 1-minute error counting
  state.lastError = {
    code: err.code || 'UNKNOWN',
    message: err.message,
    timestamp: new Date().toISOString(),
  };

  const category = categorizeError(err);

  if (category === ErrorCategory.FATAL) {
    log.error('fatal_error_triggering_shutdown', {
      error: err.message,
      code: err.code,
      errorCount: state.errorCount,
    });
    // Trigger shutdown on fatal error
    shutdown().catch((shutdownErr) => {
      log.error('shutdown_failed_after_fatal', { error: shutdownErr.message });
    });
  } else {
    // Recoverable error - will be retried on next tick
    state.recoveryCount++;
    log.warn('recoverable_error', {
      error: err.message,
      code: err.code,
      errorCount: state.errorCount,
      recoveryCount: state.recoveryCount,
    });
  }
}

/**
 * Wait for in-flight operations to complete
 *
 * @param {number} timeoutMs - Maximum wait time
 * @returns {Promise<void>}
 * @private
 */
async function waitForInflight(timeoutMs) {
  const startTime = Date.now();
  while (state.inFlightOperations > 0) {
    if (Date.now() - startTime > timeoutMs) {
      log.warn('inflight_timeout', {
        remaining: state.inFlightOperations,
        timeoutMs,
      });
      break;
    }
    await sleep(100);
  }
}

/**
 * Ensure orchestrator is initialized
 *
 * @throws {OrchestratorError} If not initialized
 * @private
 */
function ensureInitialized() {
  if (
    state.state === OrchestratorState.STOPPED ||
    state.state === OrchestratorState.INITIALIZING
  ) {
    throw new OrchestratorError(
      OrchestratorErrorCodes.NOT_INITIALIZED,
      'Orchestrator not initialized. Call init() first.',
      { currentState: state.state }
    );
  }
}

/**
 * Execute a promise with timeout
 *
 * @param {Promise} promise - Promise to execute
 * @param {number} ms - Timeout in milliseconds
 * @param {string} errorMessage - Error message on timeout
 * @returns {Promise} Result of promise or timeout error
 * @private
 */
async function withTimeout(promise, ms, errorMessage) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(errorMessage)), ms);
  });
  return Promise.race([promise, timeout]);
}

/**
 * Sleep utility
 *
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 * @private
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get the loaded launch manifest
 *
 * Returns the manifest loaded during initialization, or null if not loaded.
 *
 * @returns {Object|null} Launch manifest or null
 */
export function getLoadedManifest() {
  return loadedManifest ? { ...loadedManifest } : null;
}

/**
 * Get list of strategies allowed by manifest
 *
 * @returns {string[]} Array of strategy names from manifest
 */
export function getAllowedStrategies() {
  return loadedManifest?.strategies ?? [];
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY COMPOSITION FUNCTIONS (Story 7-12)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Set the active composed strategy at runtime
 *
 * Allows switching strategies without restarting the orchestrator.
 * The strategy must be loaded and have valid component references.
 *
 * @param {string} strategyName - Name of strategy to activate
 * @returns {Object} Result { success, strategyName, error? }
 */
export function setActiveStrategy(strategyName) {
  ensureInitialized();

  const strategyDef = getLoadedStrategy(strategyName);
  if (!strategyDef) {
    const available = listLoadedStrategies().map(s => s.name);
    log.warn('strategy_not_found', { strategyName, available });
    return {
      success: false,
      strategyName,
      error: `Strategy not found: ${strategyName}. Available: ${available.join(', ')}`,
    };
  }

  if (!strategyDef.validation.valid) {
    log.warn('strategy_invalid', {
      strategyName,
      errors: strategyDef.validation.errors,
    });
    return {
      success: false,
      strategyName,
      error: `Strategy has invalid component references: ${strategyDef.validation.errors?.join(', ')}`,
    };
  }

  try {
    setActiveStrategyLoader(strategyName);
    activeComposedStrategy = createComposedStrategyExecutor(strategyDef, getCatalog());

    // Update execution loop with new strategy
    if (executionLoop) {
      executionLoop.setComposedStrategy(activeComposedStrategy, strategyName);
    }

    log.info('active_strategy_changed', {
      strategyName,
      components: Object.keys(strategyDef.components),
    });

    return {
      success: true,
      strategyName,
    };
  } catch (err) {
    log.error('strategy_activation_failed', {
      strategyName,
      error: err.message,
    });
    return {
      success: false,
      strategyName,
      error: err.message,
    };
  }
}

/**
 * Clear the active composed strategy
 *
 * Returns the execution loop to using the default strategy-evaluator module.
 *
 * @returns {Object} Result { success, previousStrategy }
 */
export function clearActiveStrategy() {
  const previousStrategy = getActiveStrategyName();
  activeComposedStrategy = null;

  // Clear in loader
  try {
    // Reset the active strategy in the loader
    if (getActiveStrategyLoader()) {
      // There's no clearActiveStrategy in the loader, so we just clear our local state
    }
  } catch {
    // Ignore - just clearing local state
  }

  // Update execution loop
  if (executionLoop) {
    executionLoop.setComposedStrategy(null, null);
  }

  log.info('active_strategy_cleared', { previousStrategy });

  return {
    success: true,
    previousStrategy,
  };
}

/**
 * Get current active strategy name
 *
 * @returns {string|null} Active strategy name or null if using default
 */
export function getActiveStrategyNameFromOrchestrator() {
  return getActiveStrategyName();
}

/**
 * List all available strategies
 *
 * @returns {Object[]} Array of strategy summaries
 */
export function listAvailableStrategies() {
  return listLoadedStrategies();
}

// Re-export types
export {
  OrchestratorError,
  OrchestratorErrorCodes,
  OrchestratorState,
  ErrorCategory,
  categorizeError,
} from './types.js';
