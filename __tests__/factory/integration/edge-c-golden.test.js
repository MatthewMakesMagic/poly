/**
 * Golden Test: Edge-C Asymmetry — YAML vs JS Equivalence (Story 2.6)
 *
 * Covers: FR4 (YAML to runnable strategy), NFR12 (interface contract)
 *
 * This is the most critical factory test. It proves the compose engine works
 * by recreating edge-c-asymmetry in YAML, then running both versions against
 * the same mocked MarketState inputs and verifying identical signal output.
 *
 * Why this matters:
 *   If this test passes, the factory produces strategies that behave identically
 *   to hand-coded JS. If it fails, the factory is not trustworthy.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { loadBlocks } from '../../../src/factory/registry.js';
import { composeFromYaml } from '../../../src/factory/compose.js';
import { readFile } from 'node:fs/promises';

// Import the JS version directly
import * as edgeCJs from '../../../src/backtest/strategies/edge-c-asymmetry.js';

const FACTORY_DIR = new URL('../../../src/factory/', import.meta.url).pathname;
const YAML_PATH = new URL('../../../src/factory/strategies/edge-c-asymmetry.yaml', import.meta.url).pathname;

let yamlStrategy;

beforeAll(async () => {
  await loadBlocks(FACTORY_DIR);
  const yamlContent = await readFile(YAML_PATH, 'utf-8');
  yamlStrategy = await composeFromYaml(yamlContent);
});

/**
 * Generate deterministic test market states that cover various scenarios.
 * Uses a seeded approach to ensure reproducibility.
 */
function generateTestWindows(count) {
  const windows = [];
  // Use a simple deterministic sequence for reproducibility
  let seed = 42;
  function nextRand() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }

  for (let i = 0; i < count; i++) {
    const basePrice = 58000 + nextRand() * 4000; // 58000-62000
    const clDeficit = nextRand() * 200 - 50;      // -50 to 150
    const refOffset = nextRand() * 300 - 150;     // -150 to 150
    const timeToClose = nextRand() * 300000;       // 0 to 5 min
    const downAsk = nextRand() * 0.8 + 0.1;       // 0.1 to 0.9

    const oracleAtOpen = basePrice;
    const clPrice = basePrice - clDeficit;
    const refPrice = basePrice + refOffset;

    windows.push({
      chainlink: { price: clPrice, ts: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z` },
      polyRef: { price: refPrice },
      oraclePriceAtOpen: oracleAtOpen,
      strike: oracleAtOpen,
      clobDown: { bestAsk: downAsk },
      clobUp: { bestAsk: 1 - downAsk },
      window: {
        symbol: 'btc',
        timeToCloseMs: timeToClose,
      },
      timestamp: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`,
    });
  }

  return windows;
}

describe('Edge-C Golden Test — YAML vs JS Equivalence', () => {

  it('YAML and JS versions produce identical signals on 50 seeded windows', () => {
    const windows = generateTestWindows(50);
    const config = { ...edgeCJs.defaults };

    // Reset both strategies for each test run
    edgeCJs.onWindowOpen();
    yamlStrategy.onWindowOpen({}, {});

    let jsSignalCount = 0;
    let yamlSignalCount = 0;
    const mismatches = [];

    for (let i = 0; i < windows.length; i++) {
      // Reset both at the start of each "window" to test per-tick behavior
      // For the golden test, we treat each tick as a separate window
      edgeCJs.onWindowOpen();
      yamlStrategy.onWindowOpen(windows[i], {});

      const jsResult = edgeCJs.evaluate(windows[i], config);
      const yamlResult = yamlStrategy.evaluate(windows[i], config);

      if (jsResult.length > 0) jsSignalCount++;
      if (yamlResult.length > 0) yamlSignalCount++;

      // Compare signal counts
      if (jsResult.length !== yamlResult.length) {
        mismatches.push({
          window: i,
          js: jsResult.length,
          yaml: yamlResult.length,
          state: {
            clDeficit: (windows[i].oraclePriceAtOpen - windows[i].chainlink.price).toFixed(0),
            refDist: Math.abs(windows[i].polyRef.price - windows[i].oraclePriceAtOpen).toFixed(0),
            timeToClose: windows[i].window.timeToCloseMs.toFixed(0),
            downAsk: windows[i].clobDown.bestAsk.toFixed(3),
          },
        });
        continue;
      }

      // Compare signal content
      for (let j = 0; j < jsResult.length; j++) {
        if (jsResult[j].action !== yamlResult[j].action) {
          mismatches.push({ window: i, field: 'action', js: jsResult[j].action, yaml: yamlResult[j].action });
        }
        if (jsResult[j].token !== yamlResult[j].token) {
          mismatches.push({ window: i, field: 'token', js: jsResult[j].token, yaml: yamlResult[j].token });
        }
        if (jsResult[j].capitalPerTrade !== yamlResult[j].capitalPerTrade) {
          mismatches.push({ window: i, field: 'capitalPerTrade', js: jsResult[j].capitalPerTrade, yaml: yamlResult[j].capitalPerTrade });
        }
      }
    }

    expect(
      mismatches,
      `YAML and JS versions produced ${mismatches.length} mismatches out of 50 windows. ` +
      `JS fired ${jsSignalCount} signals, YAML fired ${yamlSignalCount}. ` +
      `First mismatch: ${JSON.stringify(mismatches[0])}`
    ).toHaveLength(0);

    // Sanity: at least some signals should have fired
    expect(
      jsSignalCount,
      'Golden test sanity check: at least 1 signal should fire in 50 windows with varied conditions'
    ).toBeGreaterThan(0);
  });

  it('YAML strategy has correct name', () => {
    expect(yamlStrategy.name).toBe('edge-c-asymmetry');
  });

  it('YAML strategy has required interface fields', () => {
    expect(typeof yamlStrategy.evaluate, 'evaluate must be a function').toBe('function');
    expect(typeof yamlStrategy.onWindowOpen, 'onWindowOpen must be a function').toBe('function');
    expect(typeof yamlStrategy.defaults, 'defaults must be an object').toBe('object');
    expect(typeof yamlStrategy.sweepGrid, 'sweepGrid must be an object').toBe('object');
  });

  it('both versions return empty on missing data', () => {
    edgeCJs.onWindowOpen();
    yamlStrategy.onWindowOpen({}, {});

    const emptyState = { window: { symbol: 'btc' } };
    const config = { ...edgeCJs.defaults };

    const jsResult = edgeCJs.evaluate(emptyState, config);
    const yamlResult = yamlStrategy.evaluate(emptyState, config);

    expect(jsResult, 'JS returns empty on missing data').toHaveLength(0);
    expect(yamlResult, 'YAML returns empty on missing data').toHaveLength(0);
  });
});
