/**
 * Unit tests for Timeline Trimmer
 *
 * Tests:
 *   - Source analysis for each YAML signal type
 *   - JS strategies default to keeping everything
 *   - L2 is always kept
 *   - Trim function removes correct sources
 *   - Trim function preserves event ordering
 */

import { describe, it, expect } from 'vitest';
import { analyzeStrategySources, trimTimeline } from '../../../src/factory/timeline-trimmer.js';

// ─── Helper: build a mock timeline with events from various sources ───

function buildMockTimeline() {
  // Mimics a real timeline with events from all sources, pre-sorted by _ms
  return [
    { source: 'chainlink', _ms: 1000, price: 50000 },
    { source: 'polyRef', _ms: 1001, price: 50010 },
    { source: 'clobUp', _ms: 1002, bestBid: 0.55, bestAsk: 0.56 },
    { source: 'clobDown', _ms: 1003, bestBid: 0.44, bestAsk: 0.45 },
    { source: 'exchange_binance', _ms: 1004, price: 50020 },
    { source: 'exchange_coinbase', _ms: 1005, price: 50015 },
    { source: 'coingecko', _ms: 1006, price: 50005 },
    { source: 'l2Up', _ms: 1007, best_bid: 0.55, best_ask: 0.56 },
    { source: 'l2Down', _ms: 1008, best_bid: 0.44, best_ask: 0.45 },
    { source: 'chainlink', _ms: 1009, price: 50050 },
    { source: 'exchange_kraken', _ms: 1010, price: 50030 },
    { source: 'clobUp', _ms: 1011, bestBid: 0.56, bestAsk: 0.57 },
    { source: 'l2Up', _ms: 1012, best_bid: 0.56, best_ask: 0.57 },
  ];
}

// ─── analyzeStrategySources ───

describe('analyzeStrategySources', () => {

  it('returns all-true for JS strategies (no _definition)', () => {
    const jsStrategy = {
      name: 'my-js-strategy',
      evaluate: () => [],
    };
    const sources = analyzeStrategySources(jsStrategy);
    expect(sources.needsChainlink).toBe(true);
    expect(sources.needsPolyRef).toBe(true);
    expect(sources.needsClobUp).toBe(true);
    expect(sources.needsClobDown).toBe(true);
    expect(sources.needsExchanges).toBe(true);
    expect(sources.needsCoingecko).toBe(true);
    expect(sources.needsL2).toBe(true);
  });

  it('returns all-true for null strategy', () => {
    const sources = analyzeStrategySources(null);
    expect(sources.needsChainlink).toBe(true);
    expect(sources.needsL2).toBe(true);
  });

  it('chainlink-deficit needs chainlink + clobDown', () => {
    const strategy = {
      name: 'test',
      _definition: {
        signals: [{ type: 'chainlink-deficit', params: {} }],
      },
    };
    const sources = analyzeStrategySources(strategy);
    expect(sources.needsChainlink).toBe(true);
    expect(sources.needsClobDown).toBe(true);
    expect(sources.needsPolyRef).toBe(false);
    expect(sources.needsClobUp).toBe(false);
    expect(sources.needsExchanges).toBe(false);
    expect(sources.needsCoingecko).toBe(false);
    expect(sources.needsL2).toBe(true);
  });

  it('bs-fair-value needs chainlink + polyRef + clobUp + clobDown', () => {
    const strategy = {
      name: 'test',
      _definition: {
        signals: [{ type: 'bs-fair-value', params: {} }],
      },
    };
    const sources = analyzeStrategySources(strategy);
    expect(sources.needsChainlink).toBe(true);
    expect(sources.needsPolyRef).toBe(true);
    expect(sources.needsClobUp).toBe(true);
    expect(sources.needsClobDown).toBe(true);
    expect(sources.needsExchanges).toBe(false);
    expect(sources.needsCoingecko).toBe(false);
  });

  it('exchange-consensus needs exchanges only', () => {
    const strategy = {
      name: 'test',
      _definition: {
        signals: [{ type: 'exchange-consensus', params: {} }],
      },
    };
    const sources = analyzeStrategySources(strategy);
    expect(sources.needsExchanges).toBe(true);
    expect(sources.needsChainlink).toBe(false);
    expect(sources.needsPolyRef).toBe(false);
    expect(sources.needsClobUp).toBe(false);
    expect(sources.needsClobDown).toBe(false);
    expect(sources.needsCoingecko).toBe(false);
  });

  it('clob-imbalance needs clobUp + clobDown', () => {
    const strategy = {
      name: 'test',
      _definition: {
        signals: [{ type: 'clob-imbalance', params: {} }],
      },
    };
    const sources = analyzeStrategySources(strategy);
    expect(sources.needsClobUp).toBe(true);
    expect(sources.needsClobDown).toBe(true);
    expect(sources.needsChainlink).toBe(false);
    expect(sources.needsExchanges).toBe(false);
  });

  it('momentum needs chainlink', () => {
    const strategy = {
      name: 'test',
      _definition: {
        signals: [{ type: 'momentum', params: {} }],
      },
    };
    const sources = analyzeStrategySources(strategy);
    expect(sources.needsChainlink).toBe(true);
    expect(sources.needsPolyRef).toBe(false);
    expect(sources.needsExchanges).toBe(false);
  });

  it('mean-reversion needs chainlink', () => {
    const strategy = {
      name: 'test',
      _definition: {
        signals: [{ type: 'mean-reversion', params: {} }],
      },
    };
    const sources = analyzeStrategySources(strategy);
    expect(sources.needsChainlink).toBe(true);
    expect(sources.needsPolyRef).toBe(false);
  });

  it('ref-near-strike needs polyRef', () => {
    const strategy = {
      name: 'test',
      _definition: {
        signals: [{ type: 'ref-near-strike', params: {} }],
      },
    };
    const sources = analyzeStrategySources(strategy);
    expect(sources.needsPolyRef).toBe(true);
    expect(sources.needsChainlink).toBe(false);
  });

  it('merges sources from multiple signals', () => {
    // deficit-momentum-v1 uses chainlink-deficit + momentum
    const strategy = {
      name: 'deficit-momentum-v1',
      _definition: {
        signals: [
          { type: 'chainlink-deficit', params: {} },
          { type: 'momentum', params: {} },
        ],
      },
    };
    const sources = analyzeStrategySources(strategy);
    expect(sources.needsChainlink).toBe(true);   // both need it
    expect(sources.needsClobDown).toBe(true);     // chainlink-deficit needs it
    expect(sources.needsExchanges).toBe(false);
    expect(sources.needsPolyRef).toBe(false);
    expect(sources.needsCoingecko).toBe(false);
  });

  it('consensus-reversion merges exchange-consensus + mean-reversion', () => {
    const strategy = {
      name: 'consensus-reversion-v1',
      _definition: {
        signals: [
          { type: 'exchange-consensus', params: {} },
          { type: 'mean-reversion', params: {} },
        ],
      },
    };
    const sources = analyzeStrategySources(strategy);
    expect(sources.needsExchanges).toBe(true);
    expect(sources.needsChainlink).toBe(true);
    expect(sources.needsPolyRef).toBe(false);
    expect(sources.needsClobUp).toBe(false);
    expect(sources.needsClobDown).toBe(false);
    expect(sources.needsCoingecko).toBe(false);
  });

  it('falls back to all-true for unknown signal types', () => {
    const strategy = {
      name: 'test',
      _definition: {
        signals: [{ type: 'unknown-future-signal', params: {} }],
      },
    };
    const sources = analyzeStrategySources(strategy);
    expect(sources.needsChainlink).toBe(true);
    expect(sources.needsPolyRef).toBe(true);
    expect(sources.needsExchanges).toBe(true);
    expect(sources.needsCoingecko).toBe(true);
  });

  it('L2 is always true regardless of signal type', () => {
    const strategy = {
      name: 'test',
      _definition: {
        signals: [{ type: 'momentum', params: {} }],
      },
    };
    const sources = analyzeStrategySources(strategy);
    expect(sources.needsL2).toBe(true);
  });
});

// ─── trimTimeline ───

describe('trimTimeline', () => {

  it('keeps L2 events regardless of sources', () => {
    const timeline = buildMockTimeline();
    const sources = {
      needsChainlink: false,
      needsPolyRef: false,
      needsClobUp: false,
      needsClobDown: false,
      needsExchanges: false,
      needsCoingecko: false,
      needsL2: true,
      exchangeFilter: null,
    };
    const trimmed = trimTimeline(timeline, sources);
    const l2Events = trimmed.filter(e => e.source === 'l2Up' || e.source === 'l2Down');
    expect(l2Events.length).toBe(3); // 2 l2Up + 1 l2Down from mock
    // Only L2 events should remain
    expect(trimmed.length).toBe(3);
  });

  it('removes chainlink when not needed', () => {
    const timeline = buildMockTimeline();
    const sources = {
      needsChainlink: false,
      needsPolyRef: true,
      needsClobUp: true,
      needsClobDown: true,
      needsExchanges: true,
      needsCoingecko: true,
      needsL2: true,
      exchangeFilter: null,
    };
    const trimmed = trimTimeline(timeline, sources);
    const clEvents = trimmed.filter(e => e.source === 'chainlink');
    expect(clEvents.length).toBe(0);
    // Everything else kept
    expect(trimmed.length).toBe(timeline.length - 2); // 2 chainlink events removed
  });

  it('removes exchange events when not needed', () => {
    const timeline = buildMockTimeline();
    const sources = {
      needsChainlink: true,
      needsPolyRef: true,
      needsClobUp: true,
      needsClobDown: true,
      needsExchanges: false,
      needsCoingecko: true,
      needsL2: true,
      exchangeFilter: null,
    };
    const trimmed = trimTimeline(timeline, sources);
    const exEvents = trimmed.filter(e => e.source?.startsWith('exchange_'));
    expect(exEvents.length).toBe(0);
  });

  it('filters exchanges by exchangeFilter', () => {
    const timeline = buildMockTimeline();
    const sources = {
      needsChainlink: false,
      needsPolyRef: false,
      needsClobUp: false,
      needsClobDown: false,
      needsExchanges: true,
      needsCoingecko: false,
      needsL2: true,
      exchangeFilter: ['binance'],
    };
    const trimmed = trimTimeline(timeline, sources);
    const exEvents = trimmed.filter(e => e.source?.startsWith('exchange_'));
    expect(exEvents.length).toBe(1);
    expect(exEvents[0].source).toBe('exchange_binance');
  });

  it('removes coingecko when not needed', () => {
    const timeline = buildMockTimeline();
    const sources = {
      needsChainlink: true,
      needsPolyRef: true,
      needsClobUp: true,
      needsClobDown: true,
      needsExchanges: true,
      needsCoingecko: false,
      needsL2: true,
      exchangeFilter: null,
    };
    const trimmed = trimTimeline(timeline, sources);
    const cgEvents = trimmed.filter(e => e.source === 'coingecko');
    expect(cgEvents.length).toBe(0);
    expect(trimmed.length).toBe(timeline.length - 1);
  });

  it('preserves event ordering', () => {
    const timeline = buildMockTimeline();
    const sources = {
      needsChainlink: true,
      needsPolyRef: false,
      needsClobUp: true,
      needsClobDown: false,
      needsExchanges: false,
      needsCoingecko: false,
      needsL2: true,
      exchangeFilter: null,
    };
    const trimmed = trimTimeline(timeline, sources);
    // Verify _ms is strictly non-decreasing
    for (let i = 1; i < trimmed.length; i++) {
      expect(trimmed[i]._ms).toBeGreaterThanOrEqual(trimmed[i - 1]._ms);
    }
  });

  it('returns full timeline when all sources needed (no-op optimization)', () => {
    const timeline = buildMockTimeline();
    const sources = {
      needsChainlink: true,
      needsPolyRef: true,
      needsClobUp: true,
      needsClobDown: true,
      needsExchanges: true,
      needsCoingecko: true,
      needsL2: true,
      exchangeFilter: null,
    };
    const trimmed = trimTimeline(timeline, sources);
    // Should return the same array reference (optimization)
    expect(trimmed).toBe(timeline);
  });

  it('handles empty timeline', () => {
    const trimmed = trimTimeline([], { needsChainlink: true, needsL2: true });
    expect(trimmed).toEqual([]);
  });

  it('handles null/undefined timeline', () => {
    expect(trimTimeline(null, {})).toEqual([]);
    expect(trimTimeline(undefined, {})).toEqual([]);
  });

  it('handles null sources — returns original timeline', () => {
    const timeline = buildMockTimeline();
    const trimmed = trimTimeline(timeline, null);
    expect(trimmed).toBe(timeline);
  });

  it('keeps events with no source field (safety)', () => {
    const timeline = [
      { _ms: 1000, data: 'mystery' },
      { source: 'chainlink', _ms: 1001, price: 50000 },
      { source: 'l2Up', _ms: 1002 },
    ];
    const sources = {
      needsChainlink: false,
      needsPolyRef: false,
      needsClobUp: false,
      needsClobDown: false,
      needsExchanges: false,
      needsCoingecko: false,
      needsL2: true,
      exchangeFilter: null,
    };
    const trimmed = trimTimeline(timeline, sources);
    // Mystery event (no source) + l2Up kept, chainlink removed
    expect(trimmed.length).toBe(2);
    expect(trimmed[0].data).toBe('mystery');
    expect(trimmed[1].source).toBe('l2Up');
  });

  it('achieves significant reduction for chainlink-deficit strategy', () => {
    // Simulate realistic distribution: ~13K events
    const timeline = [];
    let ms = 0;
    // 2000 chainlink, 1000 polyRef, 2000 clobUp, 2000 clobDown,
    // 3000 exchanges, 500 coingecko, 1500 l2Up, 1000 l2Down
    for (let i = 0; i < 2000; i++) timeline.push({ source: 'chainlink', _ms: ms++ });
    for (let i = 0; i < 1000; i++) timeline.push({ source: 'polyRef', _ms: ms++ });
    for (let i = 0; i < 2000; i++) timeline.push({ source: 'clobUp', _ms: ms++ });
    for (let i = 0; i < 2000; i++) timeline.push({ source: 'clobDown', _ms: ms++ });
    for (let i = 0; i < 3000; i++) timeline.push({ source: 'exchange_binance', _ms: ms++ });
    for (let i = 0; i < 500; i++) timeline.push({ source: 'coingecko', _ms: ms++ });
    for (let i = 0; i < 1500; i++) timeline.push({ source: 'l2Up', _ms: ms++ });
    for (let i = 0; i < 1000; i++) timeline.push({ source: 'l2Down', _ms: ms++ });

    // chainlink-deficit needs: chainlink + clobDown + L2
    const sources = analyzeStrategySources({
      name: 'test',
      _definition: {
        signals: [{ type: 'chainlink-deficit', params: {} }],
      },
    });

    const trimmed = trimTimeline(timeline, sources);
    const total = timeline.length; // 13000
    const kept = trimmed.length;   // 2000 chainlink + 2000 clobDown + 2500 L2 = 6500
    const reduction = ((total - kept) / total * 100);
    expect(reduction).toBeGreaterThan(40); // Should be ~50%
    expect(kept).toBe(2000 + 2000 + 1500 + 1000); // chainlink + clobDown + l2Up + l2Down
  });
});
