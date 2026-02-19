/**
 * Strategy Registry
 *
 * Creates 13 named strategy entries by wrapping the 7 strategy modules
 * with their configuration (vwapSource, directionFilter, crypto filter).
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
import * as clobStaleness from './clob-staleness-strategy.js';
import * as bookImbalance from './book-imbalance-strategy.js';
import * as earlyContrarian from './early-contrarian-strategy.js';
import * as combined from './combined-strategy.js';
import * as spreadWiden from './spread-widening-strategy.js';
import * as contrarianDepth from './contrarian-depth-strategy.js';
import * as crossoverSpread from './crossover-spread-strategy.js';

function createVwapEntry(name, vwapSource, directionFilter, cryptoFilter) {
  return {
    name,
    evaluateMarketState: (ctx) => vwapContrarian.evaluateMarketState(ctx, vwapSource),
    shouldFire: (state, v) => vwapContrarian.shouldFire(state, v, directionFilter),
    appliesTo: (crypto, offset) => cryptoFilter ? cryptoFilter(crypto) : true,
  };
}

export const strategies = [
  // VWAP contrarian — both directions
  createVwapEntry('vwap_edge', 'composite', null, null),
  createVwapEntry('vwap_cg_edge', 'coingecko', null, null),
  createVwapEntry('vwap20_edge', 'vwap20', null, (crypto) => crypto === 'btc'),

  // VWAP contrarian — DOWN only
  createVwapEntry('down_only', 'composite', 'down', null),
  createVwapEntry('down_cg', 'coingecko', 'down', null),
  createVwapEntry('down_v20', 'vwap20', 'down', (crypto) => crypto === 'btc'),

  // CLOB staleness
  {
    name: 'clob_stale',
    evaluateMarketState: (ctx) => clobStaleness.evaluateMarketState(ctx),
    shouldFire: (state, v) => clobStaleness.shouldFire(state, v),
    appliesTo: (crypto, offset) => clobStaleness.appliesTo(crypto, offset),
  },

  // Book imbalance (BTC only)
  {
    name: 'book_imbal',
    evaluateMarketState: (ctx) => bookImbalance.evaluateMarketState(ctx),
    shouldFire: (state, v) => bookImbalance.shouldFire(state, v),
    appliesTo: (crypto, offset) => bookImbalance.appliesTo(crypto, offset),
  },

  // Early contrarian (T-90/T-120 only)
  {
    name: 'early_inv',
    evaluateMarketState: (ctx) => earlyContrarian.evaluateMarketState(ctx),
    shouldFire: (state, v) => earlyContrarian.shouldFire(state, v),
    appliesTo: (crypto, offset) => earlyContrarian.appliesTo(crypto, offset),
  },

  // Combined multi-signal
  {
    name: 'combined',
    evaluateMarketState: (ctx) => combined.evaluateMarketState(ctx),
    shouldFire: (state, v) => combined.shouldFire(state, v),
    appliesTo: (crypto, offset) => combined.appliesTo(crypto, offset),
  },

  // Spread widening (XRP only — SOL killed, no edge)
  {
    name: 'spread_widen',
    evaluateMarketState: (ctx) => spreadWiden.evaluateMarketState(ctx),
    shouldFire: (state, v) => spreadWiden.shouldFire(state, v),
    appliesTo: (crypto, offset) => spreadWiden.appliesTo(crypto, offset),
  },

  // Contrarian book depth (ETH, XRP — bet with MMs quoting the "losing" side)
  {
    name: 'contra_depth',
    evaluateMarketState: (ctx) => contrarianDepth.evaluateMarketState(ctx),
    shouldFire: (state, v) => contrarianDepth.shouldFire(state, v),
    appliesTo: (crypto, offset) => contrarianDepth.appliesTo(crypto, offset),
  },

  // Crossover spread predictor (ETH, XRP — wide contrarian spread = crossover incoming)
  {
    name: 'xover_spread',
    evaluateMarketState: (ctx) => crossoverSpread.evaluateMarketState(ctx),
    shouldFire: (state, v) => crossoverSpread.shouldFire(state, v),
    appliesTo: (crypto, offset) => crossoverSpread.appliesTo(crypto, offset),
  },
];
