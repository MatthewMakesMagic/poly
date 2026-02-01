#!/usr/bin/env node
/**
 * Railway Kill Switch
 *
 * Immediately stops the Railway deployment or local process.
 * Detects environment (Railway vs local) and uses appropriate method:
 * - Railway: Calls Railway GraphQL API to set service replicas to 0
 * - Local: Sends SIGTERM/SIGKILL to process from PID file
 *
 * Exit codes:
 * - 0: Success
 * - 1: Failure
 *
 * @module kill-switch/railway-kill
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.app/graphql';
const RAILWAY_DASHBOARD_URL = 'https://railway.app/dashboard';
const PID_FILE_PATH = path.resolve(__dirname, '../data/main.pid');
const GRACEFUL_TIMEOUT_MS = 2000;

/**
 * Detect if running on Railway
 * @returns {boolean}
 */
function isRailwayEnvironment() {
  return !!(
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_SERVICE_ID ||
    process.env.RAILWAY_PROJECT_ID
  );
}

/**
 * Get current timestamp in ISO format
 * @returns {string}
 */
function getTimestamp() {
  return new Date().toISOString();
}

/**
 * Open Railway dashboard as fallback
 */
function openDashboard() {
  const projectId = process.env.RAILWAY_PROJECT_ID;
  const serviceId = process.env.RAILWAY_SERVICE_ID;

  let url = RAILWAY_DASHBOARD_URL;
  if (projectId) {
    url = `https://railway.app/project/${projectId}`;
    if (serviceId) {
      url += `/service/${serviceId}`;
    }
  }

  // Platform-specific open command
  const platform = process.platform;
  let command;

  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (err) => {
    if (err) {
      console.error(`Failed to open dashboard: ${url}`);
    } else {
      console.log(`Opened dashboard: ${url}`);
    }
  });
}

/**
 * Kill Railway deployment via GraphQL API
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function killRailwayDeployment() {
  const token = process.env.RAILWAY_API_TOKEN;
  const serviceId = process.env.RAILWAY_SERVICE_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;

  if (!token) {
    return {
      success: false,
      error: 'RAILWAY_API_TOKEN environment variable not set',
    };
  }

  if (!serviceId) {
    return {
      success: false,
      error: 'RAILWAY_SERVICE_ID environment variable not set',
    };
  }

  // Build the GraphQL mutation
  const mutation = `
    mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
    }
  `;

  const variables = {
    serviceId,
    environmentId: environmentId || null,
    input: {
      numReplicas: 0,
    },
  };

  try {
    const response = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: mutation,
        variables,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        error: `Railway API returned ${response.status}: ${text}`,
      };
    }

    const result = await response.json();

    if (result.errors && result.errors.length > 0) {
      return {
        success: false,
        error: `GraphQL errors: ${result.errors.map((e) => e.message).join(', ')}`,
      };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: `Request failed: ${err.message}`,
    };
  }
}

/**
 * Check if a process is running by PID
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessRunning(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') {
      return false;
    }
    if (err.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

/**
 * Wait for a process to exit
 * @param {number} pid
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForProcessExit(pid, timeoutMs) {
  const startTime = Date.now();
  const pollInterval = 100;

  while (Date.now() - startTime < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return false;
}

/**
 * Kill local process using PID file
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function killLocalProcess() {
  // Read PID file
  if (!fs.existsSync(PID_FILE_PATH)) {
    return {
      success: false,
      error: `PID file not found: ${PID_FILE_PATH}`,
    };
  }

  let pid;
  try {
    const content = fs.readFileSync(PID_FILE_PATH, 'utf-8').trim();
    pid = parseInt(content, 10);

    if (isNaN(pid) || pid <= 0) {
      return {
        success: false,
        error: `Invalid PID in file: ${content}`,
      };
    }
  } catch (err) {
    return {
      success: false,
      error: `Failed to read PID file: ${err.message}`,
    };
  }

  // Check if process is running
  if (!isProcessRunning(pid)) {
    // Clean up stale PID file
    try {
      fs.unlinkSync(PID_FILE_PATH);
    } catch {
      // Ignore cleanup errors
    }
    return {
      success: true,
      message: `Process ${pid} was not running (cleaned up stale PID file)`,
    };
  }

  // Step 1: Send SIGTERM (graceful shutdown)
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') {
      return {
        success: false,
        error: `Failed to send SIGTERM: ${err.message}`,
      };
    }
  }

  // Step 2: Wait for graceful exit
  const exited = await waitForProcessExit(pid, GRACEFUL_TIMEOUT_MS);

  if (exited) {
    // Clean up PID file
    try {
      fs.unlinkSync(PID_FILE_PATH);
    } catch {
      // Ignore cleanup errors
    }
    return { success: true, method: 'SIGTERM' };
  }

  // Step 3: Force kill with SIGKILL
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    if (err.code !== 'ESRCH') {
      return {
        success: false,
        error: `Failed to send SIGKILL: ${err.message}`,
      };
    }
  }

  // Brief wait for SIGKILL to take effect
  await new Promise((resolve) => setTimeout(resolve, 100));

  if (!isProcessRunning(pid)) {
    // Clean up PID file
    try {
      fs.unlinkSync(PID_FILE_PATH);
    } catch {
      // Ignore cleanup errors
    }
    return { success: true, method: 'SIGKILL' };
  }

  return {
    success: false,
    error: `Process ${pid} could not be killed`,
  };
}

/**
 * Main entry point
 */
async function main() {
  const isRailway = isRailwayEnvironment();
  const environment = isRailway ? 'Railway' : 'local';

  console.log(`Kill switch triggered in ${environment} environment...`);

  let result;

  if (isRailway) {
    result = await killRailwayDeployment();
  } else {
    result = await killLocalProcess();
  }

  if (result.success) {
    const timestamp = getTimestamp();
    console.log(`\u2713 Killed. Service stopped at ${timestamp}`);
    process.exit(0);
  } else {
    console.error(`Kill failed: ${result.error}`);

    // Open dashboard as fallback for Railway
    if (isRailway) {
      console.log('Opening Railway dashboard as fallback...');
      openDashboard();
    }

    process.exit(1);
  }
}

// Run if executed directly
main().catch((err) => {
  console.error(`Kill failed: ${err.message}`);
  process.exit(1);
});
