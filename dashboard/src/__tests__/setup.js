/**
 * Global test setup for vitest + jsdom.
 * Polyfills browser APIs not available in jsdom.
 */

// ResizeObserver polyfill — required by Recharts ResponsiveContainer
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(cb) {
      this._cb = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
