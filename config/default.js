/**
 * Default configuration for poly trading system
 *
 * This file contains base configuration values.
 * Environment-specific overrides are in development.js and production.js
 * Sensitive values come from .env file
 */

export default {
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
    maxPositionSize: 5,          // Maximum size per position ($5 cap)
    maxExposure: 20,             // Maximum total exposure ($20 cap)
    dailyDrawdownLimit: 0.10,    // 10% daily drawdown limit
    positionLimitPerMarket: 1,   // Max positions per market
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
    drawdownWarningPct: 0.03,          // Warn at 3% (60% of default 5% limit)
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

  // Strategy configuration
  strategy: {
    entry: {
      spotLagThresholdPct: 0.001,  // 0.1% lag to enter (low threshold for ExecutionTest)
      minConfidence: 0.6,          // Minimum confidence to enter
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
      defaultStopLossPct: 0.50,      // 50% stop-loss for ExecutionTest (volatile market)
    },
    // Take-profit configuration
    takeProfit: {
      enabled: true,                  // Enable/disable take-profit evaluation
      defaultTakeProfitPct: 0.10,     // 10% default take-profit (fixed mode)
      trailingEnabled: true,          // Use trailing stop mode for ExecutionTest
      trailingActivationPct: 0.01,    // 1% profit to activate trailing (enter fast for testing)
      trailingPullbackPct: 0.50,      // 50% pullback from HWM to trigger exit (volatile market)
      minProfitFloorPct: 0.01,        // 1% minimum profit floor (allow quick exits)
    },
    // Window expiry configuration
    windowExpiry: {
      enabled: true,                        // Enable/disable window expiry evaluation
      expiryWarningThresholdMs: 30 * 1000,  // 30 seconds - warn when this close to expiry
    },
  },
};
