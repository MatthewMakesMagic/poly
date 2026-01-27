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
            maxPositionPerTrade: 3,  // Allow up to $3 to accommodate minimum order adjustments
            maxTotalExposure: 20,
            maxLossPerDay: 20,
            minBidSize: 2,           // Lower threshold for thin markets
            minAskSize: 2,           // Lower threshold for thin markets
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
        if (!this.options.enabled) {
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
        
        // Calculate actual position size (ensure minimum 5 shares for Polymarket)
        const actualSize = this.calculateMinimumSize(entryPrice, this.options.positionSize);
        
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
