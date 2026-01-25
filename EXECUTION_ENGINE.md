# Polymarket Execution Engine - Technical Reference

> **PRODUCTION TESTED** - This document contains learnings from live trading on Polymarket's 15-minute crypto prediction markets.

## Table of Contents
1. [Quick Start](#quick-start)
2. [Authentication Deep Dive](#authentication-deep-dive)
3. [Order Lifecycle](#order-lifecycle)
4. [Position Management](#position-management)
5. [Critical Implementation Details](#critical-implementation-details)
6. [Common Errors & Solutions](#common-errors--solutions)
7. [Architecture](#architecture)

---

## Quick Start

### Minimum Working Example: Buy and Sell

```javascript
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

// CRITICAL: ethers v6 compatibility wrapper
function createCompatibleWallet(privateKey) {
    const wallet = new Wallet(privateKey);
    wallet._signTypedData = (d, t, v) => wallet.signTypedData(d, t, v);
    return wallet;
}

async function main() {
    const wallet = createCompatibleWallet(process.env.POLYMARKET_PRIVATE_KEY);
    const funder = process.env.POLYMARKET_FUNDER_ADDRESS; // Your Polymarket proxy
    
    // Step 1: Derive API credentials from wallet
    const baseClient = new ClobClient(HOST, CHAIN_ID, wallet);
    const creds = await baseClient.deriveApiKey();
    
    // Step 2: Create authenticated client with signature type 2
    const client = new ClobClient(HOST, CHAIN_ID, wallet, creds, 2, funder);
    
    // Step 3: Buy shares
    const buyOrder = await client.createAndPostOrder({
        tokenID: 'YOUR_TOKEN_ID',
        price: 0.50,      // 50 cents per share
        side: 'BUY',
        size: 2           // 2 shares = $1 cost
    }, { tickSize: '0.01', negRisk: false }, 'GTC');
    
    // Step 4: Sell shares (use actual balance, not expected)
    const bal = await client.getBalanceAllowance({ 
        asset_type: 'CONDITIONAL', 
        token_id: 'YOUR_TOKEN_ID' 
    });
    const actualShares = parseFloat(bal.balance) / 1e6;
    
    const sellOrder = await client.createAndPostOrder({
        tokenID: 'YOUR_TOKEN_ID',
        price: 0.55,
        side: 'SELL',
        size: Math.floor(actualShares)  // Sell whole shares only
    }, { tickSize: '0.01', negRisk: false }, 'GTC');
}
```

---

## Authentication Deep Dive

### The Three Identity Problem

Polymarket uses a proxy wallet system. You need to understand three addresses:

| Address | What It Is | Where It Comes From |
|---------|------------|---------------------|
| **Signer** | Your actual wallet (Coinbase, MetaMask, etc.) | `wallet.address` |
| **Proxy/Funder** | Polymarket-generated proxy wallet | Polymarket UI Profile |
| **API Key Address** | Address the API key is bound to | Must match signer |

### Getting Your Addresses

1. **Signer Address**: Your wallet's public address
2. **Funder Address**: Go to polymarket.com → Profile → Copy the address shown

### Signature Types

| Type | Name | When to Use |
|------|------|-------------|
| 0 | EOA | Direct wallet trading (maker = signer) |
| 1 | Poly Proxy | Deprecated |
| **2** | **Gnosis Safe / Proxy** | **USE THIS** for Coinbase/proxy wallets |

### API Credential Flow

```
┌─────────────────────┐
│   Your Wallet       │
│   (Private Key)     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  client.deriveApiKey()  │  ← Signs a message to prove ownership
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   API Credentials   │
│   - key             │  ← Bound to YOUR wallet address
│   - secret          │
│   - passphrase      │
└─────────────────────┘
```

**IMPORTANT**: API credentials from Polymarket's UI are bound to your proxy address, not your signer. Always use `deriveApiKey()` to get credentials that work with your wallet.

### Environment Variables

```bash
# .env.local
POLYMARKET_PRIVATE_KEY=0x7b24209e09b1683a5...  # Your wallet private key
POLYMARKET_FUNDER_ADDRESS=0xDd0e09CCa1291...   # From Polymarket profile
POLYMARKET_SIG_TYPE=2                           # Always 2 for proxy setup
```

---

## Order Lifecycle

### Order Flow

```
┌──────────┐    ┌───────────┐    ┌────────┐    ┌────────┐
│  CREATE  │───▶│  SUBMIT   │───▶│  MATCH │───▶│ SETTLE │
└──────────┘    └───────────┘    └────────┘    └────────┘
     │               │                │             │
     │               │                │             │
     ▼               ▼                ▼             ▼
  Validate      EIP-712 Sign     Exchange      On-chain
  Params        + HMAC Auth      Matching      Settlement
```

### Order Types

| Type | Behavior | Use Case |
|------|----------|----------|
| **GTC** | Good Till Cancel - stays on book | Limit orders, best for entries |
| **GTD** | Good Till Date - expires at time | Not commonly used |
| **FOK** | Fill Or Kill - all or nothing | Market orders |
| **IOC** | Immediate Or Cancel - partial fill OK | Quick execution |

### Order Response Structure

```javascript
{
  "errorMsg": "",
  "orderID": "0x40cab78b449684469aa41acc11c7b9f7f66ae0801dbc048ab0a122a150531b93",
  "takingAmount": "1.94",     // Amount received (USDC for sells)
  "makingAmount": "2",        // Amount given (shares for sells)
  "status": "matched",        // matched, live, cancelled
  "transactionsHashes": [
    "0xdb637e120b4c2865698bd41649086950170009f48baa531b3135e82cb928c8c3"
  ],
  "success": true
}
```

---

## Position Management

### Getting Your Balance

```javascript
const bal = await client.getBalanceAllowance({ 
    asset_type: 'CONDITIONAL', 
    token_id: tokenId 
});

// Response:
{
  "balance": "2961200",  // In micro-units (6 decimals)
  "allowances": {
    "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E": "max",
    "0xC5d563A36AE78145C45a50134d48A1215220f80a": "max",
    "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296": "max"
  }
}

// To get actual shares:
const shares = parseFloat(bal.balance) / 1_000_000;  // = 2.9612 shares
```

### Why Balance Differs from Bought Quantity

When you buy 3 shares at $0.35:
- Expected: 3.00 shares
- Actual: ~2.96 shares (after ~1% fee)

**ALWAYS check actual balance before selling.**

### Closing Positions

```javascript
// 1. Get actual balance
const bal = await client.getBalanceAllowance({ 
    asset_type: 'CONDITIONAL', 
    token_id: tokenId 
});
const actualShares = parseFloat(bal.balance) / 1e6;

// 2. Get current bid price
const priceRes = await fetch(`${HOST}/price?token_id=${tokenId}&side=buy`);
const bidPrice = parseFloat((await priceRes.json()).price);

// 3. Sell at bid (or slightly below for guaranteed fill)
const sellOrder = await client.createAndPostOrder({
    tokenID: tokenId,
    price: bidPrice,
    side: 'SELL',
    size: Math.floor(actualShares)  // Round down to avoid errors
}, { tickSize: '0.01', negRisk: false }, 'GTC');
```

### Position Expiry

15-minute markets expire automatically:
- **If you hold UP** and price ends higher: You get $1 per share
- **If you hold UP** and price ends lower: Shares become worthless
- **If you hold DOWN** and price ends lower: You get $1 per share
- **If you hold DOWN** and price ends higher: Shares become worthless

Sometimes it's better to hold to expiry than sell early (e.g., if UP bid is $0.92 but you're confident UP will win).

---

## Critical Implementation Details

### ethers v6 Compatibility

The Polymarket SDK expects ethers v5's `_signTypedData` method. ethers v6 renamed it to `signTypedData`. Add this wrapper:

```javascript
function createCompatibleWallet(privateKey) {
    const wallet = new Wallet(privateKey);
    wallet._signTypedData = async (domain, types, value) => {
        return wallet.signTypedData(domain, types, value);
    };
    return wallet;
}
```

### Size Units

**Size is in SHARES, not dollars:**

```javascript
// WRONG - this tries to buy $0.50 worth
await client.createAndPostOrder({ size: 0.50, price: 0.50, ... });

// RIGHT - buy 2 shares at $0.50 each = $1.00
await client.createAndPostOrder({ size: 2, price: 0.50, ... });
```

To buy a dollar amount:
```javascript
const dollars = 1.00;
const price = 0.50;
const shares = Math.ceil(dollars / price);  // = 2 shares
```

### Minimum Order Size

Polymarket requires minimum $1 order value:
```javascript
const shares = size;
const price = orderPrice;
const orderValue = shares * price;

if (orderValue < 1.0) {
    throw new Error('Order value must be >= $1');
}
```

### Tick Size

Prices must align to tick size (usually 0.01):
```javascript
const tickSize = 0.01;
const roundedPrice = Math.round(price / tickSize) * tickSize;
```

### Getting Current Market

```javascript
const GAMMA_API = 'https://gamma-api.polymarket.com';

async function getCurrentMarket(crypto = 'btc') {
    const now = Math.floor(Date.now() / 1000);
    const epoch = Math.floor(now / 900) * 900;  // Current 15-min window
    const slug = `${crypto}-updown-15m-${epoch}`;
    
    const res = await fetch(`${GAMMA_API}/markets?slug=${slug}`);
    const markets = await res.json();
    const market = markets[0];
    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    
    return {
        slug,
        upTokenId: tokenIds[0],
        downTokenId: tokenIds[1],
        endDate: new Date(market.endDate)
    };
}
```

---

## Common Errors & Solutions

### "invalid signature"

**Cause**: Wrong signature type or maker address mismatch

**Fix**: Use signature type 2 with your Polymarket proxy as funder:
```javascript
const client = new ClobClient(HOST, CHAIN_ID, wallet, creds, 2, funderAddress);
```

### "not enough balance / allowance"

**Causes & Fixes**:
1. **Selling more than you have**: Check actual balance with `getBalanceAllowance()`
2. **Wrong funder address**: Ensure `POLYMARKET_FUNDER_ADDRESS` is your Polymarket proxy
3. **Insufficient USDC**: Deposit more to Polymarket

### "min size: $1"

**Cause**: Order value < $1

**Fix**: Increase shares:
```javascript
const minShares = Math.ceil(1.0 / price);
const shares = Math.max(minShares, requestedShares);
```

### "invalid amounts"

**Cause**: Too many decimal places in share quantity

**Fix**: Use whole numbers for shares:
```javascript
const shares = Math.floor(desiredShares);  // or Math.ceil for minimum
```

### 401 Unauthorized / Invalid API Key

**Cause**: API credentials bound to wrong address

**Fix**: Always derive credentials from your wallet:
```javascript
const baseClient = new ClobClient(HOST, CHAIN_ID, wallet);
const creds = await baseClient.deriveApiKey();  // Creates new creds bound to your wallet
```

### "Error: Request timed out"

**Cause**: Network issues or exchange congestion

**Fix**: Implement retry with exponential backoff:
```javascript
async function withRetry(fn, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (e) {
            if (i === maxRetries - 1) throw e;
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
        }
    }
}
```

---

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────────────┐
│                      EXECUTION ENGINE                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   DATA FEEDS                    STRATEGY                            │
│   ┌──────────────┐             ┌──────────────┐                     │
│   │ Polymarket   │─────┐       │   Signal     │                     │
│   │ WebSocket    │     │       │  Generator   │                     │
│   │ (orderbook)  │     │       └──────┬───────┘                     │
│   └──────────────┘     │              │                              │
│                        ▼              ▼                              │
│   ┌──────────────┐   ┌─────────────────────┐                        │
│   │   Binance    │──▶│   TICK PROCESSOR    │                        │
│   │  WebSocket   │   │  - Merge data       │                        │
│   │   (spot)     │   │  - Calculate spread │                        │
│   └──────────────┘   │  - Detect signals   │                        │
│                      └──────────┬──────────┘                        │
│                                 │                                    │
│                      ┌──────────▼──────────┐                        │
│                      │   RISK MANAGER      │                        │
│                      │   - Kill switch     │                        │
│                      │   - Circuit breaker │                        │
│                      │   - Position limits │                        │
│                      │   - Loss limits     │                        │
│                      └──────────┬──────────┘                        │
│                                 │                                    │
│                      ┌──────────▼──────────┐                        │
│                      │   ORDER MANAGER     │                        │
│                      │   - State machine   │                        │
│                      │   - Audit trail     │                        │
│                      │   - P&L tracking    │                        │
│                      └──────────┬──────────┘                        │
│                                 │                                    │
│                      ┌──────────▼──────────┐                        │
│                      │  POLYMARKET CLIENT  │                        │
│                      │  - HMAC auth        │                        │
│                      │  - EIP-712 signing  │                        │
│                      │  - Order execution  │                        │
│                      └─────────────────────┘                        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Market Data In**: Polymarket orderbook + Binance spot prices via WebSocket
2. **Tick Processing**: Merge data, calculate spreads, time remaining
3. **Signal Generation**: Strategy evaluates tick, generates buy/sell/hold
4. **Risk Validation**: Check limits, circuit breaker, kill switch
5. **Order Execution**: Sign and submit to Polymarket CLOB
6. **Position Tracking**: Update positions, calculate P&L
7. **State Persistence**: Save state every 10s for crash recovery

### File Structure

```
src/execution/
├── index.js                 # Module exports
├── polymarket_client.js     # Custom API client (reference)
├── order_state_machine.js   # Order lifecycle tracking
├── risk_manager.js          # Risk controls
├── execution_engine.js      # Main orchestrator
└── health_monitor.js        # Monitoring & alerts

scripts/
├── test_roundtrip.mjs       # Full buy/sell test
└── run_execution_engine.mjs # Production launcher
```

---

## Production Checklist

Before going live:

- [ ] Environment variables configured
- [ ] `POLYMARKET_SIG_TYPE=2` set
- [ ] Funder address is your Polymarket proxy (not signer)
- [ ] API credentials derived from wallet (not from UI)
- [ ] ethers v6 compatibility wrapper in place
- [ ] Tested buy order ($1)
- [ ] Tested sell order (checked actual balance first)
- [ ] Kill switch file test: `touch KILL_SWITCH`
- [ ] Risk limits configured appropriately
- [ ] Health monitoring enabled

## Scaling Strategy

| Phase | Max Trade Size | Max Daily Loss | Duration |
|-------|---------------|----------------|----------|
| Testing | $1 | $5 | Until 10+ successful round-trips |
| Phase 1 | $5 | $20 | 1 week |
| Phase 2 | $10 | $50 | 2 weeks |
| Phase 3 | $25 | $100 | 4 weeks |
| Production | Based on bankroll | 5% of bankroll | Ongoing |

---

## Summary

The key gotchas for Polymarket execution:

1. **Always use signature type 2** with your Polymarket proxy as funder
2. **Always derive API credentials** from your wallet
3. **Always add the ethers v6 wrapper** (`_signTypedData`)
4. **Always check actual balance** before selling (fees reduce shares)
5. **Size is in shares**, not dollars
6. **Minimum order is $1** value
