#!/usr/bin/env node

/**
 * Scout CLI
 *
 * Real-time trading monitor with plain-English explanations.
 *
 * Usage:
 *   node cli/scout.js              # Start Scout in local mode
 *   node cli/scout.js --help       # Show help
 *
 * @module cli/scout
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Add project root to module path
process.chdir(projectRoot);

/**
 * Main execution
 */
async function main() {
  const args = process.argv.slice(2);

  // Handle help
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  // Parse mode argument
  let mode = 'local';
  const modeArg = args.find(arg => arg.startsWith('--mode='));
  if (modeArg) {
    mode = modeArg.split('=')[1];
  }

  try {
    // Import modules (dynamic import to handle initialization order)
    const { init: initLogger } = await import('../src/modules/logger/index.js');
    const { init: initPersistence } = await import('../src/persistence/index.js');
    const { init: initTradeEvent } = await import('../src/modules/trade-event/index.js');
    const scout = await import('../src/modules/scout/index.js');

    // Load config
    const configPath = join(projectRoot, 'config', 'default.js');
    let config = {};
    try {
      const configModule = await import(configPath);
      config = configModule.default || configModule;
    } catch {
      console.log('Note: No config file found, using defaults');
    }

    // Initialize required modules
    console.log('Initializing Scout...\n');

    await initLogger(config);
    await initPersistence(config);
    await initTradeEvent(config);

    // Initialize and start Scout
    await scout.init({ ...config, mode });
    await scout.start();

    // Handle graceful shutdown
    const shutdown = async () => {
      console.log('\n\nShutting down Scout...');
      try {
        await scout.stop();
        await scout.shutdown();
      } catch {
        // Ignore errors during shutdown
      }
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep process alive
    process.stdin.resume();

  } catch (error) {
    console.error('Failed to start Scout:', error.message);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

/**
 * Show help message
 */
function showHelp() {
  console.log(`
Scout - Real-time trading monitor

Usage: node cli/scout.js [options]

Options:
  --mode=local     Monitor local trade events (default)
  --mode=railway   Stream from Railway deployment (Story E.2)
  --help, -h       Show this help message

Description:
  Scout is a friendly terminal-based monitor that watches trading activity
  and explains what's happening in plain English.

  Scout will:
  - Show real-time signals, entries, and exits
  - Explain each event in simple terms
  - Highlight issues that need attention
  - Queue items for later review

  Philosophy: "Silence = Trust" - when things work, Scout confirms briefly.
  When something's off, Scout explains clearly without jargon.

Examples:
  node cli/scout.js                 # Start monitoring
  node cli/scout.js --mode=local    # Explicit local mode
  node cli/scout.js --help          # Show this help

Controls:
  Ctrl+C    Stop Scout and exit
`.trim());
}

main();
