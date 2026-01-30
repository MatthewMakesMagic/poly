/**
 * Polymarket Authentication Handler
 *
 * Handles L2 HMAC authentication for Polymarket API requests.
 * Credentials are NEVER stored directly - they flow from config.
 */

import crypto from 'crypto';

/**
 * Generate HMAC signature for L2 (authenticated) requests
 *
 * @param {string} apiSecret - Base64-encoded API secret
 * @param {string} method - HTTP method (GET, POST, DELETE)
 * @param {string} path - API path (e.g., /order)
 * @param {string} timestamp - Unix timestamp (seconds)
 * @param {string} [body=''] - Request body (empty for GET/DELETE)
 * @returns {string} Base64-encoded HMAC signature
 */
export function generateL2Signature(apiSecret, method, path, timestamp, body = '') {
  const message = timestamp + method.toUpperCase() + path + body;
  const hmac = crypto.createHmac('sha256', Buffer.from(apiSecret, 'base64'));
  hmac.update(message);
  return hmac.digest('base64');
}

/**
 * Build L2 authentication headers for Polymarket API
 *
 * @param {Object} credentials - API credentials
 * @param {string} credentials.apiKey - Polymarket API key
 * @param {string} credentials.apiSecret - Polymarket API secret (base64)
 * @param {string} credentials.passphrase - Polymarket passphrase
 * @param {string} address - Wallet address (signer)
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @param {string} [body=''] - Request body
 * @returns {Object} Headers object for authenticated request
 */
export function buildL2Headers(credentials, address, method, path, body = '') {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = generateL2Signature(
    credentials.apiSecret,
    method,
    path,
    timestamp,
    body
  );

  return {
    'POLY_ADDRESS': address,
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': timestamp,
    'POLY_API_KEY': credentials.apiKey,
    'POLY_PASSPHRASE': credentials.passphrase,
  };
}

/**
 * Validate that required credentials are present
 *
 * @param {Object} credentials - Credentials to validate
 * @returns {Object} Validation result with { valid: boolean, missing: string[] }
 */
export function validateCredentials(credentials) {
  const required = ['apiKey', 'apiSecret', 'passphrase', 'privateKey'];
  const missing = [];

  for (const field of required) {
    if (!credentials[field]) {
      missing.push(field);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}
