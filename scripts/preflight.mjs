#!/usr/bin/env node

/**
 * Pre-flight Checks Script
 *
 * Validates deployment readiness by checking:
 * - Environment variables
 * - Polymarket API authentication
 * - Database connection and migrations
 * - Railway CLI availability
 * - Launch manifest validity
 *
 * Usage:
 *   npm run preflight
 *
 * Exit codes:
 *   0 - All checks passed
 *   1 - One or more checks failed
 */

import { config as loadEnv } from 'dotenv';
import { readdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Database from 'better-sqlite3';

// Load .env.local first (takes precedence), then .env as fallback
loadEnv({ path: '.env.local' });
loadEnv();

// Import config AFTER env is loaded
import config from '../config/index.js';

// Import launch-config module functions
import { loadManifest, isKnownStrategy, init as initLaunchConfig, shutdown as shutdownLaunchConfig } from '../src/modules/launch-config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * CheckResult interface
 * @typedef {Object} CheckResult
 * @property {string} name - Display name for the check
 * @property {boolean} pass - Did the check pass?
 * @property {string} details - Success details
 * @property {string|null} [error] - Error message if failed
 */

/**
 * Check environment variables
 * @returns {CheckResult}
 */
function checkEnvironment() {
  const requiredVars = [
    'POLYMARKET_API_KEY',
    'POLYMARKET_API_SECRET',
    'POLYMARKET_PASSPHRASE',
    'POLYMARKET_PRIVATE_KEY',
  ];

  // Check for missing or empty environment variables (ISSUE 4 fix)
  const missing = requiredVars.filter((v) => !process.env[v] || process.env[v].trim() === '');

  if (missing.length > 0) {
    return {
      name: 'Environment Variables',
      pass: false,
      details: '',
      error: `Missing: ${missing.join(', ')}`,
    };
  }

  return {
    name: 'Environment Variables',
    pass: true,
    details: `All ${requiredVars.length} required vars set`,
    error: null,
  };
}

/**
 * Check Polymarket API authentication
 * @returns {Promise<CheckResult>}
 */
async function checkPolymarketAuth() {
  try {
    // Import Polymarket client dynamically to avoid loading at script start
    const { ClobClient } = await import('@polymarket/clob-client');
    const { Wallet } = await import('ethers');

    const wallet = new Wallet(config.polymarket.privateKey);
    const client = new ClobClient(
      config.polymarket.apiUrl || 'https://clob.polymarket.com',
      137,
      wallet,
      {
        key: config.polymarket.apiKey,
        secret: config.polymarket.apiSecret,
        passphrase: config.polymarket.passphrase,
      },
      2,
      config.polymarket.funder
    );

    // Get balance to verify auth works (with timeout - ISSUE 15 fix)
    const timeoutMs = 10000; // 10 second timeout
    const balancePromise = client.getBalanceAllowance();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('API request timed out')), timeoutMs)
    );
    const balance = await Promise.race([balancePromise, timeoutPromise]);

    // Validate balance is a valid number (ISSUE 9 fix)
    const rawAmount = parseFloat(balance?.amount || 0);
    if (isNaN(rawAmount)) {
      return {
        name: 'Polymarket API',
        pass: false,
        details: '',
        error: 'Invalid balance response from API',
      };
    }
    const usdcBalance = rawAmount / 1e6;

    return {
      name: 'Polymarket API',
      pass: true,
      details: `connected (balance: $${usdcBalance.toFixed(2)})`,
      error: null,
    };
  } catch (err) {
    // Sanitize error message to prevent credential leakage (ISSUE 1 fix)
    const sanitizedMessage = sanitizeErrorMessage(err.message);
    return {
      name: 'Polymarket API',
      pass: false,
      details: '',
      error: `Auth failed: ${sanitizedMessage}`,
    };
  }
}

/**
 * Sanitize error messages to prevent credential leakage
 *
 * Removes sensitive data patterns from error messages including:
 * - Ethereum addresses and private keys
 * - API keys, secrets, passwords, tokens
 *
 * @param {string} message - Raw error message that may contain sensitive data
 * @returns {string} Sanitized message with sensitive patterns replaced by [REDACTED]
 */
function sanitizeErrorMessage(message) {
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
  ];

  let sanitized = message;
  for (const pattern of sensitivePatterns) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }

  return sanitized;
}

/**
 * Check database connection
 * @returns {CheckResult}
 */
function checkDatabaseConnection() {
  let db = null;
  try {
    const dbPath = config.database.path;

    if (!existsSync(dbPath)) {
      return {
        name: 'Database',
        pass: false,
        details: '',
        error: `Database file not found: ${dbPath}`,
      };
    }

    // Open in read-only mode to avoid interfering with running processes (ISSUE 2 fix)
    db = new Database(dbPath, { readonly: true });

    // Execute a simple query to verify connection
    db.prepare('SELECT 1').get();

    db.close();
    db = null;

    return {
      name: 'Database',
      pass: true,
      details: 'connected',
      error: null,
    };
  } catch (err) {
    // Ensure database is closed on error (ISSUE 5 fix)
    if (db) {
      try { db.close(); } catch { /* ignore close errors */ }
    }
    return {
      name: 'Database',
      pass: false,
      details: '',
      error: `Connection failed: ${err.message}`,
    };
  }
}

/**
 * Check database migrations
 * @returns {CheckResult}
 */
function checkMigrations() {
  let db = null;
  try {
    const dbPath = config.database.path;

    if (!existsSync(dbPath)) {
      return {
        name: 'Database Migrations',
        pass: false,
        details: '',
        error: 'Database file not found',
      };
    }

    // Open in read-only mode (ISSUE 2 fix)
    db = new Database(dbPath, { readonly: true });

    // Get applied migrations from database
    let appliedCount = 0;
    try {
      const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY id').all();
      appliedCount = applied.length;
    } catch (err) {
      // schema_migrations table might not exist
      db.close();
      db = null;
      return {
        name: 'Database Migrations',
        pass: false,
        details: '',
        error: 'No migrations applied (schema_migrations table not found)',
      };
    }

    db.close();
    db = null;

    // Count migration files - support both 3-digit and larger prefixes (ISSUE 16 fix)
    const migrationsDir = join(__dirname, '../src/persistence/migrations');

    // Check if migrations directory exists
    if (!existsSync(migrationsDir)) {
      return {
        name: 'Database Migrations',
        pass: false,
        details: '',
        error: `Migrations directory not found: ${migrationsDir}`,
      };
    }

    // Match migration files: NNN-*.js format (3+ digit prefix)
    const migrationFiles = readdirSync(migrationsDir).filter((f) =>
      f.match(/^\d{3,}-.*\.js$/) && !f.startsWith('index')
    );
    const totalCount = migrationFiles.length;

    // Check for migration count mismatch in either direction (ISSUE 6 fix)
    if (appliedCount !== totalCount) {
      const direction = appliedCount < totalCount ? 'Missing' : 'Extra';
      const diff = Math.abs(totalCount - appliedCount);
      return {
        name: 'Database Migrations',
        pass: false,
        details: `${appliedCount}/${totalCount} applied`,
        error: `${direction} ${diff} migration(s)`,
      };
    }

    return {
      name: 'Database Migrations',
      pass: true,
      details: `${appliedCount}/${totalCount} applied`,
      error: null,
    };
  } catch (err) {
    // Ensure database is closed on error (ISSUE 5 fix)
    if (db) {
      try { db.close(); } catch { /* ignore close errors */ }
    }
    return {
      name: 'Database Migrations',
      pass: false,
      details: '',
      error: `Check failed: ${err.message}`,
    };
  }
}

/**
 * Check Railway CLI availability
 * @returns {CheckResult}
 */
function checkRailwayCli() {
  // Timeout for CLI commands to prevent hanging (ISSUE 7 fix)
  const cliTimeoutMs = 15000; // 15 seconds

  try {
    // Check if CLI installed (railway uses --version flag)
    execSync('railway --version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: cliTimeoutMs,
    });

    // Check if authenticated
    const status = execSync('railway status', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: cliTimeoutMs,
    });

    // Parse project name from status output (ISSUE 10 - add fallback patterns)
    let project = 'unknown';
    const patterns = [
      /Project:\s*(.+)/i,
      /project\s*name:\s*(.+)/i,
      /name:\s*(.+)/i,
    ];
    for (const pattern of patterns) {
      const match = status.match(pattern);
      if (match) {
        project = match[1].trim();
        break;
      }
    }

    // Warn if project couldn't be parsed but CLI works
    if (project === 'unknown') {
      return {
        name: 'Railway CLI',
        pass: true,
        details: 'authenticated (project name could not be parsed)',
        error: null,
      };
    }

    return {
      name: 'Railway CLI',
      pass: true,
      details: `authenticated (project: ${project})`,
      error: null,
    };
  } catch (err) {
    const message = err.message || '';
    const stderr = err.stderr?.toString() || '';

    if (message.includes('command not found') || message.includes('ENOENT')) {
      return {
        name: 'Railway CLI',
        pass: false,
        details: '',
        error: 'CLI not installed (npm install -g @railway/cli)',
      };
    }

    if (message.includes('ETIMEDOUT') || message.includes('timed out')) {
      return {
        name: 'Railway CLI',
        pass: false,
        details: '',
        error: 'CLI command timed out',
      };
    }

    if (stderr.includes('not logged in') || stderr.includes('login')) {
      return {
        name: 'Railway CLI',
        pass: false,
        details: '',
        error: 'Not authenticated (run: railway login)',
      };
    }

    // Provide meaningful error even if both message and stderr are empty (ISSUE 12 fix)
    const errorDetail = message || stderr || 'Unknown CLI error';
    return {
      name: 'Railway CLI',
      pass: false,
      details: '',
      error: `Check failed: ${errorDetail}`,
    };
  }
}

/**
 * Check launch manifest validity
 * @returns {Promise<CheckResult>}
 */
async function checkLaunchManifest() {
  try {
    // Initialize launch-config module to load manifest
    try {
      await initLaunchConfig();
    } catch (initErr) {
      return {
        name: 'Launch Manifest',
        pass: false,
        details: '',
        error: `Module init failed: ${initErr.message}. Check config/launch.json exists.`,
      };
    }

    const manifest = loadManifest();

    // Validate each strategy exists
    const unknownStrategies = manifest.strategies.filter(
      (s) => !isKnownStrategy(s)
    );

    if (unknownStrategies.length > 0) {
      await shutdownLaunchConfig();
      return {
        name: 'Launch Manifest',
        pass: false,
        details: '',
        error: `Unknown strategies: ${unknownStrategies.join(', ')}`,
      };
    }

    // Validate position_size_dollars > 0 (explicit check for negative/zero/missing)
    if (typeof manifest.position_size_dollars !== 'number' || manifest.position_size_dollars <= 0) {
      await shutdownLaunchConfig();
      return {
        name: 'Launch Manifest',
        pass: false,
        details: '',
        error: 'position_size_dollars must be > 0',
      };
    }

    // Validate max_exposure_dollars > position_size_dollars (explicit type check)
    if (
      typeof manifest.max_exposure_dollars !== 'number' ||
      manifest.max_exposure_dollars <= manifest.position_size_dollars
    ) {
      await shutdownLaunchConfig();
      return {
        name: 'Launch Manifest',
        pass: false,
        details: '',
        error: 'max_exposure_dollars must be > position_size_dollars',
      };
    }

    await shutdownLaunchConfig();

    return {
      name: 'Launch Manifest',
      pass: true,
      details: `valid (${manifest.strategies.length} strategies)`,
      error: null,
    };
  } catch (err) {
    try {
      await shutdownLaunchConfig();
    } catch {
      // Ignore shutdown errors
    }
    return {
      name: 'Launch Manifest',
      pass: false,
      details: '',
      error: `Check failed: ${err.message}`,
    };
  }
}

/**
 * Format check results as ASCII table
 *
 * Writes formatted output to stdout. Handles write errors gracefully
 * to support piped/CI environments.
 *
 * @param {CheckResult[]} results - Array of check results to format
 */
function formatResults(results) {
  const lines = [];
  lines.push('\nPre-flight Checks');
  lines.push('-----------------');

  for (const result of results) {
    const icon = result.pass ? '✓' : '✗';
    const name = result.name.padEnd(26);
    const info = result.pass ? result.details : result.error;
    lines.push(`  [${icon}] ${name} ${info}`);
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;

  lines.push('');
  if (passed === total) {
    lines.push(`All checks passed (${passed}/${total})`);
  } else {
    lines.push(`Checks failed: ${total - passed}/${total} failed`);
  }
  lines.push('');

  // Write all lines at once - handle potential EPIPE errors in CI
  try {
    console.log(lines.join('\n'));
  } catch (err) {
    // Silently ignore write errors (EPIPE from closed pipe)
    if (err.code !== 'EPIPE') {
      throw err;
    }
  }
}

/**
 * Check Railway deployment configuration
 * Verifies volume, database path, and required env vars for Railway
 * @returns {Promise<CheckResult>}
 */
async function checkRailwayConfig() {
  // Check if we're running ON Railway (deployed)
  const isOnRailway = !!(
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_SERVICE_ID
  );

  if (isOnRailway) {
    // Running on Railway - verify volume is accessible
    const dbPath = process.env.DATABASE_PATH || '/app/data/poly.db';
    const dataDir = dbPath.substring(0, dbPath.lastIndexOf('/'));

    try {
      const { existsSync, accessSync, constants } = await import('fs');

      // Check if data directory exists and is writable
      if (!existsSync(dataDir)) {
        return {
          name: 'Railway Config',
          pass: false,
          details: '',
          error: `Volume not mounted: ${dataDir} does not exist`,
        };
      }

      // Check write access
      try {
        accessSync(dataDir, constants.W_OK);
      } catch {
        return {
          name: 'Railway Config',
          pass: false,
          details: '',
          error: `Volume not writable: ${dataDir}`,
        };
      }

      return {
        name: 'Railway Config',
        pass: true,
        details: `volume OK (${dataDir})`,
        error: null,
      };
    } catch (err) {
      return {
        name: 'Railway Config',
        pass: false,
        details: '',
        error: `Volume check failed: ${err.message}`,
      };
    }
  }

  // Running locally - check Railway CLI can query the project config
  try {
    const envOutput = execSync('railway variables --json 2>/dev/null || echo "{}"', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });

    let railwayVars = {};
    try {
      railwayVars = JSON.parse(envOutput);
    } catch {
      // Could not parse - maybe not authenticated
      return {
        name: 'Railway Config',
        pass: true,
        details: 'skipped (CLI not linked to project)',
        error: null,
      };
    }

    // Check for required Railway env vars
    const requiredVars = ['DATABASE_PATH'];
    const missing = requiredVars.filter(v => !railwayVars[v]);

    // Check for recommended vars
    const recommendedVars = ['RAILWAY_API_TOKEN', 'RAILWAY_SERVICE_ID'];
    const missingRecommended = recommendedVars.filter(v => !railwayVars[v] && !process.env[v]);

    if (missing.length > 0) {
      return {
        name: 'Railway Config',
        pass: false,
        details: '',
        error: `Missing Railway env vars: ${missing.join(', ')}`,
      };
    }

    const warnings = [];
    if (missingRecommended.length > 0) {
      warnings.push(`(missing: ${missingRecommended.join(', ')})`);
    }

    const dbPath = railwayVars.DATABASE_PATH || '/app/data/poly.db';
    return {
      name: 'Railway Config',
      pass: true,
      details: `DB=${dbPath} ${warnings.join(' ')}`.trim(),
      error: null,
    };
  } catch (err) {
    // Railway CLI not working or not linked
    return {
      name: 'Railway Config',
      pass: true,
      details: 'skipped (CLI unavailable)',
      error: null,
    };
  }
}

/**
 * Main entry point
 */
async function main() {
  const results = [];

  // Run checks sequentially
  results.push(checkEnvironment());
  results.push(await checkPolymarketAuth());
  results.push(checkDatabaseConnection());
  results.push(checkMigrations());
  results.push(checkRailwayCli());
  results.push(await checkRailwayConfig());
  results.push(await checkLaunchManifest());

  // Display results
  formatResults(results);

  // Exit with appropriate code
  const allPassed = results.every((r) => r.pass);
  process.exit(allPassed ? 0 : 1);
}

// Export functions for testing (ISSUE 3 fix)
export {
  checkEnvironment,
  checkPolymarketAuth,
  checkDatabaseConnection,
  checkMigrations,
  checkRailwayCli,
  checkRailwayConfig,
  checkLaunchManifest,
  formatResults,
  sanitizeErrorMessage,
};

// Only run main if this is the entry point (not imported for testing)
// Use import.meta.url comparison for robust cross-platform detection
const scriptPath = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] && (
  process.argv[1] === scriptPath ||
  process.argv[1].endsWith('preflight.mjs')
);
if (isMainModule) {
  main().catch((err) => {
    console.error('Pre-flight check failed:', err.message);
    process.exit(1);
  });
}
