/**
 * Default configuration for poly trading system
 *
 * This file contains base configuration values.
 * Environment-specific overrides are in development.js and production.js
 * Sensitive values come from .env file
 */

export default {
  // TRADING MODE - CRITICAL SAFETY GATE
  // PAPER: Signal generation only, NO order execution (DEFAULT - ENFORCED)
  // LIVE: Actual order execution (requires explicit env override)
  tradingMode: process.env.TRADING_MODE || 'PAPER',

  // Polymarket API configuration
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

  // Risk management limits
  risk: {
    maxPositionSize: 100,         // Maximum size per position (high limit - controlled by strategy)
    maxExposure: 1000,            // Maximum total exposure (high limit - controlled by strategy)
    dailyDrawdownLimit: null,     // DISABLED - no drawdown limit
    positionLimitPerMarket: null, // DISABLED - each strategy can trade same market per window
  },

  // Logging configuration
  // Story 5.5: "Silence = Trust" monitoring philosophy
  // - 'info': All logs emitted (default for development)
  // - 'warn': Info suppressed, warn/error emitted (production silent mode)
  // - 'error': Only error logs emitted
  // Note: warn/error are NEVER suppressed regardless of level setting
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    directory: './logs',
    jsonFormat: true,
  },

  // Database configuration
  database: {
    path: process.env.DATABASE_PATH || './data/poly.db',
  },

  // Kill switch configuration
  killSwitch: {
    gracefulTimeoutMs: 2000,     // 2 seconds for graceful shutdown
    stateFilePath: './data/last-known-state.json',
    stateUpdateIntervalMs: 5000, // Periodic state update interval
    stateStaleThresholdMs: 5000, // Consider snapshot stale after this
  },

  // Safety module configuration
  safety: {
    startingCapital: parseFloat(process.env.STARTING_CAPITAL) || 1000,
    unrealizedUpdateIntervalMs: 5000,  // Update unrealized P&L every 5 seconds
    drawdownWarningPct: null,          // DISABLED - no drawdown warning
    autoStopStateFile: './data/auto-stop-state.json',  // Persist auto-stop state
  },

  // Trading window configuration
  trading: {
    windowDurationMs: 15 * 60 * 1000,  // 15 minutes
    minTimeRemainingMs: 60 * 1000,      // Don't enter with <1 min remaining
  },

  // Orchestrator configuration
  orchestrator: {
    tickIntervalMs: 1000,           // 1 second between ticks
    moduleInitTimeoutMs: 5000,      // 5 seconds per module init
    moduleShutdownTimeoutMs: 5000,  // 5 seconds per module shutdown
    maxRetryAttempts: 3,            // Retries for recoverable errors
    retryBackoffMs: 1000,           // Base backoff (doubles each retry)
    inflightTimeoutMs: 10000,       // Max wait for in-flight ops
  },

  // Monitoring and diagnostic thresholds (Story 5.2, AC8 + Story 5.3)
  monitoring: {
    latencyThresholdMs: 500,       // Flag events with latency > 500ms (per NFR1)
    slippageThresholdPct: 0.02,    // Flag events with slippage > 2% of expected price
    sizeImpactThreshold: 0.5,      // Flag events where size > 50% of available depth
    partialFillThresholdPct: 0.1,  // Flag partial fills with >10% size difference (Story 5.3)
    latencyComponentThresholds: {  // Individual latency component thresholds (Story 5.3)
      decisionToSubmitMs: 100,     // Decision to submit should be fast (internal processing)
      submitToAckMs: 200,          // Exchange ack should be quick (network + exchange)
      ackToFillMs: 300,            // Fill after ack varies by liquidity
    },
  },

  // Trade event module configuration (Story 5.2 + Story 5.3)
  tradeEvent: {
    thresholds: {
      latencyThresholdMs: 500,       // Same as monitoring defaults
      slippageThresholdPct: 0.02,
      sizeImpactThreshold: 0.5,
      partialFillThresholdPct: 0.1,  // 10% tolerance for partial fills (Story 5.3)
      latencyComponentThresholds: {  // Individual component checks (Story 5.3)
        decisionToSubmitMs: 100,
        submitToAckMs: 200,
        ackToFillMs: 300,
      },
    },
  },

  // Data retention policies (cleanup old data to manage storage)
  retention: {
    rtdsTicks: {
      enabled: true,
      maxAgeDays: 7,           // 7-day rolling window for tick data
    },
    oracleUpdates: {
      enabled: true,
      maxAgeDays: 30,          // 30-day rolling window
    },
    lagSignals: {
      enabled: true,
      maxAgeDays: 30,          // 30-day rolling window
    },
    tradeEvents: {
      enabled: true,
      maxAgeDays: 90,          // 90-day rolling window (archive older if needed)
    },
    cleanupIntervalMs: 6 * 60 * 60 * 1000,  // Run cleanup every 6 hours
  },

  // Strategy configuration
  strategy: {
    entry: {
      entryThresholdPct: 0.70,     // 70% token price to enter (simple threshold strategy)
      // minTimeRemainingMs comes from trading.minTimeRemainingMs
    },
    // Position sizing configuration
    sizing: {
      baseSizeDollars: 2,            // Base position size in dollars ($2 default)
      minSizeDollars: 1,             // Minimum tradeable size
      maxSlippagePct: 0.01,          // 1% max slippage
      confidenceMultiplier: 0,       // Disabled - fixed $2 size
    },
    // Stop-loss configuration
    stopLoss: {
      enabled: true,                 // Enable/disable stop-loss evaluation
      defaultStopLossPct: 0.50,      // 50% stop-loss for all strategies
    },
    // Take-profit configuration - TRAILING MODE
    // Strategy: Hold to expiry, but exit aggressively on 30% pullback from peak
    takeProfit: {
      enabled: true,                  // Enable/disable take-profit evaluation
      defaultTakeProfitPct: null,     // DISABLED - hold to expiry (no fixed take profit)
      trailingEnabled: true,          // Trailing stop mode active
      trailingActivationPct: 0.01,    // 1% profit to start tracking peak
      trailingPullbackPct: 0.30,      // 30% pullback from peak = aggressive exit
      minProfitFloorPct: 0.00,        // No minimum - can exit at breakeven on pullback
    },
    // Window expiry configuration
    windowExpiry: {
      enabled: true,                        // Enable/disable window expiry evaluation
      expiryWarningThresholdMs: 30 * 1000,  // 30 seconds - warn when this close to expiry
    },
  },

  // Signal outcome logger configuration (Story 7-8)
  signalOutcomeLogger: {
    autoSubscribeToSignals: true,       // Auto-subscribe to oracle-edge-signal
    autoSubscribeToSettlements: true,   // Auto-subscribe to settlement events
    defaultPositionSize: 1,             // Default position size for PnL calc
    retentionDays: 30,                  // Keep signals for 30 days
  },

  // Quality gate configuration (Story 7-9)
  qualityGate: {
    enabled: true,                        // Enable/disable quality gate
    evaluationIntervalMs: 60000,          // Evaluate every 1 minute
    rollingWindowSize: 20,                // Last N signals for rolling accuracy
    minAccuracyThreshold: 0.40,           // 40% minimum accuracy
    feedUnavailableThresholdMs: 10000,    // 10 seconds feed unavailable
    patternChangeThreshold: 2.0,          // 2x change in update frequency
    spreadBehaviorStdDev: 2.0,            // 2 std dev for spread behavior change
    patternCheckFrequency: 5,             // Check patterns every 5th evaluation
    minSignalsForEvaluation: 10,          // Min signals before evaluating accuracy
  },

  // Strategy composition configuration (Story 7-12)
  strategies: {
    default: 'Oracle Edge Only',          // Default active strategy name
    configDir: './config/strategies/',    // Strategy definition directory
    autoDiscover: true,                   // Auto-register strategies from dir
    autoLoadOnInit: true,                 // Load all strategies on module init
  },

  // Backtest configuration (Story 7-12)
  backtest: {
    tickBatchSize: 10000,                 // Ticks per batch in replay
    parallelEval: false,                  // Single-threaded by default
    outputDir: './logs/backtest/',        // Backtest result storage
  },
};
