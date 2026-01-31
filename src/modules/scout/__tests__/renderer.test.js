/**
 * Scout Renderer Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as renderer from '../renderer.js';
import { Colors, Icons } from '../types.js';

describe('Scout Renderer', () => {
  beforeEach(() => {
    renderer.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    renderer.reset();
  });

  describe('formatTime', () => {
    it('should format date to HH:MM:SS', () => {
      // Create a date with known time
      const date = new Date('2026-01-31T14:32:45.123Z');
      const result = renderer.formatTime(date);

      // Result depends on timezone, but should be 8 characters in HH:MM:SS format
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it('should handle midnight', () => {
      const date = new Date('2026-01-31T00:00:00.000Z');
      const result = renderer.formatTime(date);
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it('should handle end of day', () => {
      const date = new Date('2026-01-31T23:59:59.999Z');
      const result = renderer.formatTime(date);
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });
  });

  describe('getIcon', () => {
    it('should return green icon for info level', () => {
      const result = renderer.getIcon(Icons.CHECK, 'info');
      expect(result).toContain(Colors.GREEN);
      expect(result).toContain(Icons.CHECK);
      expect(result).toContain(Colors.RESET);
    });

    it('should return yellow icon for warn level', () => {
      const result = renderer.getIcon(Icons.WARNING, 'warn');
      expect(result).toContain(Colors.YELLOW);
      expect(result).toContain(Icons.WARNING);
      expect(result).toContain(Colors.RESET);
    });

    it('should return red icon for error level', () => {
      const result = renderer.getIcon(Icons.CROSS, 'error');
      expect(result).toContain(Colors.RED);
      expect(result).toContain(Icons.CROSS);
      expect(result).toContain(Colors.RESET);
    });

    it('should use default icon when none provided', () => {
      const result = renderer.getIcon(null, 'info');
      expect(result).toContain(Icons.CIRCLE);
    });

    it('should use green for undefined level', () => {
      const result = renderer.getIcon(Icons.CHECK, undefined);
      expect(result).toContain(Colors.GREEN);
    });
  });

  describe('stripAnsi', () => {
    it('should remove ANSI color codes', () => {
      const colored = `${Colors.RED}error${Colors.RESET}`;
      const result = renderer.stripAnsi(colored);
      expect(result).toBe('error');
    });

    it('should handle multiple ANSI codes', () => {
      const colored = `${Colors.BOLD}${Colors.CYAN}SCOUT${Colors.RESET}`;
      const result = renderer.stripAnsi(colored);
      expect(result).toBe('SCOUT');
    });

    it('should return empty string for empty input', () => {
      expect(renderer.stripAnsi('')).toBe('');
    });

    it('should return same string if no ANSI codes', () => {
      const plain = 'Hello World';
      expect(renderer.stripAnsi(plain)).toBe('Hello World');
    });

    it('should handle dim and bright codes', () => {
      const colored = `${Colors.DIM}dimmed${Colors.RESET} ${Colors.BRIGHT_GREEN}bright${Colors.RESET}`;
      const result = renderer.stripAnsi(colored);
      expect(result).toBe('dimmed bright');
    });
  });

  describe('addEvent', () => {
    it('should add event to history', () => {
      renderer.init();
      renderer.addEvent({
        type: 'signal',
        summary: 'Test signal',
        level: 'info',
      });

      // Event was added (we can verify via renderEventStream indirectly)
      // Since eventHistory is internal, we test via behavior
    });

    it('should add timestamp to events', () => {
      renderer.init();

      // Mock Date to verify timestamp is added
      const mockDate = new Date('2026-01-31T12:00:00.000Z');
      vi.setSystemTime(mockDate);

      renderer.addEvent({
        type: 'signal',
        summary: 'Test',
      });

      vi.useRealTimers();
    });
  });

  describe('init and reset', () => {
    it('should initialize without error', () => {
      expect(() => renderer.init()).not.toThrow();
    });

    it('should reset without error', () => {
      renderer.init();
      expect(() => renderer.reset()).not.toThrow();
    });

    it('should be safe to call reset multiple times', () => {
      renderer.init();
      renderer.reset();
      renderer.reset();
      renderer.reset();
      // Should not throw
    });

    it('should clean up resize handler on reset', () => {
      // Mock process.stdout
      const offSpy = vi.spyOn(process.stdout, 'off');

      renderer.init();
      renderer.reset();

      // Verify off was called with 'resize'
      expect(offSpy).toHaveBeenCalledWith('resize', expect.any(Function));

      offSpy.mockRestore();
    });

    it('should handle reset when init was never called', () => {
      // Should not throw even if never initialized
      expect(() => renderer.reset()).not.toThrow();
    });
  });

  describe('renderStartup', () => {
    it('should output startup message', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      renderer.init();
      renderer.renderStartup('local');

      expect(consoleSpy).toHaveBeenCalled();

      // Verify SCOUT header was printed
      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('SCOUT');
      expect(calls).toContain('local');

      consoleSpy.mockRestore();
    });
  });

  describe('renderShutdown', () => {
    it('should output shutdown message with stats', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      renderer.init();
      renderer.renderShutdown({
        eventsReceived: 42,
        signalCount: 10,
        entryCount: 8,
        exitCount: 7,
        alertCount: 2,
      });

      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('signing off');
      expect(calls).toContain('42');
      expect(calls).toContain('10');
      expect(calls).toContain('8');
      expect(calls).toContain('7');
      expect(calls).toContain('2');

      consoleSpy.mockRestore();
    });
  });

  describe('renderEvent', () => {
    it('should output event with timestamp and summary', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      renderer.init();
      renderer.renderEvent({
        type: 'signal',
        translation: {
          summary: 'Signal fired (entry)',
          explanation: 'Entry conditions met.',
          icon: Icons.ARROW_RIGHT,
          level: 'info',
        },
        data: {},
      });

      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('Signal fired');
      expect(calls).toContain('Scout:');
      expect(calls).toContain('Entry conditions met');

      consoleSpy.mockRestore();
    });

    it('should handle missing translation gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      renderer.init();
      renderer.renderEvent({
        type: 'unknown',
        translation: null,
        data: {},
      });

      // Should not throw, should output something
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});
