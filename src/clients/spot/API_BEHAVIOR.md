# Spot Price Client - API Behavior Documentation

## Overview

The spot price client provides real-time cryptocurrency price data using the Pyth Network as the primary data source. It supports BTC, ETH, SOL, and XRP.

## Price Source: Pyth Network

### Hermes API

The client uses Pyth's Hermes API for price feeds:
- **Base URL**: `https://hermes.pyth.network`
- **Endpoint**: `/v2/updates/price/latest`
- **Method**: GET
- **Rate Limit**: No explicit rate limit documented; polling at 1 second intervals is safe

### Pyth Price Feed IDs

| Crypto | Price Feed ID |
|--------|---------------|
| BTC | `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` |
| ETH | `0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace` |
| SOL | `0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` |
| XRP | `0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8` |

### Response Format

```json
{
  "parsed": [
    {
      "id": "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
      "price": {
        "price": "10500000000000",
        "expo": -8,
        "publish_time": 1738238400
      }
    }
  ]
}
```

### Price Calculation

Price = `price` × 10^`expo`

Example: `10500000000000` × 10^(-8) = `105000` USD

## Configuration

```javascript
{
  spot: {
    hermesUrl: 'https://hermes.pyth.network',  // Pyth Hermes endpoint
    pollIntervalMs: 1000,                       // Polling frequency
    staleThresholdMs: 10000,                    // Price staleness threshold
    maxConsecutiveErrors: 10,                   // Errors before disable
    reconnectBaseMs: 5000,                      // Base reconnect delay
    reconnectMaxMs: 60000,                      // Max reconnect delay
    requestTimeoutMs: 5000,                     // Request timeout
  }
}
```

## Error Handling

### Consecutive Errors

After `maxConsecutiveErrors` (default: 10) consecutive failures:
1. Source is marked as `disabled`
2. Polling stops
3. `spot_source_disabled` is logged at error level

### Reconnection Strategy

On disconnect:
1. `spot_feed_disconnected` warning emitted
2. Exponential backoff: `min(baseMs * 2^attempts, maxMs)`
3. Reconnect attempts logged with delay info
4. On success: `spot_feed_reconnected` logged, counters reset

### Staleness

Prices older than `staleThresholdMs` trigger:
- `spot_price_stale` warning with crypto and staleness value
- Staleness included in `getState()` response

## Module Interface

```javascript
import * as spotClient from './src/clients/spot/index.js';

// Initialize
await spotClient.init({ spot: { ... } });

// Get current price
const price = spotClient.getCurrentPrice('btc');
// Returns: { price, timestamp, source, staleness, raw }

// Subscribe to updates
const unsubscribe = spotClient.subscribe('eth', (price) => {
  console.log('New price:', price);
});

// Later: stop receiving updates
unsubscribe();

// Check state
const state = spotClient.getState();

// Shutdown
await spotClient.shutdown();
```

## Normalized Price Format

All prices are normalized to:

```javascript
{
  price: 105000,           // Numeric price value
  timestamp: Date,         // When price was published
  source: 'pyth',          // Price source name
  staleness: 2,            // Seconds since publication
  raw: { ... }             // Original source data
}
```

## Alternative Sources (Future)

The architecture supports additional sources:

### Chainlink (Polygon)
- Feeds: BTC, ETH, SOL (no XRP on Polygon)
- Uses ethers.js for on-chain reads
- 8 decimal precision

### Exchange WebSockets
- Coinbase, Kraken, OKX, Binance
- Real-time streaming
- Sub-second updates

See `src/collectors/` for reference implementations.
