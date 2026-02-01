#!/usr/bin/env node

/**
 * Deploy Command Script
 *
 * Orchestrates deployment to Railway with clean slate:
 * 1. Run preflight checks → abort if fail
 * 2. Show manifest → offer edit option
 * 3. Confirm deploy → abort if declined
 * 4. Git push to main (or railway up)
 * 5. Wait for build/deploy
 * 6. Run verification
 * 7. Report result
 *
 * Usage:
 *   npm run deploy
 *   npm run deploy -- --yes  (skip confirmation prompts)
 *
 * Exit codes:
 *   0 - Deployment successful
 *   1 - Deployment failed or aborted
 */

import { config as loadEnv } from 'dotenv';
import { spawn, execSync } from 'child_process';
import { createInterface } from 'readline';

// Load .env.local first (takes precedence), then .env as fallback
loadEnv({ path: '.env.local' });
loadEnv();

// Import preflight check functions
import {
  checkEnvironment,
  checkPolymarketAuth,
  checkDatabaseConnection,
  checkMigrations,
  checkRailwayCli,
  checkLaunchManifest,
  formatResults,
  sanitizeErrorMessage,
} from './preflight.mjs';

// Import verification functions
import {
  runVerifications,
  formatVerifyResults,
  sanitizeErrorMessage as sanitizeVerifyError,
} from './verify.mjs';

// Import launch-config module functions
import {
  loadManifest,
  init as initLaunchConfig,
  shutdown as shutdownLaunchConfig,
} from '../src/modules/launch-config/index.js';

// Parse command line arguments
const args = process.argv.slice(2);
const skipConfirmation = args.includes('--yes') || args.includes('-y');

/**
 * Run all preflight checks
 *
 * @returns {Promise<{results: Object[], allPassed: boolean}>}
 */
async function runPreflightChecks() {
  const results = [];

  // Run checks sequentially
  results.push(checkEnvironment());
  results.push(await checkPolymarketAuth());
  results.push(checkDatabaseConnection());
  results.push(checkMigrations());
  results.push(checkRailwayCli());
  results.push(await checkLaunchManifest());

  const allPassed = results.every((r) => r.pass);
  return { results, allPassed };
}

/**
 * Display the current launch manifest
 *
 * @param {Object} manifest - Launch manifest object
 */
function displayManifest(manifest) {
  // Guard against null/undefined manifest properties (ISSUE 8, 9 fix)
  const strategies = Array.isArray(manifest?.strategies) ? manifest.strategies : [];
  const symbols = Array.isArray(manifest?.symbols) ? manifest.symbols : [];
  const positionSize = manifest?.position_size_dollars ?? 'N/A';
  const maxExposure = manifest?.max_exposure_dollars ?? 'N/A';
  const killSwitch = manifest?.kill_switch_enabled;

  console.log('\nCurrent launch.json:');
  console.log(`  Strategies:     ${strategies.length > 0 ? strategies.join(', ') : '(none)'}`);
  console.log(`  Position size:  ${typeof positionSize === 'number' ? `$${positionSize}` : positionSize}`);
  console.log(`  Max exposure:   ${typeof maxExposure === 'number' ? `$${maxExposure}` : maxExposure}`);
  console.log(`  Symbols:        ${symbols.length > 0 ? symbols.join(', ') : '(none)'}`);
  console.log(`  Kill switch:    ${killSwitch === true ? 'enabled' : killSwitch === false ? 'disabled' : 'N/A'}`);
  console.log('');
}

/**
 * Prompt user for input
 *
 * @param {string} question - Question to ask
 * @returns {Promise<string>} User's answer (lowercase, trimmed)
 */
async function promptUser(question) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().trim());
    });
  });
}

/**
 * Check for uncommitted git changes
 *
 * @returns {boolean} True if there are uncommitted changes
 */
function hasUncommittedChanges() {
  try {
    const status = execSync('git status --porcelain', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Deploy via git push to origin main
 *
 * @returns {Promise<void>}
 * @throws {Error} If git push fails
 */
async function deployViaGit() {
  return new Promise((resolve, reject) => {
    const timeout = 5 * 60 * 1000; // 5 minutes
    let settled = false; // Prevent double-resolve/reject (ISSUE 3 improvement)

    console.log('\nPushing to Railway via git...');
    console.log('  $ git push origin main\n');

    const proc = spawn('git', ['push', 'origin', 'main'], {
      stdio: 'inherit',
    });

    const timer = setTimeout(() => {
      if (settled) return;
      // Send SIGTERM first, then SIGKILL after 5s if still running (ISSUE 3 fix)
      proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Process may already be dead
        }
      }, 5000);
      settled = true;
      reject(new Error('Git push timed out after 5 minutes'));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Git push failed with exit code ${code}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      // Differentiate error types for better debugging (ISSUE 19 fix)
      const errorType = err.code === 'ENOENT' ? 'command not found' :
                        err.code === 'EACCES' ? 'permission denied' :
                        err.message;
      reject(new Error(`Git push error: ${errorType}`));
    });
  });
}

/**
 * Deploy via Railway CLI
 *
 * @returns {Promise<void>}
 * @throws {Error} If railway up fails
 */
async function deployViaRailwayCli() {
  return new Promise((resolve, reject) => {
    const timeout = 5 * 60 * 1000; // 5 minutes
    let settled = false; // Prevent double-resolve/reject (ISSUE 3 improvement)

    console.log('\nDeploying via Railway CLI...');
    console.log('  $ railway up\n');

    const proc = spawn('railway', ['up'], {
      stdio: 'inherit',
    });

    const timer = setTimeout(() => {
      if (settled) return;
      // Send SIGTERM first, then SIGKILL after 5s if still running (ISSUE 3 fix)
      proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Process may already be dead
        }
      }, 5000);
      settled = true;
      reject(new Error('Railway deploy timed out after 5 minutes'));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Railway deploy failed with exit code ${code}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      // Differentiate error types for better debugging (ISSUE 19 fix)
      const errorType = err.code === 'ENOENT' ? 'command not found' :
                        err.code === 'EACCES' ? 'permission denied' :
                        err.message;
      reject(new Error(`Railway CLI error: ${errorType}`));
    });
  });
}

/**
 * Select deployment method based on availability
 *
 * Prefers git push, falls back to Railway CLI if git remote isn't configured.
 *
 * @returns {'git' | 'railway'} Deployment method to use
 */
function selectDeployMethod() {
  try {
    // Check if origin remote exists
    execSync('git remote get-url origin', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 'git';
  } catch {
    return 'railway';
  }
}

/**
 * Wait for Railway to process the deployment
 *
 * @param {number} [delaySeconds=30] - Delay in seconds
 */
async function waitForDeployment(delaySeconds = 30) {
  console.log(`\nWaiting ${delaySeconds}s for Railway to process deployment...`);

  for (let i = delaySeconds; i > 0; i -= 5) {
    process.stdout.write(`  ${i}s remaining...\r`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  console.log('  Deployment should be starting...\n');
}

/**
 * Display categorized error message with suggestions
 *
 * @param {'preflight' | 'abort' | 'git' | 'railway' | 'verify'} category - Error category
 * @param {string} [message] - Additional error message
 */
function displayError(category, message = '') {
  console.log('\n✗ DEPLOYMENT FAILED\n');

  switch (category) {
    case 'preflight':
      console.log('Preflight checks failed.');
      console.log('Fix the issues shown above, then re-run: npm run deploy');
      break;

    case 'abort':
      console.log('Deploy cancelled. No changes made.');
      break;

    case 'git':
      console.log(`Git push failed: ${sanitizeErrorMessage(message)}`);
      console.log('\nSuggested fixes:');
      console.log('  - Check git remote is configured: git remote -v');
      console.log('  - Check authentication: git credential-manager');
      console.log('  - Check network connectivity');
      console.log('  - Try: git push origin main --verbose');
      break;

    case 'railway':
      console.log(`Railway deploy failed: ${sanitizeErrorMessage(message)}`);
      console.log('\nSuggested fixes:');
      console.log('  - Check Railway CLI is authenticated: railway login');
      console.log('  - Check Railway project is linked: railway status');
      console.log('  - Check Railway dashboard for build logs');
      break;

    case 'verify':
      console.log(`Verification failed: ${sanitizeVerifyError(message)}`);
      console.log('\nSystem deployed but unhealthy.');
      console.log('\nSuggested fixes:');
      console.log('  - Check Railway logs in dashboard');
      console.log('  - Use Scout for monitoring: /scout');
      console.log('  - Run verification manually: npm run verify');
      break;

    default:
      console.log(`Error: ${sanitizeErrorMessage(message)}`);
  }

  console.log('');
}

/**
 * Display success message
 */
function displaySuccess() {
  console.log('\n✓ DEPLOYMENT SUCCESSFUL\n');
  console.log('Scout is watching. Use /scout for monitoring.\n');
}

/**
 * Main entry point
 */
async function main() {
  console.log('=================================');
  console.log('       POLY DEPLOY COMMAND       ');
  console.log('=================================\n');

  // Step 1: Run preflight checks
  console.log('Step 1/4: Running preflight checks...\n');
  const { results: preflightResults, allPassed: preflightPassed } = await runPreflightChecks();
  formatResults(preflightResults);

  if (!preflightPassed) {
    displayError('preflight');
    process.exit(1);
  }

  // Step 2: Display manifest and confirm
  console.log('Step 2/4: Reviewing launch configuration...');

  try {
    await initLaunchConfig();
    const manifest = loadManifest();
    displayManifest(manifest);
    await shutdownLaunchConfig();
  } catch (err) {
    // ISSUE 17 fix: Use specific error category for manifest failures, not 'preflight'
    console.error('Failed to load manifest:', sanitizeErrorMessage(err.message));
    console.log('\n✗ DEPLOYMENT FAILED\n');
    console.log('Launch manifest could not be loaded.');
    console.log('Check config/launch.json exists and is valid JSON.');
    console.log('Run `npm run launch:config` to create or edit the manifest.\n');
    process.exit(1);
  }

  if (!skipConfirmation) {
    // Ask if user wants to edit config
    const editAnswer = await promptUser('Edit config before deploy? (y/n): ');
    if (editAnswer === 'y' || editAnswer === 'yes') {
      console.log('\nRun `npm run launch:config` to edit, then re-run deploy.\n');
      process.exit(0);
    }

    // Explain what will happen
    console.log('Deployment will:');
    console.log('  1. Push code to Railway');
    console.log('  2. Clean slate restart');
    console.log('  3. Auto-verify deployment\n');

    // Confirm deployment
    const deployAnswer = await promptUser('Deploy now? (y/n): ');
    if (deployAnswer !== 'y' && deployAnswer !== 'yes') {
      displayError('abort');
      process.exit(1);
    }
  } else {
    console.log('(Skipping confirmation prompts with --yes flag)\n');
  }

  // Step 3: Check for uncommitted changes
  if (hasUncommittedChanges()) {
    console.log('⚠️  Warning: You have uncommitted changes.');
    console.log('   These changes will NOT be deployed.\n');

    if (!skipConfirmation) {
      const continueAnswer = await promptUser('Continue anyway? (y/n): ');
      if (continueAnswer !== 'y' && continueAnswer !== 'yes') {
        displayError('abort');
        process.exit(1);
      }
    }
  }

  // Step 4: Deploy
  console.log('Step 3/4: Deploying to Railway...');

  const method = selectDeployMethod();

  try {
    if (method === 'git') {
      await deployViaGit();
    } else {
      await deployViaRailwayCli();
    }
  } catch (err) {
    displayError(method === 'git' ? 'git' : 'railway', err.message);
    process.exit(1);
  }

  // Wait for Railway to process
  await waitForDeployment(30);

  // Step 5: Run verification
  console.log('Step 4/4: Verifying deployment...\n');

  // Check if RAILWAY_STATIC_URL is set
  if (!process.env.RAILWAY_STATIC_URL) {
    console.log('⚠️  Warning: RAILWAY_STATIC_URL not set.');
    console.log('   Verification will target localhost (may not work for remote deploy).');
    console.log('   Set RAILWAY_STATIC_URL to your Railway deployment URL.\n');
  }

  try {
    const { results: verifyResults, allPassed: verifyPassed } = await runVerifications();
    formatVerifyResults(verifyResults);

    if (!verifyPassed) {
      displayError('verify', 'One or more verification checks failed');
      process.exit(1);
    }

    displaySuccess();
    process.exit(0);
  } catch (err) {
    displayError('verify', err.message);
    process.exit(1);
  }
}

// Export functions for testing
export {
  runPreflightChecks,
  displayManifest,
  promptUser,
  hasUncommittedChanges,
  deployViaGit,
  deployViaRailwayCli,
  selectDeployMethod,
  waitForDeployment,
  displayError,
  displaySuccess,
};

// Only run main if this is the entry point (not imported for testing)
const isMainModule = process.argv[1]?.endsWith('deploy.mjs');
if (isMainModule) {
  main().catch((err) => {
    console.error('Deploy failed:', sanitizeErrorMessage(err.message));
    process.exit(1);
  });
}
