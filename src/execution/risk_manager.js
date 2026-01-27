/**
 * Risk Management Module
 * 
 * CRITICAL COMPONENT - Protects capital through:
 * - Position limits (per trade, per window, total)
 * - Loss limits (daily, hourly, per-trade)
 * - Slippage protection
 * - Kill switches (manual and automatic)
 * - Liquidity checks
 * - Circuit breakers
 * 
 * This module has VETO power over all trades.
 */

import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';

/**
 * Risk violation types
 */
export const RiskViolation = {
    POSITION_LIMIT: 'POSITION_LIMIT',
    LOSS_LIMIT: 'LOSS_LIMIT',
    SLIPPAGE_LIMIT: 'SLIPPAGE_LIMIT',
    LIQUIDITY_CHECK: 'LIQUIDITY_CHECK',
    SPREAD_TOO_WIDE: 'SPREAD_TOO_WIDE',
    KILL_SWITCH: 'KILL_SWITCH',
    CIRCUIT_BREAKER: 'CIRCUIT_BREAKER',
    TIME_RESTRICTION: 'TIME_RESTRICTION',
    MARKET_CLOSED: 'MARKET_CLOSED',
    INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
    COOLDOWN: 'COOLDOWN'
};

/**
 * Default risk parameters - conservative for safety
 */
const DEFAULT_RISK_PARAMS = {
    // Position limits
    maxPositionPerTrade: 1,      // $1 per trade (start small!)
    maxPositionPerWindow: 5,     // $5 max exposure per 15-min window
    maxTotalExposure: 20,        // $20 max total exposure across all positions
    maxOpenOrders: 10,           // Max concurrent open positions (4 cryptos * 2+ overlapping windows)
    
    // Loss limits
    maxLossPerTrade: 1,          // $1 max loss per trade
    maxLossPerHour: 5,           // $5 max loss per hour
    maxLossPerDay: 20,           // $20 max loss per day
    stopTradingAfterConsecutiveLosses: 50,  // Effectively disabled - let strategies run
    
    // Slippage protection
    maxSlippagePercent: 5,       // Max 5% slippage from expected price
    maxSpreadPercent: 10,        // Don't trade if spread > 10%
    
    // Liquidity requirements
    minBidSize: 10,              // Minimum $10 on bid side
    minAskSize: 10,              // Minimum $10 on ask side
    minBookDepth: 50,            // Minimum $50 total book depth
    
    // Time restrictions
    minTimeRemainingSeconds: 5,    // Reduced to 5s to allow Endgame strategies (was 30s)
    maxTimeRemainingSeconds: 870,  // Don't enter in first 30s of window
    
    // Cooldowns
    minSecondsBetweenTrades: 0,    // No global cooldown - strategies trade independently
    cooldownAfterLoss: 5,          // 5 second cooldown after a loss (reduced from 10)
    
    // Circuit breakers
    circuitBreakerLossThreshold: 10, // Trip if $10 lost in circuit breaker window
    circuitBreakerWindowMinutes: 5,  // 5 minute rolling window
    circuitBreakerCooldownMinutes: 15, // 15 min cooldown after circuit breaker
    
    // Kill switch file location
    killSwitchFile: './KILL_SWITCH',
    
    // Emergency contacts (for alerts)
    emergencyAlertEnabled: true
};

/**
 * Main Risk Manager class
 */
export class RiskManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.params = { ...DEFAULT_RISK_PARAMS, ...options };
        this.logger = options.logger || console;
        
        // State tracking
        this.state = {
            // Kill switch
            killSwitchActive: false,
            killSwitchReason: null,
            
            // Circuit breaker
            circuitBreakerTripped: false,
            circuitBreakerTrippedAt: null,
            
            // Loss tracking
            losses: [],                  // Array of { timestamp, amount }
            consecutiveLosses: 0,
            lastTradeTime: null,
            lastLossTime: null,
            
            // Position tracking
            openPositions: new Map(),    // windowKey -> { size, side }
            totalExposure: 0,
            openOrderCount: 0,
            
            // Daily stats
            dayStartTime: this.getStartOfDay(),
            dailyPnL: 0,
            dailyTrades: 0,
            
            // Violations log
            violations: []
        };
        
        // Check for existing kill switch file
        this.checkKillSwitchFile();
        
        // Set up periodic tasks
        this.setupPeriodicTasks();
        
        // Clean up any stale positions from previous runs immediately
        // This prevents order count from being stuck after restart
        setTimeout(() => this.cleanupStalePositions(), 5000);
        
        this.logger.log('[RiskManager] Initialized with params:', this.params);
    }
    
    getStartOfDay() {
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    }
    
    /**
     * Check if kill switch file exists
     */
    checkKillSwitchFile() {
        try {
            if (fs.existsSync(this.params.killSwitchFile)) {
                const content = fs.readFileSync(this.params.killSwitchFile, 'utf8').trim();
                this.activateKillSwitch(`Kill switch file found: ${content || 'no reason provided'}`);
            }
        } catch (error) {
            // File doesn't exist or can't be read - that's fine
        }
    }
    
    /**
     * Setup periodic tasks
     */
    setupPeriodicTasks() {
        // Check kill switch file every 10 seconds
        setInterval(() => this.checkKillSwitchFile(), 10000);
        
        // Reset daily stats at midnight
        setInterval(() => {
            const now = Date.now();
            if (now - this.state.dayStartTime >= 24 * 60 * 60 * 1000) {
                this.resetDailyStats();
            }
        }, 60000);
        
        // Clean up old loss records every minute
        setInterval(() => this.cleanupOldRecords(), 60000);
        
        // Clean up stale positions every 60 seconds (safety mechanism)
        // This prevents order count from getting stuck if window end notifications are missed
        setInterval(() => this.cleanupStalePositions(), 60000);
    }
    
    /**
     * Reset daily statistics
     */
    resetDailyStats() {
        this.logger.log('[RiskManager] Resetting daily stats');
        this.state.dayStartTime = this.getStartOfDay();
        this.state.dailyPnL = 0;
        this.state.dailyTrades = 0;
        this.state.consecutiveLosses = 0;
        this.emit('daily_reset');
    }
    
    /**
     * Clean up old loss records
     */
    cleanupOldRecords() {
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        this.state.losses = this.state.losses.filter(l => l.timestamp > oneHourAgo);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // KILL SWITCH
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Activate kill switch - immediately halts all trading
     */
    activateKillSwitch(reason) {
        this.state.killSwitchActive = true;
        this.state.killSwitchReason = reason;
        
        this.logger.error(`[RiskManager] !!!! KILL SWITCH ACTIVATED !!!! Reason: ${reason}`);
        this.emit('kill_switch', { reason, timestamp: Date.now() });
        
        // Create kill switch file
        try {
            fs.writeFileSync(this.params.killSwitchFile, `${new Date().toISOString()}: ${reason}`);
        } catch (error) {
            // Non-fatal
        }
        
        return this;
    }
    
    /**
     * Deactivate kill switch (manual only)
     */
    deactivateKillSwitch() {
        if (!this.state.killSwitchActive) return this;
        
        this.state.killSwitchActive = false;
        this.state.killSwitchReason = null;
        
        this.logger.log('[RiskManager] Kill switch deactivated');
        this.emit('kill_switch_cleared');
        
        // Remove kill switch file
        try {
            if (fs.existsSync(this.params.killSwitchFile)) {
                fs.unlinkSync(this.params.killSwitchFile);
            }
        } catch (error) {
            // Non-fatal
        }
        
        return this;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CIRCUIT BREAKER
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Check and potentially trip circuit breaker
     */
    checkCircuitBreaker() {
        if (this.state.circuitBreakerTripped) {
            // Check if cooldown has passed
            const cooldownMs = this.params.circuitBreakerCooldownMinutes * 60 * 1000;
            if (Date.now() - this.state.circuitBreakerTrippedAt > cooldownMs) {
                this.resetCircuitBreaker();
            }
            return this.state.circuitBreakerTripped;
        }
        
        // Calculate losses in the circuit breaker window
        const windowStart = Date.now() - (this.params.circuitBreakerWindowMinutes * 60 * 1000);
        const recentLosses = this.state.losses
            .filter(l => l.timestamp > windowStart)
            .reduce((sum, l) => sum + l.amount, 0);
        
        if (recentLosses >= this.params.circuitBreakerLossThreshold) {
            this.tripCircuitBreaker(recentLosses);
            return true;
        }
        
        return false;
    }
    
    /**
     * Trip the circuit breaker
     */
    tripCircuitBreaker(lossAmount) {
        this.state.circuitBreakerTripped = true;
        this.state.circuitBreakerTrippedAt = Date.now();
        
        this.logger.error(`[RiskManager] CIRCUIT BREAKER TRIPPED! Loss: $${lossAmount.toFixed(2)}`);
        this.emit('circuit_breaker', { lossAmount, timestamp: Date.now() });
    }
    
    /**
     * Reset circuit breaker
     */
    resetCircuitBreaker() {
        this.state.circuitBreakerTripped = false;
        this.state.circuitBreakerTrippedAt = null;
        
        this.logger.log('[RiskManager] Circuit breaker reset');
        this.emit('circuit_breaker_reset');
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // PRE-TRADE VALIDATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Main validation method - call before every trade
     * Returns { allowed: boolean, violations: string[] }
     */
    validateTrade(tradeParams, marketState) {
        const violations = [];
        
        // 1. Kill switch check (highest priority)
        if (this.state.killSwitchActive) {
            violations.push({
                type: RiskViolation.KILL_SWITCH,
                message: `Kill switch active: ${this.state.killSwitchReason}`
            });
            return { allowed: false, violations };
        }
        
        // 2. Circuit breaker check
        if (this.checkCircuitBreaker()) {
            const cooldownRemaining = Math.ceil(
                (this.state.circuitBreakerTrippedAt + 
                 this.params.circuitBreakerCooldownMinutes * 60 * 1000 - 
                 Date.now()) / 1000
            );
            violations.push({
                type: RiskViolation.CIRCUIT_BREAKER,
                message: `Circuit breaker active. Cooldown: ${cooldownRemaining}s remaining`
            });
            return { allowed: false, violations };
        }
        
        // 3. Position size limits
        if (tradeParams.size > this.params.maxPositionPerTrade) {
            violations.push({
                type: RiskViolation.POSITION_LIMIT,
                message: `Trade size $${tradeParams.size} exceeds max $${this.params.maxPositionPerTrade}`
            });
        }
        
        // 4. Window exposure limit
        const windowKey = `${tradeParams.crypto}_${tradeParams.windowEpoch}`;
        const windowExposure = this.state.openPositions.get(windowKey)?.size || 0;
        if (windowExposure + tradeParams.size > this.params.maxPositionPerWindow) {
            violations.push({
                type: RiskViolation.POSITION_LIMIT,
                message: `Window exposure $${windowExposure + tradeParams.size} exceeds max $${this.params.maxPositionPerWindow}`
            });
        }
        
        // 5. Total exposure limit
        if (this.state.totalExposure + tradeParams.size > this.params.maxTotalExposure) {
            violations.push({
                type: RiskViolation.POSITION_LIMIT,
                message: `Total exposure $${this.state.totalExposure + tradeParams.size} exceeds max $${this.params.maxTotalExposure}`
            });
        }
        
        // 6. Open orders limit
        if (this.state.openOrderCount >= this.params.maxOpenOrders) {
            violations.push({
                type: RiskViolation.POSITION_LIMIT,
                message: `Open orders ${this.state.openOrderCount} at max ${this.params.maxOpenOrders}`
            });
        }
        
        // 7. Daily loss limit
        if (this.state.dailyPnL <= -this.params.maxLossPerDay) {
            violations.push({
                type: RiskViolation.LOSS_LIMIT,
                message: `Daily loss $${Math.abs(this.state.dailyPnL).toFixed(2)} at limit $${this.params.maxLossPerDay}`
            });
        }
        
        // 8. Hourly loss limit
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        const hourlyLoss = this.state.losses
            .filter(l => l.timestamp > oneHourAgo)
            .reduce((sum, l) => sum + l.amount, 0);
        if (hourlyLoss >= this.params.maxLossPerHour) {
            violations.push({
                type: RiskViolation.LOSS_LIMIT,
                message: `Hourly loss $${hourlyLoss.toFixed(2)} at limit $${this.params.maxLossPerHour}`
            });
        }
        
        // 9. Consecutive losses check
        if (this.state.consecutiveLosses >= this.params.stopTradingAfterConsecutiveLosses) {
            violations.push({
                type: RiskViolation.LOSS_LIMIT,
                message: `${this.state.consecutiveLosses} consecutive losses. Need manual reset.`
            });
        }
        
        // 10. Cooldown check
        if (this.state.lastTradeTime) {
            const timeSinceLastTrade = (Date.now() - this.state.lastTradeTime) / 1000;
            const requiredCooldown = this.state.lastLossTime && 
                this.state.lastLossTime === this.state.lastTradeTime
                ? this.params.cooldownAfterLoss
                : this.params.minSecondsBetweenTrades;
            
            if (timeSinceLastTrade < requiredCooldown) {
                violations.push({
                    type: RiskViolation.COOLDOWN,
                    message: `Cooldown: ${(requiredCooldown - timeSinceLastTrade).toFixed(1)}s remaining`
                });
            }
        }
        
        // Market state validations (if provided)
        if (marketState) {
            // 11. Time restrictions
            if (marketState.timeRemaining !== undefined) {
                if (marketState.timeRemaining < this.params.minTimeRemainingSeconds) {
                    violations.push({
                        type: RiskViolation.TIME_RESTRICTION,
                        message: `Only ${marketState.timeRemaining}s remaining, min ${this.params.minTimeRemainingSeconds}s`
                    });
                }
                if (marketState.timeRemaining > this.params.maxTimeRemainingSeconds) {
                    violations.push({
                        type: RiskViolation.TIME_RESTRICTION,
                        message: `${marketState.timeRemaining}s remaining, wait for market to develop`
                    });
                }
            }
            
            // 12. Spread check
            if (marketState.spread !== undefined && marketState.mid !== undefined) {
                const spreadPct = (marketState.spread / marketState.mid) * 100;
                if (spreadPct > this.params.maxSpreadPercent) {
                    violations.push({
                        type: RiskViolation.SPREAD_TOO_WIDE,
                        message: `Spread ${spreadPct.toFixed(2)}% exceeds max ${this.params.maxSpreadPercent}%`
                    });
                }
            }
            
            // 13. Liquidity check
            if (marketState.bidSize !== undefined && marketState.askSize !== undefined) {
                if (marketState.bidSize < this.params.minBidSize) {
                    violations.push({
                        type: RiskViolation.LIQUIDITY_CHECK,
                        message: `Bid size $${marketState.bidSize.toFixed(2)} below min $${this.params.minBidSize}`
                    });
                }
                if (marketState.askSize < this.params.minAskSize) {
                    violations.push({
                        type: RiskViolation.LIQUIDITY_CHECK,
                        message: `Ask size $${marketState.askSize.toFixed(2)} below min $${this.params.minAskSize}`
                    });
                }
            }
            
            // 14. Slippage estimate check
            if (marketState.expectedSlippage !== undefined) {
                if (marketState.expectedSlippage > this.params.maxSlippagePercent) {
                    violations.push({
                        type: RiskViolation.SLIPPAGE_LIMIT,
                        message: `Expected slippage ${marketState.expectedSlippage.toFixed(2)}% exceeds max ${this.params.maxSlippagePercent}%`
                    });
                }
            }
        }
        
        // Log violations
        if (violations.length > 0) {
            this.logger.warn(`[RiskManager] Trade blocked: ${violations.map(v => v.message).join('; ')}`);
            this.state.violations.push({
                timestamp: Date.now(),
                tradeParams,
                violations
            });
        }
        
        return {
            allowed: violations.length === 0,
            violations
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // POST-TRADE UPDATES
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Record a new trade opening
     */
    recordTradeOpen(trade) {
        const windowKey = `${trade.crypto}_${trade.windowEpoch}`;

        // Check if this is a NEW position or adding to existing
        const existing = this.state.openPositions.get(windowKey);
        const isNewPosition = !existing || existing.size === 0;

        // Update window exposure
        this.state.openPositions.set(windowKey, {
            size: (existing?.size || 0) + trade.size,
            side: trade.side
        });

        // Update total exposure
        this.state.totalExposure += trade.size;
        this.state.lastTradeTime = Date.now();
        this.state.dailyTrades++;

        // Only increment openOrderCount for NEW positions, not additions to existing
        if (isNewPosition) {
            this.state.openOrderCount++;
        }

        this.logger.log(`[RiskManager] Trade opened: $${trade.size} on ${windowKey}. Total exposure: $${this.state.totalExposure}, Open orders: ${this.state.openOrderCount}`);
    }
    
    /**
     * Record a trade closing
     */
    recordTradeClose(trade, pnl) {
        const windowKey = `${trade.crypto}_${trade.windowEpoch}`;
        
        // Update window exposure
        const existing = this.state.openPositions.get(windowKey);
        if (existing) {
            existing.size = Math.max(0, existing.size - trade.size);
            if (existing.size === 0) {
                this.state.openPositions.delete(windowKey);
            }
        }
        
        // Update total exposure
        this.state.totalExposure = Math.max(0, this.state.totalExposure - trade.size);
        this.state.openOrderCount = Math.max(0, this.state.openOrderCount - 1);
        
        // Update P&L tracking
        this.state.dailyPnL += pnl;
        
        if (pnl < 0) {
            this.state.losses.push({
                timestamp: Date.now(),
                amount: Math.abs(pnl)
            });
            this.state.consecutiveLosses++;
            this.state.lastLossTime = Date.now();
            
            // Check circuit breaker
            this.checkCircuitBreaker();
        } else {
            this.state.consecutiveLosses = 0;
        }
        
        this.state.lastTradeTime = Date.now();
        
        this.logger.log(`[RiskManager] Trade closed: PnL $${pnl.toFixed(2)}. Daily PnL: $${this.state.dailyPnL.toFixed(2)}`);
    }
    
    /**
     * Reset consecutive losses counter (manual intervention)
     */
    resetConsecutiveLosses() {
        this.state.consecutiveLosses = 0;
        this.logger.log('[RiskManager] Consecutive losses counter reset');
    }
    
    /**
     * Clean up stale positions from expired windows
     * Called periodically to prevent order count from getting stuck
     */
    cleanupStalePositions() {
        const now = Math.floor(Date.now() / 1000);
        const currentWindowEpoch = Math.floor(now / 900) * 900;
        
        let staleCount = 0;
        const staleKeys = [];
        
        for (const [windowKey, position] of this.state.openPositions.entries()) {
            // Parse epoch from windowKey (format: crypto_epoch)
            const parts = windowKey.split('_');
            const epoch = parseInt(parts[parts.length - 1]);
            
            // If window epoch is older than current window, it's stale
            if (epoch < currentWindowEpoch) {
                staleKeys.push(windowKey);
                staleCount++;
                this.state.totalExposure = Math.max(0, this.state.totalExposure - position.size);
            }
        }
        
        // Remove stale positions
        for (const key of staleKeys) {
            this.state.openPositions.delete(key);
        }
        
        // Reset open order count to match actual open positions
        if (staleCount > 0) {
            this.state.openOrderCount = this.state.openPositions.size;
            this.logger.log(`[RiskManager] Cleaned up ${staleCount} stale positions. Open orders now: ${this.state.openOrderCount}`);
        }
        
        return staleCount;
    }
    
    /**
     * Force reset open order count (emergency use only)
     */
    forceResetOrderCount() {
        const oldCount = this.state.openOrderCount;
        this.state.openOrderCount = 0;
        this.state.openPositions.clear();
        this.state.totalExposure = 0;
        this.logger.log(`[RiskManager] Force reset: openOrderCount ${oldCount} -> 0, cleared all positions`);
        return oldCount;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STATUS & REPORTING
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Get current risk status
     */
    getStatus() {
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        const hourlyLoss = this.state.losses
            .filter(l => l.timestamp > oneHourAgo)
            .reduce((sum, l) => sum + l.amount, 0);
        
        return {
            // Switches
            killSwitchActive: this.state.killSwitchActive,
            killSwitchReason: this.state.killSwitchReason,
            circuitBreakerTripped: this.state.circuitBreakerTripped,
            
            // Exposure
            totalExposure: this.state.totalExposure,
            maxTotalExposure: this.params.maxTotalExposure,
            exposureUtilization: (this.state.totalExposure / this.params.maxTotalExposure) * 100,
            openPositionCount: this.state.openPositions.size,
            openOrderCount: this.state.openOrderCount,
            
            // P&L
            dailyPnL: this.state.dailyPnL,
            dailyPnLLimit: this.params.maxLossPerDay,
            dailyPnLUtilization: Math.abs(this.state.dailyPnL / this.params.maxLossPerDay) * 100,
            hourlyLoss,
            hourlyLossLimit: this.params.maxLossPerHour,
            
            // Streaks
            consecutiveLosses: this.state.consecutiveLosses,
            maxConsecutiveLosses: this.params.stopTradingAfterConsecutiveLosses,
            
            // Activity
            dailyTrades: this.state.dailyTrades,
            lastTradeTime: this.state.lastTradeTime,
            
            // Health
            tradingAllowed: this.isTradingAllowed(),
            
            // Recent violations
            recentViolations: this.state.violations.slice(-10)
        };
    }
    
    /**
     * Quick check if trading is allowed
     */
    isTradingAllowed() {
        return !this.state.killSwitchActive && 
               !this.state.circuitBreakerTripped &&
               this.state.consecutiveLosses < this.params.stopTradingAfterConsecutiveLosses &&
               this.state.dailyPnL > -this.params.maxLossPerDay;
    }
    
    /**
     * Get risk parameters
     */
    getParams() {
        return { ...this.params };
    }
    
    /**
     * Update risk parameters (requires explicit action)
     */
    updateParams(newParams) {
        const oldParams = { ...this.params };
        this.params = { ...this.params, ...newParams };
        
        this.logger.log('[RiskManager] Parameters updated:', {
            old: oldParams,
            new: this.params
        });
        
        this.emit('params_updated', { oldParams, newParams: this.params });
    }
}

export default RiskManager;
