#!/usr/bin/env node
/**
 * Multi-Cycle Multi-Instrument Test
 * 
 * Executes trades across multiple cryptos over multiple 15-min cycles.
 * Collects comprehensive data on each trade.
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import fs from 'fs';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const GAMMA_API = 'https://gamma-api.polymarket.com';

const CONFIG = {
    cryptos: ['xrp', 'sol', 'eth'],
    dollarsPerTrade: 1.0,
    cycles: 2,
    side: 'up',  // Trade UP tokens
    sellBeforeExpiry: true,  // Sell 60s before expiry instead of holding
    sellBuffer: 60,  // Seconds before expiry to sell
    logFile: `./data/multi_cycle_test_${Date.now()}.json`
};

// ═══════════════════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════════════════

function createCompatibleWallet(privateKey) {
    const wallet = new Wallet(privateKey);
    wallet._signTypedData = (d, t, v) => wallet.signTypedData(d, t, v);
    return wallet;
}

let client = null;
const results = {
    startTime: new Date().toISOString(),
    config: CONFIG,
    cycles: []
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

async function getMarket(crypto, epoch = null) {
    const now = Math.floor(Date.now() / 1000);
    epoch = epoch || Math.floor(now / 900) * 900;
    const slug = `${crypto}-updown-15m-${epoch}`;
    
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
}

async function getBookAndPrices(tokenId) {
    const book = await client.getOrderBook(tokenId);
    const bids = book.bids || [];
    const asks = book.asks || [];
    
    const bestBid = bids.length > 0 ? Math.max(...bids.map(b => parseFloat(b.price))) : 0;
    const bestAsk = asks.length > 0 ? Math.min(...asks.map(a => parseFloat(a.price))) : 1;
    
    return {
        bid: bestBid,
        ask: bestAsk,
        spread: bestAsk - bestBid,
        midpoint: (bestBid + bestAsk) / 2,
        bidDepth: bids.reduce((s, b) => s + parseFloat(b.size) * parseFloat(b.price), 0),
        askDepth: asks.reduce((s, a) => s + parseFloat(a.size) * parseFloat(a.price), 0)
    };
}

async function getBalance(tokenId) {
    try {
        const bal = await client.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenId });
        return parseFloat(bal.balance) / 1e6;
    } catch { return 0; }
}

async function getSpotPrice(crypto) {
    try {
        const symbol = crypto === 'btc' ? 'BTCUSDT' : 
                       crypto === 'eth' ? 'ETHUSDT' : 
                       crypto === 'sol' ? 'SOLUSDT' : 
                       crypto === 'xrp' ? 'XRPUSDT' : null;
        if (!symbol) return null;
        
        const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
        const data = await res.json();
        return parseFloat(data.price);
    } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// TRADING
// ═══════════════════════════════════════════════════════════════════════════

async function buy(tokenId, dollars, price) {
    const shares = Math.ceil(dollars / price);
    
    const order = await client.createAndPostOrder({
        tokenID: tokenId,
        price: price,
        side: 'BUY',
        size: shares
    }, { tickSize: '0.01', negRisk: false }, 'GTC');
    
    return {
        orderId: order.orderID,
        status: order.status,
        shares,
        price,
        cost: shares * price,
        tx: order.transactionsHashes?.[0],
        filled: order.status === 'matched'
    };
}

async function sell(tokenId, shares, price) {
    const actualShares = Math.floor(shares);
    if (actualShares < 1) return null;
    
    const order = await client.createAndPostOrder({
        tokenID: tokenId,
        price: price,
        side: 'SELL',
        size: actualShares
    }, { tickSize: '0.01', negRisk: false }, 'GTC');
    
    return {
        orderId: order.orderID,
        status: order.status,
        shares: actualShares,
        price,
        value: actualShares * price,
        tx: order.transactionsHashes?.[0],
        filled: order.status === 'matched'
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// CYCLE EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

async function runCycle(cycleNum, epoch = null) {
    const now = Math.floor(Date.now() / 1000);
    epoch = epoch || Math.floor(now / 900) * 900;
    
    console.log('\n' + '═'.repeat(70));
    console.log(`     CYCLE ${cycleNum} - Epoch ${epoch}`);
    console.log('═'.repeat(70));
    
    const cycleData = {
        cycleNum,
        epoch,
        startTime: new Date().toISOString(),
        trades: []
    };
    
    // Entry phase
    console.log('\n📈 ENTRY PHASE\n');
    
    for (const crypto of CONFIG.cryptos) {
        console.log(`─── ${crypto.toUpperCase()} ───`);
        
        const tradeData = {
            crypto,
            epoch,
            entry: null,
            exit: null,
            spotAtEntry: null,
            spotAtExit: null,
            pnl: null
        };
        
        try {
            const market = await getMarket(crypto, epoch);
            if (!market) {
                console.log(`   ❌ Market not found`);
                tradeData.error = 'Market not found';
                cycleData.trades.push(tradeData);
                continue;
            }
            
            const tokenId = CONFIG.side === 'up' ? market.upTokenId : market.downTokenId;
            const prices = await getBookAndPrices(tokenId);
            const spotPrice = await getSpotPrice(crypto);
            
            tradeData.spotAtEntry = spotPrice;
            tradeData.marketAtEntry = {
                bid: prices.bid,
                ask: prices.ask,
                spread: prices.spread,
                bidDepth: prices.bidDepth,
                askDepth: prices.askDepth
            };
            
            console.log(`   Spot: $${spotPrice?.toFixed(4) || 'N/A'}`);
            console.log(`   UP Bid/Ask: $${prices.bid.toFixed(4)} / $${prices.ask.toFixed(4)}`);
            console.log(`   Spread: ${(prices.spread * 100).toFixed(2)}%`);
            
            // Buy
            const buyPrice = Math.min(prices.ask + 0.01, 0.99);
            console.log(`   Buying at $${buyPrice.toFixed(4)}...`);
            
            const buyResult = await buy(tokenId, CONFIG.dollarsPerTrade, buyPrice);
            tradeData.entry = {
                time: new Date().toISOString(),
                ...buyResult
            };
            
            console.log(`   ✅ Bought ${buyResult.shares} shares @ $${buyResult.price.toFixed(4)} = $${buyResult.cost.toFixed(2)}`);
            console.log(`   Order: ${buyResult.orderId}`);
            
        } catch (e) {
            console.log(`   ❌ Error: ${e.message}`);
            tradeData.error = e.message;
        }
        
        cycleData.trades.push(tradeData);
        await sleep(1000);
    }
    
    // Wait for exit time
    const exitTime = (epoch + 900 - CONFIG.sellBuffer) * 1000;
    const waitMs = exitTime - Date.now();
    
    if (waitMs > 0 && CONFIG.sellBeforeExpiry) {
        console.log(`\n⏳ Waiting ${Math.floor(waitMs / 1000)}s until ${CONFIG.sellBuffer}s before expiry...`);
        
        // Show countdown every 30 seconds
        let remaining = waitMs;
        while (remaining > 0) {
            const waitChunk = Math.min(remaining, 30000);
            await sleep(waitChunk);
            remaining -= waitChunk;
            if (remaining > 0) {
                console.log(`   ${Math.floor(remaining / 1000)}s remaining...`);
            }
        }
    }
    
    // Exit phase
    console.log('\n📉 EXIT PHASE\n');
    
    for (const tradeData of cycleData.trades) {
        if (tradeData.error || !tradeData.entry?.filled) continue;
        
        const crypto = tradeData.crypto;
        console.log(`─── ${crypto.toUpperCase()} ───`);
        
        try {
            const market = await getMarket(crypto, epoch);
            const tokenId = CONFIG.side === 'up' ? market.upTokenId : market.downTokenId;
            
            const balance = await getBalance(tokenId);
            const prices = await getBookAndPrices(tokenId);
            const spotPrice = await getSpotPrice(crypto);
            
            tradeData.spotAtExit = spotPrice;
            tradeData.marketAtExit = {
                bid: prices.bid,
                ask: prices.ask,
                spread: prices.spread
            };
            
            console.log(`   Spot: $${spotPrice?.toFixed(4) || 'N/A'}`);
            console.log(`   UP Bid: $${prices.bid.toFixed(4)}`);
            console.log(`   Balance: ${balance.toFixed(4)} shares`);
            
            if (balance < 1) {
                console.log(`   ⚠️ Balance too low to sell`);
                continue;
            }
            
            // Sell
            const sellPrice = prices.bid;
            console.log(`   Selling at $${sellPrice.toFixed(4)}...`);
            
            const sellResult = await sell(tokenId, balance, sellPrice);
            if (sellResult) {
                tradeData.exit = {
                    time: new Date().toISOString(),
                    ...sellResult
                };
                
                // Calculate P&L
                const entryCost = tradeData.entry.cost;
                const exitValue = sellResult.value;
                tradeData.pnl = exitValue - entryCost;
                
                console.log(`   ✅ Sold ${sellResult.shares} shares @ $${sellResult.price.toFixed(4)} = $${sellResult.value.toFixed(2)}`);
                console.log(`   P&L: $${tradeData.pnl.toFixed(4)}`);
            }
            
        } catch (e) {
            console.log(`   ❌ Error: ${e.message}`);
            tradeData.exitError = e.message;
        }
        
        await sleep(1000);
    }
    
    cycleData.endTime = new Date().toISOString();
    
    // Summary
    const filledTrades = cycleData.trades.filter(t => t.entry?.filled);
    const closedTrades = cycleData.trades.filter(t => t.exit?.filled);
    const totalPnL = closedTrades.reduce((s, t) => s + (t.pnl || 0), 0);
    
    cycleData.summary = {
        tradesAttempted: cycleData.trades.length,
        tradesFilled: filledTrades.length,
        tradesClosed: closedTrades.length,
        totalPnL
    };
    
    console.log('\n' + '─'.repeat(50));
    console.log(`Cycle ${cycleNum} Summary:`);
    console.log(`   Trades: ${filledTrades.length}/${cycleData.trades.length} filled`);
    console.log(`   Closed: ${closedTrades.length}`);
    console.log(`   Total P&L: $${totalPnL.toFixed(4)}`);
    
    return cycleData;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    console.log('\n' + '═'.repeat(70));
    console.log('     MULTI-CYCLE MULTI-INSTRUMENT TEST');
    console.log('═'.repeat(70));
    console.log(`Cryptos: ${CONFIG.cryptos.join(', ').toUpperCase()}`);
    console.log(`Cycles: ${CONFIG.cycles}`);
    console.log(`$ per trade: $${CONFIG.dollarsPerTrade}`);
    console.log(`Side: ${CONFIG.side.toUpperCase()}`);
    console.log(`Sell before expiry: ${CONFIG.sellBeforeExpiry} (${CONFIG.sellBuffer}s buffer)`);
    console.log('═'.repeat(70));
    
    await initClient();
    
    for (let i = 1; i <= CONFIG.cycles; i++) {
        // Get current epoch
        const now = Math.floor(Date.now() / 1000);
        const currentEpoch = Math.floor(now / 900) * 900;
        const timeInWindow = now - currentEpoch;
        
        // If we're past the sell window for current epoch, wait for next
        if (timeInWindow > (900 - CONFIG.sellBuffer - 60)) {
            const nextEpoch = currentEpoch + 900;
            const waitTime = (nextEpoch - now + 5) * 1000;
            console.log(`\n⏳ Waiting ${Math.floor(waitTime / 1000)}s for next window...`);
            await sleep(waitTime);
        }
        
        const cycleData = await runCycle(i);
        results.cycles.push(cycleData);
        
        // Save after each cycle
        fs.mkdirSync('./data', { recursive: true });
        fs.writeFileSync(CONFIG.logFile, JSON.stringify(results, null, 2));
        console.log(`\n💾 Data saved to ${CONFIG.logFile}`);
        
        // Wait for next cycle if not the last
        if (i < CONFIG.cycles) {
            const now2 = Math.floor(Date.now() / 1000);
            const nextEpoch = Math.floor(now2 / 900) * 900 + 900;
            const waitTime = (nextEpoch - now2 + 5) * 1000;
            console.log(`\n⏳ Waiting ${Math.floor(waitTime / 1000)}s for next cycle...`);
            await sleep(waitTime);
        }
    }
    
    // Final summary
    results.endTime = new Date().toISOString();
    
    console.log('\n' + '═'.repeat(70));
    console.log('     FINAL SUMMARY');
    console.log('═'.repeat(70));
    
    let totalTrades = 0, totalFilled = 0, totalClosed = 0, grandPnL = 0;
    
    for (const cycle of results.cycles) {
        totalTrades += cycle.summary.tradesAttempted;
        totalFilled += cycle.summary.tradesFilled;
        totalClosed += cycle.summary.tradesClosed;
        grandPnL += cycle.summary.totalPnL;
    }
    
    console.log(`Total Cycles: ${results.cycles.length}`);
    console.log(`Total Trades: ${totalFilled}/${totalTrades} filled`);
    console.log(`Total Closed: ${totalClosed}`);
    console.log(`Grand Total P&L: $${grandPnL.toFixed(4)}`);
    console.log('═'.repeat(70));
    
    // Save final
    fs.writeFileSync(CONFIG.logFile, JSON.stringify(results, null, 2));
    console.log(`\n✅ Complete! Data saved to ${CONFIG.logFile}\n`);
}

main().catch(err => {
    console.error('\n❌ Fatal:', err);
    // Save what we have
    results.error = err.message;
    results.endTime = new Date().toISOString();
    fs.mkdirSync('./data', { recursive: true });
    fs.writeFileSync(CONFIG.logFile, JSON.stringify(results, null, 2));
    process.exit(1);
});
