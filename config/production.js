/**
 * Production environment configuration overrides
 *
 * These values override default.js when NODE_ENV=production
 */

export default {
  // Production logging - warn level for silence
  logging: {
    level: 'warn',
  },

  // Conservative risk limits in production
  risk: {
    maxPositionSize: 5,          // Max $5 per position
    maxExposure: 20,             // Max $20 total exposure
    dailyDrawdownLimit: 0.10,    // 10% drawdown limit
  },

  // Production position sizing - $2 fixed
  strategy: {
    sizing: {
      baseSizeDollars: 2,        // $2 per trade
      confidenceMultiplier: 0,   // Disabled - fixed size
    },
  },
};
