/**
 * Position Verifier Module
 *
 * V3 Stage 5: Implements "Verify Before Acting" principle.
 * Compares local positions against Polymarket Data API before
 * evaluating stop-loss / take-profit exits.
 *
 * Public API:
 * - init(config) - Extract wallet address from config
 * - verify(localPositions) - Compare local vs exchange positions
 * - getState() - Return cache age, last result
 * - shutdown() - Clear cache
 */

import { child } from '../logger/index.js';

let log = null;
let initialized = false;

// Config
let walletAddress = null;
let tradingMode = null;

// Cache
let cachedResponse = null;
let cacheTimestamp = null;
const CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Initialize the position verifier module
 *
 * @param {Object} config - Full application configuration
 */
export async function init(config) {
  if (initialized) return;

  log = child({ module: 'position-verifier' });
  log.info('module_init_start');

  walletAddress = config?.polymarket?.funder || null;
  tradingMode = config?.tradingMode || 'PAPER';

  if (!walletAddress && tradingMode === 'LIVE') {
    log.warn('position_verifier_no_wallet', {
      message: 'No funder address configured - verification will fail in LIVE mode',
    });
  }

  initialized = true;
  log.info('module_initialized', {
    hasWallet: !!walletAddress,
    tradingMode,
  });
}

/**
 * Verify local positions against the exchange
 *
 * @param {Array} localPositions - Array of local position objects with token_id field
 * @returns {Promise<Object>} Verification result
 */
export async function verify(localPositions = []) {
  if (!initialized) {
    return { verified: false, error: 'Position verifier not initialized' };
  }

  // PAPER mode: skip verification
  if (tradingMode !== 'LIVE') {
    log.debug('position_verification_skipped', {
      mode: tradingMode,
      reason: 'PAPER mode - verification not needed',
    });
    return { verified: true, mode: tradingMode, skipped: true };
  }

  // No wallet configured
  if (!walletAddress) {
    return { verified: false, error: 'No wallet address configured' };
  }

  // No local positions to verify
  if (localPositions.length === 0) {
    return { verified: true, positions: [], missing: [], orphans: [] };
  }

  let exchangePositions;

  try {
    exchangePositions = await fetchExchangePositions();
  } catch (err) {
    // 429 handling
    if (err.status === 429 || err.message?.includes('429')) {
      const cacheAge = cacheTimestamp ? Date.now() - cacheTimestamp : Infinity;

      if (cachedResponse && cacheAge < CACHE_TTL_MS) {
        log.warn('position_verification_rate_limited_using_cache', {
          cache_age_ms: cacheAge,
          cache_ttl_ms: CACHE_TTL_MS,
        });
        exchangePositions = cachedResponse;
      } else {
        log.error('position_verification_rate_limited_stale_cache', {
          cache_age_ms: cacheAge,
          cache_ttl_ms: CACHE_TTL_MS,
          message: 'Rate limited with stale/no cache - caller should trip CB',
        });
        const rateLimitError = new Error('Position verification rate limited - stale cache');
        rateLimitError.status = 429;
        throw rateLimitError;
      }
    } else {
      throw err;
    }
  }

  // Build lookup by token_id
  const exchangeByToken = new Map();
  for (const pos of exchangePositions) {
    const tokenId = pos.asset || pos.token_id || pos.tokenId;
    if (tokenId) {
      exchangeByToken.set(tokenId, pos);
    }
  }

  const localByToken = new Map();
  for (const pos of localPositions) {
    const tokenId = pos.token_id || pos.tokenId;
    if (tokenId) {
      localByToken.set(tokenId, pos);
    }
  }

  // Find positions on exchange that we don't track locally
  const missing = [];
  for (const [tokenId, exchangePos] of exchangeByToken) {
    if (!localByToken.has(tokenId)) {
      const size = parseFloat(exchangePos.size || exchangePos.amount || '0');
      if (size > 0) {
        missing.push({
          token_id: tokenId,
          exchange_size: size,
          source: 'exchange_only',
        });
      }
    }
  }

  // Find local positions not on exchange (orphans - less severe)
  const orphans = [];
  for (const [tokenId, localPos] of localByToken) {
    if (!exchangeByToken.has(tokenId)) {
      orphans.push({
        token_id: tokenId,
        local_size: localPos.size || localPos.amount,
        source: 'local_only',
      });
    }
  }

  const verified = missing.length === 0;

  if (!verified) {
    log.error('position_verification_failed', {
      missing_count: missing.length,
      orphan_count: orphans.length,
      local_count: localPositions.length,
      exchange_count: exchangePositions.length,
      missing,
    });
  } else if (orphans.length > 0) {
    log.error('position_verification_orphans', {
      orphan_count: orphans.length,
      orphans,
      message: 'Local positions not found on exchange - possible already settled',
    });
  } else {
    log.debug('position_verification_passed', {
      local_count: localPositions.length,
      exchange_count: exchangePositions.length,
    });
  }

  return { verified, missing, orphans };
}

/**
 * Fetch positions from Polymarket Data API
 *
 * @returns {Promise<Array>} Exchange positions
 * @private
 */
async function fetchExchangePositions() {
  const url = `https://data-api.polymarket.com/positions?user=${walletAddress}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    clearTimeout(timeoutId);

    if (response.status === 429) {
      const err = new Error('Rate limited by Polymarket Data API');
      err.status = 429;
      throw err;
    }

    if (!response.ok) {
      throw new Error(`Data API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const positions = Array.isArray(data) ? data : (data.positions || data.data || []);

    // Update cache on success
    cachedResponse = positions;
    cacheTimestamp = Date.now();

    return positions;
  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      throw new Error('Data API request timeout (5s)');
    }
    throw err;
  }
}

/**
 * Get current module state
 *
 * @returns {Object} State snapshot
 */
export function getState() {
  return {
    initialized,
    hasWallet: !!walletAddress,
    tradingMode,
    cacheAge: cacheTimestamp ? Date.now() - cacheTimestamp : null,
    hasCachedData: !!cachedResponse,
    cacheTimestamp: cacheTimestamp ? new Date(cacheTimestamp).toISOString() : null,
  };
}

/**
 * Shutdown the position verifier module
 */
export async function shutdown() {
  if (log) log.info('module_shutdown_start');

  cachedResponse = null;
  cacheTimestamp = null;
  walletAddress = null;
  tradingMode = null;
  initialized = false;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}
