/**
 * Paper Trading System
 * 
 * Simulates live trading without real money.
 * Uses real-time market data but simulated executions.
 */

import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { initDatabase, insertTrade, getDatabase } from '../db/connection.js';
import { ExecutionSimulator } from '../backtest/simulator.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const BINANCE_WS = 'wss://stream.binance.com:9443/ws';

export class PaperTrader {
    constructor(strategy, options = {}) {
        this.strategy = strategy;
        this.options = {
            crypto: 'btc',
            initialCapital: 1000,
            logTrades: true,
            ...options
        };
        
        this.simulator = new ExecutionSimulator({
            takerFee: 0.001,
            slippageModel: 'linear',
            slippageFactor: 0.001
        });
        
        // State
        this.capital = this.options.initialCapital;
        this.position = null;
        this.trades = [];
        this.equity = [this.options.initialCapital];
        
        // Market state
        this.currentMarket = null;
        this.orderBooks = {};
        this.spotPrice = null;
        this.currentTick = null;
        
        // WebSocket connections
        this.polyWs = null;
        this.binanceWs = null;
        
        this.isRunning = false;
        this.db = null;
    }
    
    /**
     * Start paper trading
     */
    async start() {
        console.log('═'.repeat(70));
        console.log(`     PAPER TRADING: ${this.strategy.getName()}`);
        console.log('═'.repeat(70));
        console.log(`\n   Crypto: ${this.options.crypto.toUpperCase()}`);
        console.log(`   Initial Capital: $${this.capital.toFixed(2)}`);
        console.log(`   Strategy: ${this.strategy.getName()}`);
        
        this.db = initDatabase();
        this.isRunning = true;
        
        // Get current market
        await this.refreshMarket();
        
        // Connect to data feeds
        await this.connectBinance();
        await this.connectPolymarket();
        
        // Set up periodic tasks
        this.setupPeriodicTasks();
        
        console.log('\n✅ Paper trading started');
        console.log('   Press Ctrl+C to stop\n');
    }
    
    /**
     * Stop paper trading
     */
    stop() {
        console.log('\n🛑 Stopping paper trading...');
        this.isRunning = false;
        
        // Close position if open
        if (this.position && this.currentTick) {
            this.closePosition('shutdown');
        }
        
        // Close connections
        if (this.polyWs) this.polyWs.close();
        if (this.binanceWs) this.binanceWs.close();
        
        // Print summary
        this.printSummary();
    }
    
    /**
     * Refresh current market
     */
    async refreshMarket() {
        const now = Math.floor(Date.now() / 1000);
        const epoch = Math.floor(now / 900) * 900;
        const slug = `${this.options.crypto}-updown-15m-${epoch}`;
        
        try {
            const response = await fetch(`${GAMMA_API}/markets?slug=${slug}`);
            const markets = await response.json();
            
            if (markets && markets.length > 0) {
                const market = markets[0];
                const tokenIds = JSON.parse(market.clobTokenIds || '[]');
                
                this.currentMarket = {
                    epoch,
                    slug,
                    upTokenId: tokenIds[0],
                    downTokenId: tokenIds[1],
                    endTime: new Date(market.endDate).getTime()
                };
                
                console.log(`📊 Market: ${slug}`);
            }
        } catch (error) {
            console.error('❌ Failed to fetch market:', error.message);
        }
    }
    
    /**
     * Connect to Binance
     */
    async connectBinance() {
        return new Promise((resolve) => {
            const symbol = this.options.crypto === 'btc' ? 'btcusdt' : 
                          this.options.crypto === 'eth' ? 'ethusdt' :
                          this.options.crypto === 'sol' ? 'solusdt' : 'xrpusdt';
            
            this.binanceWs = new WebSocket(`${BINANCE_WS}/${symbol}@ticker`);
            
            this.binanceWs.on('open', () => {
                console.log('✅ Binance connected');
                resolve();
            });
            
            this.binanceWs.on('message', (data) => {
                const parsed = JSON.parse(data.toString());
                this.spotPrice = parseFloat(parsed.c);
            });
            
            this.binanceWs.on('error', (err) => console.error('Binance error:', err.message));
            this.binanceWs.on('close', () => {
                if (this.isRunning) {
                    setTimeout(() => this.connectBinance(), 5000);
                }
            });
        });
    }
    
    /**
     * Connect to Polymarket
     */
    async connectPolymarket() {
        return new Promise((resolve) => {
            this.polyWs = new WebSocket(CLOB_WS);
            
            this.polyWs.on('open', () => {
                console.log('✅ Polymarket connected');
                this.subscribeToMarket();
                resolve();
            });
            
            this.polyWs.on('message', (data) => {
                this.handlePolymarketMessage(data);
            });
            
            this.polyWs.on('error', (err) => console.error('Polymarket error:', err.message));
            this.polyWs.on('close', () => {
                if (this.isRunning) {
                    setTimeout(() => this.connectPolymarket(), 5000);
                }
            });
        });
    }
    
    /**
     * Subscribe to market
     */
    subscribeToMarket() {
        if (!this.currentMarket) return;
        
        const msg = {
            type: 'market',
            assets_ids: [this.currentMarket.upTokenId, this.currentMarket.downTokenId]
        };
        this.polyWs.send(JSON.stringify(msg));
    }
    
    /**
     * Handle Polymarket messages
     */
    handlePolymarketMessage(rawData) {
        try {
            const data = JSON.parse(rawData.toString());
            
            if (Array.isArray(data)) {
                for (const book of data) {
                    if (book.asset_id && book.bids && book.asks) {
                        this.orderBooks[book.asset_id] = {
                            bids: book.bids,
                            asks: book.asks,
                            lastTrade: book.last_trade_price
                        };
                    }
                }
                
                // Process tick
                this.processTick();
            }
        } catch (error) {
            // Ignore parse errors
        }
    }
    
    /**
     * Process current market tick
     */
    processTick() {
        if (!this.currentMarket || !this.spotPrice) return;
        
        const upBook = this.orderBooks[this.currentMarket.upTokenId];
        if (!upBook) return;
        
        // Build tick object
        const upBids = upBook.bids || [];
        const upAsks = upBook.asks || [];
        
        const upBestBid = upBids.reduce((max, b) => 
            parseFloat(b.price) > parseFloat(max.price) ? b : max, { price: '0', size: '0' });
        const upBestAsk = upAsks.reduce((min, a) => 
            parseFloat(a.price) < parseFloat(min.price) ? a : min, { price: '1', size: '0' });
        
        const upBid = parseFloat(upBestBid.price);
        const upAsk = parseFloat(upBestAsk.price);
        const upMid = (upBid + upAsk) / 2;
        
        this.currentTick = {
            timestamp_ms: Date.now(),
            crypto: this.options.crypto,
            window_epoch: this.currentMarket.epoch,
            time_remaining_sec: Math.max(0, (this.currentMarket.endTime - Date.now()) / 1000),
            up_bid: upBid,
            up_ask: upAsk,
            up_bid_size: parseFloat(upBestBid.size),
            up_ask_size: parseFloat(upBestAsk.size),
            up_mid: upMid,
            down_bid: 1 - upAsk,
            down_ask: 1 - upBid,
            spot_price: this.spotPrice,
            spread: upAsk - upBid,
            spread_pct: upMid > 0 ? ((upAsk - upBid) / upMid) * 100 : 0
        };
        
        // Run strategy
        this.runStrategy();
    }
    
    /**
     * Run strategy on current tick
     */
    runStrategy() {
        const tick = this.currentTick;
        if (!tick) return;
        
        // Check risk limits first
        if (this.position) {
            const riskAction = this.strategy.checkRiskLimits(tick, this.position);
            if (riskAction) {
                this.closePosition(riskAction.reason);
                return;
            }
        }
        
        // Get strategy signal
        const context = {
            equity: this.equity,
            trades: this.trades
        };
        
        const signal = this.strategy.onTick(tick, this.position, context);
        
        // Execute signal
        if (signal.action === 'buy' && !this.position) {
            this.openPosition(signal);
        } else if (signal.action === 'sell' && this.position) {
            this.closePosition(signal.reason || 'strategy_signal');
        }
    }
    
    /**
     * Open a position
     */
    openPosition(signal) {
        const tick = this.currentTick;
        const size = Math.min(
            signal.size || this.strategy.params.maxPosition,
            this.capital * 0.5
        );
        
        if (size < 5) return;
        
        const side = signal.side || 'up';
        const execution = this.simulator.executeMarketOrder(
            { side: `buy_${side}`, size },
            tick
        );
        
        this.position = {
            id: uuidv4(),
            side,
            size: execution.filledSize,
            entryPrice: execution.executionPrice,
            entryTime: Date.now(),
            entryTick: tick
        };
        
        this.capital -= execution.filledSize + execution.fee;
        
        if (this.options.logTrades) {
            console.log(`\n📈 OPENED ${side.toUpperCase()} @ ${execution.executionPrice.toFixed(4)}`);
            console.log(`   Size: $${execution.filledSize.toFixed(2)} | Fee: $${execution.fee.toFixed(4)}`);
        }
        
        // Log to database
        this.logTrade('open', execution);
    }
    
    /**
     * Close current position
     */
    closePosition(reason) {
        if (!this.position) return;
        
        const tick = this.currentTick;
        const execution = this.simulator.executeMarketOrder(
            { side: `sell_${this.position.side}`, size: this.position.size },
            tick
        );
        
        // Calculate P&L
        const exitPrice = this.position.side === 'up' ? tick.up_bid : tick.down_bid;
        const pnl = (exitPrice - this.position.entryPrice) * this.position.size - execution.fee;
        const pnlPct = (exitPrice - this.position.entryPrice) / this.position.entryPrice;
        
        // Record trade
        const trade = {
            id: this.position.id,
            side: this.position.side,
            size: this.position.size,
            entryPrice: this.position.entryPrice,
            exitPrice,
            entryTime: this.position.entryTime,
            exitTime: Date.now(),
            pnl,
            pnlPct,
            fee: execution.fee,
            reason,
            holdingTime: Date.now() - this.position.entryTime
        };
        
        this.trades.push(trade);
        this.capital += this.position.size + pnl;
        this.equity.push(this.capital);
        
        if (this.options.logTrades) {
            const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
            const pnlPctStr = pnl >= 0 ? `+${(pnlPct * 100).toFixed(2)}%` : `${(pnlPct * 100).toFixed(2)}%`;
            console.log(`\n📉 CLOSED @ ${exitPrice.toFixed(4)} | ${pnlStr} (${pnlPctStr})`);
            console.log(`   Reason: ${reason} | Capital: $${this.capital.toFixed(2)}`);
        }
        
        // Log to database
        this.logTrade('close', execution, trade);
        
        this.position = null;
    }
    
    /**
     * Log trade to database
     */
    logTrade(type, execution, trade = null) {
        const tick = this.currentTick;
        
        try {
            insertTrade({
                timestamp_ms: Date.now(),
                trade_id: type === 'open' ? this.position?.id : trade?.id,
                mode: 'paper',
                strategy: this.strategy.getName(),
                crypto: this.options.crypto,
                window_epoch: this.currentMarket?.epoch,
                side: type === 'open' ? `buy_${this.position?.side}` : `sell_${trade?.side}`,
                size: execution.filledSize,
                price: execution.executionPrice,
                fee: execution.fee,
                slippage: execution.slippage,
                spot_price: tick?.spot_price,
                up_bid: tick?.up_bid,
                up_ask: tick?.up_ask,
                time_remaining_sec: tick?.time_remaining_sec,
                notes: type === 'close' ? `PnL: ${trade?.pnl?.toFixed(2)}, Reason: ${trade?.reason}` : null
            });
        } catch (error) {
            // Ignore logging errors
        }
    }
    
    /**
     * Set up periodic tasks
     */
    setupPeriodicTasks() {
        // Check for window change every 10 seconds
        setInterval(async () => {
            const now = Math.floor(Date.now() / 1000);
            const currentEpoch = Math.floor(now / 900) * 900;
            
            if (this.currentMarket && this.currentMarket.epoch !== currentEpoch) {
                console.log('\n🔄 Window changed, refreshing market...');
                
                // Close position at window end
                if (this.position) {
                    this.closePosition('window_end');
                }
                
                await this.refreshMarket();
                this.subscribeToMarket();
                this.strategy.onWindowStart({ epoch: currentEpoch });
            }
        }, 10000);
        
        // Print status every minute
        setInterval(() => {
            this.printStatus();
        }, 60000);
    }
    
    /**
     * Print current status
     */
    printStatus() {
        const tick = this.currentTick;
        if (!tick) return;
        
        console.log(`\n[${new Date().toISOString()}] 📊 Status`);
        console.log(`   Capital: $${this.capital.toFixed(2)} | Trades: ${this.trades.length}`);
        console.log(`   BTC: $${this.spotPrice?.toLocaleString()} | Up: ${tick.up_bid.toFixed(2)}/${tick.up_ask.toFixed(2)}`);
        
        if (this.position) {
            const currentPrice = this.position.side === 'up' ? tick.up_mid : (1 - tick.up_mid);
            const unrealizedPnl = (currentPrice - this.position.entryPrice) * this.position.size;
            console.log(`   Position: ${this.position.side.toUpperCase()} | Unrealized: $${unrealizedPnl.toFixed(2)}`);
        }
    }
    
    /**
     * Print final summary
     */
    printSummary() {
        console.log('\n' + '═'.repeat(70));
        console.log('     PAPER TRADING SUMMARY');
        console.log('═'.repeat(70));
        
        const totalPnL = this.capital - this.options.initialCapital;
        const winningTrades = this.trades.filter(t => t.pnl > 0);
        const losingTrades = this.trades.filter(t => t.pnl < 0);
        
        console.log(`\n   Strategy: ${this.strategy.getName()}`);
        console.log(`   Initial Capital: $${this.options.initialCapital.toFixed(2)}`);
        console.log(`   Final Capital: $${this.capital.toFixed(2)}`);
        console.log(`   Total P&L: $${totalPnL.toFixed(2)} (${((totalPnL / this.options.initialCapital) * 100).toFixed(2)}%)`);
        
        console.log(`\n   Total Trades: ${this.trades.length}`);
        console.log(`   Winning: ${winningTrades.length} | Losing: ${losingTrades.length}`);
        
        if (this.trades.length > 0) {
            const winRate = winningTrades.length / this.trades.length;
            console.log(`   Win Rate: ${(winRate * 100).toFixed(1)}%`);
            
            const avgWin = winningTrades.length > 0 
                ? winningTrades.reduce((s, t) => s + t.pnl, 0) / winningTrades.length 
                : 0;
            const avgLoss = losingTrades.length > 0 
                ? losingTrades.reduce((s, t) => s + t.pnl, 0) / losingTrades.length 
                : 0;
            
            console.log(`   Avg Win: $${avgWin.toFixed(2)} | Avg Loss: $${avgLoss.toFixed(2)}`);
        }
        
        console.log('\n' + '═'.repeat(70));
    }
}

export default PaperTrader;

