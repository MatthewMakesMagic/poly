# Story 2.1: Polymarket API Client Integration

Status: review

## Story

As a **developer**,
I want **the Polymarket API client integrated with documented behavior**,
So that **I understand exactly how the API works before trusting it with real orders**.

## Acceptance Criteria

### AC1: Module Interface Compliance

**Given** the Polymarket client is borrowed from existing code
**When** integrating into `src/clients/polymarket/`
**Then** the client is wrapped with our module interface (init, getState, shutdown)
**And** authentication uses credentials from config (never hardcoded)
**And** the module follows folder-per-module architecture pattern

### AC2: API Behavior Documentation

**Given** API integration begins
**When** documenting API behavior
**Then** every endpoint used is documented with: URL, parameters, response format, error codes
**And** rate limits are documented and respected (NFR15)
**And** documentation is saved as `src/clients/polymarket/API_BEHAVIOR.md`

### AC3: Connection Error Handling

**Given** the client is initialized
**When** connection to Polymarket fails
**Then** a typed error is thrown with context (using PolyError from src/types/errors.js)
**And** the error is logged with level='error'
**And** automatic reconnection is attempted with exponential backoff (NFR14)

### AC4: Response Anomaly Detection

**Given** an API response is received
**When** the response format is unexpected (NFR16)
**Then** the anomaly is logged with the actual response
**And** the operation fails gracefully (not silent corruption)
**And** error includes code and context for debugging

### AC5: Rate Limit Handling

**Given** the client is making API requests
**When** rate limits are approached or hit
**Then** the client backs off gracefully (NFR15)
**And** rate limit events are logged for monitoring
**And** retries use exponential backoff (max 10s delay)

### AC6: Credential Security

**Given** the client requires API credentials
**When** credentials are loaded
**Then** they come from environment variables via config (NFR11)
**And** credentials are NEVER logged or exposed (NFR12)
**And** the redactor from logger module sanitizes any credential exposure

## Tasks / Subtasks

- [x] **Task 1: Create Client Module Structure** (AC: 1)
  - [x] 1.1 Create `src/clients/polymarket/index.js` as public interface
  - [x] 1.2 Create `src/clients/polymarket/client.js` for PolymarketClient wrapper
  - [x] 1.3 Create `src/clients/polymarket/types.js` for type definitions
  - [x] 1.4 Create `src/clients/polymarket/auth.js` for authentication handling
  - [x] 1.5 Ensure module follows folder-per-module architecture pattern

- [x] **Task 2: Wrap Existing Client with Module Interface** (AC: 1, 6)
  - [x] 2.1 Import and adapt existing `src/execution/polymarket_client.js`
  - [x] 2.2 Import and adapt existing `src/execution/sdk_client.js`
  - [x] 2.3 Implement `init(config)` that loads credentials from config (not env directly)
  - [x] 2.4 Implement `getState()` returning connection status, request stats, rate limit status
  - [x] 2.5 Implement `shutdown()` for clean disconnection
  - [x] 2.6 Ensure credentials flow: config → module, never hardcoded

- [x] **Task 3: Implement Error Handling with Typed Errors** (AC: 3, 4)
  - [x] 3.1 Create PolymarketError class extending PolyError from `src/types/errors.js`
  - [x] 3.2 Define error codes: CONNECTION_FAILED, AUTH_FAILED, RATE_LIMITED, INVALID_RESPONSE, ORDER_REJECTED
  - [x] 3.3 Implement connection retry logic with exponential backoff (100ms → 200ms → 400ms → ... max 10s)
  - [x] 3.4 Add response validation to detect unexpected formats
  - [x] 3.5 Log all errors with full context via logger module

- [x] **Task 4: Implement Rate Limiting** (AC: 5)
  - [x] 4.1 Track request timestamps and enforce minimum interval (100ms between requests)
  - [x] 4.2 Implement exponential backoff on rate limit errors (HTTP 429)
  - [x] 4.3 Log rate limit events with request details
  - [x] 4.4 Add getState() field for rate limit status

- [x] **Task 5: Create API Behavior Documentation** (AC: 2)
  - [x] 5.1 Document REST endpoints: /time, /book, /midpoint, /price, /spread, /tick-size
  - [x] 5.2 Document authenticated endpoints: /nonce, /orders, /order/{id}, /trades, /balances
  - [x] 5.3 Document order placement: POST /order with signed order payload
  - [x] 5.4 Document order cancellation: DELETE /order/{id}
  - [x] 5.5 Document error codes and rate limits
  - [x] 5.6 Save as `src/clients/polymarket/API_BEHAVIOR.md`

- [x] **Task 6: Write Tests** (AC: all)
  - [x] 6.1 Create `src/clients/polymarket/__tests__/index.test.js`
  - [x] 6.2 Test init() loads config and initializes client
  - [x] 6.3 Test getState() returns expected structure
  - [x] 6.4 Test shutdown() cleans up resources
  - [x] 6.5 Test error handling throws typed errors with context
  - [x] 6.6 Test rate limiting enforces minimum interval
  - [x] 6.7 Test credentials are not logged (mock logger and verify)
  - [x] 6.8 Test retry logic with exponential backoff

## Dev Notes

### Architecture Compliance

This story implements the **Borrowed Components** pattern from the Architecture Decision Document.

**From architecture.md#Brownfield-Approach:**
> **Borrow with Validation:**
> - Polymarket API client
> - CLOB order mechanics

**From architecture.md#Module-Interface-Contract:**
```javascript
module.exports = {
  init: async (config) => {},
  // Main operations (module-specific)
  getState: () => {},
  shutdown: async () => {}
};
```

**From architecture.md#Project-Structure:**
```
src/clients/
    polymarket/
        index.js          # Polymarket API client (borrowed)
        clob.js           # CLOB order mechanics (borrowed)
        auth.js           # Authentication handling
```

### Existing Client Code to Borrow

**CRITICAL: Do NOT rewrite from scratch - wrap existing production-tested code!**

Two existing client implementations exist and should be borrowed/wrapped:

1. **`src/execution/polymarket_client.js`** - Custom CLOB client
   - Full EIP-712 order signing
   - L2 HMAC authentication
   - Rate limiting with 100ms interval
   - Exponential backoff retry (3 attempts)
   - Public endpoints: getTime, getOrderBook, getMidpoint, getPrice, getSpread, getTickSize
   - Authenticated endpoints: getNonce, getOpenOrders, getOrder, getTrades, getBalances
   - Order management: placeOrder, cancelOrder, cancelAllOrders, marketOrder
   - Market data: getMarketBySlug, getCurrentCryptoMarket

2. **`src/execution/sdk_client.js`** - Official SDK wrapper
   - Uses @polymarket/clob-client SDK
   - ethers v6 compatibility shim (_signTypedData wrapper)
   - Signature type 2 for proxy wallets
   - Automatic credential derivation
   - Multi-factor fill verification (txHash + success + status)
   - Price improvement detection and logging
   - Binary option price validation (0.01-0.99 range)
   - Token allowance management for sells

**Recommendation:** Use SDK client for primary operations (more robust fill verification), custom client for low-level access and backup.

### API Endpoints Reference

**REST Base URL:** `https://clob.polymarket.com`
**WebSocket URL:** `wss://ws-subscriptions-clob.polymarket.com/ws/market`
**Gamma API:** `https://gamma-api.polymarket.com`

**Public Endpoints (no auth):**
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/time` | GET | Server time |
| `/book?token_id={id}` | GET | Order book |
| `/midpoint?token_id={id}` | GET | Midpoint price |
| `/price?token_id={id}&side={buy\|sell}` | GET | Best price for side |
| `/spread?token_id={id}` | GET | Bid-ask spread |
| `/tick-size?token_id={id}` | GET | Minimum tick size |

**Authenticated Endpoints (L2 HMAC):**
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/nonce` | GET | Current nonce for orders |
| `/auth/api-key` | GET | API key info |
| `/orders?open=true` | GET | Open orders |
| `/order/{id}` | GET | Order by ID |
| `/trades?limit={n}` | GET | Trade history |
| `/balances` | GET | Token balances |
| `/order` | POST | Place order |
| `/order/{id}` | DELETE | Cancel order |
| `/orders` | DELETE | Cancel all orders |

### Authentication Pattern

**L2 HMAC Authentication Headers:**
```javascript
{
  'POLY_ADDRESS': address,        // Signer address
  'POLY_SIGNATURE': signature,    // HMAC-SHA256 signature
  'POLY_TIMESTAMP': timestamp,    // Unix timestamp (seconds)
  'POLY_API_KEY': apiKey,         // API key from Polymarket UI
  'POLY_PASSPHRASE': passphrase   // Passphrase from Polymarket UI
}
```

**Signature Generation:**
```javascript
const message = timestamp + method.toUpperCase() + path + body;
const signature = crypto.createHmac('sha256', Buffer.from(apiSecret, 'base64'))
  .update(message)
  .digest('base64');
```

### Order Signing (EIP-712)

**Domain:**
```javascript
{
  name: 'Polymarket CTF Exchange',
  version: '1',
  chainId: 137  // Polygon mainnet
}
```

**Order Structure:**
- salt: uint256 (random)
- maker: address (funder)
- signer: address (wallet)
- taker: address (0x0 for any)
- tokenId: uint256
- makerAmount: uint256 (USDC for buy, shares for sell)
- takerAmount: uint256 (shares for buy, USDC for sell)
- expiration: uint256 (0 = no expiration)
- nonce: uint256 (from API)
- feeRateBps: uint256 (usually 0)
- side: uint8 (0=BUY, 1=SELL)
- signatureType: uint8 (0=EOA, 1=PolyProxy, 2=Safe)

### Error Codes to Handle

```javascript
const ERROR_CODES = {
  CONNECTION_FAILED: 'POLYMARKET_CONNECTION_FAILED',
  AUTH_FAILED: 'POLYMARKET_AUTH_FAILED',
  RATE_LIMITED: 'POLYMARKET_RATE_LIMITED',
  INVALID_RESPONSE: 'POLYMARKET_INVALID_RESPONSE',
  ORDER_REJECTED: 'POLYMARKET_ORDER_REJECTED',
  INSUFFICIENT_BALANCE: 'POLYMARKET_INSUFFICIENT_BALANCE',
  INVALID_PRICE: 'POLYMARKET_INVALID_PRICE',
  INVALID_SIZE: 'POLYMARKET_INVALID_SIZE'
};
```

### Rate Limiting Strategy

**From existing code:**
- Minimum 100ms between requests
- Exponential backoff on errors: 1s → 2s → 4s → 8s → 10s (max)
- Maximum 3 retries per request
- Log rate limit events for monitoring

### Expected Module Interface

```javascript
// src/clients/polymarket/index.js

import { createLogger } from '../../modules/logger/index.js';
import { PolymarketError } from './types.js';

let config = null;
let client = null;  // SDKClient instance
let customClient = null;  // PolymarketClient for low-level access
let log = null;
let stats = { requests: 0, errors: 0, rateLimitHits: 0 };

export async function init(cfg) {
  config = cfg.polymarket;
  log = createLogger('polymarket-client');

  // Validate required credentials
  if (!config.apiKey || !config.apiSecret || !config.passphrase) {
    throw new PolymarketError('AUTH_FAILED', 'Missing API credentials', {
      hasApiKey: !!config.apiKey,
      hasSecret: !!config.apiSecret,
      hasPassphrase: !!config.passphrase
    });
  }

  // Initialize SDK client (primary)
  client = new SDKClient({ logger: log });
  await client.initialize();

  // Initialize custom client (backup/low-level)
  customClient = new PolymarketClient({
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    passphrase: config.passphrase,
    privateKey: config.privateKey,
    funder: config.funder,
    logger: log
  });

  log.info('client_initialized', { address: client.wallet.address });
}

export function getState() {
  return {
    initialized: client !== null,
    address: client?.wallet?.address || null,
    funder: client?.funder || null,
    stats,
    ready: client?.ready || false
  };
}

export async function shutdown() {
  log?.info('client_shutdown', { stats });
  client = null;
  customClient = null;
}

// Re-export client methods with error handling wrapper
export async function getOrderBook(tokenId) { ... }
export async function placeOrder(params) { ... }
export async function cancelOrder(orderId) { ... }
// etc.
```

### Configuration Pattern

**From config/default.js:**
```javascript
module.exports = {
  polymarket: {
    apiKey: process.env.POLYMARKET_API_KEY,
    apiSecret: process.env.POLYMARKET_SECRET,
    passphrase: process.env.POLYMARKET_PASSPHRASE,
    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
    funder: process.env.POLYMARKET_FUNDER_ADDRESS
  }
};
```

**CRITICAL:** Credentials flow from env → config → module. Module never reads env directly.

### Critical Learnings from Existing Code

**From sdk_client.js - Fill Verification:**
```javascript
// MULTI-FACTOR FILL VERIFICATION - ALL must pass
const hasTxHash = order?.transactionsHashes?.length > 0;
const hasSuccess = order?.success === true;
const hasGoodStatus = order?.status === 'matched' || order?.status === 'live';
const filled = hasTxHash && hasSuccess && hasGoodStatus;
```

**From sdk_client.js - Price Validation:**
```javascript
// Binary option prices MUST be between 0.01 and 0.99
// If extracted price is outside this range, it's WRONG
if (extractedPrice >= 0.01 && extractedPrice <= 0.99) {
  actualFillPrice = extractedPrice;
} else {
  // Use requested price as fallback
  actualFillPrice = price;
}
```

**From sdk_client.js - Token Allowance:**
```javascript
// CRITICAL: Approve token for selling BEFORE attempting sell
await this.client.updateBalanceAllowance({
  asset_type: 'CONDITIONAL',
  token_id: tokenId
});
```

**From polymarket_client.js - ethers v6 Compatibility:**
```javascript
// SDK expects ethers v5's _signTypedData method
wallet._signTypedData = async (domain, types, value) => {
  return wallet.signTypedData(domain, types, value);
};
```

### Testing Requirements

**Test File:** `src/clients/polymarket/__tests__/index.test.js`

```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Polymarket Client', () => {
  describe('init', () => {
    it('initializes with valid config');
    it('throws AUTH_FAILED if credentials missing');
    it('logs initialization success');
    it('does not log credentials');
  });

  describe('getState', () => {
    it('returns connection status');
    it('returns request stats');
    it('returns rate limit status');
  });

  describe('error handling', () => {
    it('throws PolymarketError on connection failure');
    it('includes error code and context');
    it('retries with exponential backoff');
    it('logs errors with full context');
  });

  describe('rate limiting', () => {
    it('enforces 100ms minimum between requests');
    it('backs off on rate limit errors');
    it('logs rate limit events');
  });

  describe('credential security', () => {
    it('never logs API key');
    it('never logs API secret');
    it('never logs passphrase');
    it('never logs private key');
  });
});
```

### Project Structure Notes

**Files to Create:**
```
src/clients/
└── polymarket/
    ├── index.js          # Public module interface (init, getState, shutdown + re-exports)
    ├── client.js         # Wrapped SDKClient with error handling
    ├── types.js          # PolymarketError, type definitions
    ├── auth.js           # Authentication helpers
    ├── API_BEHAVIOR.md   # Documented API behavior
    └── __tests__/
        ├── index.test.js     # Integration tests
        └── client.test.js    # Unit tests
```

### Previous Epic Intelligence

**From Epic 1 (Foundation):**
- All imports use ESM syntax (`import/export`)
- Module interface: `init(config)`, `getState()`, `shutdown()`
- Error classes extend `PolyError` from `src/types/errors.js`
- Tests use vitest with `describe`, `it`, `expect`, `vi` (for mocks)
- Logger provides `createLogger(moduleName)` for child loggers
- Configuration loaded via `config/index.js`

**Key patterns established:**
- Structured JSON logging with required fields: timestamp, level, module, event
- Write-ahead logging for any state-changing operations
- State reconciliation on startup

### NFR Compliance

- **NFR11** (Credentials outside codebase): Loaded from config, which reads from env
- **NFR12** (Credentials never logged): Use logger redactor, test for exposure
- **NFR14** (Auto reconnection): Exponential backoff retry on connection failures
- **NFR15** (Rate limit backoff): 100ms minimum interval, backoff on 429 errors
- **NFR16** (Log API anomalies): Validate response format, log unexpected responses

### References

- [Source: architecture.md#Brownfield-Approach] - Borrow with validation pattern
- [Source: architecture.md#Module-Interface-Contract] - Standard module interface
- [Source: architecture.md#Project-Structure] - File locations for clients
- [Source: architecture.md#Error-Handling-Pattern] - Typed errors with context
- [Source: epics.md#Story-2.1] - Story requirements and acceptance criteria
- [Source: prd.md#NFR11] - Credentials outside codebase
- [Source: prd.md#NFR12] - Credentials never logged
- [Source: prd.md#NFR14] - Auto reconnection with backoff
- [Source: prd.md#NFR15] - Rate limit backoff
- [Source: prd.md#NFR16] - Log API response anomalies
- [Source: src/execution/polymarket_client.js] - Existing custom client implementation
- [Source: src/execution/sdk_client.js] - Existing SDK wrapper implementation
- [Source: 1-5-state-reconciliation-on-startup.md] - Previous story patterns

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- All tests pass (264 total tests, 39 in polymarket client module)

### Completion Notes List

- Created Polymarket client module with standard interface (init, getState, shutdown)
- Wrapped existing SDK client with PolymarketError typed errors
- Implemented rate limiting with 100ms minimum interval and exponential backoff
- Response validation detects unexpected formats and logs anomalies
- Credentials flow from config only - never read from env directly in module
- Tests verify credentials are never logged (mock logger verification)
- Comprehensive API behavior documentation created

### Change Log

- 2026-01-30: Implemented Story 2.1 - Polymarket API Client Integration
  - Created module structure: index.js, client.js, types.js, auth.js
  - Implemented typed errors (PolymarketError extending PolyError)
  - Added rate limiting with configurable intervals
  - Created API_BEHAVIOR.md documentation
  - Added 39 tests for module, client wrapper, and types
  - Updated config/default.js with privateKey and funder fields

### File List

- src/clients/polymarket/index.js (new)
- src/clients/polymarket/client.js (new)
- src/clients/polymarket/types.js (new)
- src/clients/polymarket/auth.js (new)
- src/clients/polymarket/API_BEHAVIOR.md (new)
- src/clients/polymarket/__tests__/index.test.js (new)
- src/clients/polymarket/__tests__/client.test.js (new)
- config/default.js (modified - added privateKey and funder)
