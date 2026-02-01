#!/usr/bin/env node

/**
 * Launch Config CLI
 *
 * Interactive command-line tool for managing the launch manifest.
 * Provides a fallback for users who prefer CLI over Claude Code.
 *
 * Usage:
 *   npm run launch:config              # Show current config and menu
 *   npm run launch:config -- show      # Show current config
 *   npm run launch:config -- list      # List available strategies
 *   npm run launch:config -- set strategies simple-threshold oracle-edge
 *   npm run launch:config -- set position_size_dollars 25
 *   npm run launch:config -- set max_exposure_dollars 1000
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

// Import from module to avoid duplication (DRY principle)
import { KNOWN_STRATEGIES, MANIFEST_LIMITS } from '../src/modules/launch-config/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(__dirname, '../config/launch.json');

/**
 * Read the current manifest
 */
function readManifest() {
  try {
    const content = fs.readFileSync(MANIFEST_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error('Launch manifest not found. Creating default...');
      const defaultManifest = {
        strategies: ['simple-threshold'],
        position_size_dollars: 10,
        max_exposure_dollars: 500,
        symbols: ['BTC', 'ETH', 'SOL', 'XRP'],
        kill_switch_enabled: true,
      };
      writeManifest(defaultManifest);
      return defaultManifest;
    }
    throw err;
  }
}

/**
 * Write the manifest
 */
function writeManifest(manifest) {
  const content = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(MANIFEST_PATH, content, 'utf-8');
}

/**
 * Display current manifest
 */
function showManifest() {
  const manifest = readManifest();
  console.log('\n=== Launch Manifest ===\n');
  console.log(`Strategies:          ${manifest.strategies.join(', ')}`);
  console.log(`Position Size:       $${manifest.position_size_dollars}`);
  console.log(`Max Exposure:        $${manifest.max_exposure_dollars}`);
  console.log(`Symbols:             ${manifest.symbols.join(', ')}`);
  console.log(`Kill Switch:         ${manifest.kill_switch_enabled ? 'Enabled' : 'Disabled'}`);
  console.log(`\nPath: ${MANIFEST_PATH}\n`);
}

/**
 * List available strategies
 */
function listStrategies() {
  console.log('\n=== Available Strategies ===\n');
  console.log('Name                 Description                        Dependencies');
  console.log('-------------------- ---------------------------------- ------------');
  for (const s of KNOWN_STRATEGIES) {
    console.log(
      `${s.name.padEnd(20)} ${s.description.padEnd(34)} ${s.dependencies.join(', ')}`
    );
  }
  console.log('');
}

/**
 * Set a manifest value
 */
function setValue(key, values) {
  const manifest = readManifest();

  switch (key) {
    case 'strategies':
      // Validate strategy names
      const unknown = values.filter((v) => !KNOWN_STRATEGIES.some((s) => s.name === v));
      if (unknown.length > 0) {
        console.error(`Unknown strategies: ${unknown.join(', ')}`);
        console.error('Use "npm run launch:config -- list" to see available strategies');
        process.exit(1);
      }
      manifest.strategies = values;
      break;

    case 'position_size_dollars':
      const posSize = parseFloat(values[0]);
      if (isNaN(posSize) || posSize < 1) {
        console.error('Position size must be a number >= 1');
        process.exit(1);
      }
      if (posSize > MANIFEST_LIMITS.maxPositionSizeDollars) {
        console.error(`Position size must be <= ${MANIFEST_LIMITS.maxPositionSizeDollars}`);
        process.exit(1);
      }
      manifest.position_size_dollars = posSize;
      break;

    case 'max_exposure_dollars':
      const maxExp = parseFloat(values[0]);
      if (isNaN(maxExp) || maxExp < 1) {
        console.error('Max exposure must be a number >= 1');
        process.exit(1);
      }
      if (maxExp > MANIFEST_LIMITS.maxExposureDollars) {
        console.error(`Max exposure must be <= ${MANIFEST_LIMITS.maxExposureDollars}`);
        process.exit(1);
      }
      manifest.max_exposure_dollars = maxExp;
      break;

    case 'symbols':
      if (values.length === 0) {
        console.error('At least one symbol required');
        process.exit(1);
      }
      manifest.symbols = values;
      break;

    case 'kill_switch_enabled':
      const val = values[0]?.toLowerCase();
      if (!['true', 'false', '1', '0', 'yes', 'no'].includes(val)) {
        console.error('Kill switch must be true/false, 1/0, or yes/no');
        process.exit(1);
      }
      manifest.kill_switch_enabled = ['true', '1', 'yes'].includes(val);
      break;

    default:
      console.error(`Unknown key: ${key}`);
      console.error('Valid keys: strategies, position_size_dollars, max_exposure_dollars, symbols, kill_switch_enabled');
      process.exit(1);
  }

  writeManifest(manifest);
  console.log(`Updated ${key}`);
  showManifest();
}

/**
 * Interactive menu
 */
async function interactiveMenu() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

  showManifest();

  console.log('Commands:');
  console.log('  1. Show current config');
  console.log('  2. List available strategies');
  console.log('  3. Set strategies');
  console.log('  4. Set position size');
  console.log('  5. Set max exposure');
  console.log('  6. Toggle kill switch');
  console.log('  q. Quit');
  console.log('');

  while (true) {
    const choice = await question('> ');

    switch (choice.trim()) {
      case '1':
        showManifest();
        break;

      case '2':
        listStrategies();
        break;

      case '3':
        listStrategies();
        const stratInput = await question('Enter strategy names (space-separated): ');
        const strategies = stratInput.trim().split(/\s+/).filter(Boolean);
        if (strategies.length > 0) {
          setValue('strategies', strategies);
        }
        break;

      case '4':
        const posInput = await question('Enter position size in dollars: ');
        if (posInput.trim()) {
          setValue('position_size_dollars', [posInput.trim()]);
        }
        break;

      case '5':
        const expInput = await question('Enter max exposure in dollars: ');
        if (expInput.trim()) {
          setValue('max_exposure_dollars', [expInput.trim()]);
        }
        break;

      case '6':
        const manifest = readManifest();
        manifest.kill_switch_enabled = !manifest.kill_switch_enabled;
        writeManifest(manifest);
        console.log(`Kill switch ${manifest.kill_switch_enabled ? 'enabled' : 'disabled'}`);
        break;

      case 'q':
      case 'quit':
      case 'exit':
        rl.close();
        return;

      default:
        console.log('Unknown command. Enter 1-6 or q to quit.');
    }
  }
}

// Main entry point
const args = process.argv.slice(2);

if (args.length === 0) {
  interactiveMenu().catch(console.error);
} else {
  const command = args[0];

  switch (command) {
    case 'show':
      showManifest();
      break;

    case 'list':
      listStrategies();
      break;

    case 'set':
      if (args.length < 3) {
        console.error('Usage: npm run launch:config -- set <key> <value...>');
        process.exit(1);
      }
      setValue(args[1], args.slice(2));
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Commands: show, list, set');
      process.exit(1);
  }
}
