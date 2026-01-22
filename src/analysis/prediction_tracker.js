/**
 * Prediction Tracker
 * 
 * Logs all predictions made by models/strategies for later analysis.
 * Key for understanding:
 * - Which models are accurate?
 * - When are they accurate (time phases, regimes)?
 * - Are they well-calibrated?
 * - Which features drove predictions?
 */

import { v4 as uuidv4 } from 'uuid';

export class PredictionTracker {
    constructor(db = null) {
        this.db = db;
        this.predictions = [];          // In-memory buffer
        this.pendingOutcomes = new Map(); // epoch -> [prediction_ids]
    }
    
    /**
     * Set database connection
     */
    setDatabase(db) {
        this.db = db;
        this.ensureTable();
    }
    
    /**
     * Ensure predictions table exists
     */
    ensureTable() {
        if (!this.db) return;
        
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS predictions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                prediction_id TEXT UNIQUE,
                timestamp_ms INTEGER NOT NULL,
                crypto TEXT NOT NULL,
                window_epoch INTEGER NOT NULL,
                model_name TEXT NOT NULL,
                model_version TEXT,
                predicted_outcome TEXT,
                predicted_prob_up REAL,
                confidence REAL,
                feature_snapshot TEXT,
                signals_snapshot TEXT,
                time_remaining_sec REAL,
                spot_price REAL,
                up_mid REAL,
                spot_delta_pct REAL,
                actual_outcome TEXT,
                was_correct INTEGER,
                calibration_bucket INTEGER,
                top_feature_1 TEXT,
                top_feature_1_value REAL,
                top_feature_2 TEXT,
                top_feature_2_value REAL,
                top_feature_3 TEXT,
                top_feature_3_value REAL
            )
        `);
        
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pred_model ON predictions(model_name, crypto)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pred_window ON predictions(window_epoch)`);
    }
    
    /**
     * Log a prediction
     * 
     * @param {Object} prediction - The prediction details
     * @returns {string} prediction_id
     */
    logPrediction({
        crypto,
        windowEpoch,
        modelName,
        modelVersion = null,
        predictedOutcome,     // 'up' or 'down'
        predictedProbUp,      // 0-1 probability
        confidence = null,    // Optional confidence score
        features = {},        // Feature values at prediction time
        signals = [],         // [{name, value, weight}, ...]
        tick = {}            // Current tick data
    }) {
        const predictionId = uuidv4();
        const timestamp = Date.now();
        
        // Get top features by absolute value (most influential)
        const sortedFeatures = Object.entries(features)
            .filter(([k, v]) => v !== null && !isNaN(v))
            .map(([k, v]) => ({ name: k, value: Math.abs(v), rawValue: v }))
            .sort((a, b) => b.value - a.value);
        
        const prediction = {
            prediction_id: predictionId,
            timestamp_ms: timestamp,
            crypto,
            window_epoch: windowEpoch,
            model_name: modelName,
            model_version: modelVersion,
            predicted_outcome: predictedOutcome,
            predicted_prob_up: predictedProbUp,
            confidence,
            feature_snapshot: JSON.stringify(features),
            signals_snapshot: JSON.stringify(signals),
            time_remaining_sec: tick.time_remaining_sec,
            spot_price: tick.spot_price,
            up_mid: tick.up_mid,
            spot_delta_pct: tick.spot_delta_pct,
            // Outcome fields - filled later
            actual_outcome: null,
            was_correct: null,
            calibration_bucket: Math.floor(predictedProbUp * 10), // 0-10
            // Top features
            top_feature_1: sortedFeatures[0]?.name,
            top_feature_1_value: sortedFeatures[0]?.rawValue,
            top_feature_2: sortedFeatures[1]?.name,
            top_feature_2_value: sortedFeatures[1]?.rawValue,
            top_feature_3: sortedFeatures[2]?.name,
            top_feature_3_value: sortedFeatures[2]?.rawValue
        };
        
        // Buffer for batch insert
        this.predictions.push(prediction);
        
        // Track for outcome resolution
        if (!this.pendingOutcomes.has(windowEpoch)) {
            this.pendingOutcomes.set(windowEpoch, []);
        }
        this.pendingOutcomes.get(windowEpoch).push(predictionId);
        
        // Flush if buffer is large
        if (this.predictions.length >= 50) {
            this.flush();
        }
        
        return predictionId;
    }
    
    /**
     * Resolve outcomes for a completed window
     */
    resolveWindow(windowEpoch, actualOutcome) {
        const predictionIds = this.pendingOutcomes.get(windowEpoch) || [];
        
        if (this.db && predictionIds.length > 0) {
            const stmt = this.db.prepare(`
                UPDATE predictions 
                SET actual_outcome = ?, 
                    was_correct = CASE WHEN predicted_outcome = ? THEN 1 ELSE 0 END
                WHERE window_epoch = ?
            `);
            
            stmt.run(actualOutcome, actualOutcome, windowEpoch);
        }
        
        // Also update in-memory predictions
        for (const pred of this.predictions) {
            if (pred.window_epoch === windowEpoch && pred.actual_outcome === null) {
                pred.actual_outcome = actualOutcome;
                pred.was_correct = pred.predicted_outcome === actualOutcome ? 1 : 0;
            }
        }
        
        this.pendingOutcomes.delete(windowEpoch);
        
        console.log(`📊 Resolved ${predictionIds.length} predictions for epoch ${windowEpoch}: ${actualOutcome}`);
    }
    
    /**
     * Flush predictions to database
     */
    flush() {
        if (!this.db || this.predictions.length === 0) return;
        
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO predictions (
                prediction_id, timestamp_ms, crypto, window_epoch,
                model_name, model_version, predicted_outcome, predicted_prob_up,
                confidence, feature_snapshot, signals_snapshot,
                time_remaining_sec, spot_price, up_mid, spot_delta_pct,
                actual_outcome, was_correct, calibration_bucket,
                top_feature_1, top_feature_1_value,
                top_feature_2, top_feature_2_value,
                top_feature_3, top_feature_3_value
            ) VALUES (
                @prediction_id, @timestamp_ms, @crypto, @window_epoch,
                @model_name, @model_version, @predicted_outcome, @predicted_prob_up,
                @confidence, @feature_snapshot, @signals_snapshot,
                @time_remaining_sec, @spot_price, @up_mid, @spot_delta_pct,
                @actual_outcome, @was_correct, @calibration_bucket,
                @top_feature_1, @top_feature_1_value,
                @top_feature_2, @top_feature_2_value,
                @top_feature_3, @top_feature_3_value
            )
        `);
        
        const insert = this.db.transaction((preds) => {
            for (const pred of preds) {
                stmt.run(pred);
            }
        });
        
        try {
            insert(this.predictions);
            console.log(`💾 Flushed ${this.predictions.length} predictions to DB`);
            this.predictions = [];
        } catch (error) {
            console.error('❌ Failed to flush predictions:', error.message);
        }
    }
    
    /**
     * Get prediction accuracy summary
     */
    getAccuracySummary(modelName = null, crypto = null, limit = 1000) {
        if (!this.db) return null;
        
        let query = `
            SELECT 
                model_name,
                crypto,
                COUNT(*) as total_predictions,
                SUM(was_correct) as correct_predictions,
                AVG(was_correct) as accuracy,
                AVG(CASE WHEN predicted_outcome = 'up' THEN predicted_prob_up ELSE 1 - predicted_prob_up END) as avg_confidence,
                COUNT(DISTINCT window_epoch) as windows_covered
            FROM predictions 
            WHERE actual_outcome IS NOT NULL
        `;
        
        const params = [];
        if (modelName) {
            query += ` AND model_name = ?`;
            params.push(modelName);
        }
        if (crypto) {
            query += ` AND crypto = ?`;
            params.push(crypto);
        }
        
        query += ` GROUP BY model_name, crypto ORDER BY accuracy DESC LIMIT ?`;
        params.push(limit);
        
        return this.db.prepare(query).all(...params);
    }
    
    /**
     * Get calibration data (for reliability diagrams)
     */
    getCalibrationData(modelName) {
        if (!this.db) return null;
        
        return this.db.prepare(`
            SELECT 
                calibration_bucket,
                COUNT(*) as count,
                AVG(was_correct) as actual_accuracy,
                AVG(predicted_prob_up) as avg_predicted_prob
            FROM predictions 
            WHERE model_name = ? AND actual_outcome IS NOT NULL
            GROUP BY calibration_bucket
            ORDER BY calibration_bucket
        `).all(modelName);
    }
}

// Singleton
let tracker = null;

export function getPredictionTracker() {
    if (!tracker) {
        tracker = new PredictionTracker();
    }
    return tracker;
}

export default PredictionTracker;
