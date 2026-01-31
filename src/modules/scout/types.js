/**
 * Scout Module Types
 *
 * Constants, error codes, and type definitions for Scout.
 */

/**
 * Scout error codes
 */
export const ScoutErrorCodes = {
  ALREADY_INITIALIZED: 'SCOUT_ALREADY_INITIALIZED',
  NOT_INITIALIZED: 'SCOUT_NOT_INITIALIZED',
  ALREADY_RUNNING: 'SCOUT_ALREADY_RUNNING',
  NOT_RUNNING: 'SCOUT_NOT_RUNNING',
  INVALID_MODE: 'SCOUT_INVALID_MODE',
};

/**
 * Scout error class
 */
export class ScoutError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'ScoutError';
    this.code = code;
    this.context = context;
  }
}

/**
 * Scout operating modes
 */
export const ScoutMode = {
  LOCAL: 'local',     // Subscribe to local EventEmitter
  RAILWAY: 'railway', // Parse Railway log stream
};

/**
 * Event types Scout handles
 */
export const ScoutEventType = {
  SIGNAL: 'signal',
  ENTRY: 'entry',
  EXIT: 'exit',
  ALERT: 'alert',
  DIVERGENCE: 'divergence',
};

/**
 * ANSI color codes for terminal output
 */
export const Colors = {
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',

  // Foreground
  BLACK: '\x1b[30m',
  RED: '\x1b[31m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[34m',
  MAGENTA: '\x1b[35m',
  CYAN: '\x1b[36m',
  WHITE: '\x1b[37m',

  // Bright foreground
  BRIGHT_BLACK: '\x1b[90m',
  BRIGHT_RED: '\x1b[91m',
  BRIGHT_GREEN: '\x1b[92m',
  BRIGHT_YELLOW: '\x1b[93m',
  BRIGHT_BLUE: '\x1b[94m',
  BRIGHT_MAGENTA: '\x1b[95m',
  BRIGHT_CYAN: '\x1b[96m',
  BRIGHT_WHITE: '\x1b[97m',

  // Background
  BG_BLACK: '\x1b[40m',
  BG_RED: '\x1b[41m',
  BG_GREEN: '\x1b[42m',
  BG_YELLOW: '\x1b[43m',
  BG_BLUE: '\x1b[44m',
};

/**
 * Status icons
 */
export const Icons = {
  CHECK: '\u2713',      // ✓
  CROSS: '\u2717',      // ✗
  WARNING: '\u26a0',    // ⚠
  ARROW_UP: '\u25b2',   // ▲
  ARROW_RIGHT: '\u25b6', // ▶
  CIRCLE: '\u25cf',     // ●
  DOT: '\u00b7',        // ·
};
