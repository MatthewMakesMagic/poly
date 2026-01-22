/**
 * Trader Insights & Annotation System
 * 
 * Captures intuitive trader observations for later analysis.
 * The goal is to learn from human pattern recognition
 * and eventually quantify it.
 * 
 * Usage:
 * - Log observations as they happen
 * - Tag with sentiment, confidence, and categories
 * - Track which insights led to profitable trades
 */

import { v4 as uuidv4 } from 'uuid';

// Annotation types
export const ANNOTATION_TYPES = {
    MARKET_REGIME: 'market_regime',     // Observations about market state
    TRADE_IDEA: 'trade_idea',           // Specific trade ideas
    OBSERVATION: 'observation',         // General observations
    WARNING: 'warning',                 // Risk/warning signals
    POST_MORTEM: 'post_mortem'          // After-the-fact analysis
};

// Common tags for searchability
export const COMMON_TAGS = [
    'momentum', 'reversal', 'breakout', 'range_bound',
    'high_vol', 'low_vol', 'news', 'manipulation',
    'whale', 'retail_fomo', 'smart_money', 'divergence',
    'support', 'resistance', 'liquidity_grab', 'squeeze'
];

export class TraderInsights {
    constructor(db = null) {
        this.db = db;
        this.annotations = [];
        this.sessionAnnotations = [];   // This session only
    }
    
    /**
     * Set database connection
     */
    setDatabase(db) {
        this.db = db;
        this.ensureTable();
    }
    
    /**
     * Ensure annotations table exists
     */
    ensureTable() {
        if (!this.db) return;
        
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS trader_annotations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                annotation_id TEXT UNIQUE,
                timestamp_ms INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                crypto TEXT,
                window_epoch INTEGER,
                annotation_type TEXT NOT NULL,
                content TEXT NOT NULL,
                sentiment INTEGER,
                confidence INTEGER,
                tags TEXT,
                related_trade_id TEXT,
                outcome_correct INTEGER,
                outcome_notes TEXT,
                
                -- Context at annotation time
                spot_price REAL,
                up_mid REAL,
                time_remaining_sec REAL
            )
        `);
        
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ann_type ON trader_annotations(annotation_type)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ann_crypto ON trader_annotations(crypto)`);
    }
    
    /**
     * Log an annotation
     * 
     * @param {Object} params
     * @returns {string} annotation_id
     */
    annotate({
        type,                   // From ANNOTATION_TYPES
        content,                // Free text description
        crypto = null,          // Optional - which crypto
        windowEpoch = null,     // Optional - which window
        sentiment = 0,          // -2 to +2 (very bearish to very bullish)
        confidence = 3,         // 1-5 confidence in this insight
        tags = [],              // Array of tags
        relatedTradeId = null,  // If this led to a trade
        context = {}            // Current market context
    }) {
        const annotationId = uuidv4();
        const timestamp = Date.now();
        
        const annotation = {
            annotation_id: annotationId,
            timestamp_ms: timestamp,
            crypto,
            window_epoch: windowEpoch,
            annotation_type: type,
            content,
            sentiment: Math.max(-2, Math.min(2, sentiment)),
            confidence: Math.max(1, Math.min(5, confidence)),
            tags: JSON.stringify(tags),
            related_trade_id: relatedTradeId,
            outcome_correct: null,
            outcome_notes: null,
            spot_price: context.spot_price,
            up_mid: context.up_mid,
            time_remaining_sec: context.time_remaining_sec
        };
        
        this.annotations.push(annotation);
        this.sessionAnnotations.push(annotation);
        
        // Persist immediately (annotations are valuable)
        this.persistAnnotation(annotation);
        
        console.log(`📝 Annotation logged: [${type}] ${content.substring(0, 50)}...`);
        
        return annotationId;
    }
    
    /**
     * Shorthand methods for common annotation types
     */
    
    // Log a market regime observation
    regime(content, { crypto = null, sentiment = 0, confidence = 3, tags = [], context = {} } = {}) {
        return this.annotate({
            type: ANNOTATION_TYPES.MARKET_REGIME,
            content,
            crypto,
            sentiment,
            confidence,
            tags: [...tags, 'regime'],
            context
        });
    }
    
    // Log a trade idea
    idea(content, { crypto = null, windowEpoch = null, sentiment, confidence = 3, tags = [], context = {} } = {}) {
        return this.annotate({
            type: ANNOTATION_TYPES.TRADE_IDEA,
            content,
            crypto,
            windowEpoch,
            sentiment,
            confidence,
            tags: [...tags, 'idea'],
            context
        });
    }
    
    // Log a general observation
    observe(content, { crypto = null, sentiment = 0, confidence = 3, tags = [], context = {} } = {}) {
        return this.annotate({
            type: ANNOTATION_TYPES.OBSERVATION,
            content,
            crypto,
            sentiment,
            confidence,
            tags,
            context
        });
    }
    
    // Log a warning
    warn(content, { crypto = null, confidence = 4, tags = [], context = {} } = {}) {
        return this.annotate({
            type: ANNOTATION_TYPES.WARNING,
            content,
            crypto,
            sentiment: -1,  // Warnings are inherently cautious
            confidence,
            tags: [...tags, 'warning'],
            context
        });
    }
    
    // Log a post-mortem analysis
    postMortem(content, { crypto = null, windowEpoch = null, wasCorrect = null, tags = [], context = {} } = {}) {
        const annotationId = this.annotate({
            type: ANNOTATION_TYPES.POST_MORTEM,
            content,
            crypto,
            windowEpoch,
            sentiment: 0,
            confidence: 5,  // Post-mortems are fact-based
            tags: [...tags, 'post_mortem'],
            context
        });
        
        // Update outcome if provided
        if (wasCorrect !== null) {
            this.updateOutcome(annotationId, wasCorrect);
        }
        
        return annotationId;
    }
    
    /**
     * Update annotation outcome
     */
    updateOutcome(annotationId, wasCorrect, notes = null) {
        if (this.db) {
            this.db.prepare(`
                UPDATE trader_annotations 
                SET outcome_correct = ?, outcome_notes = ?
                WHERE annotation_id = ?
            `).run(wasCorrect ? 1 : 0, notes, annotationId);
        }
        
        // Update in memory
        const ann = this.annotations.find(a => a.annotation_id === annotationId);
        if (ann) {
            ann.outcome_correct = wasCorrect ? 1 : 0;
            ann.outcome_notes = notes;
        }
    }
    
    /**
     * Link annotation to a trade
     */
    linkToTrade(annotationId, tradeId) {
        if (this.db) {
            this.db.prepare(`
                UPDATE trader_annotations 
                SET related_trade_id = ?
                WHERE annotation_id = ?
            `).run(tradeId, annotationId);
        }
    }
    
    /**
     * Persist single annotation to database
     */
    persistAnnotation(annotation) {
        if (!this.db) return;
        
        try {
            this.db.prepare(`
                INSERT OR IGNORE INTO trader_annotations (
                    annotation_id, timestamp_ms, crypto, window_epoch,
                    annotation_type, content, sentiment, confidence,
                    tags, related_trade_id, outcome_correct, outcome_notes,
                    spot_price, up_mid, time_remaining_sec
                ) VALUES (
                    @annotation_id, @timestamp_ms, @crypto, @window_epoch,
                    @annotation_type, @content, @sentiment, @confidence,
                    @tags, @related_trade_id, @outcome_correct, @outcome_notes,
                    @spot_price, @up_mid, @time_remaining_sec
                )
            `).run(annotation);
        } catch (error) {
            console.error('❌ Failed to persist annotation:', error.message);
        }
    }
    
    /**
     * Get annotations with outcome analysis
     */
    getInsightAccuracy(type = null, minConfidence = 1) {
        if (!this.db) return null;
        
        let query = `
            SELECT 
                annotation_type,
                COUNT(*) as total,
                SUM(CASE WHEN outcome_correct = 1 THEN 1 ELSE 0 END) as correct,
                AVG(outcome_correct) as accuracy,
                AVG(confidence) as avg_confidence
            FROM trader_annotations
            WHERE outcome_correct IS NOT NULL
            AND confidence >= ?
        `;
        
        const params = [minConfidence];
        
        if (type) {
            query += ` AND annotation_type = ?`;
            params.push(type);
        }
        
        query += ` GROUP BY annotation_type`;
        
        return this.db.prepare(query).all(...params);
    }
    
    /**
     * Get recent annotations for display
     */
    getRecent(limit = 20, crypto = null) {
        if (!this.db) {
            return this.sessionAnnotations.slice(-limit);
        }
        
        let query = `
            SELECT * FROM trader_annotations
            WHERE 1=1
        `;
        
        const params = [];
        if (crypto) {
            query += ` AND crypto = ?`;
            params.push(crypto);
        }
        
        query += ` ORDER BY timestamp_ms DESC LIMIT ?`;
        params.push(limit);
        
        return this.db.prepare(query).all(...params);
    }
    
    /**
     * Search annotations by content or tags
     */
    search(query, { type = null, crypto = null, limit = 50 } = {}) {
        if (!this.db) return [];
        
        let sql = `
            SELECT * FROM trader_annotations
            WHERE (content LIKE ? OR tags LIKE ?)
        `;
        
        const params = [`%${query}%`, `%${query}%`];
        
        if (type) {
            sql += ` AND annotation_type = ?`;
            params.push(type);
        }
        if (crypto) {
            sql += ` AND crypto = ?`;
            params.push(crypto);
        }
        
        sql += ` ORDER BY timestamp_ms DESC LIMIT ?`;
        params.push(limit);
        
        return this.db.prepare(sql).all(...params);
    }
    
    /**
     * Get session summary
     */
    getSessionSummary() {
        const byType = {};
        for (const ann of this.sessionAnnotations) {
            byType[ann.annotation_type] = (byType[ann.annotation_type] || 0) + 1;
        }
        
        return {
            total: this.sessionAnnotations.length,
            byType,
            avgSentiment: this.sessionAnnotations.length > 0
                ? this.sessionAnnotations.reduce((s, a) => s + a.sentiment, 0) / this.sessionAnnotations.length
                : 0,
            avgConfidence: this.sessionAnnotations.length > 0
                ? this.sessionAnnotations.reduce((s, a) => s + a.confidence, 0) / this.sessionAnnotations.length
                : 0
        };
    }
}

// Singleton
let insights = null;

export function getTraderInsights() {
    if (!insights) {
        insights = new TraderInsights();
    }
    return insights;
}

export default TraderInsights;
