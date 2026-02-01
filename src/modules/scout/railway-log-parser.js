/**
 * Railway Log Parser
 *
 * Story E.2: Parse Railway log stream for trade events.
 *
 * Connects to Railway logs via CLI and extracts trade events
 * from the structured JSON log output.
 *
 * @module modules/scout/railway-log-parser
 */

import { spawn } from 'child_process';
import { TradeEventType } from '../trade-event/types.js';

/**
 * Log entry patterns that map to trade events
 */
const LOG_PATTERNS = {
  // Entry events
  entry_executed: TradeEventType.ENTRY,
  position_opened: TradeEventType.ENTRY,
  order_filled: TradeEventType.ENTRY,

  // Exit events
  exit_executed: TradeEventType.EXIT,
  position_closed: TradeEventType.EXIT,
  take_profit_triggered: TradeEventType.EXIT,
  stop_loss_triggered: TradeEventType.EXIT,

  // Signal events
  signal_generated: TradeEventType.SIGNAL,
  entry_signal: TradeEventType.SIGNAL,
  composed_strategy_signals: TradeEventType.SIGNAL,

  // Alert/divergence events
  divergence_detected: TradeEventType.DIVERGENCE,
  price_divergence: TradeEventType.DIVERGENCE,
  stale_oracle: TradeEventType.ALERT,
  kill_switch_triggered: TradeEventType.ALERT,
  error: TradeEventType.ALERT,
};

/**
 * RailwayLogParser class
 *
 * Manages the Railway log stream subprocess and parses events.
 */
export class RailwayLogParser {
  constructor(options = {}) {
    this.onEvent = options.onEvent || (() => {});
    this.onError = options.onError || (() => {});
    this.onClose = options.onClose || (() => {});

    this.process = null;
    this.buffer = '';
    this.isRunning = false;
    this.eventCount = 0;
  }

  /**
   * Start streaming Railway logs
   *
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      if (this.isRunning) {
        reject(new Error('Railway log parser already running'));
        return;
      }

      // Spawn railway logs process with follow flag
      this.process = spawn('railway', ['logs', '-f', '--json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.process.on('error', (err) => {
        if (err.code === 'ENOENT') {
          reject(new Error('Railway CLI not found. Install with: npm install -g @railway/cli'));
        } else {
          reject(err);
        }
      });

      // Handle stdout (log stream)
      this.process.stdout.on('data', (chunk) => {
        this.buffer += chunk.toString();
        this.processBuffer();
      });

      // Handle stderr (errors/warnings)
      this.process.stderr.on('data', (chunk) => {
        const message = chunk.toString().trim();
        if (message && !message.includes('Watching logs')) {
          this.onError(new Error(message));
        }
      });

      // Handle process close
      this.process.on('close', (code) => {
        this.isRunning = false;
        this.onClose(code);
      });

      // Give it a moment to connect
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.isRunning = true;
          resolve();
        }
      }, 1000);
    });
  }

  /**
   * Stop streaming
   */
  stop() {
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      this.isRunning = false;
    }
  }

  /**
   * Process buffered log lines
   */
  processBuffer() {
    const lines = this.buffer.split('\n');

    // Keep incomplete line in buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const parsed = this.parseLine(line);
        if (parsed) {
          this.eventCount++;
          this.onEvent(parsed);
        }
      } catch (err) {
        // Skip unparseable lines (non-JSON logs, etc.)
      }
    }
  }

  /**
   * Parse a single log line
   *
   * @param {string} line - Raw log line
   * @returns {Object|null} Parsed event or null
   */
  parseLine(line) {
    // Try to parse as JSON
    let logEntry;
    try {
      logEntry = JSON.parse(line);
    } catch {
      // Not JSON - might be plain text log
      return this.parsePlainTextLine(line);
    }

    // Extract event type from log message
    const message = logEntry.msg || logEntry.message || logEntry.event || '';

    // Check if this log entry matches a trade event pattern
    for (const [pattern, eventType] of Object.entries(LOG_PATTERNS)) {
      if (message.includes(pattern) || logEntry.event === pattern) {
        return {
          type: eventType,
          data: this.extractEventData(logEntry, eventType),
        };
      }
    }

    return null;
  }

  /**
   * Parse plain text log line (fallback)
   *
   * @param {string} line - Plain text log line
   * @returns {Object|null} Parsed event or null
   */
  parsePlainTextLine(line) {
    const lowerLine = line.toLowerCase();

    for (const [pattern, eventType] of Object.entries(LOG_PATTERNS)) {
      if (lowerLine.includes(pattern.replace(/_/g, ' ')) || lowerLine.includes(pattern)) {
        return {
          type: eventType,
          data: {
            raw: line,
            timestamp: new Date().toISOString(),
          },
        };
      }
    }

    return null;
  }

  /**
   * Extract event data from log entry
   *
   * @param {Object} logEntry - Parsed JSON log entry
   * @param {string} eventType - Detected event type
   * @returns {Object} Event data
   */
  extractEventData(logEntry, eventType) {
    const data = {
      timestamp: logEntry.time || logEntry.timestamp || new Date().toISOString(),
      raw: logEntry,
    };

    // Extract common fields
    if (logEntry.window_id) data.windowId = logEntry.window_id;
    if (logEntry.windowId) data.windowId = logEntry.windowId;
    if (logEntry.position_id) data.positionId = logEntry.position_id;
    if (logEntry.positionId) data.positionId = logEntry.positionId;
    if (logEntry.strategy) data.strategyId = logEntry.strategy;
    if (logEntry.strategyId) data.strategyId = logEntry.strategyId;
    if (logEntry.symbol) data.symbol = logEntry.symbol;
    if (logEntry.crypto) data.symbol = logEntry.crypto;

    // Extract type-specific fields
    switch (eventType) {
      case TradeEventType.ENTRY:
        if (logEntry.price) data.price = logEntry.price;
        if (logEntry.size) data.size = logEntry.size;
        if (logEntry.direction) data.direction = logEntry.direction;
        break;

      case TradeEventType.EXIT:
        if (logEntry.price) data.price = logEntry.price;
        if (logEntry.pnl) data.pnl = logEntry.pnl;
        if (logEntry.reason) data.reason = logEntry.reason;
        break;

      case TradeEventType.SIGNAL:
        if (logEntry.confidence) data.confidence = logEntry.confidence;
        if (logEntry.edge) data.edge = logEntry.edge;
        if (logEntry.probability) data.probability = logEntry.probability;
        if (logEntry.signalCount) data.signalCount = logEntry.signalCount;
        break;

      case TradeEventType.ALERT:
      case TradeEventType.DIVERGENCE:
        if (logEntry.level) data.level = logEntry.level;
        if (logEntry.error) data.error = logEntry.error;
        if (logEntry.message) data.message = logEntry.message;
        break;
    }

    return data;
  }

  /**
   * Get parser stats
   *
   * @returns {Object} Stats
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      eventCount: this.eventCount,
    };
  }
}

/**
 * Create and configure a Railway log parser
 *
 * @param {Function} onEvent - Event handler callback
 * @param {Function} onError - Error handler callback
 * @param {Function} onClose - Close handler callback
 * @returns {RailwayLogParser}
 */
export function createParser(onEvent, onError, onClose) {
  return new RailwayLogParser({ onEvent, onError, onClose });
}
