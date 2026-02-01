#!/usr/bin/env node
/**
 * CLI Strategy Status Command
 *
 * Shows detailed status of the currently active strategy.
 *
 * Usage: node cli/commands/strategy-status.js
 *
 * @module cli/commands/strategy-status
 */

import { discoverComponents } from '../../src/modules/strategy/logic.js';
import { setCatalog, getFromCatalog } from '../../src/modules/strategy/state.js';
import {
  loadAllStrategies,
  getActiveStrategy,
  getActiveStrategyName,
  setActiveStrategy,
} from '../../src/modules/strategy/loader.js';

/**
 * Execute the strategy status command
 *
 * @returns {Promise<{success: boolean, status: Object}>}
 */
export async function execute() {
  // First discover components to populate catalog
  const catalog = await discoverComponents();
  setCatalog(catalog);

  // Load all strategies
  loadAllStrategies();

  // Get active strategy
  let activeStrategy = getActiveStrategy();

  // If no active strategy, try to set default
  if (!activeStrategy) {
    try {
      // Try common default name
      setActiveStrategy('Oracle Edge Only');
      activeStrategy = getActiveStrategy();
    } catch {
      // No default available
    }
  }

  if (!activeStrategy) {
    return {
      success: true,
      status: {
        active: false,
        message: 'No active strategy. Use strategy-select to set one.',
      },
    };
  }

  // Build component details
  const componentDetails = {};
  for (const [type, value] of Object.entries(activeStrategy.components)) {
    const versionIds = Array.isArray(value) ? value : [value];
    componentDetails[type] = [];

    for (const versionId of versionIds) {
      const component = getFromCatalog(versionId);
      if (component) {
        componentDetails[type].push({
          versionId,
          name: component.name,
          type: component.type,
          valid: true,
        });
      } else {
        componentDetails[type].push({
          versionId,
          valid: false,
        });
      }
    }
  }

  return {
    success: true,
    status: {
      active: true,
      name: activeStrategy.name,
      description: activeStrategy.description,
      version: activeStrategy.version,
      valid: activeStrategy.validation.valid,
      components: componentDetails,
      config: activeStrategy.config,
      pipeline: activeStrategy.pipeline,
      configPath: activeStrategy.configPath,
    },
  };
}

/**
 * Format component for display
 */
function formatComponent(type, components) {
  let output = `  ${type}:`;
  for (const comp of components) {
    const marker = comp.valid ? '✓' : '✗';
    output += `\n    ${marker} ${comp.versionId}`;
  }
  return output;
}

/**
 * Show help for the strategy status command
 */
export function showHelp() {
  console.log(`
Strategy Status Command - Show current active strategy details

Usage: node cli/commands/strategy-status.js [options]

Options:
  --help, -h    Show this help message
  --json        Output as JSON

Description:
  Shows detailed information about the currently active trading strategy
  including components, configuration, and validation status.

Examples:
  node cli/commands/strategy-status.js           # Show status
  node cli/commands/strategy-status.js --json    # Output as JSON
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
      const status = result.status;

      if (!status.active) {
        console.log(`\n${status.message}`);
      } else {
        console.log(`\nActive Strategy: ${status.name}`);
        console.log('═'.repeat(50));
        console.log(`Description: ${status.description || 'None'}`);
        console.log(`Version: ${status.version}`);
        console.log(`Valid: ${status.valid ? '✓ Yes' : '✗ No'}`);
        console.log(`Config: ${status.configPath}`);

        console.log('\nComponents:');
        for (const [type, components] of Object.entries(status.components)) {
          console.log(formatComponent(type, components));
        }

        if (status.config && Object.keys(status.config).length > 0) {
          console.log('\nConfiguration:');
          for (const [key, value] of Object.entries(status.config)) {
            if (typeof value === 'object') {
              console.log(`  ${key}: ${JSON.stringify(value)}`);
            } else {
              console.log(`  ${key}: ${value}`);
            }
          }
        }

        if (status.pipeline) {
          console.log('\nPipeline:');
          console.log(`  Order: ${status.pipeline.order?.join(' → ') || 'default'}`);
          console.log(`  Aggregation: ${status.pipeline.signalAggregation || 'default'}`);
        }
      }
    }

    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
