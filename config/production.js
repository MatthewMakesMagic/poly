/**
 * Production environment configuration overrides
 *
 * These values override default.js when NODE_ENV=production
 */

export default {
  // Production logging - info level, no debug noise
  logging: {
    level: 'info',
  },

  // Stricter risk limits in production
  risk: {
    maxPositionSize: 100,
    maxExposure: 500,
    dailyDrawdownLimit: 0.05,  // 5% - strict in production
  },
};
