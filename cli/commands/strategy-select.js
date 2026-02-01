#!/usr/bin/env node
/**
 * CLI Strategy Select Command
 *
 * Sets the active strategy for trading.
 *
 * Usage: node cli/commands/strategy-select.js <strategy-name>
 *
 * @module cli/commands/strategy-select
 */

import { discoverComponents } from '../../src/modules/strategy/logic.js';
import { setCatalog } from '../../src/modules/strategy/state.js';
import {
  loadAllStrategies,
  listLoadedStrategies,
  setActiveStrategy,
  getActiveStrategyName,
} from '../../src/modules/strategy/loader.js';

/**
 * Execute the strategy select command
 *
 * @param {string} strategyName - Name of strategy to activate
 * @returns {Promise<{success: boolean, message: string, strategy?: Object}>}
 */
export async function execute(strategyName) {
  if (!strategyName) {
    return {
      success: false,
      message: 'Strategy name is required',
    };
  }

  // First discover components to populate catalog
  const catalog = await discoverComponents();
  setCatalog(catalog);

  // Load all strategies
  loadAllStrategies();

  // Get previous active strategy
  const previousActive = getActiveStrategyName();

  // Try to set active strategy
  try {
    const strategy = setActiveStrategy(strategyName);

    return {
      success: true,
      message: `Switched active strategy to: ${strategyName}`,
      previousStrategy: previousActive,
      strategy: {
        name: strategy.name,
        description: strategy.description,
        version: strategy.version,
        componentCount: Object.values(strategy.components).flat().length,
      },
    };
  } catch (err) {
    // Strategy not found - show available options
    const strategies = listLoadedStrategies();

    return {
      success: false,
      message: err.message,
      availableStrategies: strategies.map(s => s.name),
    };
  }
}

/**
 * Show help for the strategy select command
 */
export function showHelp() {
  console.log(`
Strategy Select Command - Set the active trading strategy

Usage: node cli/commands/strategy-select.js <strategy-name> [options]

Arguments:
  strategy-name   Name of the strategy to activate (case-sensitive)

Options:
  --help, -h      Show this help message
  --json          Output as JSON

Description:
  Sets the active strategy for trading operations.
  The strategy must be loaded from config/strategies/ and validated.

Examples:
  node cli/commands/strategy-select.js "Oracle Edge Only"
  node cli/commands/strategy-select.js "Hybrid" --json
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

  // Find strategy name (first non-flag argument)
  const strategyName = args.find(arg => !arg.startsWith('--'));

  try {
    const result = await execute(strategyName);

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.success) {
        console.log(`\n✓ ${result.message}`);
        if (result.previousStrategy) {
          console.log(`  Previous: ${result.previousStrategy}`);
        }
        console.log(`  Strategy loaded and validated.`);
        console.log(`  Components: ${result.strategy.componentCount}`);
      } else {
        console.log(`\n✗ Error: ${result.message}`);
        if (result.availableStrategies) {
          console.log('\nAvailable strategies:');
          for (const name of result.availableStrategies) {
            console.log(`  - ${name}`);
          }
        }
      }
    }

    process.exit(result.success ? 0 : 1);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
