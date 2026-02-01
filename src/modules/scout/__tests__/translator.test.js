/**
 * Scout Translator Tests
 */

import { describe, it, expect } from 'vitest';
import { translate, getSilentOperationMessage, getTimeAgo } from '../translator.js';

describe('Scout Translator', () => {
  describe('translate', () => {
    describe('signal events', () => {
      it('should translate entry signal', () => {
        const result = translate('signal', {
          signalType: 'entry',
          strategyId: 'spot-lag-v1',
          priceAtSignal: 0.42,
          expectedPrice: 0.42,
        });

        expect(result.summary).toContain('Signal fired');
        expect(result.summary).toContain('entry');
        expect(result.explanation).toContain('Entry conditions met');
        expect(result.explanation).toContain('0.420');
        expect(result.level).toBe('info');
      });

      it('should translate exit signal', () => {
        const result = translate('signal', {
          signalType: 'exit',
          strategyId: 'spot-lag-v1',
          priceAtSignal: 0.55,
        });

        expect(result.summary).toContain('Signal fired');
        expect(result.summary).toContain('exit');
        expect(result.explanation).toContain('Exit signal triggered');
        expect(result.level).toBe('info');
      });
    });

    describe('entry events', () => {
      it('should translate clean entry', () => {
        const result = translate('entry', {
          prices: {
            priceAtFill: 0.421,
            expectedPrice: 0.420,
          },
          sizes: {
            requestedSize: 100,
            filledSize: 100,
          },
          latencies: {
            latency_total_ms: 150,
          },
          slippage: {
            slippage_vs_expected: 0.001,
          },
          hasDivergence: false,
        });

        expect(result.summary).toContain('0.421');
        expect(result.summary).toContain('expected 0.420');
        expect(result.explanation).toContain('clean');
        expect(result.icon).toBe('\u2713'); // ✓
        expect(result.level).toBe('info');
      });

      it('should translate entry with high slippage', () => {
        const result = translate('entry', {
          prices: {
            priceAtFill: 0.445,
            expectedPrice: 0.420,
          },
          sizes: {
            requestedSize: 100,
            filledSize: 100,
          },
          latencies: {
            latency_total_ms: 200,
          },
          slippage: {
            slippage_vs_expected: 0.025,
          },
          hasDivergence: true,
          diagnosticFlags: ['slippage_high'],
        });

        expect(result.summary).toContain('0.445');
        expect(result.explanation).toContain('slippage');
        expect(result.explanation).toContain('review');
        expect(result.icon).toBe('\u26a0'); // ⚠
        expect(result.level).toBe('warn');
      });

      it('should translate entry with high latency', () => {
        const result = translate('entry', {
          prices: {
            priceAtFill: 0.421,
            expectedPrice: 0.420,
          },
          sizes: {
            requestedSize: 100,
            filledSize: 100,
          },
          latencies: {
            latency_total_ms: 890,
          },
          slippage: {
            slippage_vs_expected: 0.001,
          },
          hasDivergence: true,
          diagnosticFlags: ['latency_high'],
        });

        expect(result.explanation).toContain('890ms');
        expect(result.explanation).toContain('review');
        expect(result.level).toBe('warn');
      });

      it('should translate entry with size divergence', () => {
        const result = translate('entry', {
          prices: {
            priceAtFill: 0.421,
            expectedPrice: 0.420,
          },
          sizes: {
            requestedSize: 100,
            filledSize: 85,
          },
          latencies: {
            latency_total_ms: 150,
          },
          slippage: {
            slippage_vs_expected: 0.001,
          },
          hasDivergence: true,
          diagnosticFlags: ['size_divergence'],
        });

        expect(result.explanation).toContain('85');
        expect(result.explanation).toContain('100');
        expect(result.level).toBe('warn');
      });
    });

    describe('exit events', () => {
      it('should translate take-profit exit', () => {
        const result = translate('exit', {
          exitReason: 'take_profit',
          prices: {
            priceAtFill: 0.55,
          },
          hasDivergence: false,
        });

        expect(result.summary).toContain('Take-profit');
        expect(result.summary).toContain('0.550');
        expect(result.explanation).toContain('profit');
        expect(result.level).toBe('info');
      });

      it('should translate stop-loss exit', () => {
        const result = translate('exit', {
          exitReason: 'stop_loss',
          prices: {
            priceAtFill: 0.35,
          },
          hasDivergence: false,
        });

        expect(result.summary).toContain('Stop-loss');
        expect(result.explanation).toContain('loss');
        expect(result.level).toBe('info');
      });

      it('should translate window expiry exit', () => {
        const result = translate('exit', {
          exitReason: 'window_expiry',
          prices: {
            priceAtFill: 0.50,
          },
          hasDivergence: false,
        });

        expect(result.summary).toContain('Window expiry');
        expect(result.explanation).toContain('resolved');
        expect(result.level).toBe('info');
      });

      it('should translate exit with divergence', () => {
        const result = translate('exit', {
          exitReason: 'take_profit',
          prices: {
            priceAtFill: 0.55,
          },
          latencies: {
            latency_total_ms: 650,
          },
          hasDivergence: true,
          diagnosticFlags: ['latency_high'],
        });

        expect(result.explanation).toContain('slow');
        expect(result.explanation).toContain('review');
        expect(result.level).toBe('warn');
      });
    });

    describe('alert events', () => {
      it('should translate state divergence alert', () => {
        const result = translate('alert', {
          alertType: 'divergence',
          level: 'error',
          diagnosticFlags: ['state_divergence'],
        });

        expect(result.summary).toContain('mismatch');
        expect(result.explanation).toContain('exchange');
        expect(result.explanation).toContain('attention');
        expect(result.level).toBe('error');
      });

      it('should translate latency alert', () => {
        const result = translate('alert', {
          alertType: 'latency',
          level: 'warn',
          diagnosticFlags: ['latency_high'],
        });

        expect(result.summary).toContain('Latency');
        expect(result.explanation).toContain('slow');
        expect(result.level).toBe('warn');
      });

      it('should translate slippage alert', () => {
        const result = translate('alert', {
          alertType: 'slippage',
          level: 'warn',
          diagnosticFlags: ['slippage_high'],
        });

        expect(result.summary).toContain('slippage');
        expect(result.level).toBe('warn');
      });
    });

    describe('unknown events', () => {
      it('should handle unknown event type', () => {
        const result = translate('unknown', {});

        expect(result.summary).toContain('Unknown');
        expect(result.icon).toBe('?');
      });
    });
  });

  describe('getSilentOperationMessage', () => {
    it('should return a positive message', () => {
      const result = getSilentOperationMessage();

      expect(result.summary).toBe('All quiet');
      expect(result.explanation).toContain('expected');
      expect(result.level).toBe('info');
    });
  });

  describe('getTimeAgo', () => {
    it('should return "never" for null input', () => {
      expect(getTimeAgo(null)).toBe('never');
      expect(getTimeAgo(undefined)).toBe('never');
    });

    it('should return "just now" for recent timestamps', () => {
      const now = new Date().toISOString();
      expect(getTimeAgo(now)).toBe('just now');
    });

    it('should return seconds ago', () => {
      const tenSecondsAgo = new Date(Date.now() - 10000).toISOString();
      expect(getTimeAgo(tenSecondsAgo)).toBe('10s ago');
    });

    it('should return minutes ago', () => {
      const fiveMinutesAgo = new Date(Date.now() - 300000).toISOString();
      expect(getTimeAgo(fiveMinutesAgo)).toBe('5m ago');
    });

    it('should return hours ago', () => {
      const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();
      expect(getTimeAgo(twoHoursAgo)).toBe('2h ago');
    });
  });

  // Story E.3: Mode prefix tests
  describe('formatModePrefix (Story E.3)', () => {
    it('should format PAPER mode prefix', () => {
      const { formatModePrefix } = require('../translator.js');
      const result = formatModePrefix('PAPER');

      expect(result).toBe('[PAPER] ');
    });

    it('should format LIVE mode prefix', () => {
      const { formatModePrefix } = require('../translator.js');
      const result = formatModePrefix('LIVE');

      expect(result).toBe('[LIVE] ');
    });

    it('should return empty string for null mode', () => {
      const { formatModePrefix } = require('../translator.js');
      const result = formatModePrefix(null);

      expect(result).toBe('');
    });

    it('should return empty string for undefined mode', () => {
      const { formatModePrefix } = require('../translator.js');
      const result = formatModePrefix(undefined);

      expect(result).toBe('');
    });
  });

  describe('translate with trading mode (Story E.3)', () => {
    it('should prefix signal translation with PAPER mode', () => {
      const result = translate('signal', {
        signalType: 'entry',
        strategyId: 'spot-lag-v1',
        priceAtSignal: 0.42,
        tradingMode: 'PAPER',
      });

      expect(result.summary).toContain('[PAPER]');
      expect(result.summary).toContain('Signal fired');
    });

    it('should prefix entry translation with LIVE mode', () => {
      const result = translate('entry', {
        prices: {
          priceAtFill: 0.421,
          expectedPrice: 0.420,
        },
        hasDivergence: false,
        tradingMode: 'LIVE',
      });

      expect(result.summary).toContain('[LIVE]');
      expect(result.summary).toContain('Filled');
    });

    it('should not add prefix when tradingMode is not present', () => {
      const result = translate('signal', {
        signalType: 'entry',
        strategyId: 'spot-lag-v1',
        priceAtSignal: 0.42,
      });

      expect(result.summary).not.toContain('[PAPER]');
      expect(result.summary).not.toContain('[LIVE]');
    });
  });
});
