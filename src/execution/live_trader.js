/**
 * Live Trader Module
 * 
 * Executes REAL trades for strategies that are enabled via the dashboard.
 * Paper trading continues independently for ALL strategies.
 * 
 * Key features:
 * - Strategies are toggled ON/OFF via dashboard
 * - Only executes trades for enabled strategies
 * - Uses $1 position sizes (configurable)
 * - Global kill switch stops all live trading
 * - Tracks live P&L separately from paper P&L
 */

import EventEmitter from 'events';
import { SDKClient } from './sdk_client.js';
import { RiskManager } from './risk_manager.js';
import { saveLiveTrade, getLiveEnabledStrategies, setLiveStrategyEnabled } from '../db/connection.js';
import { getClaimService } from '../services/claim_service.js';

// Order sides and types for SDK
const Side = { BUY: 'BUY', SELL: 'SELL' };
const OrderType = { FOK: 'FOK', GTC: 'GTC', GTD: 'GTD' };

// Configuration
const CONFIG = {
    POSITION_SIZE: parseFloat(process.env.LIVE_POSITION_SIZE || '1'),
    ENABLED: process.env.LIVE_TRADING_ENABLED === 'true',
};

// Position states - prevents duplicate exit attempts
const PositionState = {
    OPEN: 'open',
    EXITING: 'exiting',
    CLOSED: 'closed'
};

// Take Profit Configuration (defaults)
const TP_CONFIG = {
    DEFAULT_ACTIVATION_PCT: 0.15,    // Activate trailing at +15%
    DEFAULT_TRAIL_PCT: 0.10,         // Trail 10% below HWM
    DEFAULT_FLOOR_PCT: 0.05,         // Never exit below +5% profit
};

// Strategy-specific Take Profit settings
// Format: { activation, trail, floor, fixedTP, trailingSL }
// - activation: % profit to activate trailing TP
// - trail: % drop from peak to trigger trailing TP exit
// - floor: minimum profit to lock in
// - fixedTP: (optional) fixed take profit % - exit immediately when hit
// - trailingSL: (optional) trailing stop loss % from HWM
const TP_STRATEGY_CONFIG = {
    // TEST STRATEGY - full feature test
    'TP_SL_Test': {
        activation: 0.10,    // Trailing TP activates at +10%
        trail: 0.10,         // Exit when drops 10% from peak
        floor: 0.03,         // Minimum +3% profit
        fixedTP: 0.25,       // Fixed TP at +25%
        trailingSL: 0.10     // Trailing SL: exit if drops 10% from HWM (even in loss)
    },

    // SPOTLAG TRAIL - varies by aggressiveness
    'SpotLag_Trail_V1': { activation: 0.20, trail: 0.15, floor: 0.08 },  // Safe: higher activation, wider trail
    'SpotLag_Trail_V2': { activation: 0.15, trail: 0.12, floor: 0.06 },  // Moderate
    'SpotLag_Trail_V3': { activation: 0.15, trail: 0.10, floor: 0.05 },  // Base
    'SpotLag_Trail_V4': { activation: 0.12, trail: 0.08, floor: 0.04 },  // Aggressive: tighter trail

    // PUREPROB - probabilistic strategies
    'PureProb_Base': { activation: 0.15, trail: 0.10, floor: 0.05 },
    'PureProb_Conservative': { activation: 0.20, trail: 0.12, floor: 0.08 },  // More patient
    'PureProb_Aggressive': { activation: 0.10, trail: 0.08, floor: 0.03 },    // Quick profits
    'PureProb_Late': { activation: 0.12, trail: 0.08, floor: 0.04 },          // Late window, tighter

    // LAGPROB - lag + probabilistic
    'LagProb_Base': { activation: 0.15, trail: 0.10, floor: 0.05 },
    'LagProb_Conservative': { activation: 0.20, trail: 0.12, floor: 0.08 },
    'LagProb_Aggressive': { activation: 0.10, trail: 0.08, floor: 0.03 },
    'LagProb_RightSide': { activation: 0.15, trail: 0.10, floor: 0.05 },

    // TIMEAWARE - time-based strategies
    'SpotLag_TimeAware': { activation: 0.15, trail: 0.10, floor: 0.05 },
    'SpotLag_TimeAwareAggro': { activation: 0.10, trail: 0.08, floor: 0.03 },
    'SpotLag_TimeAwareSafe': { activation: 0.20, trail: 0.12, floor: 0.08 },
    'SpotLag_TimeAwareTP': { activation: 0.12, trail: 0.08, floor: 0.04 },   // Built for TP
    'SpotLag_LateOnly': { activation: 0.12, trail: 0.08, floor: 0.04 },      // Late window
    'SpotLag_ProbEdge': { activation: 0.15, trail: 0.10, floor: 0.05 },

    // ENDGAME - near-expiry, hold longer
    'Endgame': { activation: 0.08, trail: 0.05, floor: 0.02 },               // Very tight - near expiry
    'Endgame_Aggressive': { activation: 0.06, trail: 0.04, floor: 0.02 },
    'Endgame_Conservative': { activation: 0.10, trail: 0.06, floor: 0.03 },
    'Endgame_Safe': { activation: 0.05, trail: 0.03, floor: 0.01 },          // Tightest - very near expiry
    'Endgame_Momentum': { activation: 0.08, trail: 0.05, floor: 0.02 },
};

// Stop Loss Configuration
const SL_CONFIG = {
    DEFAULT_STOP_LOSS: 0.15,         // Default 15% stop loss
    MAX_EXIT_ATTEMPTS: 3,            // Retry failed exits
};

/**
 * Live Trader - executes real trades for enabled strategies
 */
export class LiveTrader extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            positionSize: CONFIG.POSITION_SIZE,
            enabled: CONFIG.ENABLED,
            ...options
        };
        
        this.logger = options.logger || console;
        
        // Core components
        this.client = null;
        this.riskManager = new RiskManager({
            logger: this.logger,
            maxPositionPerTrade: 15,  // Allow up to $15 for dynamic sizing (Endgame 10x = $10)
            maxPositionPerWindow: 30, // Allow multiple $2-$10 trades per window (was $5)
            maxTotalExposure: 50,     // Increased for larger Endgame positions
            maxLossPerDay: 30,        // Increased to accommodate larger positions
            minBidSize: 2,            // Lower threshold for thin markets
            minAskSize: 2,            // Lower threshold for thin markets
            stopTradingAfterConsecutiveLosses: 50,  // Effectively disabled - let strategies run, we have other risk controls
        });
        
        // State
        this.isRunning = false;
        this.killSwitchActive = false;
        
        // Enabled strategies (controlled via dashboard)
        this.enabledStrategies = new Set();
        
        // Live positions: strategyName -> crypto -> position
        this.livePositions = {};

        // Pending entries: positionKey -> timestamp
        // Prevents race condition where multiple signals try to enter same position simultaneously
        this.pendingEntries = new Map();

        // Stats
        this.stats = {
            tradesExecuted: 0,
            ordersPlaced: 0,
            ordersFilled: 0,
            ordersRejected: 0,
            grossPnL: 0,
            fees: 0,
            netPnL: 0
        };
        
        // Wire up risk manager events
        this.riskManager.on('kill_switch', (data) => {
            this.logger.error('[LiveTrader] KILL SWITCH TRIGGERED');
            this.killSwitchActive = true;
            this.emit('kill_switch', data);
        });

        // Claim service for tracking and claiming resolved positions
        this.claimService = getClaimService({
            autoClaimEnabled: process.env.AUTO_CLAIM_ENABLED === 'true'
        });
    }
    
    /**
     * Initialize the live trader
     */
    async initialize() {
        // Check env var at RUNTIME, not module load time
        // (Static imports hoist before env var is set in start_collector.js)
        const isEnabled = process.env.LIVE_TRADING_ENABLED === 'true';
        this.options.enabled = isEnabled;

        if (!isEnabled) {
            this.logger.log('[LiveTrader] Live trading is DISABLED (set LIVE_TRADING_ENABLED=true to enable)');
            return false;
        }
        
        try {
            // Initialize Polymarket SDK client (official SDK with proper auth)
            this.client = new SDKClient({ logger: this.logger });
            await this.client.initialize();
            
            // Verify API connection
            try {
                const balance = await this.client.getBalance();
                this.logger.log(`[LiveTrader] API verified - Balance: ${balance?.availableUSDC || 'unknown'} USDC`);
            } catch (verifyError) {
                this.logger.warn(`[LiveTrader] Balance check skipped: ${verifyError.message}`);
            }
            
            // Load enabled strategies from database
            await this.loadEnabledStrategies();

            // Link SDK client to claim service and start it
            this.claimService.setSDKClient(this.client);
            this.claimService.start();

            this.isRunning = true;
            this.logger.log('[LiveTrader] Initialized successfully');
            this.logger.log(`[LiveTrader] Position size: $${this.options.positionSize}`);
            this.logger.log(`[LiveTrader] Enabled strategies: ${this.enabledStrategies.size > 0 ? Array.from(this.enabledStrategies).join(', ') : 'NONE'}`);
            this.logger.log(`[LiveTrader] Auto-claim: ${this.claimService.options.autoClaimEnabled ? 'ENABLED' : 'DISABLED (manual)'}`);

            return true;
        } catch (error) {
            this.logger.error('[LiveTrader] Failed to initialize:', error.message);
            this.isRunning = false;
            return false;
        }
    }
    
    /**
     * Load enabled strategies from database
     */
    async loadEnabledStrategies() {
        try {
            const strategies = await getLiveEnabledStrategies();
            this.enabledStrategies = new Set(strategies);
            this.logger.log(`[LiveTrader] Loaded ${this.enabledStrategies.size} enabled strategies from database`);
        } catch (error) {
            this.logger.warn('[LiveTrader] Could not load enabled strategies:', error.message);
            this.enabledStrategies = new Set();
        }
    }
    
    /**
     * Enable a strategy for live trading
     */
    async enableStrategy(strategyName) {
        this.enabledStrategies.add(strategyName);
        try {
            await setLiveStrategyEnabled(strategyName, true);
            this.logger.log(`[LiveTrader] ✅ Enabled live trading for: ${strategyName}`);
            this.emit('strategy_enabled', { strategy: strategyName });
            return true;
        } catch (error) {
            this.logger.error(`[LiveTrader] Failed to enable ${strategyName}:`, error.message);
            return false;
        }
    }
    
    /**
     * Disable a strategy from live trading
     */
    async disableStrategy(strategyName) {
        this.enabledStrategies.delete(strategyName);
        try {
            await setLiveStrategyEnabled(strategyName, false);
            this.logger.log(`[LiveTrader] ❌ Disabled live trading for: ${strategyName}`);
            this.emit('strategy_disabled', { strategy: strategyName });
            return true;
        } catch (error) {
            this.logger.error(`[LiveTrader] Failed to disable ${strategyName}:`, error.message);
            return false;
        }
    }
    
    /**
     * Check if a strategy is enabled for live trading
     */
    isStrategyEnabled(strategyName) {
        return this.enabledStrategies.has(strategyName);
    }
    
    /**
     * Get all enabled strategies
     */
    getEnabledStrategies() {
        return Array.from(this.enabledStrategies);
    }
    
    /**
     * Monitor live positions for STOP LOSS and TAKE PROFIT
     * This is critical because strategies only see PAPER positions, not LIVE ones
     */
    async monitorPositions(tick, market) {
        if (!this.isRunning || this.killSwitchActive) return;

        const crypto = tick.crypto;
        const windowEpoch = tick.window_epoch;

        // Check all positions for this crypto
        for (const [positionKey, position] of Object.entries(this.livePositions)) {
            if (position.crypto !== crypto) continue;
            if (position.windowEpoch !== windowEpoch) continue;

            // Skip if already exiting (prevents duplicate triggers)
            if (position.state === PositionState.EXITING) {
                continue;
            }

            // Calculate current price and PnL
            const currentPrice = position.tokenSide === 'UP' ? tick.up_bid : tick.down_bid;
            const entryPrice = position.entryPrice;
            const pnlPct = (currentPrice - entryPrice) / entryPrice;

            // Initialize tracking fields if not present
            if (!position.highWaterMark) position.highWaterMark = entryPrice;
            if (!position.state) position.state = PositionState.OPEN;
            if (!position.ticksMonitored) position.ticksMonitored = 0;
            position.ticksMonitored++;

            // ═══════════════════════════════════════════════════════════════
            // TAKE PROFIT LOGIC (check first - we prefer taking profit!)
            // Strategy-specific activation, trail, and floor percentages
            // ═══════════════════════════════════════════════════════════════

            // Get strategy-specific TP config
            const tpConfig = this.getTakeProfitConfig(position.strategyName);

            // Update high water mark (always track, used by trailing SL too)
            if (currentPrice > position.highWaterMark) {
                const oldHWM = position.highWaterMark;
                position.highWaterMark = currentPrice;
                position.peakPnlPct = pnlPct;
                this.logger.log(`[LiveTrader] 📈 NEW HWM: ${position.strategyName} | ${crypto} ${position.tokenSide} | ${oldHWM.toFixed(3)} → ${currentPrice.toFixed(3)} | Peak: +${(pnlPct * 100).toFixed(1)}%`);
            }

            // ─────────────────────────────────────────────────────────────────
            // 1. FIXED TAKE PROFIT - exit immediately if profit exceeds threshold
            // ─────────────────────────────────────────────────────────────────
            if (tpConfig.fixedTP && pnlPct >= tpConfig.fixedTP) {
                this.logger.log(`[LiveTrader] 🎯 FIXED TP HIT: ${position.strategyName} | ${crypto} ${position.tokenSide} | Entry: ${entryPrice.toFixed(3)} | Current: ${currentPrice.toFixed(3)} | Profit: +${(pnlPct * 100).toFixed(1)}% >= +${(tpConfig.fixedTP * 100).toFixed(0)}%`);

                position.state = PositionState.EXITING;
                position.exitReason = 'fixed_take_profit';

                const exitResult = await this.executeExitDirect(position, tick, market, 'fixed_take_profit');
                if (exitResult) {
                    delete this.livePositions[positionKey];
                    this.logger.log(`[LiveTrader] ✅ FIXED TP EXIT COMPLETE: ${positionKey}`);
                } else {
                    position.state = PositionState.OPEN;
                    position.exitAttempts = (position.exitAttempts || 0) + 1;
                    if (position.exitAttempts >= SL_CONFIG.MAX_EXIT_ATTEMPTS) {
                        delete this.livePositions[positionKey];
                    }
                }
                continue;
            }

            // ─────────────────────────────────────────────────────────────────
            // 2. TRAILING TAKE PROFIT - activate at threshold, exit on pullback
            // ─────────────────────────────────────────────────────────────────

            // Check if trailing should activate (strategy-specific threshold)
            if (!position.trailingActive && pnlPct >= tpConfig.activation) {
                position.trailingActive = true;
                position.trailingActivatedAt = currentPrice;
                this.logger.log(`[LiveTrader] 🎯 TRAILING TP ACTIVATED: ${position.strategyName} | ${crypto} ${position.tokenSide} | Entry: ${entryPrice.toFixed(3)} | Current: ${currentPrice.toFixed(3)} | Profit: +${(pnlPct * 100).toFixed(1)}% (threshold: ${(tpConfig.activation * 100)}%)`);
            }

            // Execute trailing stop if active (strategy-specific trail and floor)
            if (position.trailingActive) {
                const trailingStopPrice = position.highWaterMark * (1 - tpConfig.trail);
                const profitFloorPrice = entryPrice * (1 + tpConfig.floor);
                const effectiveStopPrice = Math.max(trailingStopPrice, profitFloorPrice);

                if (currentPrice <= effectiveStopPrice) {
                    const capturedPnlPct = (currentPrice - entryPrice) / entryPrice;
                    const peakCaptured = position.peakPnlPct > 0 ? (capturedPnlPct / position.peakPnlPct * 100) : 100;

                    this.logger.log(`[LiveTrader] 💰 TRAILING TP: ${position.strategyName} | ${crypto} ${position.tokenSide} | Entry: ${entryPrice.toFixed(3)} | Peak: ${position.highWaterMark.toFixed(3)} | Exit: ${currentPrice.toFixed(3)} | Captured: ${peakCaptured.toFixed(0)}% of peak (+${(capturedPnlPct * 100).toFixed(1)}%)`);

                    // Mark as exiting to prevent duplicate triggers
                    position.state = PositionState.EXITING;
                    position.exitReason = 'trailing_stop';

                    const exitResult = await this.executeExitDirect(position, tick, market, 'trailing_stop');

                    if (exitResult) {
                        delete this.livePositions[positionKey];
                        this.logger.log(`[LiveTrader] ✅ TRAILING TP EXIT COMPLETE: ${positionKey}`);
                    } else {
                        // Reset state to try again
                        position.state = PositionState.OPEN;
                        position.exitAttempts = (position.exitAttempts || 0) + 1;
                        if (position.exitAttempts >= SL_CONFIG.MAX_EXIT_ATTEMPTS) {
                            this.logger.error(`[LiveTrader] ❌ GIVING UP on trailing TP exit for ${positionKey}`);
                            delete this.livePositions[positionKey];
                        }
                    }
                    continue; // Move to next position
                }
            }

            // ─────────────────────────────────────────────────────────────────
            // 3. TRAILING STOP LOSS - exit if price drops X% from HWM (even in loss)
            // ─────────────────────────────────────────────────────────────────
            if (tpConfig.trailingSL) {
                const trailingSLPrice = position.highWaterMark * (1 - tpConfig.trailingSL);
                const hwmPnlPct = (position.highWaterMark - entryPrice) / entryPrice;

                if (currentPrice <= trailingSLPrice && !position.trailingActive) {
                    // Only trigger if trailing TP not already active (TP takes priority)
                    const dropFromHWM = (position.highWaterMark - currentPrice) / position.highWaterMark;

                    this.logger.log(`[LiveTrader] 📉 TRAILING SL: ${position.strategyName} | ${crypto} ${position.tokenSide} | Entry: ${entryPrice.toFixed(3)} | HWM: ${position.highWaterMark.toFixed(3)} | Current: ${currentPrice.toFixed(3)} | Drop: -${(dropFromHWM * 100).toFixed(1)}% from HWM | P&L: ${(pnlPct * 100).toFixed(1)}%`);

                    position.state = PositionState.EXITING;
                    position.exitReason = 'trailing_stop_loss';

                    const exitResult = await this.executeExitDirect(position, tick, market, 'trailing_stop_loss');
                    if (exitResult) {
                        delete this.livePositions[positionKey];
                        this.logger.log(`[LiveTrader] ✅ TRAILING SL EXIT COMPLETE: ${positionKey}`);
                    } else {
                        position.state = PositionState.OPEN;
                        position.exitAttempts = (position.exitAttempts || 0) + 1;
                        if (position.exitAttempts >= SL_CONFIG.MAX_EXIT_ATTEMPTS) {
                            delete this.livePositions[positionKey];
                        }
                    }
                    continue;
                }
            }

            // ═══════════════════════════════════════════════════════════════
            // STOP LOSS LOGIC
            // ═══════════════════════════════════════════════════════════════

            const stopLossThreshold = this.getStopLossThreshold(position.strategyName);

            if (pnlPct < -stopLossThreshold) {
                this.logger.log(`[LiveTrader] 🛑 STOP LOSS: ${position.strategyName} | ${crypto} ${position.tokenSide} | Entry: ${entryPrice.toFixed(3)} | Current: ${currentPrice.toFixed(3)} | Loss: ${(pnlPct * 100).toFixed(1)}% < -${(stopLossThreshold * 100).toFixed(0)}%`);

                // Mark as exiting to prevent duplicate triggers
                position.state = PositionState.EXITING;
                position.exitReason = 'stop_loss';

                const exitResult = await this.executeExitDirect(position, tick, market, 'stop_loss');

                if (exitResult) {
                    delete this.livePositions[positionKey];
                    this.logger.log(`[LiveTrader] ✅ STOP LOSS EXIT COMPLETE: ${positionKey}`);
                } else {
                    // Reset state to try again
                    position.state = PositionState.OPEN;
                    position.exitAttempts = (position.exitAttempts || 0) + 1;
                    if (position.exitAttempts >= SL_CONFIG.MAX_EXIT_ATTEMPTS) {
                        this.logger.error(`[LiveTrader] ❌ GIVING UP on stop loss exit for ${positionKey}`);
                        delete this.livePositions[positionKey];
                    }
                }
            }
        }
    }

    /**
     * Execute exit directly (for TP/SL monitoring)
     */
    async executeExitDirect(position, tick, market, reason) {
        try {
            const EXIT_BUFFER = 0.03;
            const rawPrice = position.tokenSide === 'UP' ? tick.up_bid : tick.down_bid;
            const exitPrice = Math.round(Math.max(rawPrice - EXIT_BUFFER, 0.01) * 100) / 100;

            const sharesToSell = position.shares;
            const orderValue = sharesToSell * exitPrice;

            // Check minimum order value
            if (orderValue < 1.0) {
                this.logger.warn(`[LiveTrader] Exit order too small: $${orderValue.toFixed(2)} < $1 minimum`);
                return false;
            }

            this.stats.ordersPlaced++;
            const response = await this.client.sell(position.tokenId, sharesToSell, exitPrice, 'FOK');

            if (response.filled || response.shares > 0) {
                this.stats.ordersFilled++;
                this.stats.tradesExecuted++;

                const exitValue = response.value || (sharesToSell * exitPrice);
                const pnl = exitValue - position.size;
                const fee = exitValue * 0.001;
                const netPnl = pnl - fee;

                this.stats.grossPnL += pnl;
                this.stats.fees += fee;
                this.stats.netPnL += netPnl;

                // Update risk manager
                this.riskManager.recordTradeClose({
                    crypto: position.crypto,
                    windowEpoch: position.windowEpoch,
                    size: position.size
                }, netPnl);

                const pnlStr = `${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`;
                this.logger.log(`[LiveTrader] ✅ EXIT FILLED (${reason}): ${position.strategyName} | ${position.crypto} @ ${(response.avgPrice || exitPrice).toFixed(3)} | P&L: ${pnlStr}`);

                // Save to database
                await saveLiveTrade({
                    type: 'exit',
                    strategy_name: position.strategyName,
                    crypto: position.crypto,
                    side: position.tokenSide.toLowerCase(),
                    window_epoch: position.windowEpoch,
                    price: response.avgPrice || exitPrice,
                    size: position.size,
                    spot_price: tick.spot_price,
                    time_remaining: tick.time_remaining_sec,
                    reason: reason,
                    entry_price: position.entryPrice,
                    pnl: netPnl,
                    timestamp: new Date().toISOString()
                });

                this.emit('trade_exit', {
                    strategyName: position.strategyName,
                    crypto: position.crypto,
                    side: position.tokenSide.toLowerCase(),
                    entryPrice: position.entryPrice,
                    exitPrice: response.avgPrice || exitPrice,
                    pnl: netPnl,
                    reason: reason
                });

                return true;
            } else {
                this.stats.ordersRejected++;
                this.logger.warn(`[LiveTrader] Exit not filled: ${JSON.stringify(response)}`);
                return false;
            }
        } catch (error) {
            this.stats.ordersRejected++;
            this.logger.error(`[LiveTrader] Exit failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Get stop loss threshold for a strategy
     * Different strategies may have different risk tolerances
     */
    /**
     * Get stop loss threshold for a strategy
     */
    getStopLossThreshold(strategyName) {
        const thresholds = {
            // TEST STRATEGY
            'TP_SL_Test': 0.15,

            // SPOTLAG TRAIL
            'SpotLag_Trail_V1': 0.40,  // Safe: 40% stop
            'SpotLag_Trail_V2': 0.30,  // Moderate: 30% stop
            'SpotLag_Trail_V3': 0.25,  // Base: 25% stop
            'SpotLag_Trail_V4': 0.20,  // Aggressive: 20% stop

            // PUREPROB
            'PureProb_Base': 0.25,
            'PureProb_Conservative': 0.20,
            'PureProb_Aggressive': 0.30,
            'PureProb_Late': 0.25,

            // LAGPROB
            'LagProb_Base': 0.25,
            'LagProb_Conservative': 0.20,
            'LagProb_Aggressive': 0.30,
            'LagProb_RightSide': 0.25,

            // TIMEAWARE
            'SpotLag_TimeAware': 0.25,
            'SpotLag_TimeAwareAggro': 0.20,
            'SpotLag_TimeAwareSafe': 0.30,
            'SpotLag_TimeAwareTP': 0.25,
            'SpotLag_LateOnly': 0.25,
            'SpotLag_ProbEdge': 0.25,

            // ENDGAME - wider stops, hold to expiry
            'Endgame': 0.30,
            'Endgame_Aggressive': 0.35,
            'Endgame_Conservative': 0.25,
            'Endgame_Safe': 0.20,
            'Endgame_Momentum': 0.30,
        };

        return thresholds[strategyName] || SL_CONFIG.DEFAULT_STOP_LOSS;
    }

    /**
     * Get take profit config for a strategy
     * Returns { activation, trail, floor }
     */
    getTakeProfitConfig(strategyName) {
        const config = TP_STRATEGY_CONFIG[strategyName];
        if (config) {
            return config;
        }
        // Default config
        return {
            activation: TP_CONFIG.DEFAULT_ACTIVATION_PCT,
            trail: TP_CONFIG.DEFAULT_TRAIL_PCT,
            floor: TP_CONFIG.DEFAULT_FLOOR_PCT
        };
    }

    /**
     * Process a strategy signal - execute if enabled for live
     * Called by ResearchEngine when a strategy signals
     */
    async processSignal(strategyName, signal, tick, market) {
        // Check if live trading is active
        if (!this.isRunning || this.killSwitchActive) {
            return null;
        }

        // Check if this strategy is enabled for live trading
        if (!this.isStrategyEnabled(strategyName)) {
            return null;
        }

        // Only process buy/sell signals
        if (!signal || signal.action === 'hold') {
            return null;
        }

        // CRITICAL: Prevent opposite bets in the same window
        // If we already have a position in this crypto/window, don't open opposite side
        if (signal.action === 'buy') {
            const crypto = tick.crypto;
            const windowEpoch = tick.window_epoch;
            const requestedSide = signal.side?.toUpperCase();

            for (const [key, pos] of Object.entries(this.livePositions)) {
                if (pos.crypto === crypto && pos.windowEpoch === windowEpoch) {
                    if (pos.tokenSide !== requestedSide) {
                        this.logger.log(`[LiveTrader] ⚠️ BLOCKED OPPOSITE BET: ${strategyName} wants ${requestedSide} but already have ${pos.tokenSide} for ${crypto}`);
                        return null;
                    }
                }
            }
        }
        
        const crypto = tick.crypto;
        const windowEpoch = tick.window_epoch;
        const positionKey = `${strategyName}_${crypto}_${windowEpoch}`;

        try {
            if (signal.action === 'buy') {
                // Check if we already have a position
                if (this.livePositions[positionKey]) {
                    return null; // Already in position
                }

                // RACE CONDITION PREVENTION: Check if entry is already being processed
                // This prevents multiple signals from the same strategy+crypto+window
                // from triggering duplicate orders before the first one completes
                if (this.pendingEntries.has(positionKey)) {
                    const pendingTime = Date.now() - this.pendingEntries.get(positionKey);
                    if (pendingTime < 30000) { // 30 second timeout for pending entries
                        this.logger.log(`[LiveTrader] Skipping duplicate signal for ${positionKey} (entry pending for ${(pendingTime/1000).toFixed(1)}s)`);
                        return null;
                    } else {
                        // Stale pending entry, clear it
                        this.pendingEntries.delete(positionKey);
                    }
                }

                // Mark as pending BEFORE executing (prevents race condition)
                this.pendingEntries.set(positionKey, Date.now());

                try {
                    const result = await this.executeEntry(strategyName, signal, tick, market);
                    // If entry failed, clear pending flag
                    if (!result) {
                        this.pendingEntries.delete(positionKey);
                    }
                    return result;
                } catch (error) {
                    this.pendingEntries.delete(positionKey);
                    throw error;
                }
                
            } else if (signal.action === 'sell') {
                // Check if we have a position to exit
                if (!this.livePositions[positionKey]) {
                    return null; // No position to exit
                }
                
                return await this.executeExit(strategyName, signal, tick, market);
            }
        } catch (error) {
            this.logger.error(`[LiveTrader] Error processing signal for ${strategyName}:`, error.message);
            return null;
        }
    }
    
    /**
     * Calculate minimum viable position size
     * Polymarket requires minimum $1 order VALUE (shares * price >= $1)
     */
    calculateMinimumSize(price, requestedSize) {
        const MIN_ORDER_VALUE = 1.0;  // $1 minimum order value
        
        // Calculate shares for requested size
        const requestedShares = requestedSize / price;
        const requestedValue = requestedShares * price;
        
        // If requested value is already >= $1, use it
        if (requestedValue >= MIN_ORDER_VALUE) {
            return requestedSize;
        }
        
        // Otherwise, calculate minimum size to hit $1 value
        // shares * price >= $1, so shares >= 1/price
        const minShares = Math.ceil(MIN_ORDER_VALUE / price);
        const actualSize = minShares * price;
        
        this.logger.log(`[LiveTrader] Adjusted size: $${requestedSize} → $${actualSize.toFixed(2)} (min $1 value requires ${minShares} shares at $${price.toFixed(2)})`);
        
        return actualSize;
    }
    
    /**
     * Execute entry trade
     */
    async executeEntry(strategyName, signal, tick, market) {
        const crypto = tick.crypto;
        const windowEpoch = tick.window_epoch;
        
        // STALENESS CHECK: Don't trade with data older than 5 seconds
        const MAX_TICK_AGE_MS = 5000;
        const tickAge = Date.now() - (tick.timestamp_ms || Date.now());
        if (tickAge > MAX_TICK_AGE_MS) {
            this.logger.warn(`[LiveTrader] SKIPPING: ${crypto} tick is ${(tickAge/1000).toFixed(1)}s stale (max ${MAX_TICK_AGE_MS/1000}s)`);
            return null;
        }
        
        // Determine token side and price first
        const tokenSide = signal.side === 'up' ? 'UP' : 'DOWN';
        const tokenId = tokenSide === 'UP' ? market.upTokenId : market.downTokenId;
        
        // Add 3 cent buffer to cross the spread
        const ENTRY_BUFFER = 0.03;
        const rawPrice = tokenSide === 'UP' ? tick.up_ask : tick.down_ask;
        // Round to 2 decimal places to avoid floating point precision issues
        const entryPrice = Math.round(Math.min(rawPrice + ENTRY_BUFFER, 0.99) * 100) / 100;
        
        // DEBUG: Log actual prices from tick vs what we're using
        this.logger.log(`[LiveTrader] DEBUG PRICES: ${crypto} | up_bid=${tick.up_bid?.toFixed(3)} up_ask=${tick.up_ask?.toFixed(3)} | using=${entryPrice.toFixed(2)}`);

        // Determine requested position size:
        // Strategy signal.size is in "strategy units" (capitalPerTrade = 100)
        // Production uses LIVE_POSITION_SIZE (default $1)
        // Scale factor: $1 / 100 = 0.01
        const STRATEGY_CAPITAL_BASE = 100;  // Strategies are created with capital=100
        const SCALE_FACTOR = this.options.positionSize / STRATEGY_CAPITAL_BASE;
        const MAX_POSITION_SIZE = 15;  // Max $15 per trade for safety

        // Use signal.size (scaled) if provided, otherwise use default
        const requestedSize = signal.size && signal.size > 0
            ? Math.min(signal.size * SCALE_FACTOR, MAX_POSITION_SIZE)
            : this.options.positionSize;

        // Calculate actual position size (ensure minimum 5 shares for Polymarket)
        const actualSize = this.calculateMinimumSize(entryPrice, requestedSize);
        
        // Validate with risk manager
        const validation = this.riskManager.validateTrade({
            crypto,
            windowEpoch,
            size: actualSize,
            side: signal.side
        }, {
            timeRemaining: tick.time_remaining_sec,
            spread: tick.spread,
            mid: tick.up_mid,
            bidSize: tick.up_bid_size,
            askSize: tick.up_ask_size
        });
        
        if (!validation.allowed) {
            this.logger.log(`[LiveTrader] Trade blocked for ${strategyName}: ${validation.violations.map(v => v.message).join('; ')}`);
            return null;
        }
        
        this.logger.log(`[LiveTrader] 📈 EXECUTING LIVE ENTRY: ${strategyName} | ${crypto} | ${tokenSide} | $${actualSize.toFixed(2)} @ ${entryPrice.toFixed(3)}`);
        
        try {
            this.stats.ordersPlaced++;
            
            // Place order using SDK client (FOK with price buffer for fill)
            const response = await this.client.buy(tokenId, actualSize, entryPrice, 'FOK');
            
            // FACTOR 1: SDK reports filled (has tx hash, success, status)
            if (response.filled && response.shares > 0) {
                
                // FACTOR 2: POST-TRADE BALANCE VERIFICATION WITH RETRIES
                // Blockchain state may not propagate immediately - retry with delays
                let balanceVerified = false;
                let postTradeBalance = 0;
                const MAX_RETRIES = 3;
                const RETRY_DELAY_MS = 500;
                
                for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                    try {
                        // Wait before checking (blockchain needs time to update)
                        if (attempt > 1) {
                            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                        }
                        
                        postTradeBalance = await this.client.getBalance(tokenId);
                        
                        if (postTradeBalance > 0) {
                            balanceVerified = true;
                            this.logger.log(`[LiveTrader] ✓ BALANCE VERIFIED (attempt ${attempt}): ${postTradeBalance.toFixed(2)} tokens`);
                            break;
                        } else if (attempt < MAX_RETRIES) {
                            this.logger.log(`[LiveTrader] Balance check ${attempt}/${MAX_RETRIES}: 0 tokens, retrying...`);
                        }
                    } catch (balanceErr) {
                        this.logger.warn(`[LiveTrader] Balance check ${attempt} failed: ${balanceErr.message}`);
                    }
                }
                
                // CRITICAL: If we have a valid tx hash, the trade DID execute on-chain
                // Trust the tx hash even if balance check fails (RPC lag is common)
                if (!balanceVerified && response.tx && response.txHashes?.length > 0) {
                    this.logger.warn(`[LiveTrader] ⚠️ Balance verification failed but TX HASH EXISTS: ${response.tx}`);
                    this.logger.warn(`[LiveTrader] TRUSTING TX HASH - trade executed on-chain, RPC may be lagging`);
                    balanceVerified = true; // Trust the blockchain proof
                }
                
                if (!balanceVerified) {
                    this.logger.error(`[LiveTrader] ❌ TRADE VERIFICATION FAILED - no tx hash and no balance`);
                    this.logger.error(`[LiveTrader] Response: ${JSON.stringify(response)}`);
                    this.stats.ordersRejected++;
                    return null;
                }
                
                this.stats.ordersFilled++;
                
                // Record position
                const positionKey = `${strategyName}_${crypto}_${windowEpoch}`;
                this.livePositions[positionKey] = {
                    strategyName,
                    crypto,
                    windowEpoch,
                    tokenSide,
                    tokenId,
                    entryPrice: response.avgPrice || entryPrice,
                    entryTime: Date.now(),
                    size: response.value || actualSize,
                    shares: response.shares,
                    spotAtEntry: tick.spot_price,
                    orderId: response.orderId,
                    txHash: response.tx,  // Store tx hash for audit
                    balanceVerified: true
                };

                // Clear pending entry now that position is recorded
                this.pendingEntries.delete(positionKey);

                // Update risk manager
                this.riskManager.recordTradeOpen({
                    crypto,
                    windowEpoch,
                    size: actualSize
                });

                // Track position for claiming after resolution
                this.claimService.trackPosition({
                    strategyName,
                    crypto,
                    windowEpoch,
                    side: tokenSide.toLowerCase(),
                    tokenId,
                    shares: response.shares,
                    entryPrice: response.avgPrice || entryPrice,
                    entryTimestamp: Date.now()
                });

                this.logger.log(`[LiveTrader] ✅ ENTRY FILLED & VERIFIED: ${strategyName} | ${crypto} ${tokenSide} @ ${(response.avgPrice || entryPrice).toFixed(3)} (${response.shares} shares) | tx=${response.tx?.slice(0, 10)}...`);
                
                this.emit('trade_entry', {
                    strategyName,
                    crypto,
                    side: signal.side,
                    price: response.avgPrice || entryPrice,
                    size: response.value || actualSize,
                    shares: response.shares
                });
                
                // Save to database with tx_hash for reconciliation
                await this.saveTrade('entry', strategyName, signal, tick, response.avgPrice || entryPrice, null, null, response.tx || response.txHashes?.[0]);
                
                return response;
            } else {
                this.stats.ordersRejected++;
                this.logger.warn(`[LiveTrader] Order not filled: ${JSON.stringify(response)}`);
                return null;
            }
            
        } catch (error) {
            this.stats.ordersRejected++;
            this.logger.error(`[LiveTrader] Entry order failed: ${error.message}`);
            
            // RETRY ONCE at slightly worse price (+2 cents)
            const RETRY_SLIPPAGE = 0.02;
            const MAX_SLIPPAGE = 0.02;  // Don't retry if we'd exceed 2c worse
            // Round to 2 decimal places to avoid floating point precision issues
            const retryPrice = Math.round(Math.min(entryPrice + RETRY_SLIPPAGE, 0.99) * 100) / 100;
            
            if (retryPrice - entryPrice <= MAX_SLIPPAGE) {
                this.logger.log(`[LiveTrader] 🔄 RETRYING at ${retryPrice.toFixed(3)} (+${((retryPrice - entryPrice) * 100).toFixed(1)}c)`);
                
                try {
                    const retryResponse = await this.client.buy(tokenId, actualSize, retryPrice, 'FOK');
                    
                    if (retryResponse.filled && retryResponse.shares > 0) {
                        // Trust TX hash for retries - blockchain proof is sufficient
                        // Balance verification adds latency and RPC lag causes false negatives
                        let balanceVerified = retryResponse.tx && retryResponse.txHashes?.length > 0;
                        
                        if (balanceVerified) {
                            this.logger.log(`[LiveTrader] ✓ RETRY VERIFIED via TX: ${retryResponse.tx?.slice(0, 16)}...`);
                        } else {
                            this.logger.error(`[LiveTrader] ⚠️ RETRY has no TX hash - rejecting`);
                            return null;
                        }
                        
                        this.stats.ordersFilled++;
                        
                        const positionKey = `${strategyName}_${crypto}_${windowEpoch}`;
                        this.livePositions[positionKey] = {
                            strategyName,
                            crypto,
                            windowEpoch,
                            tokenSide,
                            tokenId,
                            entryPrice: retryResponse.avgPrice || retryPrice,
                            entryTime: Date.now(),
                            size: retryResponse.value || actualSize,
                            shares: retryResponse.shares,
                            spotAtEntry: tick.spot_price,
                            orderId: retryResponse.orderId,
                            txHash: retryResponse.tx,
                            wasRetry: true,
                            balanceVerified: true
                        };
                        
                        this.riskManager.recordTradeOpen({ crypto, windowEpoch, size: actualSize });

                        // Track position for claiming after resolution
                        this.claimService.trackPosition({
                            strategyName,
                            crypto,
                            windowEpoch,
                            side: tokenSide.toLowerCase(),
                            tokenId,
                            shares: retryResponse.shares,
                            entryPrice: retryResponse.avgPrice || retryPrice,
                            entryTimestamp: Date.now()
                        });

                        this.logger.log(`[LiveTrader] ✅ RETRY FILLED & VERIFIED: ${strategyName} | ${crypto} ${tokenSide} @ ${(retryResponse.avgPrice || retryPrice).toFixed(3)} | tx=${retryResponse.tx?.slice(0, 10)}...`);
                        
                        this.emit('trade_entry', {
                            strategyName,
                            crypto,
                            side: signal.side,
                            price: retryResponse.avgPrice || retryPrice,
                            size: retryResponse.value || actualSize,
                            shares: retryResponse.shares,
                            wasRetry: true
                        });
                        
                        await this.saveTrade('entry', strategyName, signal, tick, retryResponse.avgPrice || retryPrice, null, null, retryResponse.tx || retryResponse.txHashes?.[0]);
                        return retryResponse;
                    }
                } catch (retryError) {
                    this.logger.error(`[LiveTrader] Retry also failed: ${retryError.message}`);
                }
            } else {
                this.logger.warn(`[LiveTrader] Skipping retry - would exceed 2c slippage`);
            }
            
            // Log the missed opportunity for analysis
            this.emit('trade_missed', {
                strategyName,
                crypto,
                side: signal.side,
                price: entryPrice,
                size: actualSize,
                reason: error.message,
                timestamp: Date.now()
            });
            
            return null;
        }
    }
    
    /**
     * Execute exit trade
     */
    async executeExit(strategyName, signal, tick, market) {
        const crypto = tick.crypto;
        const windowEpoch = tick.window_epoch;
        const positionKey = `${strategyName}_${crypto}_${windowEpoch}`;
        
        const position = this.livePositions[positionKey];
        if (!position) {
            return null;
        }
        
        const tokenId = position.tokenId;
        
        // Subtract 3 cent buffer to ensure sell fills
        const EXIT_BUFFER = 0.03;
        const rawPrice = position.tokenSide === 'UP' ? tick.up_bid : tick.down_bid;
        // Round to 2 decimal places to avoid floating point precision issues
        const price = Math.round(Math.max(rawPrice - EXIT_BUFFER, 0.01) * 100) / 100;
        
        this.logger.log(`[LiveTrader] 📉 EXECUTING LIVE EXIT: ${strategyName} | ${crypto} | ${position.tokenSide} | @ ${price.toFixed(3)}`);
        
        try {
            this.stats.ordersPlaced++;
            
            // Place sell order using SDK client
            const sharesToSell = position.shares || Math.ceil(position.size / position.entryPrice);
            const response = await this.client.sell(tokenId, sharesToSell, price, 'FOK');
            
            if (response.filled || response.shares > 0) {
                this.stats.ordersFilled++;
                this.stats.tradesExecuted++;
                
                // Calculate P&L
                const exitValue = response.value || (sharesToSell * price);
                const entryValue = position.size;
                const pnl = exitValue - entryValue;
                const fee = exitValue * 0.001; // Estimate 0.1% fee
                const netPnl = pnl - fee;
                
                this.stats.grossPnL += pnl;
                this.stats.fees += fee;
                this.stats.netPnL += netPnl;
                
                // Update risk manager
                this.riskManager.recordTradeClose({
                    crypto,
                    windowEpoch,
                    size: position.size
                }, netPnl);
                
                // Remove position
                delete this.livePositions[positionKey];
                
                const pnlStr = `${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`;
                this.logger.log(`[LiveTrader] ✅ EXIT FILLED: ${strategyName} | ${crypto} @ ${(response.avgPrice || price).toFixed(3)} | P&L: ${pnlStr}`);
                
                this.emit('trade_exit', {
                    strategyName,
                    crypto,
                    side: position.tokenSide.toLowerCase(),
                    entryPrice: position.entryPrice,
                    exitPrice: response.avgPrice || price,
                    pnl: netPnl,
                    size: position.size,
                    shares: response.shares
                });
                
                // Save to database
                await this.saveTrade('exit', strategyName, signal, tick, response.avgPrice || price, position, netPnl);
                
                return response;
            } else {
                this.stats.ordersRejected++;
                this.logger.warn(`[LiveTrader] Exit order not filled: ${JSON.stringify(response)}`);
                return null;
            }
            
        } catch (error) {
            this.stats.ordersRejected++;
            this.logger.error(`[LiveTrader] Exit order failed: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Save live trade to database
     * Now includes tx_hash and condition_id for reconciliation with Polymarket
     */
    async saveTrade(type, strategyName, signal, tick, price, position = null, pnl = null, txHash = null) {
        try {
            await saveLiveTrade({
                type,
                strategy_name: strategyName,
                crypto: tick.crypto,
                side: signal.side,
                window_epoch: tick.window_epoch,
                price,
                size: this.options.positionSize,
                spot_price: tick.spot_price,
                time_remaining: tick.time_remaining_sec,
                reason: signal.reason,
                entry_price: position?.entryPrice,
                pnl,
                tx_hash: txHash,
                condition_id: tick.condition_id || null,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            // saveLiveTrade now has retry logic, this is a final fallback log
            this.logger.error('[LiveTrader] Failed to save trade after retries:', error.message);
        }
    }
    
    /**
     * Handle window end - close any open positions
     * CRITICAL: This must save to database so we track live P&L properly
     */
    async onWindowEnd(windowInfo) {
        const { crypto, epoch, outcome } = windowInfo;
        
        // Find positions for this window
        for (const [key, position] of Object.entries(this.livePositions)) {
            if (position.crypto === crypto && position.windowEpoch === epoch) {
                // Position expired at window end - binary resolution
                const won = outcome === position.tokenSide.toLowerCase();
                const finalPrice = won ? 1.0 : 0.0;
                const pnl = (finalPrice - position.entryPrice) * position.size;
                const fee = position.size * 0.001;
                const netPnl = pnl - fee;
                
                this.stats.grossPnL += pnl;
                this.stats.fees += fee;
                this.stats.netPnL += netPnl;
                this.stats.tradesExecuted++;
                
                this.riskManager.recordTradeClose({
                    crypto,
                    windowEpoch: epoch,
                    size: position.size
                }, netPnl);
                
                const pnlStr = `${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`;
                this.logger.log(`[LiveTrader] 🏁 WINDOW END: ${position.strategyName} | ${crypto} | Bet: ${position.tokenSide} | Outcome: ${outcome.toUpperCase()} | ${won ? 'WIN' : 'LOSS'} | P&L: ${pnlStr}`);
                
                // CRITICAL: Save exit to database for tracking
                try {
                    await saveLiveTrade({
                        type: 'exit',
                        strategy_name: position.strategyName,
                        crypto,
                        side: position.tokenSide.toLowerCase(),
                        window_epoch: epoch,
                        price: finalPrice,
                        size: position.size,
                        spot_price: null, // Window already ended
                        time_remaining: 0,
                        reason: 'window_expiry',
                        entry_price: position.entryPrice,
                        pnl: netPnl,
                        outcome: outcome,
                        timestamp: new Date().toISOString()
                    });
                    this.logger.log(`[LiveTrader] ✅ Saved window expiry exit to database`);
                } catch (error) {
                    this.logger.error(`[LiveTrader] ❌ Failed to save window expiry exit: ${error.message}`);
                }
                
                this.emit('trade_exit', {
                    strategyName: position.strategyName,
                    crypto,
                    side: position.tokenSide.toLowerCase(),
                    entryPrice: position.entryPrice,
                    exitPrice: finalPrice,
                    pnl: netPnl,
                    size: position.size,
                    reason: 'window_expiry',
                    outcome: outcome,
                    won: won
                });
                
                delete this.livePositions[key];
            }
        }
    }
    
    /**
     * Kill switch - stop all live trading immediately
     */
    activateKillSwitch(reason = 'manual') {
        this.killSwitchActive = true;
        this.logger.error(`[LiveTrader] 🛑 KILL SWITCH ACTIVATED: ${reason}`);
        this.emit('kill_switch', { reason });
    }
    
    /**
     * Reset kill switch
     */
    resetKillSwitch() {
        this.killSwitchActive = false;
        this.logger.log('[LiveTrader] Kill switch reset');
    }
    
    /**
     * FACTOR 3: RECONCILIATION
     * Compare internal position state vs actual on-chain balances
     * Call periodically or after suspicious activity
     */
    async reconcilePositions() {
        const discrepancies = [];
        const checked = [];
        
        this.logger.log('[LiveTrader] 🔍 Starting position reconciliation...');
        
        // Get all unique token IDs from our positions
        const tokenIds = new Set();
        for (const position of Object.values(this.livePositions)) {
            tokenIds.add(position.tokenId);
        }
        
        // Check actual on-chain balance for each token
        for (const tokenId of tokenIds) {
            try {
                const actualBalance = await this.client.getBalance(tokenId);
                
                // Sum expected balance from our positions
                let expectedBalance = 0;
                for (const position of Object.values(this.livePositions)) {
                    if (position.tokenId === tokenId) {
                        expectedBalance += position.shares || 0;
                    }
                }
                
                const diff = Math.abs(actualBalance - expectedBalance);
                const status = diff < 0.01 ? 'OK' : 'MISMATCH';
                
                checked.push({
                    tokenId: tokenId.slice(0, 16) + '...',
                    expected: expectedBalance,
                    actual: actualBalance,
                    diff,
                    status
                });
                
                if (status === 'MISMATCH') {
                    discrepancies.push({
                        tokenId,
                        expected: expectedBalance,
                        actual: actualBalance,
                        diff
                    });
                    this.logger.error(`[LiveTrader] ❌ RECONCILIATION MISMATCH: ${tokenId.slice(0, 16)}... | Expected: ${expectedBalance} | Actual: ${actualBalance}`);
                }
            } catch (error) {
                this.logger.warn(`[LiveTrader] Failed to check balance for ${tokenId}: ${error.message}`);
            }
        }
        
        // Also check USDC balance
        try {
            const usdcBalance = await this.client.getUSDCBalance();
            checked.push({
                tokenId: 'USDC',
                actual: usdcBalance,
                status: 'INFO'
            });
        } catch (e) {
            // Ignore
        }
        
        const result = {
            timestamp: new Date().toISOString(),
            positionsChecked: Object.keys(this.livePositions).length,
            tokensChecked: tokenIds.size,
            discrepancies: discrepancies.length,
            details: checked
        };
        
        if (discrepancies.length === 0) {
            this.logger.log(`[LiveTrader] ✅ RECONCILIATION OK: ${tokenIds.size} tokens verified`);
        } else {
            this.logger.error(`[LiveTrader] ⚠️ RECONCILIATION FAILED: ${discrepancies.length} discrepancies found!`);
        }
        
        return result;
    }
    
    /**
     * FACTOR 4: EXECUTION QUALITY METRICS
     * Track fill rate, slippage, and other quality metrics
     */
    getExecutionMetrics() {
        const fillRate = this.stats.ordersPlaced > 0 
            ? (this.stats.ordersFilled / this.stats.ordersPlaced * 100).toFixed(1) 
            : 0;
        
        return {
            ordersPlaced: this.stats.ordersPlaced,
            ordersFilled: this.stats.ordersFilled,
            ordersRejected: this.stats.ordersRejected,
            fillRate: `${fillRate}%`,
            tradesExecuted: this.stats.tradesExecuted,
            grossPnL: this.stats.grossPnL.toFixed(2),
            fees: this.stats.fees.toFixed(2),
            netPnL: this.stats.netPnL.toFixed(2),
            avgPnLPerTrade: this.stats.tradesExecuted > 0 
                ? (this.stats.netPnL / this.stats.tradesExecuted).toFixed(2) 
                : '0.00'
        };
    }
    
    /**
     * Get current status
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            enabled: this.options.enabled,
            killSwitchActive: this.killSwitchActive,
            positionSize: this.options.positionSize,
            enabledStrategies: Array.from(this.enabledStrategies),
            livePositions: Object.values(this.livePositions),
            stats: this.stats,
            executionMetrics: this.getExecutionMetrics(),
            riskStatus: this.riskManager.getStatus()
        };
    }
}

// Singleton instance
let liveTraderInstance = null;

export function getLiveTrader() {
    if (!liveTraderInstance) {
        liveTraderInstance = new LiveTrader();
    }
    return liveTraderInstance;
}

export default LiveTrader;
