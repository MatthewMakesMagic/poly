#!/usr/bin/env node

/**
 * Pre-flight Checks Script
 *
 * Validates deployment readiness by checking:
 * - Environment variables
 * - Polymarket API authentication
 * - PostgreSQL database connection
 * - Database migrations
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
import pg from 'pg';

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

  // Check for missing or empty environment variables
  const missing = requiredVars.filter((v) => !process.env[v] || process.env[v].trim() === '');

  if (missing.length > 0) {
    return {
      name: 'Environment Variables',
      pass: false,
      details: '',
      error: `Missing: ${missing.join(', ')}`,
    };
  }

  // Check DATABASE_URL
  if (!process.env.DATABASE_URL) {
    return {
      name: 'Environment Variables',
      pass: false,
      details: '',
      error: 'Missing: DATABASE_URL',
    };
  }

  return {
    name: 'Environment Variables',
    pass: true,
    details: `All required vars set (TRADING_MODE=${config.tradingMode})`,
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

    // Get balance to verify auth works (with timeout)
    const timeoutMs = 10000;
    const balancePromise = client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('API request timed out')), timeoutMs)
    );
    const balance = await Promise.race([balancePromise, timeoutPromise]);

    const rawAmount = parseFloat(balance?.balance || balance?.amount || 0);
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
 * @param {string} message - Raw error message that may contain sensitive data
 * @returns {string} Sanitized message with sensitive patterns replaced by [REDACTED]
 */
function sanitizeErrorMessage(message) {
  if (!message) return 'Unknown error';

  const sensitivePatterns = [
    /0x[a-fA-F0-9]{40,}/g,
    /[a-fA-F0-9]{64}/g,
    /key[=:]\s*["']?[^"'\s]+["']?/gi,
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
 * Check PostgreSQL database connection
 * @returns {Promise<CheckResult>}
 */
async function checkDatabaseConnection() {
  const dbUrl = config.database?.url || process.env.DATABASE_URL;

  if (!dbUrl) {
    return {
      name: 'Database',
      pass: false,
      details: '',
      error: 'DATABASE_URL not configured',
    };
  }

  let client;
  try {
    client = new pg.Client({
      connectionString: dbUrl,
      connectionTimeoutMillis: 10000,
      statement_timeout: 5000,
    });

    await client.connect();
    const result = await client.query('SELECT 1 AS ok');
    await client.end();

    if (result.rows[0]?.ok === 1) {
      return {
        name: 'Database',
        pass: true,
        details: 'PostgreSQL connected',
        error: null,
      };
    }

    return {
      name: 'Database',
      pass: false,
      details: '',
      error: 'Query returned unexpected result',
    };
  } catch (err) {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
    return {
      name: 'Database',
      pass: false,
      details: '',
      error: `Connection failed: ${sanitizeErrorMessage(err.message)}`,
    };
  }
}

/**
 * Check database migrations
 * @returns {Promise<CheckResult>}
 */
async function checkMigrations() {
  const dbUrl = config.database?.url || process.env.DATABASE_URL;

  if (!dbUrl) {
    return {
      name: 'Database Migrations',
      pass: false,
      details: '',
      error: 'DATABASE_URL not configured',
    };
  }

  let client;
  try {
    client = new pg.Client({
      connectionString: dbUrl,
      connectionTimeoutMillis: 10000,
      statement_timeout: 5000,
    });

    await client.connect();

    // Get applied migrations from database
    let appliedCount = 0;
    try {
      const applied = await client.query('SELECT version FROM schema_migrations ORDER BY id');
      appliedCount = applied.rows.length;
    } catch (err) {
      await client.end();
      return {
        name: 'Database Migrations',
        pass: false,
        details: '',
        error: 'No migrations applied (schema_migrations table not found)',
      };
    }

    await client.end();

    // Count migration files
    const migrationsDir = join(__dirname, '../src/persistence/migrations');

    if (!existsSync(migrationsDir)) {
      return {
        name: 'Database Migrations',
        pass: false,
        details: '',
        error: `Migrations directory not found: ${migrationsDir}`,
      };
    }

    const migrationFiles = readdirSync(migrationsDir).filter((f) =>
      f.match(/^\d{3,}-.*\.js$/) && !f.startsWith('index')
    );
    const totalCount = migrationFiles.length;

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
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
    return {
      name: 'Database Migrations',
      pass: false,
      details: '',
      error: `Check failed: ${sanitizeErrorMessage(err.message)}`,
    };
  }
}

/**
 * Check Railway CLI availability
 * @returns {CheckResult}
 */
function checkRailwayCli() {
  const cliTimeoutMs = 15000;

  try {
    execSync('railway --version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: cliTimeoutMs,
    });

    const status = execSync('railway status', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: cliTimeoutMs,
    });

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

    if (typeof manifest.position_size_dollars !== 'number' || manifest.position_size_dollars <= 0) {
      await shutdownLaunchConfig();
      return {
        name: 'Launch Manifest',
        pass: false,
        details: '',
        error: 'position_size_dollars must be > 0',
      };
    }

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

  try {
    console.log(lines.join('\n'));
  } catch (err) {
    if (err.code !== 'EPIPE') {
      throw err;
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  const results = [];

  results.push(checkEnvironment());
  results.push(await checkPolymarketAuth());
  results.push(await checkDatabaseConnection());
  results.push(await checkMigrations());
  results.push(checkRailwayCli());
  results.push(await checkLaunchManifest());

  formatResults(results);

  const allPassed = results.every((r) => r.pass);
  process.exit(allPassed ? 0 : 1);
}

// Export functions for testing
export {
  checkEnvironment,
  checkPolymarketAuth,
  checkDatabaseConnection,
  checkMigrations,
  checkRailwayCli,
  checkLaunchManifest,
  formatResults,
  sanitizeErrorMessage,
};

// Only run main if this is the entry point (not imported for testing)
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
