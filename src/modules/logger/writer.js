/**
 * Logger Writer - File output with daily rotation
 *
 * Writes log entries to files in newline-delimited JSON format.
 * Uses daily rotation: logs/poly-YYYY-MM-DD.log
 * Uses async file operations to avoid blocking the event loop.
 */

import { appendFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';

// Writer state
let currentDate = null;
let currentFilePath = null;
let directoryVerified = false;
let currentDirectory = null;
let stats = {
  filesWritten: 0,
  bytesWritten: 0,
};

// Write queue for async operations
let writeQueue = Promise.resolve();

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
 * Ensure the log directory exists (checked once per directory)
 *
 * @param {string} directory - Log directory path
 * @returns {Promise<void>}
 */
async function ensureDirectory(directory) {
  // Only check once per directory
  if (directoryVerified && currentDirectory === directory) {
    return;
  }

  try {
    await access(directory);
  } catch {
    await mkdir(directory, { recursive: true });
  }

  directoryVerified = true;
  currentDirectory = directory;
}

/**
 * Write a log entry to file (async, non-blocking)
 *
 * Uses a write queue to ensure writes are ordered correctly
 * while not blocking the event loop.
 *
 * @param {string} logEntry - JSON log entry
 * @param {string} directory - Log directory
 */
export function writeToFile(logEntry, directory) {
  const line = logEntry + '\n';
  const byteLength = Buffer.byteLength(line, 'utf8');

  // Queue the async write to maintain order
  writeQueue = writeQueue.then(async () => {
    try {
      await ensureDirectory(directory);
      const filePath = getLogFilePath(directory);
      await appendFile(filePath, line, 'utf8');
      stats.bytesWritten += byteLength;
    } catch (err) {
      // Log to console as fallback, don't throw
      console.error('[logger writer error]', err.message);
    }
  });
}

/**
 * Flush pending writes to disk
 *
 * @returns {Promise<void>}
 */
export async function flushWrites() {
  await writeQueue;
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
  // Wait for pending writes to complete
  await writeQueue;

  // Reset state
  currentDate = null;
  currentFilePath = null;
  directoryVerified = false;
  currentDirectory = null;
  stats = {
    filesWritten: 0,
    bytesWritten: 0,
  };
}
