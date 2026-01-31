/**
 * Configuration loader
 *
 * Merges default config with environment-specific overrides.
 * Validates required configuration before returning.
 */

import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env.local first (takes precedence), then .env as fallback
loadEnv({ path: '.env.local' });
loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Deep merge two objects
 * @param {Object} target - Base object
 * @param {Object} source - Object to merge in
 * @returns {Object} Merged object
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Validate configuration has required fields
 * @param {Object} config - Configuration to validate
 * @throws {Error} If required configuration is missing
 */
function validateConfig(config) {
  const errors = [];

  // Check Polymarket credentials (required for live trading)
  if (!config.polymarket.apiKey && process.env.NODE_ENV === 'production') {
    errors.push('POLYMARKET_API_KEY is required in production');
  }

  if (!config.polymarket.apiSecret && process.env.NODE_ENV === 'production') {
    errors.push('POLYMARKET_API_SECRET is required in production');
  }

  // Check risk limits are sensible
  if (config.risk.maxPositionSize <= 0) {
    errors.push('risk.maxPositionSize must be positive');
  }

  if (config.risk.maxExposure <= 0) {
    errors.push('risk.maxExposure must be positive');
  }

  if (config.risk.dailyDrawdownLimit <= 0 || config.risk.dailyDrawdownLimit > 1) {
    errors.push('risk.dailyDrawdownLimit must be between 0 and 1');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n  - ${errors.join('\n  - ')}`);
  }
}

/**
 * Load and merge configuration
 * @returns {Promise<Object>} Complete configuration object
 */
async function loadConfig() {
  // Load default config
  const defaultModule = await import(join(__dirname, 'default.js'));
  const defaultConfig = defaultModule.default;

  // Determine environment
  const env = process.env.NODE_ENV || 'development';

  // Try to load environment-specific config
  let envConfig = {};
  try {
    const envModule = await import(join(__dirname, `${env}.js`));
    envConfig = envModule.default;
  } catch (err) {
    // Environment config doesn't exist, that's fine
    if (err.code !== 'ERR_MODULE_NOT_FOUND') {
      throw err;
    }
  }

  // Merge configs
  const config = deepMerge(defaultConfig, envConfig);

  // Validate
  validateConfig(config);

  // Freeze to prevent accidental modification
  return Object.freeze(config);
}

// Load config and export
let config;
try {
  config = await loadConfig();
} catch (err) {
  console.error('Failed to load configuration:', err.message);
  process.exit(1);
}
export default config;

// Also export the loader and validator for testing
export { loadConfig, validateConfig };
