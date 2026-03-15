/**
 * Parallel Window Evaluator (Performance: Worker Thread Pool)
 *
 * Maintains a pool of worker threads for parallel backtest window evaluation.
 * Each worker loads the strategy once, then processes multiple windows.
 *
 * Performance target: 200 windows x 13K events from ~3 minutes (sequential)
 * down to ~18 seconds with 10 parallel workers.
 *
 * Architecture:
 *   Main thread:  owns window list, distributes work, collects results
 *   Worker threads:  each has own PG connection, strategy instance, MarketState
 *   Communication:  structured messages via parentPort (no SharedArrayBuffer needed)
 */

import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_PATH = join(__dirname, 'backtest-worker-thread.mjs');

// Cap at 10 workers — beyond this, PG connection pool contention hurts more than parallelism helps
const MAX_WORKERS = 10;

/**
 * Create a parallel evaluator with a pool of worker threads.
 *
 * @param {Object} options
 * @param {string} options.strategyName - Strategy name (resolved by factory loadStrategy)
 * @param {Object} options.config - Backtest config passed to each worker
 * @param {number} [options.poolSize] - Number of worker threads (default: min(cpus, 10))
 * @param {Function} [options.onProgress] - Progress callback (completed, total)
 * @returns {Promise<ParallelEvaluator>}
 */
export async function createParallelEvaluator({
  strategyName,
  config,
  poolSize,
  onProgress,
}) {
  const numWorkers = Math.min(poolSize || availableParallelism(), MAX_WORKERS);
  const workers = [];
  const initPromises = [];

  for (let i = 0; i < numWorkers; i++) {
    const worker = new Worker(WORKER_PATH);
    const initPromise = new Promise((resolve, reject) => {
      const onMessage = (msg) => {
        if (msg.type === 'ready') {
          worker.off('message', onMessage);
          worker.off('error', onError);
          resolve();
        } else if (msg.type === 'error' && msg.id === null) {
          worker.off('message', onMessage);
          worker.off('error', onError);
          reject(new Error(msg.error));
        }
      };
      const onError = (err) => {
        worker.off('message', onMessage);
        worker.off('error', onError);
        reject(err);
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
    });

    worker.postMessage({ type: 'init', strategyName, config });
    workers.push(worker);
    initPromises.push(initPromise);
  }

  // Wait for all workers to finish loading strategy
  await Promise.all(initPromises);

  return new ParallelEvaluator(workers, onProgress);
}

/**
 * ParallelEvaluator — distributes window evaluation across a worker pool.
 */
class ParallelEvaluator {
  constructor(workers, onProgress) {
    this._workers = workers;
    this._onProgress = onProgress;
    this._destroyed = false;
  }

  get poolSize() {
    return this._workers.length;
  }

  /**
   * Evaluate windows in parallel across the worker pool.
   * Returns results IN ORDER (matching the input windows array).
   *
   * @param {Object[]} windows - Array of { window_id, ...metadata }
   * @param {Object} [options]
   * @param {Object} [options.strategyParams] - Strategy params override (for sweep grid)
   * @returns {Promise<Object[]>} Array of evaluation results, same order as input
   */
  async evaluateWindows(windows, options = {}) {
    const { strategyParams } = options;
    if (this._destroyed) {
      throw new Error('ParallelEvaluator has been destroyed');
    }

    const total = windows.length;
    const results = new Array(total);
    let completed = 0;
    let nextIdx = 0;

    // Track which workers are free
    const freeWorkers = [...this._workers];
    const pendingByWorker = new Map(); // worker -> { resolve, reject, idx }

    return new Promise((resolveAll, rejectAll) => {
      let failed = false;

      const dispatchNext = () => {
        while (freeWorkers.length > 0 && nextIdx < total) {
          const worker = freeWorkers.shift();
          const idx = nextIdx++;
          const win = windows[idx];
          const id = idx; // Use index as message ID

          const messageHandler = (msg) => {
            if (msg.id !== id) return; // Not our message

            worker.off('message', messageHandler);
            worker.off('error', errorHandler);

            if (msg.type === 'result') {
              results[idx] = msg.result;
              completed++;

              if (this._onProgress) {
                this._onProgress(completed, total);
              }

              freeWorkers.push(worker);

              if (completed === total) {
                resolveAll(results);
              } else {
                dispatchNext();
              }
            } else if (msg.type === 'error') {
              // Retry on another worker if available, otherwise record error
              if (!failed && freeWorkers.length > 0) {
                // Retry: put this window back and try on another worker
                const retryWorker = freeWorkers.shift();
                setupWorkerForWindow(retryWorker, idx, win);
                // Don't return the failed worker to pool
              } else {
                // No retry possible — record null result and continue
                results[idx] = {
                  skipped: true,
                  windowId: win.window_id,
                  reason: `worker_error: ${msg.error}`,
                };
                completed++;

                if (this._onProgress) {
                  this._onProgress(completed, total);
                }

                freeWorkers.push(worker);

                if (completed === total) {
                  resolveAll(results);
                } else {
                  dispatchNext();
                }
              }
            }
          };

          const errorHandler = (err) => {
            worker.off('message', messageHandler);
            worker.off('error', errorHandler);

            // Worker crashed — record error result, do NOT put worker back
            results[idx] = {
              skipped: true,
              windowId: win.window_id,
              reason: `worker_crash: ${err.message}`,
            };
            completed++;

            if (this._onProgress) {
              this._onProgress(completed, total);
            }

            // Remove crashed worker from pool
            const workerIdx = this._workers.indexOf(worker);
            if (workerIdx >= 0) {
              this._workers.splice(workerIdx, 1);
            }

            if (completed === total) {
              resolveAll(results);
            } else if (freeWorkers.length > 0 || this._workers.length > 0) {
              dispatchNext();
            } else {
              // All workers dead
              rejectAll(new Error('All worker threads have crashed'));
            }
          };

          const setupWorkerForWindow = (w, windowIdx, windowData) => {
            const msgHandler = (msg) => {
              if (msg.id !== windowIdx) return;
              w.off('message', msgHandler);
              w.off('error', errHandler);

              if (msg.type === 'result') {
                results[windowIdx] = msg.result;
                completed++;
                if (this._onProgress) this._onProgress(completed, total);
                freeWorkers.push(w);
                if (completed === total) resolveAll(results);
                else dispatchNext();
              } else {
                results[windowIdx] = {
                  skipped: true,
                  windowId: windowData.window_id,
                  reason: `worker_error: ${msg.error}`,
                };
                completed++;
                if (this._onProgress) this._onProgress(completed, total);
                freeWorkers.push(w);
                if (completed === total) resolveAll(results);
                else dispatchNext();
              }
            };
            const errHandler = (err) => {
              w.off('message', msgHandler);
              w.off('error', errHandler);
              results[windowIdx] = {
                skipped: true,
                windowId: windowData.window_id,
                reason: `worker_crash: ${err.message}`,
              };
              completed++;
              if (this._onProgress) this._onProgress(completed, total);
              const wIdx = this._workers.indexOf(w);
              if (wIdx >= 0) this._workers.splice(wIdx, 1);
              if (completed === total) resolveAll(results);
              else dispatchNext();
            };

            w.on('message', msgHandler);
            w.on('error', errHandler);
            w.postMessage({
              type: 'evaluate',
              windowId: windowData.window_id,
              windowMeta: windowData,
              strategyParams,
              id: windowIdx,
            });
          };

          worker.on('message', messageHandler);
          worker.on('error', errorHandler);

          worker.postMessage({
            type: 'evaluate',
            windowId: win.window_id,
            windowMeta: win,
            strategyParams,
            id,
          });
        }
      };

      if (total === 0) {
        resolveAll([]);
        return;
      }

      dispatchNext();
    });
  }

  /**
   * Shutdown all workers gracefully.
   */
  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    const terminations = this._workers.map((worker) => {
      return new Promise((resolve) => {
        worker.once('exit', resolve);
        worker.postMessage({ type: 'shutdown' });
        // Force terminate after 5 seconds if worker doesn't exit gracefully
        setTimeout(() => {
          worker.terminate().then(resolve).catch(resolve);
        }, 5000);
      });
    });

    await Promise.all(terminations);
    this._workers = [];
  }
}

/**
 * Convenience function: evaluate windows in parallel and return results.
 * Creates the pool, evaluates, then destroys the pool.
 *
 * @param {Object} options
 * @param {Object[]} options.windows - Windows to evaluate (with window_id + metadata)
 * @param {string} options.strategyName - Strategy name
 * @param {Object} options.config - Backtest config
 * @param {number} [options.poolSize] - Worker pool size
 * @param {Function} [options.onProgress] - Progress callback
 * @returns {Promise<Object[]>} Evaluation results in order
 */
export async function evaluateWindowsParallel({
  windows,
  strategyName,
  config,
  poolSize,
  onProgress,
}) {
  const evaluator = await createParallelEvaluator({
    strategyName,
    config,
    poolSize,
    onProgress,
  });

  try {
    return await evaluator.evaluateWindows(windows);
  } finally {
    await evaluator.destroy();
  }
}
