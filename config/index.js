/**
 * Unified Configuration Module - V3 Philosophy
 *
 * PRINCIPLE 2: IDENTICAL ARTIFACTS
 * This is the ONLY config file. No environment-specific files.
 * Env vars for secrets + TRADING_MODE only. All else is constant.
 *
 * Environment differences come ONLY from:
 *   - Secrets (API keys, private keys) - injected at runtime
 *   - TRADING_MODE env var ('PAPER' or 'LIVE')
 *   - DATABASE_URL env var (PostgreSQL connection string)
 *
 * @module config
 */

import { config as loadEnv } from 'dotenv';

// Load .env.local first (takes precedence), then .env as fallback
loadEnv({ path: '.env.local' });
loadEnv();

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Deep freeze an object to make it truly immutable (F2 fix)
 * @param {Object} obj - Object to freeze
 * @returns {Object} Deeply frozen object
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Freeze all nested objects first
  Object.keys(obj).forEach((key) => {
    const value = obj[key];
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  });

  // Then freeze the object itself
  return Object.freeze(obj);
}

/**
 * Check if running in test environment
 * @returns {boolean}
 */
function isTestEnvironment() {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

// =============================================================================
// TRADING MODE VALIDATION
// =============================================================================

/**
 * Validate and normalize TRADING_MODE
 * @returns {{ mode: string, isLive: boolean }}
 * @throws {Error} If TRADING_MODE is invalid or LIVE without confirmation
 */
function validateTradingMode() {
  const raw = process.env.TRADING_MODE;
  const normalized = raw?.trim().toUpperCase();

  // Default to PAPER if not set (F10: only warn if not in test environment)
  if (!raw) {
    if (!isTestEnvironment()) {
      console.warn('[config] TRADING_MODE not set, defaulting to PAPER');
    }
    return { mode: 'PAPER', isLive: false };
  }

  // Must be exactly PAPER or LIVE
  if (normalized !== 'PAPER' && normalized !== 'LIVE') {
    throw new Error(
      `[config] FATAL: TRADING_MODE must be 'PAPER' or 'LIVE', got '${raw}'`
    );
  }

  // LIVE mode requires explicit confirmation
  if (normalized === 'LIVE') {
    const confirm = process.env.CONFIRM_LIVE_TRADING?.trim().toLowerCase();

    // STRICT: Only exact string "true" is accepted
    if (confirm !== 'true') {
      throw new Error(
        '[config] FATAL: TRADING_MODE=LIVE requires CONFIRM_LIVE_TRADING=true\n' +
        '  Set CONFIRM_LIVE_TRADING=true to enable LIVE trading.\n' +
        `  Current value: '${process.env.CONFIRM_LIVE_TRADING || '(not set)'}'`
      );
    }
  }

  return { mode: normalized, isLive: normalized === 'LIVE' };
}

// =============================================================================
// DATABASE URL VALIDATION
// =============================================================================

/**
 * Validate DATABASE_URL for PostgreSQL connection (F6, F7 fixes)
 * @param {boolean} isLive - Whether TRADING_MODE is LIVE
 * @returns {string|null} Validated DATABASE_URL or null
 * @throws {Error} If DATABASE_URL is malformed or insecure for LIVE mode
 */
function validateDatabaseUrl(isLive) {
  const url = process.env.DATABASE_URL;

  // DATABASE_URL is required for PostgreSQL (V3 Single Book principle)
  if (!url) {
    if (isTestEnvironment()) {
      return null; // Tests may mock persistence
    }
    throw new Error(
      '[config] FATAL: DATABASE_URL is required.\n' +
      '  Set DATABASE_URL to your PostgreSQL connection string.'
    );
  }

  // F6 FIX: Wrap URL parsing to never leak credentials in errors
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Don't include original error - it may contain the URL
    throw new Error(
      '[config] FATAL: DATABASE_URL is malformed - cannot parse as URL'
    );
  }

  // Must be postgres protocol
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      '[config] FATAL: DATABASE_URL must use postgres:// or postgresql:// protocol'
    );
  }

  // Must have host, database name
  if (!parsed.hostname) {
    throw new Error('[config] FATAL: DATABASE_URL missing hostname');
  }

  if (!parsed.pathname || parsed.pathname === '/') {
    throw new Error('[config] FATAL: DATABASE_URL missing database name');
  }

  // F7 FIX: LIVE mode requires SSL - check both sslmode and ssl parameters
  if (isLive) {
    const sslMode = parsed.searchParams.get('sslmode');
    const sslParam = parsed.searchParams.get('ssl');

    const hasValidSslMode = ['require', 'verify-full', 'verify-ca'].includes(sslMode);
    const hasValidSslParam = sslParam === 'true';

    if (!hasValidSslMode && !hasValidSslParam) {
      throw new Error(
        '[config] FATAL: LIVE mode requires DATABASE_URL with SSL enabled.\n' +
        '  Add ?sslmode=require or ?ssl=true to your DATABASE_URL'
      );
    }
  }

  return url;
}

// =============================================================================
// RAILWAY ENVIRONMENT DETECTION
// =============================================================================

/**
 * Detect if running on Railway
 * @returns {{ isRailway: boolean, environment: string|null, serviceId: string|null }}
 */
function detectRailwayEnvironment() {
  const isRailway = !!(
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_SERVICE_ID ||
    process.env.RAILWAY_PROJECT_ID
  );

  return {
    isRailway,
    environment: process.env.RAILWAY_ENVIRONMENT || null,
    serviceId: process.env.RAILWAY_SERVICE_ID || null,
    projectId: process.env.RAILWAY_PROJECT_ID || null,
    staticUrl: process.env.RAILWAY_STATIC_URL || null,
  };
}

/**
 * Parse STARTING_CAPITAL with proper handling of 0 and invalid values (F5 fix)
 * @returns {number} Starting capital (defaults to 1000)
 */
function parseStartingCapital() {
  const raw = process.env.STARTING_CAPITAL;

  // Not set - use default
  if (raw === undefined || raw === '') {
    return 1000;
  }

  const parsed = parseFloat(raw);

  // Invalid number - warn and use default
  if (Number.isNaN(parsed)) {
    console.warn(`[config] Invalid STARTING_CAPITAL '${raw}', using default 1000`);
    return 1000;
  }

  // Valid number (including 0)
  return parsed;
}

// =============================================================================
// VALIDATE AND BUILD CONFIG
// =============================================================================

// Perform validations (will throw on failure)
const tradingModeResult = validateTradingMode();
const databaseUrl = validateDatabaseUrl(tradingModeResult.isLive);
const railway = detectRailwayEnvironment();

// Log startup info (suppress in test environment - F10 fix)
if (!isTestEnvironment()) {
  console.log(`[config] TRADING_MODE: ${tradingModeResult.mode}`);
  if (railway.isRailway) {
    console.log(`[config] Railway environment detected: ${railway.environment || 'unknown'}`);
  }
  if (databaseUrl) {
    console.log('[config] DATABASE_URL: [REDACTED - PostgreSQL configured]');
  }
}

// =============================================================================
// THE CONFIGURATION OBJECT
// =============================================================================

const config = {
  // TRADING MODE - set once, never changes
  tradingMode: tradingModeResult.mode,

  // Polymarket API configuration (secrets from env)
  polymarket: {
    apiUrl: process.env.POLYMARKET_API_URL || 'https://clob.polymarket.com',
    apiKey: process.env.POLYMARKET_API_KEY,
    apiSecret: process.env.POLYMARKET_API_SECRET,
    passphrase: process.env.POLYMARKET_PASSPHRASE,
    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
    funder: process.env.POLYMARKET_FUNDER_ADDRESS,
  },

  // Spot price feed configuration
  spot: {
    provider: process.env.SPOT_PROVIDER || 'pyth',
    endpoint: process.env.SPOT_ENDPOINT,
  },

  // Risk management limits (same everywhere - V3 Principle 2)
  risk: {
    maxPositionSize: 100,
    maxExposure: 1000,
    dailyDrawdownLimit: null, // DISABLED
    positionLimitPerMarket: null, // DISABLED
  },

  // Logging configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    directory: './logs',
    jsonFormat: true,
  },

  // Database configuration
  database: {
    // PostgreSQL connection (V3 Single Book)
    url: databaseUrl,
    // Pool configuration
    pool: {
      min: 2,
      max: 10,
      idleTimeoutMs: 30000,
      connectionTimeoutMs: 15000, // Increased for Supabase (Singapore region)
    },
    // Circuit breaker dedicated pool
    circuitBreakerPool: {
      min: 1,
      max: 2,
      idleTimeoutMs: 30000,
      connectionTimeoutMs: 5000, // Faster timeout for CB but still reasonable
    },
    // Query timeout
    queryTimeoutMs: 10000, // Increased for Supabase latency
    // Retry configuration
    retry: {
      maxAttempts: 3,
      initialDelayMs: 500, // Increased initial delay
      maxDelayMs: 5000,    // Increased max delay
    },
  },

  // Kill switch configuration
  killSwitch: {
    gracefulTimeoutMs: 2000,
    stateFilePath: './data/last-known-state.json',
    stateUpdateIntervalMs: 5000,
    stateStaleThresholdMs: 5000,
  },

  // Safety module configuration (F5 fix: proper parsing of STARTING_CAPITAL)
  safety: {
    startingCapital: parseStartingCapital(),
    unrealizedUpdateIntervalMs: 5000,
    drawdownWarningPct: null, // DISABLED
    // auto-stop state persisted in PostgreSQL (auto_stop_state table)
  },

  // Trading window configuration
  trading: {
    windowDurationMs: 15 * 60 * 1000, // 15 minutes
    minTimeRemainingMs: 60 * 1000, // 1 minute
  },

  // Orchestrator configuration
  orchestrator: {
    tickIntervalMs: 1000,
    moduleInitTimeoutMs: 30000, // Increased for PostgreSQL connection (Supabase can be slow)
    moduleShutdownTimeoutMs: 10000,
    maxRetryAttempts: 3,
    retryBackoffMs: 1000,
    inflightTimeoutMs: 10000,
  },

  // Monitoring and diagnostic thresholds
  monitoring: {
    latencyThresholdMs: 500,
    slippageThresholdPct: 0.02,
    sizeImpactThreshold: 0.5,
    partialFillThresholdPct: 0.1,
    latencyComponentThresholds: {
      decisionToSubmitMs: 100,
      submitToAckMs: 200,
      ackToFillMs: 300,
    },
  },

  // Trade event module configuration
  tradeEvent: {
    thresholds: {
      latencyThresholdMs: 500,
      slippageThresholdPct: 0.02,
      sizeImpactThreshold: 0.5,
      partialFillThresholdPct: 0.1,
      latencyComponentThresholds: {
        decisionToSubmitMs: 100,
        submitToAckMs: 200,
        ackToFillMs: 300,
      },
    },
  },

  // Data retention policies
  retention: {
    rtdsTicks: {
      enabled: true,
      maxAgeDays: 7,
    },
    oracleUpdates: {
      enabled: true,
      maxAgeDays: 30,
    },
    lagSignals: {
      enabled: true,
      maxAgeDays: 30,
    },
    tradeEvents: {
      enabled: true,
      maxAgeDays: 90,
    },
    cleanupIntervalMs: 6 * 60 * 60 * 1000, // 6 hours
  },

  // Strategy configuration
  strategy: {
    entry: {
      entryThresholdPct: 0.70,
    },
    sizing: {
      baseSizeDollars: 2,
      minSizeDollars: 1,
      maxSlippagePct: 0.01,
      confidenceMultiplier: 0,
    },
    stopLoss: {
      enabled: true,
      defaultStopLossPct: 0.50,
    },
    takeProfit: {
      enabled: true,
      defaultTakeProfitPct: null, // DISABLED - hold to expiry
      trailingEnabled: true,
      trailingActivationPct: 0.01,
      trailingPullbackPct: 0.30,
      minProfitFloorPct: 0.00,
    },
    windowExpiry: {
      enabled: true,
      expiryWarningThresholdMs: 30 * 1000,
    },
  },

  // Signal outcome logger configuration
  signalOutcomeLogger: {
    autoSubscribeToSignals: true,
    autoSubscribeToSettlements: true,
    defaultPositionSize: 1,
    retentionDays: 30,
  },

  // Quality gate configuration
  qualityGate: {
    enabled: true,
    evaluationIntervalMs: 60000,
    rollingWindowSize: 20,
    minAccuracyThreshold: 0.40,
    feedUnavailableThresholdMs: 10000,
    patternChangeThreshold: 2.0,
    spreadBehaviorStdDev: 2.0,
    patternCheckFrequency: 5,
    minSignalsForEvaluation: 10,
  },

  // Strategy composition configuration
  strategies: {
    default: 'Oracle Edge Only',
    configDir: './config/strategies/',
    autoDiscover: true,
    autoLoadOnInit: true,
  },

  // Backtest configuration
  backtest: {
    tickBatchSize: 10000,
    parallelEval: false,
    outputDir: './logs/backtest/',
  },

  // Railway environment info (read-only)
  railway,
};

// =============================================================================
// VALIDATE REQUIRED CREDENTIALS
// =============================================================================

/**
 * Validate configuration has required fields (F9 fix: validate funder)
 * @param {Object} cfg - Configuration to validate
 * @throws {Error} If required configuration is missing
 */
function validateConfig(cfg) {
  const errors = [];

  // In LIVE mode, require Polymarket credentials
  if (cfg.tradingMode === 'LIVE') {
    if (!cfg.polymarket.apiKey) {
      errors.push('POLYMARKET_API_KEY is required for LIVE trading');
    }
    if (!cfg.polymarket.apiSecret) {
      errors.push('POLYMARKET_API_SECRET is required for LIVE trading');
    }
    if (!cfg.polymarket.passphrase) {
      errors.push('POLYMARKET_PASSPHRASE is required for LIVE trading');
    }
    if (!cfg.polymarket.privateKey) {
      errors.push('POLYMARKET_PRIVATE_KEY is required for LIVE trading');
    }
    // F9 FIX: Also require funder address for LIVE trading
    if (!cfg.polymarket.funder) {
      errors.push('POLYMARKET_FUNDER_ADDRESS is required for LIVE trading');
    }
  }

  // Risk limits must be positive
  if (cfg.risk.maxPositionSize <= 0) {
    errors.push('risk.maxPositionSize must be positive');
  }

  if (cfg.risk.maxExposure <= 0) {
    errors.push('risk.maxExposure must be positive');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n  - ${errors.join('\n  - ')}`);
  }
}

// Validate the config
validateConfig(config);

// F2 FIX: Deep freeze to make truly immutable (V3 Principle: immutable after load)
const frozenConfig = deepFreeze(config);

// =============================================================================
// EXPORTS
// =============================================================================

export default frozenConfig;

// Export utilities for testing
export { validateTradingMode, validateDatabaseUrl, detectRailwayEnvironment, validateConfig, deepFreeze };
