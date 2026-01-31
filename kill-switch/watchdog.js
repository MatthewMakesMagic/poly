#!/usr/bin/env node
/**
 * Kill Switch Watchdog
 *
 * Separate process that monitors and can forcibly terminate the main trading process.
 * This is critical safety infrastructure (FR25, FR26) that guarantees <5 second kill time.
 *
 * Usage: node kill-switch/watchdog.js <command>
 *
 * Commands:
 *   start   - Start watching the main process
 *   stop    - Stop the watchdog
 *   kill    - Trigger kill sequence on main process
 *   status  - Show status of main process and watchdog
 *   help    - Show usage information
 *
 * @module kill-switch/watchdog
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WatchdogDefaults, WatchdogErrorCodes } from './types.js';
import { initialize, executeCommand, stopCommand } from './commands.js';
import { log, error, configure as configureLogger } from './logger.js';

// Get the project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

/**
 * Load configuration from config/default.js if available
 *
 * @returns {Object} Configuration object
 */
function loadConfig() {
  const config = {
    gracefulTimeoutMs: WatchdogDefaults.GRACEFUL_TIMEOUT_MS,
    pidFilePath: WatchdogDefaults.PID_FILE_PATH,
    logFilePath: WatchdogDefaults.LOG_FILE_PATH,
    watchdogPidFile: WatchdogDefaults.WATCHDOG_PID_FILE,
  };

  // Try to load from config/default.js if it exists
  try {
    const configPath = join(projectRoot, 'config', 'default.js');
    if (existsSync(configPath)) {
      // Dynamic import for ES modules
      return import(configPath).then((module) => {
        const defaultConfig = module.default || module;
        if (defaultConfig.killSwitch) {
          config.gracefulTimeoutMs = defaultConfig.killSwitch.gracefulTimeoutMs || config.gracefulTimeoutMs;
          config.stateFilePath = defaultConfig.killSwitch.stateFilePath || WatchdogDefaults.STATE_FILE_PATH;
        }
        return config;
      });
    }
  } catch (err) {
    // Ignore config loading errors - use defaults
    log('config_load_warning', { error: err.message }, 'warn');
  }

  return Promise.resolve(config);
}

/**
 * Parse command line arguments
 *
 * @returns {Object} Parsed arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  return {
    command: command.toLowerCase(),
    args: args.slice(1),
  };
}

/**
 * Format and display command result
 *
 * @param {Object} result - Command result
 * @param {string} command - Command that was executed
 */
function displayResult(result, command) {
  if (command === 'help') {
    // Help command handles its own output
    return;
  }

  console.log('');

  if (command === 'status') {
    displayStatus(result);
    return;
  }

  if (result.success) {
    console.log(`✅ ${result.message}`);
  } else {
    console.log(`❌ ${result.message}`);
  }

  // Display additional details for kill command
  if (command === 'kill' && result.success) {
    console.log(`   Method: ${result.method}`);
    console.log(`   Duration: ${result.durationMs}ms`);
    if (result.forceSent) {
      console.log('   Note: Force kill was required (main process was unresponsive)');
    }
  }

  console.log('');
}

/**
 * Display formatted status output
 *
 * @param {Object} status - Status object
 */
function displayStatus(status) {
  console.log('=== Kill Switch Watchdog Status ===\n');

  // Watchdog status
  console.log('Watchdog:');
  if (status.watchdog.running) {
    console.log(`  ✅ Running (PID: ${status.watchdog.pid})`);
    if (status.watchdog.uptime) {
      console.log(`  ⏱️  Uptime: ${status.watchdog.uptime}`);
    }
  } else {
    console.log('  ⭕ Not running');
  }

  console.log('');

  // Main process status
  console.log('Main Process:');
  const statusEmoji = {
    running: '✅',
    stopped: '⭕',
    unresponsive: '⚠️',
    unknown: '❓',
  };
  console.log(`  ${statusEmoji[status.mainProcess.status] || '❓'} Status: ${status.mainProcess.status}`);
  if (status.mainProcess.pid) {
    console.log(`  📋 PID: ${status.mainProcess.pid}`);
  }
  console.log(`  💬 ${status.mainProcess.message}`);

  console.log('');

  // Health checks
  if (status.healthChecks.total > 0) {
    console.log('Health Checks:');
    console.log(`  Total: ${status.healthChecks.total}`);
    console.log(`  Successful: ${status.healthChecks.successful}`);
    console.log(`  Failed: ${status.healthChecks.failed}`);
    console.log('');
  }

  // Last kill
  if (status.lastKill) {
    console.log('Last Kill Operation:');
    console.log(`  Method: ${status.lastKill.method}`);
    console.log(`  Success: ${status.lastKill.success ? 'Yes' : 'No'}`);
    console.log(`  Duration: ${status.lastKill.durationMs}ms`);
    console.log(`  Time: ${status.lastKill.completedAt}`);
    console.log('');
  }

  // Config
  console.log('Configuration:');
  console.log(`  Graceful timeout: ${status.config.gracefulTimeoutMs}ms`);
  console.log(`  PID file: ${status.config.pidFilePath}`);
  console.log('');
}

/**
 * Setup graceful shutdown handlers
 */
function setupShutdownHandlers() {
  const shutdown = async (signal) => {
    log('watchdog_shutdown_signal', { signal });
    await stopCommand();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Main entry point
 */
async function main() {
  try {
    // Load configuration
    const config = await loadConfig();

    // Initialize logger
    configureLogger({ logFile: config.logFilePath });

    // Initialize commands with config
    initialize(config);

    // Setup shutdown handlers
    setupShutdownHandlers();

    // Parse command line arguments
    const { command } = parseArgs();

    // Log the command
    log('watchdog_command_received', { command, pid: process.pid });

    // Execute the command
    const result = await executeCommand(command);

    // Display result
    displayResult(result, command);

    // Exit with appropriate code (except for 'start' which keeps running)
    if (command !== 'start') {
      process.exit(result.success ? 0 : 1);
    }

    // For 'start' command, keep the process running
    if (command === 'start' && result.success) {
      console.log('Watchdog is now monitoring. Press Ctrl+C to stop.\n');
    }
  } catch (err) {
    error('watchdog_fatal_error', { error: err.message, stack: err.stack });
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  }
}

// Run main
main();
