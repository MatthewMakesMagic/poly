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
    // Minimum $2 position size to ensure exits work even at max loss
    // At 30% stop loss, exit value = $2 * 0.70 = $1.40 > $1 minimum
    POSITION_SIZE: parseFloat(process.env.LIVE_POSITION_SIZE || '2'),
    ENABLED: process.env.LIVE_TRADING_ENABLED === 'true',
};

// Position states - prevents duplicate exit attempts
const PositionState = {
    OPEN: 'open',
    EXITING: 'exiting',
    CLOSED: 'closed'
};

// ═══════════════════════════════════════════════════════════════════════════════
// TAKE PROFIT / STOP LOSS CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════
//
// SYSTEM OVERVIEW:
// 1. FIXED STOP LOSS - Always active, exits at max loss (safety net)
// 2. AGGRESSIVE LOCK-IN FLOORS - Ratchet up as profit increases, never down
// 3. TRAILING FROM PEAK - Exit when price drops X% from high water mark
// 4. CONTINUOUS MONITORING - Every tick, no silent errors, no skipping
//
// CHECK ORDER (every tick):
// 1. Stop Loss: If loss >= stopLoss% → EXIT (always checked first!)
// 2. Update HWM and peak profit
// 3. Update profit floor based on peak (ratchets up)
// 4. Floor Check: If profit dropped below locked floor → EXIT
// 5. Trailing Check: If price dropped trail% from HWM → EXIT
// ═══════════════════════════════════════════════════════════════════════════════

// Global defaults
const EXIT_CONFIG = {
    // Stop Loss - ALWAYS ACTIVE (safety net)
    // Widened to 50% for binary options - they swing wildly before resolving (Jan 28 2026)
    DEFAULT_STOP_LOSS: 0.50,           // Exit if loss >= 50%

    // Trailing Take Profit
    DEFAULT_TRAIL_PCT: 0.10,           // Exit when price drops 10% from HWM

    // Aggressive Lock-in Floors (ratchet up, never down)
    // Format: [profitThreshold, floorToLock]
    PROFIT_FLOORS: [
        [0.30, 0.20],  // At +30% profit → lock in +20% minimum
        [0.20, 0.12],  // At +20% profit → lock in +12% minimum
        [0.10, 0.05],  // At +10% profit → lock in +5% minimum
    ],

    // Execution
    MAX_EXIT_ATTEMPTS: 5,  // Increased from 3 - give more chances to exit
    EXIT_PRICE_BUFFER: 0.02,           // 2 cents below bid for fills (reduced from 3)
};

// Strategy-specific overrides (optional - defaults work for most)
// All stop losses set to 50% - binary options swing wildly before resolving
const STRATEGY_OVERRIDES = {
    // ═══════════════════════════════════════════════════════════════
    // ENABLED STRATEGIES (explicitly configured)
    // ═══════════════════════════════════════════════════════════════

    // SpotLag_ProbEdge - BEST PERFORMER (+$47)
    'SpotLag_ProbEdge':     { trail: 0.10, stopLoss: 0.50 },

    // Endgame - Near-expiry specialist (tighter trailing)
    'Endgame':              { trail: 0.06, stopLoss: 0.50 },

    // SpotLag_TimeAware - Time-based entry
    'SpotLag_TimeAware':    { trail: 0.10, stopLoss: 0.50 },

    // SpotLag_LateOnly - Late window specialist
    'SpotLag_LateOnly':     { trail: 0.08, stopLoss: 0.50 },

    // PureProb_Late - Late probability edge
    'PureProb_Late':        { trail: 0.10, stopLoss: 0.50 },

    // Trail strategies - need wider stops for BS edge to play out
    'SpotLag_Trail_V1':     { trail: 0.10, stopLoss: 0.50 },
    'SpotLag_Trail_V2':     { trail: 0.10, stopLoss: 0.50 },
    'SpotLag_Trail_V3':     { trail: 0.10, stopLoss: 0.50 },

    // ═══════════════════════════════════════════════════════════════
    // OTHER STRATEGIES (may be disabled but keep config)
    // ═══════════════════════════════════════════════════════════════

    // Endgame variants
    'Endgame_Aggressive':   { trail: 0.05, stopLoss: 0.50 },
    'Endgame_Conservative': { trail: 0.08, stopLoss: 0.50 },
    'Endgame_Safe':         { trail: 0.04, stopLoss: 0.50 },
    'Endgame_Momentum':     { trail: 0.06, stopLoss: 0.50 },

    // Aggressive strategies
    'PureProb_Aggressive':  { trail: 0.08, stopLoss: 0.50 },
    'LagProb_Aggressive':   { trail: 0.08, stopLoss: 0.50 },
    'SpotLag_TimeAwareAggro': { trail: 0.08, stopLoss: 0.50 },

    // Conservative strategies
    'PureProb_Conservative': { trail: 0.12, stopLoss: 0.50 },
    'LagProb_Conservative':  { trail: 0.12, stopLoss: 0.50 },
    'SpotLag_TimeAwareSafe': { trail: 0.12, stopLoss: 0.50 },
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

        // Monitoring failure tracking - triggers kill switch if too many consecutive failures
        this.monitoringFailures = new Map(); // crypto -> failure count
        this.MAX_MONITORING_FAILURES = 10;   // Kill switch after 10 consecutive failures per crypto

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

            // CRITICAL: Restore any open positions from database
            // This prevents orphaned positions after restart/deployment
            await this.restoreOpenPositions();

            // Link SDK client to claim service and start it
            this.claimService.setSDKClient(this.client);
            this.claimService.start();

            this.isRunning = true;
            this.logger.log('[LiveTrader] Initialized successfully');

            // Start the beautiful status dashboard (every 60 seconds)
            this.startStatusDisplay(60000);

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
     * CRITICAL: Restore open positions from database on startup
     * This prevents orphaned positions after restarts/deployments
     */
    async restoreOpenPositions() {
        try {
            const { getOpenPositions } = await import('../db/connection.js');
            const openPositions = await getOpenPositions();

            if (!openPositions || openPositions.length === 0) {
                this.logger.log('[LiveTrader] No open positions to restore');
                return;
            }

            this.logger.log(`[LiveTrader] 🔄 RESTORING ${openPositions.length} OPEN POSITIONS...`);

            for (const pos of openPositions) {
                const positionKey = `${pos.strategy_name}_${pos.crypto}_${pos.window_epoch}`;

                // Only restore if position is from current or recent window
                const now = Math.floor(Date.now() / 1000);
                const currentEpoch = Math.floor(now / 900) * 900;
                const posAge = currentEpoch - pos.window_epoch;

                if (posAge > 900) { // Older than one window (15 min)
                    this.logger.log(`[LiveTrader] ⏭️ Skipping old position: ${positionKey} (age: ${posAge}s)`);
                    continue;
                }

                this.livePositions[positionKey] = {
                    strategyName: pos.strategy_name,
                    crypto: pos.crypto,
                    windowEpoch: pos.window_epoch,
                    tokenSide: pos.side?.toUpperCase(),
                    entryPrice: pos.price,
                    entryTime: new Date(pos.timestamp).getTime(),
                    size: pos.size || 2,
                    shares: Math.ceil((pos.size || 2) / pos.price),
                    restored: true  // Mark as restored for debugging
                };

                this.logger.log(`[LiveTrader] ✅ Restored: ${positionKey} | ${pos.side?.toUpperCase()} @ ${pos.price?.toFixed(3)}`);
            }

            this.logger.log(`[LiveTrader] 🔄 Restoration complete: ${Object.keys(this.livePositions).length} active positions`);
        } catch (error) {
            this.logger.error('[LiveTrader] Failed to restore positions:', error.message);
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
     *
     * CRITICAL: This runs on EVERY tick. No silent errors. No skipping.
     *
     * CHECK ORDER:
     * 1. STOP LOSS - Always first (safety net, catches gaps)
     * 2. Update HWM and peak profit tracking
     * 3. Update profit floor (ratchets up based on peak)
     * 4. FLOOR CHECK - Exit if dropped below locked floor
     * 5. TRAILING CHECK - Exit if price dropped X% from peak
     */
    async monitorPositions(tick, market) {
        if (!this.isRunning || this.killSwitchActive) return;

        const crypto = tick.crypto;
        const windowEpoch = tick.window_epoch;

        // Count positions for this crypto (log only if we have any)
        const cryptoPositions = Object.values(this.livePositions).filter(p => p.crypto === crypto && p.windowEpoch === windowEpoch);
        // Note: Position count logged in periodic status, not every tick

        // Check all positions for this crypto
        for (const [positionKey, position] of Object.entries(this.livePositions)) {
            // Wrap EACH position in try-catch so one failure doesn't kill all monitoring
            try {
                if (position.crypto !== crypto) continue;

                // Skip positions from different windows - they resolve automatically at window end
                if (position.windowEpoch !== windowEpoch) {
                    continue;
                }

                // Skip if already exiting (prevents duplicate triggers)
                // BUT reset if stuck for too long (> 60 seconds)
                if (position.state === PositionState.EXITING) {
                    const stuckTime = Date.now() - (position.exitingStartTime || Date.now());
                    if (stuckTime > 60000) {
                        this.logger.warn(`[LiveTrader] ⚠️ RESETTING STUCK POSITION: ${positionKey} stuck in EXITING for ${(stuckTime/1000).toFixed(0)}s`);
                        position.state = PositionState.OPEN;
                    } else {
                        continue;
                    }
                }

            // CRITICAL FIX: Ensure position has tokenId for exits
            // Restored positions from DB don't have tokenId - look it up from market
            if (!position.tokenId && market) {
                position.tokenId = position.tokenSide === 'UP' ? market.upTokenId : market.downTokenId;
                if (position.tokenId) {
                    this.logger.log(`[LiveTrader] 🔧 Resolved tokenId for restored position: ${positionKey}`);
                }
            }

            // Skip monitoring if we can't exit (no tokenId) - will resolve at expiry
            if (!position.tokenId) {
                if (!position.warnedNoTokenId) {
                    this.logger.warn(`[LiveTrader] ⚠️ Position ${positionKey} has no tokenId - cannot exit, will resolve at expiry`);
                    position.warnedNoTokenId = true;
                }
                continue;
            }

            // CRITICAL: Get LIVE price from order book - this is the source of truth
            // Tick data can be stale or missing, order book is what we'll actually trade at
            let currentPrice = position.tokenSide === 'UP' ? tick.up_bid : tick.down_bid;
            const entryPrice = position.entryPrice;

            // If tick price is invalid, fetch LIVE from order book
            if (!currentPrice || currentPrice <= 0) {
                try {
                    const liveBook = await this.client.getBestPrices(position.tokenId);
                    currentPrice = liveBook.bid;
                    this.logger.log(`[LiveTrader] 📡 LIVE PRICE: ${positionKey} | tick had no price, fetched bid=${currentPrice?.toFixed(3)} from order book`);
                } catch (bookErr) {
                    this.logger.error(`[LiveTrader] ❌ FAILED TO GET LIVE PRICE: ${positionKey} | ${bookErr.message}`);
                    continue;
                }
            }

            // Validate price data
            if (!currentPrice || currentPrice <= 0 || !entryPrice || entryPrice <= 0) {
                this.logger.error(`[LiveTrader] ⚠️ INVALID PRICE DATA: ${positionKey} | current=${currentPrice} entry=${entryPrice}`);
                continue;
            }

            const pnlPct = (currentPrice - entryPrice) / entryPrice;

            // Initialize tracking fields if not present
            if (!position.highWaterMark) position.highWaterMark = entryPrice;
            if (!position.peakPnlPct) position.peakPnlPct = 0;
            if (!position.profitFloor) position.profitFloor = 0;
            if (!position.state) position.state = PositionState.OPEN;
            if (!position.ticksMonitored) position.ticksMonitored = 0;
            position.ticksMonitored++;

            // Get strategy-specific config
            const strategyConfig = STRATEGY_OVERRIDES[position.strategyName] || {};
            const stopLossThreshold = strategyConfig.stopLoss || EXIT_CONFIG.DEFAULT_STOP_LOSS;
            const trailPct = strategyConfig.trail || EXIT_CONFIG.DEFAULT_TRAIL_PCT;

            // ═══════════════════════════════════════════════════════════════
            // 1. STOP LOSS - ALWAYS CHECK FIRST (safety net, catches gaps)
            // ═══════════════════════════════════════════════════════════════

            // Log when approaching stop loss (> 30% loss) or significant profit (> 15%)
            if (pnlPct <= -0.30 || pnlPct >= 0.15) {
                this.logger.log(`[LiveTrader] 🎯 CHECK: ${position.strategyName} | ${crypto} ${position.tokenSide} | Entry: $${entryPrice.toFixed(3)} → Current: $${currentPrice.toFixed(3)} | P&L: ${(pnlPct * 100).toFixed(1)}% | StopLoss: -${(stopLossThreshold * 100).toFixed(0)}% | Trail: ${(trailPct * 100).toFixed(0)}%`);
            }

            if (pnlPct <= -stopLossThreshold) {
                this.logger.log(`[LiveTrader] 🛑 STOP LOSS: ${position.strategyName} | ${crypto} ${position.tokenSide} | Entry: ${entryPrice.toFixed(3)} | Current: ${currentPrice.toFixed(3)} | Loss: ${(pnlPct * 100).toFixed(1)}% <= -${(stopLossThreshold * 100).toFixed(0)}%`);

                position.state = PositionState.EXITING;
                position.exitingStartTime = Date.now();
                position.exitReason = 'stop_loss';

                const exitResult = await this.executeExitDirect(position, tick, market, 'stop_loss');
                if (exitResult) {
                    delete this.livePositions[positionKey];
                    this.logger.log(`[LiveTrader] ✅ STOP LOSS EXIT COMPLETE: ${positionKey}`);
                } else {
                    position.state = PositionState.OPEN;
                    position.exitAttempts = (position.exitAttempts || 0) + 1;
                    if (position.exitAttempts >= EXIT_CONFIG.MAX_EXIT_ATTEMPTS) {
                        this.logger.error(`[LiveTrader] ❌ GIVING UP on stop loss for ${positionKey} after ${EXIT_CONFIG.MAX_EXIT_ATTEMPTS} attempts`);
                        await this.saveAbandonedPosition(position, tick, 'stop_loss_failed');
                        delete this.livePositions[positionKey];
                    }
                }
                continue;
            }

            // ═══════════════════════════════════════════════════════════════
            // 2. UPDATE HIGH WATER MARK AND PEAK PROFIT
            // ═══════════════════════════════════════════════════════════════
            if (currentPrice > position.highWaterMark) {
                const oldHWM = position.highWaterMark;
                position.highWaterMark = currentPrice;
                position.peakPnlPct = pnlPct;
                this.logger.log(`[LiveTrader] 📈 NEW PEAK: ${position.strategyName} | ${crypto} ${position.tokenSide} | Price: ${oldHWM.toFixed(3)} → ${currentPrice.toFixed(3)} | Peak P&L: +${(pnlPct * 100).toFixed(1)}%`);
            }

            // ═══════════════════════════════════════════════════════════════
            // 3. UPDATE PROFIT FLOOR (Aggressive Lock-in - ratchets up, never down)
            // ═══════════════════════════════════════════════════════════════
            for (const [threshold, floor] of EXIT_CONFIG.PROFIT_FLOORS) {
                if (position.peakPnlPct >= threshold && position.profitFloor < floor) {
                    const oldFloor = position.profitFloor;
                    position.profitFloor = floor;
                    this.logger.log(`[LiveTrader] 🔒 FLOOR LOCKED: ${position.strategyName} | ${crypto} ${position.tokenSide} | Peak: +${(position.peakPnlPct * 100).toFixed(1)}% | Floor: +${(oldFloor * 100).toFixed(0)}% → +${(floor * 100).toFixed(0)}%`);
                }
            }

            // ═══════════════════════════════════════════════════════════════
            // 4. FLOOR CHECK - Exit if dropped below locked profit floor
            // ═══════════════════════════════════════════════════════════════
            if (position.profitFloor > 0 && pnlPct <= position.profitFloor) {
                this.logger.log(`[LiveTrader] 💰 FLOOR EXIT: ${position.strategyName} | ${crypto} ${position.tokenSide} | Entry: ${entryPrice.toFixed(3)} | Peak: ${position.highWaterMark.toFixed(3)} | Current: ${currentPrice.toFixed(3)} | P&L: +${(pnlPct * 100).toFixed(1)}% hit floor +${(position.profitFloor * 100).toFixed(0)}%`);

                position.state = PositionState.EXITING;
                position.exitingStartTime = Date.now();
                position.exitReason = `profit_floor_${(position.profitFloor * 100).toFixed(0)}pct`;

                const exitResult = await this.executeExitDirect(position, tick, market, position.exitReason);
                if (exitResult) {
                    delete this.livePositions[positionKey];
                    this.logger.log(`[LiveTrader] ✅ FLOOR EXIT COMPLETE: ${positionKey} | Locked in +${(position.profitFloor * 100).toFixed(0)}% minimum`);
                } else {
                    position.state = PositionState.OPEN;
                    position.exitAttempts = (position.exitAttempts || 0) + 1;
                    if (position.exitAttempts >= EXIT_CONFIG.MAX_EXIT_ATTEMPTS) {
                        this.logger.error(`[LiveTrader] ❌ GIVING UP on floor exit for ${positionKey}`);
                        await this.saveAbandonedPosition(position, tick, 'floor_exit_failed');
                        delete this.livePositions[positionKey];
                    }
                }
                continue;
            }

            // ═══════════════════════════════════════════════════════════════
            // 5. TRAILING CHECK - Exit if price dropped X% from peak
            // ═══════════════════════════════════════════════════════════════
            const dropFromPeak = (position.highWaterMark - currentPrice) / position.highWaterMark;

            // DEBUG: Log every trailing check when there's significant drop (>5% from peak)
            if (dropFromPeak > 0.05) {
                this.logger.log(`[LiveTrader] 🔍 TRAIL CHECK: ${position.strategyName} | ${crypto} ${position.tokenSide} | Drop: ${(dropFromPeak * 100).toFixed(1)}% vs trail=${(trailPct * 100).toFixed(0)}% | P&L: ${(pnlPct * 100).toFixed(1)}% vs floor=${(position.profitFloor * 100).toFixed(0)}% | Would trigger: ${dropFromPeak >= trailPct} && ${pnlPct > position.profitFloor} = ${dropFromPeak >= trailPct && pnlPct > position.profitFloor}`);
            }

            // NOTE: Trailing only triggers if ABOVE floor (floor check takes priority for locking profits)
            // If profitFloor=0 and pnlPct<0, trailing won't trigger - stop loss handles losses
            if (dropFromPeak >= trailPct && pnlPct > position.profitFloor) {
                // Only trail-exit if we're still above the floor (floor takes priority)
                const capturedPct = position.peakPnlPct > 0 ? (pnlPct / position.peakPnlPct * 100) : 100;

                this.logger.log(`[LiveTrader] 📉 TRAILING EXIT: ${position.strategyName} | ${crypto} ${position.tokenSide} | Entry: ${entryPrice.toFixed(3)} | Peak: ${position.highWaterMark.toFixed(3)} | Current: ${currentPrice.toFixed(3)} | Drop: -${(dropFromPeak * 100).toFixed(1)}% from peak | Captured: ${capturedPct.toFixed(0)}% of peak (+${(pnlPct * 100).toFixed(1)}%)`);

                position.state = PositionState.EXITING;
                position.exitingStartTime = Date.now();
                position.exitReason = 'trailing_exit';

                const exitResult = await this.executeExitDirect(position, tick, market, 'trailing_exit');
                if (exitResult) {
                    delete this.livePositions[positionKey];
                    this.logger.log(`[LiveTrader] ✅ TRAILING EXIT COMPLETE: ${positionKey}`);
                } else {
                    position.state = PositionState.OPEN;
                    position.exitAttempts = (position.exitAttempts || 0) + 1;
                    if (position.exitAttempts >= EXIT_CONFIG.MAX_EXIT_ATTEMPTS) {
                        this.logger.error(`[LiveTrader] ❌ GIVING UP on trailing exit for ${positionKey}`);
                        await this.saveAbandonedPosition(position, tick, 'trailing_exit_failed');
                        delete this.livePositions[positionKey];
                    }
                }
                continue;
            }

            // Log periodic status for debugging (every 60 ticks = ~1 minute)
            if (position.ticksMonitored % 60 === 0) {
                const dropPct = dropFromPeak * 100;
                const trailTriggerPct = trailPct * 100;
                this.logger.log(`[LiveTrader] 📊 STATUS: ${position.strategyName} | ${crypto} ${position.tokenSide} | Entry: $${entryPrice.toFixed(3)} → Current: $${currentPrice.toFixed(3)} (HWM: $${position.highWaterMark.toFixed(3)}) | P&L: ${(pnlPct * 100).toFixed(1)}% | Drop: ${dropPct.toFixed(1)}%/${trailTriggerPct.toFixed(0)}% | Floor: +${(position.profitFloor * 100).toFixed(0)}% | StopLoss: -${(stopLossThreshold * 100).toFixed(0)}%`);
            }

            } catch (positionError) {
                // CRITICAL: Log but DON'T let one position's error kill monitoring for others
                this.logger.error(`[LiveTrader] ❌ POSITION MONITORING ERROR: ${positionKey} | ${positionError.message}`);
                this.logger.error(positionError.stack);
                // Reset state in case it got stuck
                if (position.state === PositionState.EXITING) {
                    position.state = PositionState.OPEN;
                }
            }
        }

        // Reset monitoring failure count on successful run
        this.monitoringFailures.delete(crypto);
    }

    /**
     * Save abandoned position to database for tracking
     * Called when we give up on exit after MAX_EXIT_ATTEMPTS
     * The position still exists on Polymarket but we can't exit it
     */
    async saveAbandonedPosition(position, tick, reason) {
        try {
            await saveLiveTrade({
                type: 'abandoned',
                strategy_name: position.strategyName,
                crypto: position.crypto,
                side: position.tokenSide.toLowerCase(),
                window_epoch: position.windowEpoch,
                price: tick ? (position.tokenSide === 'UP' ? tick.up_bid : tick.down_bid) : null,
                size: position.size,
                spot_price: tick?.spot_price,
                time_remaining: tick?.time_remaining_sec,
                reason: reason,
                entry_price: position.entryPrice,
                pnl: null, // Unknown - position still open on Polymarket
                peak_price: position.highWaterMark,  // Track peak for analysis
                timestamp: new Date().toISOString()
            });
            this.logger.error(`[LiveTrader] ⚠️ ABANDONED POSITION SAVED: ${position.strategyName} | ${position.crypto} | Reason: ${reason}`);
        } catch (e) {
            this.logger.error(`[LiveTrader] ❌ FAILED TO SAVE ABANDONED POSITION: ${e.message}`);
        }
    }

    /**
     * Execute exit directly (for TP/SL monitoring)
     */
    async executeExitDirect(position, tick, market, reason) {
        this.logger.log(`[LiveTrader] 🚨 EXECUTING EXIT: ${position.strategyName} | ${position.crypto} ${position.tokenSide} | Reason: ${reason}`);

        try {
            // CRITICAL: Validate we have tokenId before attempting exit
            if (!position.tokenId) {
                this.logger.error(`[LiveTrader] ❌ CANNOT EXIT: No tokenId for ${position.strategyName} ${position.crypto}`);
                return false;
            }

            // CRITICAL: Get LIVE price from order book - this is the actual price we'll trade at
            // Tick data can be stale, order book is source of truth
            let rawPrice = position.tokenSide === 'UP' ? tick?.up_bid : tick?.down_bid;

            // Always fetch fresh from order book for exits - we need accurate price
            try {
                const liveBook = await this.client.getBestPrices(position.tokenId);
                const liveBid = liveBook.bid;
                if (liveBid && liveBid > 0) {
                    // Use live price if available
                    if (rawPrice && Math.abs(liveBid - rawPrice) > 0.02) {
                        this.logger.warn(`[LiveTrader] 📡 PRICE DIFF: tick=${rawPrice?.toFixed(3)} vs live=${liveBid.toFixed(3)} - using LIVE`);
                    }
                    rawPrice = liveBid;
                }
            } catch (bookErr) {
                this.logger.warn(`[LiveTrader] ⚠️ Could not fetch live price, using tick: ${bookErr.message}`);
            }

            this.logger.log(`[LiveTrader] 📊 EXIT DETAILS: rawPrice=${rawPrice?.toFixed(3)} | shares=${position.shares} | tokenId=${position.tokenId?.slice(0, 16)}...`);

            // DYNAMIC EXIT BUFFER: Use smaller buffer when prices are low to ensure exits work
            // At low prices (< 30¢), a 2¢ buffer can make order too small to execute
            // Use 1¢ buffer for prices < 30¢, otherwise 2¢
            const dynamicBuffer = rawPrice < 0.30 ? 0.01 : EXIT_CONFIG.EXIT_PRICE_BUFFER;
            const exitPrice = Math.round(Math.max(rawPrice - dynamicBuffer, 0.01) * 100) / 100;

            const sharesToSell = position.shares;
            const orderValue = sharesToSell * exitPrice;

            // Check minimum order value - Polymarket requires $1 minimum
            // If we can't exit, try with NO buffer as last resort
            if (orderValue < 1.0) {
                const noBufferPrice = Math.round(Math.max(rawPrice, 0.01) * 100) / 100;
                const noBufferValue = sharesToSell * noBufferPrice;

                if (noBufferValue >= 1.0) {
                    // Try exit with no buffer - worse fill but at least we exit
                    this.logger.warn(`[LiveTrader] Using no-buffer exit: $${noBufferValue.toFixed(2)} @ ${noBufferPrice.toFixed(2)}`);
                    const response = await this.client.sell(position.tokenId, sharesToSell, noBufferPrice, 'FOK');
                    if (response.filled) {
                        this.logger.log(`[LiveTrader] ✅ NO-BUFFER EXIT FILLED: ${position.strategyName} | ${position.crypto}`);
                        const positionKey = `${position.strategyName}_${position.crypto}_${position.windowEpoch}`;
                        delete this.livePositions[positionKey];
                        return true;
                    }
                }

                this.logger.warn(`[LiveTrader] Exit order too small: $${orderValue.toFixed(2)} < $1 minimum - letting ride to expiry`);

                // Mark as abandoned - can't exit, will resolve at expiry
                await this.saveAbandonedPosition(position, tick, 'exit_too_small');

                // Remove from active monitoring - it will resolve naturally
                // FIXED: Use correct position key format
                const positionKey = `${position.strategyName}_${position.crypto}_${position.windowEpoch}`;
                delete this.livePositions[positionKey];
                return true;  // Return true so we don't retry forever
            }

            // CRITICAL: Validate shares before attempting sell
            if (!sharesToSell || sharesToSell <= 0 || isNaN(sharesToSell)) {
                this.logger.error(`[LiveTrader] ❌ INVALID SHARES: ${sharesToSell} for ${position.strategyName} ${position.crypto}`);
                return false;
            }

            this.stats.ordersPlaced++;

            // Try FOK first (fastest), then fall back to more aggressive price if it fails
            let response = await this.client.sell(position.tokenId, sharesToSell, exitPrice, 'FOK');

            // If FOK fails, try again with MUCH more aggressive price (sell at 1¢ to guarantee fill)
            if (!response.filled && response.shares === 0) {
                this.logger.warn(`[LiveTrader] ⚠️ FOK FAILED at ${exitPrice.toFixed(2)}, trying aggressive exit at 1¢`);
                const aggressivePrice = 0.01; // Sell at minimum to guarantee fill
                response = await this.client.sell(position.tokenId, sharesToSell, aggressivePrice, 'FOK');

                if (response.filled) {
                    this.logger.log(`[LiveTrader] ✅ AGGRESSIVE EXIT FILLED at ${(response.avgPrice || aggressivePrice).toFixed(3)}`);
                }
            }

            if (response.filled || response.shares > 0) {
                this.stats.ordersFilled++;
                this.stats.tradesExecuted++;

                // CRITICAL FIX: Use actual fill price for exit value calculation
                const actualExitPrice = response.avgPrice || response.priceFilled || exitPrice;
                const actualSharesSold = response.shares || sharesToSell;
                const exitValue = actualSharesSold * actualExitPrice;

                // P&L = what we got - what we paid (cost basis)
                const costBasis = position.costBasis || position.size;
                const pnl = exitValue - costBasis;
                const fee = exitValue * 0.001;
                const netPnl = pnl - fee;

                this.logger.log(`[LiveTrader] 📊 P&L CALC: exitValue=$${exitValue.toFixed(2)} (${actualSharesSold} shares @ $${actualExitPrice.toFixed(3)}) - costBasis=$${costBasis.toFixed(2)} = $${pnl.toFixed(2)} gross, $${netPnl.toFixed(2)} net`);

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
                    peak_price: position.highWaterMark,  // Track peak for analysis
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
     * Uses new EXIT_CONFIG and STRATEGY_OVERRIDES
     */
    getStopLossThreshold(strategyName) {
        const override = STRATEGY_OVERRIDES[strategyName];
        return override?.stopLoss || EXIT_CONFIG.DEFAULT_STOP_LOSS;
    }

    /**
     * Get trailing % for a strategy
     * Uses new EXIT_CONFIG and STRATEGY_OVERRIDES
     */
    getTrailPercent(strategyName) {
        const override = STRATEGY_OVERRIDES[strategyName];
        return override?.trail || EXIT_CONFIG.DEFAULT_TRAIL_PCT;
    }

    /**
     * Get current profit floors config
     */
    getProfitFloors() {
        return EXIT_CONFIG.PROFIT_FLOORS;
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
     *
     * CRITICAL: Polymarket requires minimum $1 order VALUE for both ENTRY and EXIT.
     * If we enter at $1 and the position drops 30% (stop loss), exit value = $0.70 < $1 = REJECTED!
     *
     * Solution: Entry must be large enough that even at maximum loss, exit still >= $1
     * With 30% emergency stop: entry * 0.70 >= $1, so entry >= $1.43
     * With buffer for slippage: minimum $2 entry
     */
    calculateMinimumSize(price, requestedSize) {
        // Minimum entry to ensure exits work even at max loss
        // Emergency stop = 30%, so worst case exit = entry * 0.70
        // For exit >= $1: entry >= $1 / 0.70 = $1.43
        // Add buffer for slippage/spread: $2.00 minimum
        const MIN_ENTRY_VALUE = 2.0;

        // Calculate shares for requested size
        const requestedShares = requestedSize / price;
        const requestedValue = requestedShares * price;

        // If requested value is already >= minimum, use it
        if (requestedValue >= MIN_ENTRY_VALUE) {
            return requestedSize;
        }

        // Otherwise, calculate minimum size to ensure exits work
        // shares * price >= $2, so shares >= 2/price
        const minShares = Math.ceil(MIN_ENTRY_VALUE / price);
        const actualSize = minShares * price;

        this.logger.log(`[LiveTrader] Adjusted size: $${requestedSize.toFixed(2)} → $${actualSize.toFixed(2)} (min $2 entry ensures $1 exit at 50% loss, ${minShares} shares at $${price.toFixed(2)})`);

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

        // ═══════════════════════════════════════════════════════════════════════════
        // CRITICAL SAFETY CHECK 1: MINIMUM ENTRY PRICE
        // Don't buy tokens priced below 5 cents - they're near-certain losers
        // A 1 cent token means the market thinks there's only 1% chance of that outcome
        // ═══════════════════════════════════════════════════════════════════════════
        const MIN_ENTRY_PRICE = 0.05;  // 5 cents = 5% probability minimum
        const tokenSideCheck = signal.side === 'up' ? 'UP' : 'DOWN';
        const rawPriceCheck = tokenSideCheck === 'UP' ? tick.up_ask : tick.down_ask;

        if (rawPriceCheck < MIN_ENTRY_PRICE) {
            this.logger.warn(`[LiveTrader] ⛔ BLOCKED LOW PRICE: ${strategyName} | ${crypto} ${tokenSideCheck} at ${(rawPriceCheck * 100).toFixed(1)}¢ < ${MIN_ENTRY_PRICE * 100}¢ minimum`);
            return null;
        }

        // ═══════════════════════════════════════════════════════════════════════════
        // CRITICAL SAFETY CHECK 2: GLOBAL PER-CRYPTO EXPOSURE LIMIT
        // Prevents multiple strategies from stacking positions on the same crypto
        // Maximum $2 total exposure per crypto per window (across ALL strategies)
        // REDUCED from $5 to $2 on Jan 28 2026 due to low balance
        // ═══════════════════════════════════════════════════════════════════════════
        const MAX_EXPOSURE_PER_CRYPTO = 2.0;  // Maximum $2 per crypto per window

        // Calculate current exposure for this crypto in this window
        let currentCryptoExposure = 0;
        for (const [key, pos] of Object.entries(this.livePositions)) {
            if (pos.crypto === crypto && pos.windowEpoch === windowEpoch) {
                currentCryptoExposure += pos.size || 0;
            }
        }

        if (currentCryptoExposure >= MAX_EXPOSURE_PER_CRYPTO) {
            this.logger.warn(`[LiveTrader] ⛔ BLOCKED EXPOSURE LIMIT: ${strategyName} | ${crypto} already has $${currentCryptoExposure.toFixed(2)} exposure (max $${MAX_EXPOSURE_PER_CRYPTO})`);
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
        let requestedSize = signal.size && signal.size > 0
            ? Math.min(signal.size * SCALE_FACTOR, MAX_POSITION_SIZE)
            : this.options.positionSize;

        // Cap requested size to stay within per-crypto exposure limit
        const remainingExposure = MAX_EXPOSURE_PER_CRYPTO - currentCryptoExposure;
        if (requestedSize > remainingExposure) {
            this.logger.log(`[LiveTrader] Capping size from $${requestedSize.toFixed(2)} to $${remainingExposure.toFixed(2)} (exposure limit)`);
            requestedSize = remainingExposure;
        }

        // If remaining exposure is too small for a viable trade, skip
        const MIN_VIABLE_TRADE = 2.0;  // Minimum $2 to ensure exits work
        if (requestedSize < MIN_VIABLE_TRADE) {
            this.logger.warn(`[LiveTrader] ⛔ BLOCKED INSUFFICIENT ROOM: ${strategyName} | ${crypto} only $${remainingExposure.toFixed(2)} room (need $${MIN_VIABLE_TRADE})`);
            return null;
        }

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
                // Increased retries and delay to handle RPC lag (Jan 29 2026)
                let balanceVerified = false;
                let postTradeBalance = 0;
                const MAX_RETRIES = 5;      // Increased from 3
                const RETRY_DELAY_MS = 800; // Increased from 500
                
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
                
                // Jan 29 2026: Balance is source of truth, BUT if we have strong on-chain proof, trust it
                // TX hash + success=true + status=matched is strong evidence the trade succeeded
                if (!balanceVerified) {
                    const hasStrongProof = response.tx &&
                                          response.txHashes?.length > 0 &&
                                          response.success === true &&
                                          response.status === 'matched';

                    if (hasStrongProof) {
                        // RPC lag - balance check failed but trade clearly succeeded
                        // TRUST THE TX and track the position anyway
                        this.logger.warn(`[LiveTrader] ⚠️ BALANCE LAG: TX=${response.tx?.slice(0,16)}... success=true status=matched BUT balance=0`);
                        this.logger.warn(`[LiveTrader] 🔧 PROCEEDING WITH TX PROOF - position will be tracked despite balance lag`);
                        balanceVerified = true; // Override to proceed
                        this.stats.balanceLagOverrides = (this.stats.balanceLagOverrides || 0) + 1;
                    } else {
                        // Weak proof or no proof - reject
                        this.logger.error(`[LiveTrader] ❌ TRADE VERIFICATION FAILED`);
                        this.logger.error(`[LiveTrader] TX: ${response.tx || 'none'} | Status: ${response.status} | Success: ${response.success}`);
                        this.logger.error(`[LiveTrader] Response: ${JSON.stringify(response)}`);
                        this.stats.txHashNoBalance = (this.stats.txHashNoBalance || 0) + 1;
                        this.stats.ordersRejected++;
                        return null;
                    }
                }
                
                this.stats.ordersFilled++;
                
                // Record position with VALIDATED fields
                const positionKey = `${strategyName}_${crypto}_${windowEpoch}`;
                const finalEntryPrice = response.avgPrice || entryPrice;

                // CRITICAL FIX: Use SDK's shares if available, otherwise calculate from REQUESTED price
                // Don't use finalEntryPrice (fill price) for recalculation - that changes the shares count
                const finalShares = response.shares || Math.ceil(actualSize / entryPrice);

                // CRITICAL: Validate all required fields before storing
                if (!tokenId || !finalEntryPrice || finalEntryPrice <= 0 || !finalShares || finalShares <= 0) {
                    this.logger.error(`[LiveTrader] ❌ INVALID POSITION DATA: tokenId=${!!tokenId} price=${finalEntryPrice} shares=${finalShares}`);
                    this.stats.ordersRejected++;
                    return null;
                }

                // Calculate actual cost paid (cost basis for P&L)
                // This is what we ACTUALLY spent, not what the position is worth
                const actualCostPaid = finalShares * finalEntryPrice;

                this.logger.log(`[LiveTrader] 💰 POSITION COST: requested=$${actualSize.toFixed(2)} | actual=$${actualCostPaid.toFixed(2)} | shares=${finalShares} @ $${finalEntryPrice.toFixed(3)}`);

                this.livePositions[positionKey] = {
                    strategyName,
                    crypto,
                    windowEpoch,
                    tokenSide,
                    tokenId,
                    entryPrice: finalEntryPrice,
                    entryTime: Date.now(),
                    // CRITICAL FIX: size = COST BASIS (what we paid), NOT market value
                    size: actualCostPaid,           // Actual $ spent (shares * fill price)
                    costBasis: actualCostPaid,      // Explicit cost basis field
                    requestedSize: actualSize,      // What we requested to spend
                    shares: finalShares,
                    spotAtEntry: tick.spot_price,
                    orderId: response.orderId,
                    txHash: response.tx,
                    balanceVerified: true,
                    // Initialize tracking fields NOW to avoid issues later
                    highWaterMark: finalEntryPrice,
                    peakPnlPct: 0,
                    profitFloor: 0,
                    state: PositionState.OPEN,
                    ticksMonitored: 0,
                    exitAttempts: 0
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
                await this.saveTrade('entry', strategyName, signal, tick, response.avgPrice || entryPrice, null, null, response.tx || response.txHashes?.[0], {
                    priceRequested: response.priceRequested || entryPrice,
                    priceFilled: response.priceFilled || response.avgPrice || entryPrice,
                    fillDetails: response.fillDetails
                });
                
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
                        
                        await this.saveTrade('entry', strategyName, signal, tick, retryResponse.avgPrice || retryPrice, null, null, retryResponse.tx || retryResponse.txHashes?.[0], {
                            priceRequested: retryResponse.priceRequested || retryPrice,
                            priceFilled: retryResponse.priceFilled || retryResponse.avgPrice || retryPrice,
                            fillDetails: retryResponse.fillDetails
                        });
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
                await this.saveTrade('exit', strategyName, signal, tick, response.avgPrice || price, position, netPnl, response.tx || null, {
                    priceRequested: response.priceRequested || price,
                    priceFilled: response.priceFilled || response.avgPrice || price,
                    fillDetails: response.fillDetails
                });
                
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
     * Now includes tx_hash, condition_id, LAG ANALYTICS, and EXECUTION PRICE TRACKING
     *
     * LAG ANALYTICS (Jan 29 2026):
     * - oracle_price: Chainlink/Pyth price at entry (what determines resolution)
     * - oracle_source: 'chainlink', 'pyth', or 'binance'
     * - chainlink_staleness: How stale Chainlink was at entry (seconds)
     * - lag_ratio: Market lag ratio (how much market is lagging oracle)
     * - bs_prob: Black-Scholes expected probability
     * - market_prob: Actual market probability at entry
     * - edge_at_entry: Calculated edge (bs_prob - market_prob)
     * - price_to_beat: Strike price for this window
     *
     * EXECUTION PRICE TRACKING (Jan 29 2026):
     * - price_requested: Price we sent to the API (willing to pay)
     * - price_filled: Actual execution price (may be better due to price improvement)
     * - fill_details: JSON with source of fill price determination
     */
    async saveTrade(type, strategyName, signal, tick, price, position = null, pnl = null, txHash = null, priceData = null) {
        try {
            // Extract lag analytics from signal metadata
            // Signals include: lagRatio, edge, expected (BS prob), market (market prob)
            const lagRatio = signal.lagRatio ? parseFloat(signal.lagRatio) : null;
            const edgeStr = signal.edge || signal.edgeAtEntry;
            const edgeAtEntry = edgeStr ? parseFloat(edgeStr.replace('%', '')) / 100 : null;
            const bsProbStr = signal.expected || signal.bsProb;
            const bsProb = bsProbStr ? parseFloat(bsProbStr.replace('%', '')) / 100 : null;
            const marketProbStr = signal.market || signal.marketProb;
            const marketProb = marketProbStr ? parseFloat(marketProbStr.replace('%', '')) / 100 : null;

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
                timestamp: new Date().toISOString(),
                // LAG ANALYTICS - from tick data
                oracle_price: tick.oracle_price || null,
                oracle_source: tick.oracle_source || null,
                chainlink_staleness: tick.chainlink_staleness || null,
                price_to_beat: tick.price_to_beat || null,
                // LAG ANALYTICS - from signal data
                lag_ratio: lagRatio,
                bs_prob: bsProb,
                market_prob: marketProb,
                edge_at_entry: edgeAtEntry,
                // EXECUTION PRICE TRACKING - from SDK response
                price_requested: priceData?.priceRequested || null,
                price_filled: priceData?.priceFilled || null,
                fill_details: priceData?.fillDetails || null
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
                // Winning side pays $1/share, losing side pays $0/share
                const won = outcome === position.tokenSide.toLowerCase();
                const finalPrice = won ? 1.0 : 0.0;

                // CRITICAL FIX: Correct P&L formula for binary options
                // exitValue = shares * finalPrice ($1 or $0 per share)
                // pnl = exitValue - costBasis
                const exitValue = position.shares * finalPrice;
                const costBasis = position.costBasis || position.size;
                const pnl = exitValue - costBasis;
                const fee = exitValue * 0.001;  // Fee on proceeds, not cost
                const netPnl = pnl - fee;

                this.logger.log(`[LiveTrader] 📊 EXPIRY P&L: ${position.shares} shares @ $${finalPrice.toFixed(2)} = $${exitValue.toFixed(2)} - cost $${costBasis.toFixed(2)} = $${pnl.toFixed(2)}`);
                
                this.stats.grossPnL += pnl;
                this.stats.fees += fee;
                this.stats.netPnL += netPnl;
                this.stats.tradesExecuted++;
                
                this.riskManager.recordTradeClose({
                    crypto,
                    windowEpoch: epoch,
                    size: costBasis
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
                        price: finalPrice,  // $1.00 for win, $0.00 for loss
                        size: costBasis,    // Use cost basis, not market value
                        spot_price: null,   // Window already ended
                        time_remaining: 0,
                        reason: 'window_expiry',
                        entry_price: position.entryPrice,
                        pnl: netPnl,
                        peak_price: position.highWaterMark,
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

    /**
     * Print a beautiful live trading status dashboard
     */
    printStatusDashboard() {
        if (!this.isRunning) return;

        const now = new Date().toISOString().slice(11, 19);
        const positions = Object.values(this.livePositions);
        const enabledList = Array.from(this.enabledStrategies);

        console.log('');
        console.log('╔══════════════════════════════════════════════════════════════╗');
        console.log(`║  🎰 LIVE TRADING STATUS                        ${now} UTC  ║`);
        console.log('╠══════════════════════════════════════════════════════════════╣');

        // Stats line
        const wins = this.stats.wins || 0;
        const losses = this.stats.losses || 0;
        const pnl = this.stats.netPnL?.toFixed(2) || '0.00';
        const pnlSign = parseFloat(pnl) >= 0 ? '+' : '';
        console.log(`║  💰 Session: ${wins}W/${losses}L | P&L: ${pnlSign}$${pnl}`.padEnd(64) + '║');
        console.log('╠══════════════════════════════════════════════════════════════╣');

        // Open positions
        if (positions.length > 0) {
            console.log('║  📈 OPEN POSITIONS:'.padEnd(64) + '║');
            for (const pos of positions) {
                const side = pos.tokenSide?.toUpperCase() || '?';
                const crypto = pos.crypto?.toUpperCase() || '?';
                const entry = pos.entryPrice?.toFixed(2) || '?';
                const current = pos.currentPrice?.toFixed(2) || entry;
                const pnlPct = pos.entryPrice ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice * 100) : 0;
                const pnlStr = pnlPct >= 0 ? `+${pnlPct.toFixed(1)}%` : `${pnlPct.toFixed(1)}%`;
                const stratShort = (pos.strategyName || '?').slice(0, 18);
                console.log(`║    ${stratShort.padEnd(18)} | ${crypto} ${side.padEnd(4)} | $${entry} → $${current} | ${pnlStr}`.padEnd(64) + '║');
            }
        } else {
            console.log('║  📈 OPEN POSITIONS: None'.padEnd(64) + '║');
        }

        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log('║  🎯 ENABLED STRATEGIES:'.padEnd(64) + '║');

        for (const strat of enabledList) {
            const hasPosition = positions.some(p => p.strategyName === strat);
            const icon = hasPosition ? '🟢' : '⚪';
            const status = hasPosition ? 'IN POSITION' : 'scanning...';
            console.log(`║    ${icon} ${strat.padEnd(24)} ${status}`.padEnd(64) + '║');
        }

        console.log('╚══════════════════════════════════════════════════════════════╝');
        console.log('');
    }

    /**
     * Start periodic status display
     */
    startStatusDisplay(intervalMs = 60000) {
        // Print immediately
        this.printStatusDashboard();

        // Then every interval
        this.statusInterval = setInterval(() => {
            this.printStatusDashboard();
        }, intervalMs);
    }

    /**
     * Stop periodic status display
     */
    stopStatusDisplay() {
        if (this.statusInterval) {
            clearInterval(this.statusInterval);
            this.statusInterval = null;
        }
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
