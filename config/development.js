/**
 * Development environment configuration overrides
 *
 * These values override default.js when NODE_ENV=development
 */

export default {
  // More verbose logging in development
  logging: {
    level: 'debug',
  },

  // Smaller limits for testing
  risk: {
    maxPositionSize: 10,
    maxExposure: 50,
    dailyDrawdownLimit: 0.10,  // 10% - more lenient for testing
  },

  // Use test database
  database: {
    path: './data/poly-dev.db',
  },
};
