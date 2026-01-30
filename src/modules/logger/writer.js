/**
 * Logger Writer - File output with daily rotation
 *
 * Writes log entries to files in newline-delimited JSON format.
 * Uses daily rotation: logs/poly-YYYY-MM-DD.log
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Writer state
let currentDate = null;
let currentFilePath = null;
let stats = {
  filesWritten: 0,
  bytesWritten: 0,
};

/**
 * Get the log file path for today
 *
 * @param {string} directory - Log directory
 * @returns {string} Full path to log file
 */
function getLogFilePath(directory) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // Check if date has changed (daily rotation)
  if (today !== currentDate) {
    currentDate = today;
    currentFilePath = join(directory, `poly-${today}.log`);
    stats.filesWritten++;
  }

  return currentFilePath;
}

/**
 * Write a log entry to file
 *
 * @param {string} logEntry - JSON log entry
 * @param {string} directory - Log directory
 */
export function writeToFile(logEntry, directory) {
  // Ensure directory exists
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }

  const filePath = getLogFilePath(directory);

  // Append with newline (newline-delimited JSON)
  const line = logEntry + '\n';
  appendFileSync(filePath, line, 'utf8');

  stats.bytesWritten += Buffer.byteLength(line, 'utf8');
}

/**
 * Get writer statistics
 *
 * @returns {Object} Writer stats
 */
export function getWriterStats() {
  return {
    filesWritten: stats.filesWritten,
    bytesWritten: stats.bytesWritten,
    currentFile: currentFilePath,
  };
}

/**
 * Close the writer and flush any pending writes
 *
 * @returns {Promise<void>}
 */
export async function closeWriter() {
  // Reset state
  currentDate = null;
  currentFilePath = null;
  stats = {
    filesWritten: 0,
    bytesWritten: 0,
  };
}
