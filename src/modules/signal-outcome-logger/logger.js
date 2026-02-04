/**
 * Signal Outcome Logger Class
 *
 * Tracks signal outcomes against actual settlement to measure
 * whether the oracle edge hypothesis works.
 *
 * @module modules/signal-outcome-logger/logger
 */

import { SignalOutcomeLoggerError, SignalOutcomeLoggerErrorCodes, BucketType } from './types.js';

/**
 * SignalOutcomeLogger class
 *
 * Logs oracle edge signals and updates them with settlement outcomes.
 * Provides analytics queries to measure signal accuracy and PnL.
 */
export class SignalOutcomeLogger {
  /**
   * Create a new SignalOutcomeLogger
   *
   * @param {Object} options - Logger options
   * @param {Object} options.config - Configuration
   * @param {Object} options.logger - Logger instance
   * @param {Object} options.db - Database module
   */
  constructor({ config, logger, db }) {
    this.config = config;
    this.log = logger;
    this.db = db;
    this.subscriptions = {
      signalGenerator: null,
      settlements: null,
    };
    this.stats = {
      signals_logged: 0,
      outcomes_updated: 0,
      errors: 0,
    };
  }

  /**
   * Log a signal at generation time
   *
   * @param {Object} signal - Signal from oracle-edge-signal module
   * @returns {Promise<number>} Inserted signal ID
   */
  async logSignal(signal) {
    // Validate signal structure
    if (!signal || !signal.window_id) {
      throw new SignalOutcomeLoggerError(
        SignalOutcomeLoggerErrorCodes.INVALID_SIGNAL,
        'Signal must have window_id',
        { signal }
      );
    }

    try {
      const {
        window_id,
        symbol,
        direction,
        confidence,
        token_id,
        side,
        inputs = {},
        generated_at,
      } = signal;

      // Extract inputs with defensive null checks
      const {
        time_remaining_ms = null,
        market_price = null,
        ui_price = null,
        oracle_price = null,
        oracle_staleness_ms = null,
        strike = null,
      } = inputs;

      // V3: Await async db.run() - Use upsert to handle duplicate window_id gracefully
      const result = await this.db.run(`
        INSERT INTO oracle_edge_signals (
          timestamp, window_id, symbol, time_to_expiry_ms, ui_price, oracle_price,
          oracle_staleness_ms, strike, market_token_price, signal_direction,
          confidence, token_id, side, entry_price
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT(window_id) DO UPDATE SET
          timestamp = excluded.timestamp,
          symbol = excluded.symbol,
          time_to_expiry_ms = excluded.time_to_expiry_ms,
          ui_price = excluded.ui_price,
          oracle_price = excluded.oracle_price,
          oracle_staleness_ms = excluded.oracle_staleness_ms,
          strike = excluded.strike,
          market_token_price = excluded.market_token_price,
          signal_direction = excluded.signal_direction,
          confidence = excluded.confidence,
          token_id = excluded.token_id,
          side = excluded.side,
          entry_price = excluded.entry_price,
          updated_at = CURRENT_TIMESTAMP
      `, [
        generated_at || new Date().toISOString(),
        window_id,
        symbol || null,
        time_remaining_ms,
        ui_price,
        oracle_price,
        oracle_staleness_ms,
        strike,
        market_price,  // market_token_price
        direction || null,
        confidence || null,
        token_id || null,
        side || null,
        market_price,  // entry_price (proxy for now)
      ]);

      const signalId = result.lastInsertRowid;

      this.stats.signals_logged++;

      this.log.info('signal_logged', {
        window_id,
        symbol,
        direction,
        signal_id: signalId,
      });

      return signalId;
    } catch (err) {
      this.stats.errors++;
      this.log.error('signal_logging_failed', {
        window_id: signal.window_id,
        error: err.message,
        stack: err.stack,
      });
      throw new SignalOutcomeLoggerError(
        SignalOutcomeLoggerErrorCodes.DATABASE_ERROR,
        `Failed to log signal: ${err.message}`,
        { window_id: signal.window_id, originalError: err.message, originalStack: err.stack }
      );
    }
  }

  /**
   * Update signal record with settlement outcome
   *
   * @param {string} windowId - Window identifier
   * @param {Object} settlementData - Settlement data
   * @param {number} settlementData.final_oracle_price - Oracle price at settlement
   * @param {string} settlementData.settlement_time - Settlement timestamp
   * @returns {Promise<boolean>} True if update succeeded
   */
  async updateOutcome(windowId, settlementData) {
    // Validate inputs
    if (!windowId) {
      throw new SignalOutcomeLoggerError(
        SignalOutcomeLoggerErrorCodes.INVALID_SETTLEMENT,
        'windowId is required',
        { windowId }
      );
    }

    if (!settlementData || settlementData.final_oracle_price === undefined) {
      throw new SignalOutcomeLoggerError(
        SignalOutcomeLoggerErrorCodes.INVALID_SETTLEMENT,
        'settlementData must include final_oracle_price',
        { windowId, settlementData }
      );
    }

    try {
      // V3: Await async db.get() - Get existing signal record
      const signalRecord = await this.db.get(
        'SELECT * FROM oracle_edge_signals WHERE window_id = $1',
        [windowId]
      );

      if (!signalRecord) {
        this.log.debug('settlement_no_signal', {
          window_id: windowId,
          reason: 'no_signal_for_window',
        });
        return false;
      }

      const { final_oracle_price } = settlementData;
      const strike = signalRecord.strike ?? 0.5;

      // Calculate settlement outcome
      // Note: At exact strike (final_oracle_price === strike), outcome is 'down'
      // This matches the binary market convention where 'up' requires strictly greater
      const settlementOutcome = final_oracle_price > strike ? 'up' : 'down';

      // Calculate signal_correct
      const signalCorrect = this.calculateSignalCorrect(
        signalRecord.signal_direction,
        settlementOutcome
      );

      // Calculate PnL
      const pnl = this.calculatePnL(
        signalRecord,
        signalCorrect,
        this.config.defaultPositionSize
      );

      // V3: Await async db.run() - Update the record
      await this.db.run(`
        UPDATE oracle_edge_signals
        SET final_oracle_price = $1,
            settlement_outcome = $2,
            signal_correct = $3,
            exit_price = $4,
            pnl = $5,
            updated_at = CURRENT_TIMESTAMP
        WHERE window_id = $6
      `, [
        final_oracle_price,
        settlementOutcome,
        signalCorrect,
        signalCorrect === 1 ? 1 : 0,  // exit_price: 1 if won, 0 if lost
        pnl,
        windowId,
      ]);

      this.stats.outcomes_updated++;

      this.log.info('outcome_updated', {
        window_id: windowId,
        signal_correct: signalCorrect,
        pnl,
        settlement_outcome: settlementOutcome,
      });

      return true;
    } catch (err) {
      this.stats.errors++;
      this.log.warn('outcome_update_failed', {
        window_id: windowId,
        error: err.message,
        stack: err.stack,
      });
      throw new SignalOutcomeLoggerError(
        SignalOutcomeLoggerErrorCodes.DATABASE_ERROR,
        `Failed to update outcome: ${err.message}`,
        { windowId, originalError: err.message, originalStack: err.stack }
      );
    }
  }

  /**
   * Determine if our signal was correct
   *
   * @param {string} signalDirection - 'fade_up' or 'fade_down'
   * @param {string} settlementOutcome - 'up' or 'down'
   * @returns {number} 1 if correct, 0 if incorrect
   */
  calculateSignalCorrect(signalDirection, settlementOutcome) {
    if (!signalDirection || !settlementOutcome) {
      return 0;
    }

    // FADE_UP means we bet on DOWN (settlement should be 'down')
    if (signalDirection === 'fade_up') {
      return settlementOutcome === 'down' ? 1 : 0;
    }
    // FADE_DOWN means we bet on UP (settlement should be 'up')
    if (signalDirection === 'fade_down') {
      return settlementOutcome === 'up' ? 1 : 0;
    }
    return 0;
  }

  /**
   * Calculate PnL from signal
   *
   * For binary markets:
   * - If correct: We paid entryPrice to win, payout is 1, so profit = 1 - entryPrice
   * - If incorrect: We paid entryPrice and get 0, so loss = -entryPrice
   *
   * @param {Object} signalRecord - Signal record with market_token_price
   * @param {number} signalCorrect - 1 if correct, 0 if not
   * @param {number} positionSize - Position size in tokens
   * @returns {number} PnL in USDC
   */
  calculatePnL(signalRecord, signalCorrect, positionSize = 1) {
    const entryPrice = signalRecord.market_token_price ?? signalRecord.entry_price ?? 0.5;

    if (signalCorrect === 1) {
      // We bought at entryPrice, token settled at 1
      return positionSize * (1 - entryPrice);
    } else {
      // We bought at entryPrice, token settled at 0
      return -positionSize * entryPrice;
    }
  }

  /**
   * Get overall signal statistics
   *
   * V3 Philosophy: Uses async PostgreSQL API.
   *
   * @returns {Promise<Object>} Statistics object
   */
  async getStats() {
    try {
      // V3: Await async db.get()
      const row = await this.db.get(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN settlement_outcome IS NOT NULL THEN 1 ELSE 0 END) as with_outcome,
          SUM(CASE WHEN settlement_outcome IS NULL THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN settlement_outcome IS NOT NULL THEN signal_correct ELSE 0 END) as wins,
          SUM(CASE WHEN settlement_outcome IS NOT NULL THEN pnl ELSE 0 END) as total_pnl,
          AVG(confidence) as avg_confidence
        FROM oracle_edge_signals
      `);

      if (!row || row.total === 0) {
        return {
          total_signals: 0,
          signals_with_outcome: 0,
          pending_outcomes: 0,
          win_rate: 0,
          total_pnl: 0,
          avg_confidence: 0,
        };
      }

      const winRate = row.with_outcome > 0 ? row.wins / row.with_outcome : 0;

      return {
        total_signals: row.total,
        signals_with_outcome: row.with_outcome,
        pending_outcomes: row.pending,
        win_rate: winRate,
        total_pnl: row.total_pnl || 0,
        avg_confidence: row.avg_confidence || 0,
      };
    } catch (err) {
      this.log.error('get_stats_failed', { error: err.message });
      return {
        total_signals: 0,
        signals_with_outcome: 0,
        pending_outcomes: 0,
        win_rate: 0,
        total_pnl: 0,
        avg_confidence: 0,
      };
    }
  }

  /**
   * Get statistics grouped by bucket type
   *
   * V3 Philosophy: Uses async PostgreSQL API.
   *
   * @param {string} bucketType - One of BucketType values
   * @returns {Promise<Array>} Array of bucket statistics (empty array for invalid bucket types)
   */
  async getStatsByBucket(bucketType) {
    // Validate bucket type and log warning for invalid inputs
    const validBucketTypes = Object.values(BucketType);
    if (!validBucketTypes.includes(bucketType)) {
      this.log.warn('invalid_bucket_type', { bucketType, valid: validBucketTypes });
      return [];
    }

    try {
      let query;

      switch (bucketType) {
        case BucketType.TIME_TO_EXPIRY:
          query = `
            SELECT
              CASE
                WHEN time_to_expiry_ms <= 10000 THEN '0-10s'
                WHEN time_to_expiry_ms <= 20000 THEN '10-20s'
                ELSE '20-30s'
              END as bucket,
              COUNT(*) as signals,
              SUM(signal_correct) as wins,
              SUM(pnl) as pnl,
              AVG(confidence) as avg_confidence
            FROM oracle_edge_signals
            WHERE settlement_outcome IS NOT NULL
            GROUP BY bucket
            ORDER BY bucket
          `;
          break;

        case BucketType.STALENESS:
          query = `
            SELECT
              CASE
                WHEN oracle_staleness_ms < 30000 THEN '15-30s'
                WHEN oracle_staleness_ms < 60000 THEN '30-60s'
                ELSE '60s+'
              END as bucket,
              COUNT(*) as signals,
              SUM(signal_correct) as wins,
              SUM(pnl) as pnl,
              AVG(confidence) as avg_confidence
            FROM oracle_edge_signals
            WHERE settlement_outcome IS NOT NULL
            GROUP BY bucket
            ORDER BY bucket
          `;
          break;

        case BucketType.CONFIDENCE:
          query = `
            SELECT
              CASE
                WHEN confidence < 0.6 THEN '0.5-0.6'
                WHEN confidence < 0.7 THEN '0.6-0.7'
                WHEN confidence < 0.8 THEN '0.7-0.8'
                ELSE '0.8+'
              END as bucket,
              COUNT(*) as signals,
              SUM(signal_correct) as wins,
              SUM(pnl) as pnl,
              AVG(confidence) as avg_confidence
            FROM oracle_edge_signals
            WHERE settlement_outcome IS NOT NULL
            GROUP BY bucket
            ORDER BY bucket
          `;
          break;

        case BucketType.SYMBOL:
          query = `
            SELECT
              symbol as bucket,
              COUNT(*) as signals,
              SUM(signal_correct) as wins,
              SUM(pnl) as pnl,
              AVG(confidence) as avg_confidence
            FROM oracle_edge_signals
            WHERE settlement_outcome IS NOT NULL
            GROUP BY symbol
            ORDER BY symbol
          `;
          break;

        default:
          return [];
      }

      // V3: Await async db.all()
      const rows = await this.db.all(query);

      return rows.map(row => ({
        bucket: row.bucket,
        signals: row.signals,
        wins: row.wins || 0,
        win_rate: row.signals > 0 ? (row.wins || 0) / row.signals : 0,
        pnl: row.pnl || 0,
        avg_confidence: row.avg_confidence || 0,
      }));
    } catch (err) {
      this.log.error('get_stats_by_bucket_failed', { bucketType, error: err.message });
      return [];
    }
  }

  /**
   * Get recent signals with outcomes
   *
   * V3 Philosophy: Uses async PostgreSQL API.
   *
   * @param {number} limit - Maximum number of signals to return (1-1000)
   * @returns {Promise<Array>} Array of recent signal records
   */
  async getRecentSignals(limit = 50) {
    // Validate and clamp limit to prevent memory issues
    const maxLimit = 1000;
    const minLimit = 1;
    let safeLimit = Math.floor(Number(limit) || 50);
    safeLimit = Math.max(minLimit, Math.min(maxLimit, safeLimit));

    if (safeLimit !== limit) {
      this.log.debug('limit_clamped', { original: limit, clamped: safeLimit });
    }

    try {
      // V3: Await async db.all()
      const rows = await this.db.all(`
        SELECT *
        FROM oracle_edge_signals
        ORDER BY timestamp DESC
        LIMIT $1
      `, [safeLimit]);

      return rows || [];
    } catch (err) {
      this.log.error('get_recent_signals_failed', { limit: safeLimit, error: err.message });
      return [];
    }
  }

  /**
   * Subscribe to signal generator events
   *
   * @param {Object} signalModule - oracle-edge-signal module
   */
  subscribeToSignals(signalModule) {
    if (!signalModule || typeof signalModule.subscribe !== 'function') {
      this.log.warn('signal_subscription_failed', { reason: 'invalid_module' });
      return;
    }

    try {
      this.subscriptions.signalGenerator = signalModule.subscribe(async (signal) => {
        try {
          await this.logSignal(signal);
        } catch (err) {
          this.log.error('auto_signal_log_failed', {
            window_id: signal?.window_id,
            error: err.message,
          });
        }
      });
      this.log.info('signal_subscription_active');
    } catch (err) {
      this.log.warn('signal_subscription_failed', { error: err.message });
    }
  }

  /**
   * Subscribe to settlement events
   *
   * @param {Function} subscribeToSettlements - Function to subscribe to settlements
   */
  subscribeToSettlements(subscribeToSettlements) {
    if (typeof subscribeToSettlements !== 'function') {
      this.log.warn('settlement_subscription_failed', { reason: 'invalid_subscribe_fn' });
      return;
    }

    try {
      this.subscriptions.settlements = subscribeToSettlements(async (settlementData) => {
        try {
          if (settlementData && settlementData.window_id) {
            await this.updateOutcome(settlementData.window_id, settlementData);
          }
        } catch (err) {
          // Log but don't throw - settlement for unknown windows is expected
          if (err.code !== SignalOutcomeLoggerErrorCodes.SIGNAL_NOT_FOUND) {
            this.log.debug('auto_outcome_update_skipped', {
              window_id: settlementData?.window_id,
              error: err.message,
            });
          }
        }
      });
      this.log.info('settlement_subscription_active');
    } catch (err) {
      this.log.warn('settlement_subscription_failed', { error: err.message });
    }
  }

  /**
   * Cleanup subscriptions
   */
  clearSubscriptions() {
    if (this.subscriptions.signalGenerator) {
      try {
        this.subscriptions.signalGenerator();
      } catch {
        // Ignore cleanup errors
      }
      this.subscriptions.signalGenerator = null;
    }

    if (this.subscriptions.settlements) {
      try {
        this.subscriptions.settlements();
      } catch {
        // Ignore cleanup errors
      }
      this.subscriptions.settlements = null;
    }
  }

  /**
   * Get internal statistics
   *
   * @returns {Object} Internal stats
   */
  getInternalStats() {
    return { ...this.stats };
  }
}
