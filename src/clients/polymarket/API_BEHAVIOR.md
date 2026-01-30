# Polymarket API Behavior Documentation

This document describes the observed behavior of the Polymarket CLOB API as integrated into this module. All endpoints, parameters, response formats, and error codes are documented here for reference.

## Base URLs

| Service | URL |
|---------|-----|
| REST API | `https://clob.polymarket.com` |
| WebSocket | `wss://ws-subscriptions-clob.polymarket.com/ws/market` |
| Gamma API | `https://gamma-api.polymarket.com` |

## Rate Limits

**Observed Rate Limits:**
- Minimum interval between requests: **100ms**
- Rate limit error: HTTP 429
- Backoff strategy: Exponential (100ms → 200ms → 400ms → ... max 10s)
- Maximum retries: 3

**Rate Limit Headers (when applicable):**
- Response may include `X-RateLimit-*` headers
- Rate limit events are logged for monitoring

## Authentication

### L2 HMAC Authentication

All authenticated endpoints require L2 HMAC authentication headers.

**Required Headers:**
```
POLY_ADDRESS: <signer_address>
POLY_SIGNATURE: <hmac_signature>
POLY_TIMESTAMP: <unix_timestamp_seconds>
POLY_API_KEY: <api_key>
POLY_PASSPHRASE: <passphrase>
```

**Signature Generation:**
```javascript
const message = timestamp + method.toUpperCase() + path + body;
const signature = crypto.createHmac('sha256', Buffer.from(apiSecret, 'base64'))
  .update(message)
  .digest('base64');
```

### API Key Derivation

New API keys can be derived from wallet signature:
```javascript
const baseClient = new ClobClient(HOST, CHAIN_ID, wallet);
const creds = await baseClient.deriveApiKey();
```

## Public Endpoints (No Authentication)

### GET /time

Returns server time for synchronization.

**Response:**
```json
{
  "timestamp": 1706000000
}
```

### GET /book

Returns order book for a token.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| token_id | string | Yes | Token ID |

**Response:**
```json
{
  "bids": [
    { "price": "0.45", "size": "100" },
    { "price": "0.44", "size": "200" }
  ],
  "asks": [
    { "price": "0.55", "size": "100" },
    { "price": "0.56", "size": "150" }
  ]
}
```

### GET /midpoint

Returns midpoint price for a token.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| token_id | string | Yes | Token ID |

**Response:**
```json
{
  "mid": "0.50"
}
```

### GET /price

Returns best price for a side.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| token_id | string | Yes | Token ID |
| side | string | Yes | `buy` or `sell` |

**Response:**
```json
{
  "price": "0.55"
}
```

### GET /spread

Returns bid-ask spread for a token.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| token_id | string | Yes | Token ID |

**Response:**
```json
{
  "spread": "0.10"
}
```

### GET /tick-size

Returns minimum tick size for a token.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| token_id | string | Yes | Token ID |

**Response:**
```json
{
  "minimum_tick_size": "0.01"
}
```

## Authenticated Endpoints

### GET /nonce

Returns current nonce for order signing.

**Response:**
```json
{
  "nonce": "12345"
}
```

### GET /auth/api-key

Returns API key information.

**Response:**
```json
{
  "apiKey": "...",
  "createdAt": "2024-01-01T00:00:00Z"
}
```

### GET /orders

Returns open orders.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| open | boolean | No | Filter to open orders only |
| market | string | No | Filter by market |

**Response:**
```json
[
  {
    "id": "order-id-123",
    "status": "live",
    "tokenId": "...",
    "side": "BUY",
    "price": "0.50",
    "size": "100"
  }
]
```

### GET /order/{id}

Returns a specific order by ID.

**Response:**
```json
{
  "id": "order-id-123",
  "status": "matched",
  "tokenId": "...",
  "side": "BUY",
  "price": "0.50",
  "size": "100",
  "filledSize": "100",
  "transactionsHashes": ["0xabc..."]
}
```

### GET /trades

Returns trade history.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| limit | number | No | Max results (default 100) |

**Response:**
```json
[
  {
    "id": "trade-123",
    "orderId": "order-123",
    "tokenId": "...",
    "side": "BUY",
    "price": "0.50",
    "size": "50",
    "timestamp": "2024-01-01T00:00:00Z"
  }
]
```

### GET /balances

Returns token balances.

**Response:**
```json
{
  "balances": [
    {
      "tokenId": "...",
      "balance": "1000000"
    }
  ]
}
```

## Order Management

### POST /order

Places a new order.

**Request Body:**
```json
{
  "order": {
    "salt": "123...",
    "maker": "0x...",
    "signer": "0x...",
    "taker": "0x0000000000000000000000000000000000000000",
    "tokenId": "...",
    "makerAmount": "1000000",
    "takerAmount": "2000000",
    "expiration": "0",
    "nonce": "12345",
    "feeRateBps": "0",
    "side": "BUY",
    "signatureType": 2
  },
  "signature": "0x...",
  "owner": "0x...",
  "orderType": "GTC"
}
```

**Order Types:**
| Type | Description |
|------|-------------|
| GTC | Good Till Cancelled |
| GTD | Good Till Date |
| FOK | Fill Or Kill |
| IOC | Immediate Or Cancel |

**Response (Success):**
```json
{
  "orderID": "order-123",
  "status": "live",
  "success": true,
  "transactionsHashes": []
}
```

**Response (Filled - FOK/IOC):**
```json
{
  "orderID": "order-123",
  "status": "matched",
  "success": true,
  "transactionsHashes": ["0xabc..."],
  "takingAmount": "1000000",
  "makingAmount": "2000000"
}
```

### DELETE /order/{id}

Cancels a specific order.

**Response:**
```json
{
  "success": true
}
```

### DELETE /orders

Cancels all orders.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| market | string | No | Cancel only for specific market |

**Response:**
```json
{
  "success": true,
  "cancelled": 5
}
```

## Order Signing (EIP-712)

Orders are signed using EIP-712 typed data.

**Domain:**
```json
{
  "name": "Polymarket CTF Exchange",
  "version": "1",
  "chainId": 137
}
```

**Order Types:**
```javascript
{
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' }
  ]
}
```

**Signature Types:**
| Value | Description |
|-------|-------------|
| 0 | EOA (Externally Owned Account) |
| 1 | Poly Proxy |
| 2 | Gnosis Safe / Proxy Wallet |

## Error Codes

### HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Bad Request - Invalid parameters |
| 401 | Unauthorized - Invalid credentials |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource doesn't exist |
| 429 | Too Many Requests - Rate limited |
| 500 | Internal Server Error |

### API Error Codes

| Code | Description |
|------|-------------|
| INSUFFICIENT_BALANCE | Not enough balance for order |
| INVALID_SIGNATURE | Order signature verification failed |
| INVALID_NONCE | Nonce already used or invalid |
| ORDER_NOT_FOUND | Order ID doesn't exist |
| PRICE_OUT_OF_RANGE | Price not within valid range (0.01-0.99) |
| SIZE_TOO_SMALL | Order size below minimum |
| MARKET_CLOSED | Market is no longer accepting orders |

### Module Error Codes

This module wraps API errors in `PolymarketError` with these codes:

| Code | Description |
|------|-------------|
| POLYMARKET_CONNECTION_FAILED | Failed to connect to API |
| POLYMARKET_AUTH_FAILED | Authentication failed |
| POLYMARKET_RATE_LIMITED | Rate limit exceeded |
| POLYMARKET_INVALID_RESPONSE | Unexpected response format |
| POLYMARKET_ORDER_REJECTED | Order was rejected |
| POLYMARKET_INSUFFICIENT_BALANCE | Insufficient balance |
| POLYMARKET_INVALID_PRICE | Price outside valid range |
| POLYMARKET_INVALID_SIZE | Size below minimum |
| POLYMARKET_NOT_INITIALIZED | Client not initialized |

## Fill Verification

Orders are verified as filled using multi-factor verification:

```javascript
// ALL factors must pass for confirmed fill
const hasTxHash = order?.transactionsHashes?.length > 0;
const hasSuccess = order?.success === true;
const hasGoodStatus = order?.status === 'matched' || order?.status === 'live';
const filled = hasTxHash && hasSuccess && hasGoodStatus;
```

## Price Validation

Binary option prices must be between 0.01 and 0.99:

```javascript
// SANITY CHECK: Prices outside this range are invalid
if (price < 0.01 || price > 0.99) {
  throw new PolymarketError('INVALID_PRICE', ...);
}
```

## Token Allowance

Before selling conditional tokens, allowance must be set:

```javascript
await client.updateBalanceAllowance({
  asset_type: 'CONDITIONAL',
  token_id: tokenId
});
```

## Balance Units

Balances are returned in micro-units (6 decimal places):

```javascript
// Convert from API balance to human-readable
const shares = parseFloat(balance) / 1_000_000;
```

## Known Quirks

1. **ethers v6 Compatibility**: The SDK expects ethers v5's `_signTypedData` method. A shim is required:
   ```javascript
   wallet._signTypedData = async (domain, types, value) => {
     return wallet.signTypedData(domain, types, value);
   };
   ```

2. **FOK Orders**: Fill-or-kill orders that can't fill throw an error rather than returning a killed status.

3. **Price Extraction**: Actual fill prices may differ from requested (price improvement). Extract from `avgPrice`, `takingAmount/makingAmount`, or `fills` array.

4. **Signature Type 2**: Use signature type 2 for proxy wallets (most common setup).
