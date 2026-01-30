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
    maxPositionSize: 100,        // Maximum size per position
    maxExposure: 500,            // Maximum total exposure
    dailyDrawdownLimit: 0.05,    // 5% daily drawdown limit
    positionLimitPerMarket: 1,   // Max positions per market
  },

  // Logging configuration
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
  },

  // Trading window configuration
  trading: {
    windowDurationMs: 15 * 60 * 1000,  // 15 minutes
    minTimeRemainingMs: 60 * 1000,      // Don't enter with <1 min remaining
  },
};
