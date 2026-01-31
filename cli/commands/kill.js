/**
 * CLI Kill Command
 *
 * Provides a simple CLI interface to trigger the kill switch.
 * Wraps the watchdog kill command for ease of use.
 *
 * Usage: node cli/commands/kill.js
 *
 * @module cli/commands/kill
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..', '..');

/**
 * Execute the kill command
 *
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function execute() {
  const watchdogPath = join(projectRoot, 'kill-switch', 'watchdog.js');

  return new Promise((resolve) => {
    console.log('🛑 Triggering kill switch...\n');

    const child = spawn('node', [watchdogPath, 'kill'], {
      cwd: projectRoot,
      stdio: 'inherit',
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({
          success: true,
          message: 'Kill command executed successfully',
        });
      } else {
        resolve({
          success: false,
          message: `Kill command failed with exit code ${code}`,
        });
      }
    });

    child.on('error', (err) => {
      console.error(`Error: ${err.message}`);
      resolve({
        success: false,
        message: `Failed to execute kill command: ${err.message}`,
      });
    });
  });
}

/**
 * Show help for the kill command
 */
export function showHelp() {
  console.log(`
Kill Command - Emergency shutdown for poly trading system

Usage: node cli/commands/kill.js [options]

Options:
  --help, -h    Show this help message

Description:
  Triggers the kill switch to immediately halt all trading activity.
  This command will:
  1. Send SIGTERM to the main process (graceful shutdown)
  2. Wait up to 2 seconds for graceful exit
  3. Send SIGKILL if process is still running (force kill)

  Guaranteed to complete within 5 seconds.

Examples:
  node cli/commands/kill.js           # Execute kill
  node cli/commands/kill.js --help    # Show this help
`.trim());
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  const result = await execute();
  process.exit(result.success ? 0 : 1);
}

main();
