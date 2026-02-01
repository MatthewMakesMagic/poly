/**
 * RTDS Client Component Adapter
 *
 * Wraps the RTDS client module as a strategy component for the Epic 6 composition framework.
 * Provides access to real-time spot (Binance) and oracle (Chainlink) prices.
 *
 * @module modules/strategy/components/price-source/rtds-client
 */

import * as rtdsClient from '../../../../clients/rtds/index.js';
import { TOPICS } from '../../../../clients/rtds/types.js';

/**
 * Component metadata - REQUIRED
 */
export const metadata = {
  name: 'rtds-client',
  version: 1,
  type: 'price-source',
  description: 'Real-time price data from RTDS WebSocket (Binance spot + Chainlink oracle)',
  author: 'BMAD',
  createdAt: '2026-02-01',
};

/**
 * Evaluate price source (standard component interface)
 *
 * Returns current spot and oracle prices for the given symbol.
 *
 * @param {Object} context - Execution context
 * @param {string} context.symbol - Cryptocurrency symbol (btc, eth, sol, xrp)
 * @param {Object} config - Component configuration (unused)
 * @returns {Object} Evaluation result with prices
 */
export function evaluate(context, config) {
  const { symbol } = context;

  // Get RTDS state
  const rtdsState = rtdsClient.getState();

  // Get current prices for both feeds
  let spotPrice = null;
  let oraclePrice = null;
  let spotStaleness = null;
  let oracleStaleness = null;

  try {
    const spotData = rtdsClient.getCurrentPrice(symbol, TOPICS.CRYPTO_PRICES);
    if (spotData) {
      spotPrice = spotData.price;
      spotStaleness = spotData.staleness_ms;
    }
  } catch {
    // Spot price unavailable
  }

  try {
    const oracleData = rtdsClient.getCurrentPrice(symbol, TOPICS.CRYPTO_PRICES_CHAINLINK);
    if (oracleData) {
      oraclePrice = oracleData.price;
      oracleStaleness = oracleData.staleness_ms;
    }
  } catch {
    // Oracle price unavailable
  }

  // Calculate spread if both prices available
  let spread = null;
  let spreadPct = null;
  if (spotPrice !== null && oraclePrice !== null && oraclePrice !== 0) {
    spread = spotPrice - oraclePrice;
    spreadPct = (spread / oraclePrice) * 100;
  }

  return {
    prices: {
      spot: spotPrice,
      oracle: oraclePrice,
    },
    staleness: {
      spot_ms: spotStaleness,
      oracle_ms: oracleStaleness,
    },
    spread: {
      absolute: spread,
      pct: spreadPct,
    },
    connected: rtdsState.connected,
    symbol,
  };
}

/**
 * Validate component configuration
 *
 * @param {Object} config - Configuration to validate
 * @returns {Object} Validation result { valid: boolean, errors?: string[] }
 */
export function validateConfig(config) {
  // RTDS client component has no required config options
  return { valid: true };
}

export default {
  metadata,
  evaluate,
  validateConfig,
};
