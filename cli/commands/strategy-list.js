#!/usr/bin/env node
/**
 * CLI Strategy List Command
 *
 * Lists all available strategies loaded from config/strategies/.
 *
 * Usage: node cli/commands/strategy-list.js
 *
 * @module cli/commands/strategy-list
 */

import { discoverComponents } from '../../src/modules/strategy/logic.js';
import { setCatalog } from '../../src/modules/strategy/state.js';
import {
  loadAllStrategies,
  listLoadedStrategies,
  getActiveStrategyName,
} from '../../src/modules/strategy/loader.js';

/**
 * Execute the strategy list command
 *
 * @returns {Promise<{success: boolean, strategies: Object[]}>}
 */
export async function execute() {
  // First discover components to populate catalog
  const catalog = await discoverComponents();
  setCatalog(catalog);

  // Load all strategies
  const loadResult = loadAllStrategies();

  // Get list of strategies
  const strategies = listLoadedStrategies();
  const activeStrategy = getActiveStrategyName();

  return {
    success: true,
    strategies,
    loaded: loadResult.loaded.length,
    failed: loadResult.failed.length,
    activeStrategy,
  };
}

/**
 * Format strategy for display
 */
function formatStrategy(strategy, index, isActive) {
  const activeMarker = isActive ? ' (active)' : '';
  const validMarker = strategy.valid ? '✓' : '✗';

  return `  ${index + 1}. ${strategy.name}${activeMarker}
     ${validMarker} ${strategy.description || 'No description'}
     Components: ${strategy.componentCount}`;
}

/**
 * Show help for the strategy list command
 */
export function showHelp() {
  console.log(`
Strategy List Command - Show available trading strategies

Usage: node cli/commands/strategy-list.js [options]

Options:
  --help, -h    Show this help message
  --json        Output as JSON

Description:
  Lists all trading strategies loaded from config/strategies/ directory.
  Each strategy is validated against the component catalog.

Examples:
  node cli/commands/strategy-list.js           # List all strategies
  node cli/commands/strategy-list.js --json    # Output as JSON
`.trim());
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  const jsonOutput = args.includes('--json');

  try {
    const result = await execute();

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('\nAvailable Strategies:');
      console.log('═'.repeat(50));

      if (result.strategies.length === 0) {
        console.log('  No strategies found in config/strategies/');
      } else {
        for (let i = 0; i < result.strategies.length; i++) {
          const strategy = result.strategies[i];
          const isActive = strategy.name === result.activeStrategy;
          console.log(formatStrategy(strategy, i, isActive));
          console.log('');
        }
      }

      console.log(`Total: ${result.loaded} loaded, ${result.failed} failed`);
    }

    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
