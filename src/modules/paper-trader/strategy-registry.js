/**
 * Strategy Registry
 *
 * Creates 4 VWAP contrarian strategy entries — the only strategies with
 * proven edge from 22K+ paper trades.
 *
 * Each entry has:
 * - name: unique identifier used as signal_type in paper_trades_v2
 * - evaluateMarketState(ctx): returns market state or null
 * - shouldFire(state, variation): returns boolean
 * - appliesTo(crypto, offsetSec): returns boolean
 *
 * @module modules/paper-trader/strategy-registry
 */

import * as vwapContrarian from './vwap-contrarian-strategy.js';

function createVwapEntry(name, vwapSource, directionFilter, cryptoFilter) {
  return {
    name,
    evaluateMarketState: (ctx) => vwapContrarian.evaluateMarketState(ctx, vwapSource),
    shouldFire: (state, v) => vwapContrarian.shouldFire(state, v, directionFilter),
    appliesTo: (crypto, offset) => cryptoFilter ? cryptoFilter(crypto) : true,
  };
}

export const strategies = [
  createVwapEntry('down_only', 'composite', 'down', null),
  createVwapEntry('vwap_edge', 'composite', null, null),
];
