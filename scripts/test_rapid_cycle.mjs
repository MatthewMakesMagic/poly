#!/usr/bin/env node
/**
 * Rapid Cycle Test - 20-30 Orders with Momentum-Based Direction
 * 
 * Features:
 * - Trades BTC, XRP, SOL, ETH based on current momentum
 * - Spreads orders throughout the cycle
 * - Randomly holds 50% of positions to expiry
 * - Kill switch support (file + API)
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import fs from 'fs';
import http from 'http';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const GAMMA_API = 'https://gamma-api.polymarket.com';

const CONFIG = {
    cryptos: ['btc', 'xrp', 'sol', 'eth'],
    dollarsPerTrade: 1.0,
    targetOrders: 25,                    // Target 20-30 orders
    orderIntervalMs: 20000,              // ~20 seconds between orders
    holdToExpiryPct: 0.5,                // 50% hold to expiry
    sellBufferSec: 30,                   // Sell 30s before expiry for non-hold
    momentumWindowMs: 60000,             // 60s momentum window
    killSwitchFile: './KILL_SWITCH',
    killSwitchPort: 3099,                // HTTP API port for kill switch
    logFile: `./data/rapid_cycle_${Date.now()}.json`
};

// ═══════════════════════════════════════════════════════════════════════════
// KILL SWITCH
// ═══════════════════════════════════════════════════════════════════════════

let killSwitchActive = false;
let killSwitchReason = null;

function checkKillSwitch() {
    // Check file-based kill switch
    if (fs.existsSync(CONFIG.killSwitchFile)) {
        if (!killSwitchActive) {
            killSwitchActive = true;
            killSwitchReason = 'KILL_SWITCH file detected';
            console.log('\n🛑 KILL SWITCH ACTIVATED: ' + killSwitchReason);
        }
        return true;
    }
    return killSwitchActive;
}

function activateKillSwitch(reason) {
    killSwitchActive = true;
    killSwitchReason = reason;
    console.log('\n🛑 KILL SWITCH ACTIVATED: ' + reason);
    // Create file for persistence
    fs.writeFileSync(CONFIG.killSwitchFile, JSON.stringify({
        activated: new Date().toISOString(),
        reason
    }));
}

function deactivateKillSwitch() {
    killSwitchActive = false;
    killSwitchReason = null;
    if (fs.existsSync(CONFIG.killSwitchFile)) {
        fs.unlinkSync(CONFIG.killSwitchFile);
    }
    console.log('\n✅ KILL SWITCH DEACTIVATED');
}

// Kill Switch HTTP API
function startKillSwitchAPI() {
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
        
        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }
        
        // GET /kill-switch - Check status
        if (req.method === 'GET' && req.url === '/kill-switch') {
            res.writeHead(200);
            res.end(JSON.stringify({
                active: killSwitchActive,
                reason: killSwitchReason,
                fileExists: fs.existsSync(CONFIG.killSwitchFile)
            }));
            return;
        }
        
        // POST /kill-switch - Activate
        if (req.method === 'POST' && req.url === '/kill-switch') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                const data = body ? JSON.parse(body) : {};
                activateKillSwitch(data.reason || 'API triggered');
                res.writeHead(200);
                res.end(JSON.stringify({ success: true, active: true }));
            });
            return;
        }
        
        // DELETE /kill-switch - Deactivate
        if (req.method === 'DELETE' && req.url === '/kill-switch') {
            deactivateKillSwitch();
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, active: false }));
            return;
        }
        
        // GET /status - Full status
        if (req.method === 'GET' && req.url === '/status') {
            res.writeHead(200);
            res.end(JSON.stringify({
                killSwitch: { active: killSwitchActive, reason: killSwitchReason },
                positions: Array.from(positions.values()),
                stats: tradeStats,
                config: CONFIG
            }));
            return;
        }
        
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
    });
    
    server.listen(CONFIG.killSwitchPort, () => {
        console.log(`\n📡 Kill Switch API running on http://localhost:${CONFIG.killSwitchPort}`);
        console.log('   GET  /kill-switch  - Check status');
        console.log('   POST /kill-switch  - Activate (body: {"reason": "..."})');
        console.log('   DELETE /kill-switch - Deactivate');
        console.log('   GET  /status       - Full trading status\n');
    });
    
    return server;
}

// ═══════════════════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════════════════

function createCompatibleWallet(privateKey) {
    const wallet = new Wallet(privateKey);
    wallet._signTypedData = (d, t, v) => wallet.signTypedData(d, t, v);
    return wallet;
}

let client = null;
const positions = new Map();
const spotHistory = new Map();  // crypto -> [{time, price}]
const tradeStats = {
    ordersPlaced: 0,
    ordersFilled: 0,
    ordersFailed: 0,
    positionsOpened: 0,
    positionsClosed: 0,
    positionsExpired: 0,
    totalPnL: 0
};

const results = {
    startTime: new Date().toISOString(),
    config: CONFIG,
    trades: [],
    expiryResults: []
};

async function initClient() {
    const wallet = createCompatibleWallet(process.env.POLYMARKET_PRIVATE_KEY);
    const funder = process.env.POLYMARKET_FUNDER_ADDRESS;
    
    console.log(`Signer: ${wallet.address}`);
    console.log(`Funder: ${funder}`);
    
    const baseClient = new ClobClient(HOST, CHAIN_ID, wallet);
    const creds = await baseClient.deriveApiKey();
    
    client = new ClobClient(HOST, CHAIN_ID, wallet, creds, 2, funder);
    console.log('Client ready\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKET DATA
// ═══════════════════════════════════════════════════════════════════════════

async function getSpotPrice(crypto) {
    const symbol = { btc: 'BTCUSDT', eth: 'ETHUSDT', sol: 'SOLUSDT', xrp: 'XRPUSDT' }[crypto];
    if (!symbol) return null;
    
    try {
        const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
        const data = await res.json();
        return parseFloat(data.price);
    } catch { return null; }
}

function updateSpotHistory(crypto, price) {
    if (!spotHistory.has(crypto)) spotHistory.set(crypto, []);
    const history = spotHistory.get(crypto);
    history.push({ time: Date.now(), price });
    
    // Keep only last 5 minutes
    const cutoff = Date.now() - 5 * 60 * 1000;
    while (history.length > 0 && history[0].time < cutoff) {
        history.shift();
    }
}

function getMomentum(crypto) {
    const history = spotHistory.get(crypto);
    if (!history || history.length < 2) return 0;
    
    // Get oldest and newest in momentum window
    const cutoff = Date.now() - CONFIG.momentumWindowMs;
    const recent = history.filter(h => h.time >= cutoff);
    
    if (recent.length < 2) return 0;
    
    const oldest = recent[0].price;
    const newest = recent[recent.length - 1].price;
    
    return (newest - oldest) / oldest;  // Returns percentage change
}

async function getMarket(crypto, epoch = null) {
    const now = Math.floor(Date.now() / 1000);
    epoch = epoch || Math.floor(now / 900) * 900;
    const slug = `${crypto}-updown-15m-${epoch}`;
    
    try {
        const res = await fetch(`${GAMMA_API}/markets?slug=${slug}`);
        const markets = await res.json();
        if (!markets || markets.length === 0) return null;
        
        const m = markets[0];
        const tokenIds = JSON.parse(m.clobTokenIds || '[]');
        
        return {
            slug,
            epoch,
            upTokenId: tokenIds[0],
            downTokenId: tokenIds[1],
            endDate: new Date(m.endDate)
        };
    } catch { return null; }
}

async function getBookPrices(tokenId) {
    try {
        const book = await client.getOrderBook(tokenId);
        const bids = book.bids || [];
        const asks = book.asks || [];
        
        const bestBid = bids.length > 0 ? Math.max(...bids.map(b => parseFloat(b.price))) : 0;
        const bestAsk = asks.length > 0 ? Math.min(...asks.map(a => parseFloat(a.price))) : 1;
        
        return { bid: bestBid, ask: bestAsk, spread: bestAsk - bestBid };
    } catch { return { bid: 0, ask: 1, spread: 1 }; }
}

async function getBalance(tokenId) {
    try {
        const bal = await client.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenId });
        return parseFloat(bal.balance) / 1e6;
    } catch { return 0; }
}

// ═══════════════════════════════════════════════════════════════════════════
// TRADING
// ═══════════════════════════════════════════════════════════════════════════

async function buy(tokenId, dollars, price) {
    const shares = Math.max(5, Math.ceil(dollars / price));  // Min 5 shares
    
    try {
        const order = await client.createAndPostOrder({
            tokenID: tokenId,
            price,
            side: 'BUY',
            size: shares
        }, { tickSize: '0.01', negRisk: false }, 'GTC');
        
        return {
            success: order.status === 'matched',
            orderId: order.orderID,
            status: order.status,
            shares,
            price,
            cost: shares * price,
            tx: order.transactionsHashes?.[0]
        };
    } catch (e) {
        return { success: false, error: e.message, shares, price, cost: shares * price };
    }
}

async function sell(tokenId, shares, price) {
    const actualShares = Math.floor(shares);
    if (actualShares < 1) return { success: false, error: 'Not enough shares' };
    
    try {
        const order = await client.createAndPostOrder({
            tokenID: tokenId,
            price,
            side: 'SELL',
            size: actualShares
        }, { tickSize: '0.01', negRisk: false }, 'GTC');
        
        return {
            success: order.status === 'matched',
            orderId: order.orderID,
            status: order.status,
            shares: actualShares,
            price,
            value: actualShares * price,
            tx: order.transactionsHashes?.[0]
        };
    } catch (e) {
        return { success: false, error: e.message, shares: actualShares, price };
    }
}

async function openPosition(crypto, epoch) {
    if (checkKillSwitch()) {
        console.log(`   ⛔ Kill switch active - skipping`);
        return null;
    }
    
    const market = await getMarket(crypto, epoch);
    if (!market) {
        console.log(`   ❌ Market not found`);
        return null;
    }
    
    // Get spot and determine direction
    const spot = await getSpotPrice(crypto);
    if (!spot) {
        console.log(`   ❌ No spot price`);
        return null;
    }
    
    updateSpotHistory(crypto, spot);
    const momentum = getMomentum(crypto);
    const direction = momentum >= 0 ? 'up' : 'down';
    
    const tokenId = direction === 'up' ? market.upTokenId : market.downTokenId;
    const prices = await getBookPrices(tokenId);
    
    if (prices.spread > 0.1) {
        console.log(`   ⚠️ Spread too wide: ${(prices.spread * 100).toFixed(1)}%`);
        return null;
    }
    
    const buyPrice = Math.min(prices.ask + 0.01, 0.99);
    
    console.log(`   ${crypto.toUpperCase()} ${direction.toUpperCase()} | Spot: $${spot.toFixed(4)} | Mom: ${(momentum * 100).toFixed(3)}% | Price: $${buyPrice.toFixed(2)}`);
    
    const result = await buy(tokenId, CONFIG.dollarsPerTrade, buyPrice);
    tradeStats.ordersPlaced++;
    
    if (result.success) {
        tradeStats.ordersFilled++;
        tradeStats.positionsOpened++;
        
        const holdToExpiry = Math.random() < CONFIG.holdToExpiryPct;
        const posId = `${crypto}_${epoch}_${Date.now()}`;
        
        const position = {
            id: posId,
            crypto,
            epoch,
            direction,
            tokenId,
            entryTime: new Date().toISOString(),
            entryPrice: buyPrice,
            entryCost: result.cost,
            shares: result.shares,
            holdToExpiry,
            closed: false,
            spotAtEntry: spot,
            momentum,
            orderId: result.orderId,
            tx: result.tx
        };
        
        positions.set(posId, position);
        results.trades.push(position);
        
        console.log(`   ✅ Bought ${result.shares} @ $${buyPrice.toFixed(2)} = $${result.cost.toFixed(2)} [${holdToExpiry ? 'HOLD TO EXPIRY' : 'SELL EARLY'}]`);
        
        return position;
    } else {
        tradeStats.ordersFailed++;
        console.log(`   ❌ Failed: ${result.error || result.status}`);
        return null;
    }
}

async function closePosition(position, reason = 'manual') {
    if (position.closed) return null;
    
    const prices = await getBookPrices(position.tokenId);
    const balance = await getBalance(position.tokenId);
    
    if (balance < 1) {
        console.log(`   ⚠️ ${position.crypto.toUpperCase()} - No balance to sell`);
        position.closed = true;
        position.closeReason = 'no_balance';
        return null;
    }
    
    const result = await sell(position.tokenId, balance, prices.bid);
    
    if (result.success) {
        tradeStats.positionsClosed++;
        const pnl = result.value - position.entryCost;
        tradeStats.totalPnL += pnl;
        
        position.closed = true;
        position.closeReason = reason;
        position.exitTime = new Date().toISOString();
        position.exitPrice = prices.bid;
        position.exitValue = result.value;
        position.pnl = pnl;
        position.spotAtExit = await getSpotPrice(position.crypto);
        
        console.log(`   💰 ${position.crypto.toUpperCase()} ${position.direction.toUpperCase()} - Sold ${result.shares} @ $${prices.bid.toFixed(2)} = $${result.value.toFixed(2)} | P&L: $${pnl.toFixed(4)}`);
        
        return position;
    } else {
        console.log(`   ❌ ${position.crypto.toUpperCase()} - Sell failed: ${result.error}`);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN CYCLE
// ═══════════════════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runCycle() {
    const now = Math.floor(Date.now() / 1000);
    const epoch = Math.floor(now / 900) * 900;
    const endTime = (epoch + 900) * 1000;
    const timeRemaining = endTime - Date.now();
    
    console.log('\n' + '═'.repeat(70));
    console.log(`     RAPID CYCLE TEST - Epoch ${epoch}`);
    console.log('═'.repeat(70));
    console.log(`Time remaining: ${Math.floor(timeRemaining / 1000)}s`);
    console.log(`Target orders: ${CONFIG.targetOrders}`);
    console.log(`Hold to expiry: ${CONFIG.holdToExpiryPct * 100}%`);
    console.log('═'.repeat(70) + '\n');
    
    // Calculate order timing
    const sellTime = endTime - CONFIG.sellBufferSec * 1000;
    const tradingTime = sellTime - Date.now();
    const interval = Math.max(5000, tradingTime / CONFIG.targetOrders);
    
    console.log(`📊 Order interval: ${Math.floor(interval / 1000)}s\n`);
    
    // Seed spot history
    console.log('📡 Getting initial spot prices...');
    for (const crypto of CONFIG.cryptos) {
        const spot = await getSpotPrice(crypto);
        if (spot) {
            updateSpotHistory(crypto, spot);
            console.log(`   ${crypto.toUpperCase()}: $${spot.toFixed(4)}`);
        }
    }
    console.log('');
    
    // ENTRY PHASE - Place orders throughout the cycle
    console.log('─'.repeat(50));
    console.log('     ENTRY PHASE');
    console.log('─'.repeat(50) + '\n');
    
    let orderNum = 0;
    while (Date.now() < sellTime && orderNum < CONFIG.targetOrders) {
        if (checkKillSwitch()) {
            console.log('\n🛑 Kill switch - stopping entries\n');
            break;
        }
        
        // Pick a random crypto
        const crypto = CONFIG.cryptos[Math.floor(Math.random() * CONFIG.cryptos.length)];
        
        orderNum++;
        console.log(`[Order ${orderNum}/${CONFIG.targetOrders}]`);
        
        await openPosition(crypto, epoch);
        
        // Wait for next order
        const waitTime = Math.min(interval, sellTime - Date.now() - 5000);
        if (waitTime > 0 && orderNum < CONFIG.targetOrders) {
            console.log(`   ⏳ Next order in ${Math.floor(waitTime / 1000)}s...\n`);
            await sleep(waitTime);
        }
    }
    
    // Wait until sell time
    const waitUntilSell = sellTime - Date.now();
    if (waitUntilSell > 0) {
        console.log(`\n⏳ Waiting ${Math.floor(waitUntilSell / 1000)}s until exit phase...\n`);
        await sleep(waitUntilSell);
    }
    
    // EXIT PHASE - Close non-hold positions
    console.log('─'.repeat(50));
    console.log('     EXIT PHASE (Sell Early)');
    console.log('─'.repeat(50) + '\n');
    
    for (const pos of positions.values()) {
        if (!pos.closed && !pos.holdToExpiry && pos.epoch === epoch) {
            await closePosition(pos, 'sell_early');
            await sleep(500);
        }
    }
    
    // Wait for expiry
    const waitUntilExpiry = endTime - Date.now() + 5000;  // 5s after expiry
    if (waitUntilExpiry > 0) {
        const holdPositions = Array.from(positions.values()).filter(p => !p.closed && p.holdToExpiry && p.epoch === epoch);
        console.log(`\n⏳ Waiting ${Math.floor(waitUntilExpiry / 1000)}s for expiry (${holdPositions.length} positions held)...\n`);
        await sleep(waitUntilExpiry);
    }
    
    // EXPIRY PHASE - Check hold positions
    console.log('─'.repeat(50));
    console.log('     EXPIRY PHASE (Hold to Expiry)');
    console.log('─'.repeat(50) + '\n');
    
    for (const pos of positions.values()) {
        if (!pos.closed && pos.holdToExpiry && pos.epoch === epoch) {
            const balance = await getBalance(pos.tokenId);
            const spot = await getSpotPrice(pos.crypto);
            
            // Check if we won (balance should be worth ~$1/share if won, ~$0 if lost)
            const prices = await getBookPrices(pos.tokenId);
            const estimatedValue = balance * (prices.bid > 0.5 ? 1.0 : prices.bid);
            
            pos.closed = true;
            pos.closeReason = 'expiry';
            pos.exitTime = new Date().toISOString();
            pos.balanceAtExpiry = balance;
            pos.spotAtExit = spot;
            pos.estimatedExitValue = estimatedValue;
            
            const pnl = estimatedValue - pos.entryCost;
            pos.pnl = pnl;
            tradeStats.positionsExpired++;
            tradeStats.totalPnL += pnl;
            
            const won = prices.bid > 0.5;
            console.log(`   ${pos.crypto.toUpperCase()} ${pos.direction.toUpperCase()} - ${won ? '✅ WON' : '❌ LOST'} | Balance: ${balance.toFixed(4)} | Est. Value: $${estimatedValue.toFixed(2)} | P&L: $${pnl.toFixed(4)}`);
            
            results.expiryResults.push({
                crypto: pos.crypto,
                direction: pos.direction,
                won,
                balance,
                entryPrice: pos.entryPrice,
                exitBid: prices.bid,
                pnl
            });
        }
    }
    
    // Summary
    console.log('\n' + '═'.repeat(70));
    console.log('     CYCLE SUMMARY');
    console.log('═'.repeat(70));
    console.log(`Orders placed: ${tradeStats.ordersPlaced}`);
    console.log(`Orders filled: ${tradeStats.ordersFilled}`);
    console.log(`Orders failed: ${tradeStats.ordersFailed}`);
    console.log(`Positions closed early: ${tradeStats.positionsClosed}`);
    console.log(`Positions held to expiry: ${tradeStats.positionsExpired}`);
    console.log(`Total P&L: $${tradeStats.totalPnL.toFixed(4)}`);
    console.log('═'.repeat(70) + '\n');
    
    // Save results
    results.endTime = new Date().toISOString();
    results.stats = tradeStats;
    fs.mkdirSync('./data', { recursive: true });
    fs.writeFileSync(CONFIG.logFile, JSON.stringify(results, null, 2));
    console.log(`💾 Results saved to ${CONFIG.logFile}\n`);
}

async function main() {
    console.log('\n' + '═'.repeat(70));
    console.log('     RAPID CYCLE TEST');
    console.log('═'.repeat(70));
    console.log(`Cryptos: ${CONFIG.cryptos.join(', ').toUpperCase()}`);
    console.log(`Target orders: ${CONFIG.targetOrders}`);
    console.log(`$ per trade: $${CONFIG.dollarsPerTrade}`);
    console.log(`Hold to expiry: ${CONFIG.holdToExpiryPct * 100}%`);
    console.log('═'.repeat(70));
    
    // Start kill switch API
    const server = startKillSwitchAPI();
    
    // Initialize client
    await initClient();
    
    // Check if we should wait for next window
    const now = Math.floor(Date.now() / 1000);
    const epoch = Math.floor(now / 900) * 900;
    const timeInWindow = now - epoch;
    
    if (timeInWindow > 600) {  // More than 10 mins in, wait for next
        const nextEpoch = epoch + 900;
        const waitTime = (nextEpoch - now + 5) * 1000;
        console.log(`\n⏳ Window ${Math.floor((900 - timeInWindow))}s remaining - waiting ${Math.floor(waitTime / 1000)}s for fresh window...\n`);
        await sleep(waitTime);
    }
    
    await runCycle();
    
    // Cleanup
    server.close();
    console.log('✅ Test complete!\n');
}

main().catch(err => {
    console.error('\n❌ Fatal:', err);
    results.error = err.message;
    results.endTime = new Date().toISOString();
    fs.mkdirSync('./data', { recursive: true });
    fs.writeFileSync(CONFIG.logFile, JSON.stringify(results, null, 2));
    process.exit(1);
});
