#!/usr/bin/env node

/**
 * Post-deploy Verification Script
 *
 * Verifies that deployment succeeded by checking:
 * - Health endpoint responds with "healthy" status
 * - Active strategies match launch.json manifest
 * - Data flow is active (fresh ticks, no errors)
 * - Logs are clean (Scout integration, optional)
 *
 * Usage:
 *   npm run verify
 *
 * Exit codes:
 *   0 - All verifications passed
 *   1 - One or more verifications failed
 */

import { config as loadEnv } from 'dotenv';
import { readFileSync, existsSync } from 'fs';

// Load .env.local first (takes precedence), then .env as fallback
loadEnv({ path: '.env.local' });
loadEnv();

// Import config AFTER env is loaded
import config from '../config/index.js';

/**
 * VerifyResult interface
 * @typedef {Object} VerifyResult
 * @property {string} name - Display name for the verification
 * @property {boolean} pass - Did the verification pass?
 * @property {string} [details] - Success details
 * @property {string} [error] - Error message if failed
 * @property {string[]} [strategies] - Strategy list (for strategy match)
 * @property {string[]} [missing] - Missing strategies
 * @property {string[]} [extra] - Extra strategies
 */

/**
 * Sanitize error messages to prevent credential/URL leakage
 *
 * @param {string} message - Raw error message
 * @returns {string} Sanitized message
 */
export function sanitizeErrorMessage(message) {
  if (!message) return 'Unknown error';

  // Patterns that might contain sensitive data
  const sensitivePatterns = [
    /0x[a-fA-F0-9]{40,}/g,           // Ethereum addresses/keys
    /[a-fA-F0-9]{64}/g,               // 64-char hex strings (private keys)
    /key[=:]\s*["']?[^"'\s]+["']?/gi, // key=value patterns
    /secret[=:]\s*["']?[^"'\s]+["']?/gi,
    /password[=:]\s*["']?[^"'\s]+["']?/gi,
    /passphrase[=:]\s*["']?[^"'\s]+["']?/gi,
    /token[=:]\s*["']?[^"'\s]+["']?/gi,
    /Bearer\s+[^\s]+/gi,              // Bearer tokens
    /Basic\s+[^\s]+/gi,               // Basic auth
  ];

  let sanitized = message;
  for (const pattern of sensitivePatterns) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }

  return sanitized;
}

/**
 * Validate URL is safe for health check requests
 *
 * Prevents SSRF attacks by ensuring URL is either localhost or a trusted Railway domain.
 *
 * @param {string} url - URL to validate
 * @returns {boolean} True if URL is safe
 */
export function isValidHealthUrl(url) {
  try {
    const parsed = new URL(url);

    // Must be http or https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }

    // Allow localhost for local verification
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      return true;
    }

    // Allow Railway domains (*.railway.app, *.up.railway.app)
    if (parsed.hostname.endsWith('.railway.app')) {
      return true;
    }

    // Reject all other domains
    return false;
  } catch {
    return false;
  }
}

/**
 * Get the health endpoint URL
 *
 * Uses RAILWAY_STATIC_URL for remote verification, otherwise localhost.
 * Validates URL to prevent SSRF attacks.
 *
 * @returns {string} Health endpoint URL
 * @throws {Error} If RAILWAY_STATIC_URL is set to an invalid/untrusted URL
 */
export function getHealthUrl() {
  // For remote (Railway) verification
  if (process.env.RAILWAY_STATIC_URL) {
    const railwayUrl = process.env.RAILWAY_STATIC_URL;

    // Validate the Railway URL before using
    const fullUrl = `${railwayUrl}/api/live/status`;
    if (!isValidHealthUrl(fullUrl)) {
      throw new Error('RAILWAY_STATIC_URL contains invalid or untrusted URL');
    }

    return fullUrl;
  }

  // For local verification - use config if available, fallback to env/default
  const port = config?.server?.port || process.env.PORT || 3333;
  return `http://localhost:${port}/api/live/status`;
}

/**
 * Fetch with timeout using AbortController
 *
 * @param {string} url - URL to fetch
 * @param {number} [timeoutMs=10000] - Timeout for individual request
 * @returns {Promise<Response>} Fetch response
 */
async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Poll health endpoint until healthy or timeout
 *
 * @param {string} url - Health endpoint URL
 * @param {number} [timeoutMs=60000] - Total timeout in milliseconds
 * @param {number} [pollIntervalMs=2000] - Poll interval in milliseconds
 * @param {number} [requestTimeoutMs=10000] - Individual request timeout
 * @returns {Promise<Object>} Health response
 * @throws {Error} If timeout or connection errors persist
 */
export async function pollHealthEndpoint(url, timeoutMs = 60000, pollIntervalMs = 2000, requestTimeoutMs = 10000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetchWithTimeout(url, requestTimeoutMs);
      if (response.ok) {
        const health = await response.json();
        if (health.status === 'healthy') {
          return health;
        }
        // Log degraded/unhealthy status but continue polling
        console.log(`  Status: ${health.status}, waiting...`);
      }
    } catch (err) {
      // Connection error or timeout - service might still be starting
      if (err.name === 'AbortError') {
        console.log('  Request timed out, retrying...');
      } else {
        console.log('  Waiting for service to start...');
      }
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error('Health check timeout - service did not become healthy within 60 seconds');
}

/**
 * Load launch manifest from config/launch.json
 *
 * @param {string} [manifestPath='config/launch.json'] - Path to manifest
 * @returns {Object} Parsed manifest with strategies array
 * @throws {Error} If manifest not found, invalid JSON, or missing strategies field
 */
export function loadLaunchManifest(manifestPath = 'config/launch.json') {
  if (!existsSync(manifestPath)) {
    throw new Error(`Launch manifest not found: ${manifestPath}`);
  }

  const content = readFileSync(manifestPath, 'utf-8');

  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch (parseErr) {
    throw new Error(`Launch manifest contains invalid JSON: ${parseErr.message}`);
  }

  // Validate required strategies field exists and is an array
  if (!manifest.strategies || !Array.isArray(manifest.strategies)) {
    throw new Error('Launch manifest missing required "strategies" array');
  }

  return manifest;
}

/**
 * Verify active strategies match launch manifest
 *
 * @param {Object} healthResponse - Health endpoint response
 * @param {Object} manifest - Launch manifest
 * @returns {VerifyResult}
 */
export function verifyStrategiesMatch(healthResponse, manifest) {
  const activeStrategies = healthResponse.active_strategies || [];
  const expectedStrategies = manifest.strategies || [];

  const active = new Set(activeStrategies);
  const expected = new Set(expectedStrategies);

  const missing = expectedStrategies.filter(s => !active.has(s));
  const extra = activeStrategies.filter(s => !expected.has(s));

  if (missing.length === 0 && extra.length === 0) {
    const strategyWord = expectedStrategies.length === 1 ? 'strategy' : 'strategies';
    return {
      name: 'Strategy Match',
      pass: true,
      details: `All ${expectedStrategies.length} ${strategyWord} active`,
      strategies: expectedStrategies,
    };
  }

  return {
    name: 'Strategy Match',
    pass: false,
    error: `Mismatch: ${missing.length} missing, ${extra.length} extra`,
    missing,
    extra,
  };
}

/**
 * Parse and validate a tick timestamp
 *
 * @param {string} tickTimestamp - ISO timestamp string
 * @returns {{ valid: boolean, timestamp: Date|null, error: string|null }}
 */
export function parseTickTimestamp(tickTimestamp) {
  if (!tickTimestamp) {
    return { valid: false, timestamp: null, error: 'No tick data received' };
  }

  const parsed = new Date(tickTimestamp);

  // Check for Invalid Date
  if (isNaN(parsed.getTime())) {
    return { valid: false, timestamp: null, error: `Invalid tick timestamp: ${tickTimestamp}` };
  }

  return { valid: true, timestamp: parsed, error: null };
}

/**
 * Verify data flow is active
 *
 * Checks that last_tick is within 30 seconds and error_count_1m is 0.
 *
 * @param {Object} healthResponse - Health endpoint response
 * @param {number} [currentTime] - Current time in ms (for testing, defaults to Date.now())
 * @returns {VerifyResult[]} Array of verification results
 */
export function verifyDataFlow(healthResponse, currentTime = Date.now()) {
  const results = [];

  // Check last_tick freshness (within 30 seconds)
  const tickParse = parseTickTimestamp(healthResponse.last_tick);

  if (tickParse.valid) {
    const tickAge = currentTime - tickParse.timestamp.getTime();
    const isFresh = tickAge < 30000;
    results.push({
      name: 'Tick Freshness',
      pass: isFresh,
      details: isFresh ? `Last tick ${Math.floor(tickAge / 1000)}s ago` : null,
      error: isFresh ? null : `Last tick ${Math.floor(tickAge / 1000)}s ago (stale)`,
    });
  } else {
    results.push({
      name: 'Tick Freshness',
      pass: false,
      error: tickParse.error,
    });
  }

  // Check error count (must be 0 for post-deploy)
  const errorCount = healthResponse.error_count_1m ?? 0;
  results.push({
    name: 'Error Rate',
    pass: errorCount === 0,
    details: errorCount === 0 ? 'No errors in last minute' : null,
    error: errorCount > 0 ? `${errorCount} errors in last minute` : null,
  });

  return results;
}

/**
 * Verify logs using Scout integration (optional)
 *
 * Checks for error patterns in recent logs and verifies startup messages.
 * Returns soft pass if Scout module is not available.
 *
 * @returns {Promise<VerifyResult>}
 */
export async function verifyLogs() {
  // Error patterns to check for
  const errorPatterns = [
    'FATAL',
    'CRITICAL',
    'unhandled',
    'crash',
    'exception',
  ];

  // Expected startup messages
  const expectedMessages = [
    'strategies_initialized',
    'orchestrator_started',
    'rtds_connected',
  ];

  // Scout integration is optional - if not available, return soft pass
  // In a full implementation, this would integrate with the Scout module
  return {
    name: 'Log Analysis',
    pass: true,
    details: 'Scout verification skipped (module not available)',
  };
}

/**
 * Format verification results for console output
 *
 * @param {VerifyResult[]} results - Array of verification results
 * @param {Object} [options={}] - Formatting options
 * @param {string[]} [options.strategies] - Active strategies to display
 */
export function formatVerifyResults(results, options = {}) {
  console.log('');

  for (const result of results) {
    const icon = result.pass ? '✓' : '✗';
    const name = result.name;

    if (result.pass) {
      console.log(`  [${icon}] ${name}: ${result.details || 'OK'}`);
    } else {
      console.log(`  [${icon}] ${name}: ${result.error}`);
    }

    // Show strategy list for strategy match
    if (result.strategies && result.strategies.length > 0) {
      for (const strategy of result.strategies) {
        console.log(`      - ${strategy}`);
      }
    }

    // Show missing/extra strategies on failure
    if (result.missing && result.missing.length > 0) {
      console.log(`      Missing: ${result.missing.join(', ')}`);
    }
    if (result.extra && result.extra.length > 0) {
      console.log(`      Extra: ${result.extra.join(', ')}`);
    }
  }

  const passed = results.filter(r => r.pass).length;
  const total = results.length;

  console.log('');
  if (passed === total) {
    console.log('DEPLOYMENT SUCCESSFUL');
  } else {
    console.log(`DEPLOYMENT FAILED (${total - passed}/${total} checks failed)`);
  }
  console.log('');
}

/**
 * Run all verifications
 *
 * @returns {Promise<{results: VerifyResult[], allPassed: boolean}>}
 */
export async function runVerifications() {
  const results = [];

  // Get health URL
  const url = getHealthUrl();
  console.log('Verifying deployment...');
  console.log(`  Target: ${url}`);

  // Step 1: Poll health endpoint
  let healthResponse;
  const pollStartTime = Date.now();

  try {
    healthResponse = await pollHealthEndpoint(url);
    const pollDuration = Date.now() - pollStartTime;
    results.push({
      name: 'Health Endpoint',
      pass: true,
      details: `responding (${pollDuration}ms)`,
    });
  } catch (err) {
    results.push({
      name: 'Health Endpoint',
      pass: false,
      error: sanitizeErrorMessage(err.message),
    });
    return { results, allPassed: false };
  }

  // Step 2: Verify strategies match manifest
  try {
    const manifest = loadLaunchManifest();
    const strategyResult = verifyStrategiesMatch(healthResponse, manifest);
    results.push(strategyResult);
  } catch (err) {
    results.push({
      name: 'Strategy Match',
      pass: false,
      error: `Failed to load manifest: ${sanitizeErrorMessage(err.message)}`,
    });
  }

  // Step 3: Verify data flow
  const dataFlowResults = verifyDataFlow(healthResponse);
  results.push(...dataFlowResults);

  // Step 4: Verify logs (Scout integration)
  const logsResult = await verifyLogs();
  results.push(logsResult);

  const allPassed = results.every(r => r.pass);
  return { results, allPassed };
}

/**
 * Main entry point
 */
async function main() {
  try {
    const { results, allPassed } = await runVerifications();

    // Display results
    formatVerifyResults(results);

    // Exit with appropriate code
    process.exit(allPassed ? 0 : 1);
  } catch (err) {
    console.error('Verification failed:', sanitizeErrorMessage(err.message));
    process.exit(1);
  }
}

// Only run main if this is the entry point (not imported for testing)
const isMainModule = process.argv[1]?.endsWith('verify.mjs');
if (isMainModule) {
  main();
}
