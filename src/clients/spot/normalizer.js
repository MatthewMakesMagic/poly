/**
 * Price Normalization Utilities
 *
 * Normalizes price data from different sources to a consistent format.
 * Handles different source formats (Pyth, Chainlink, exchange WebSockets).
 */

/**
 * Normalize a raw price to a consistent format
 *
 * @param {Object} raw - Raw price data from source
 * @param {string} source - Source name (e.g., 'pyth', 'chainlink')
 * @returns {Object} Normalized price object
 */
export function normalizePrice(raw, source) {
  const now = Date.now();
  let timestamp;
  let price;

  // Handle different source formats
  switch (source) {
    case 'pyth': {
      // Pyth returns price with exponent
      // Format: { price: string, expo: number, publish_time: number }
      if (raw.price && raw.expo !== undefined) {
        price = parseFloat(raw.price) * Math.pow(10, raw.expo);
        timestamp = raw.publish_time ? raw.publish_time * 1000 : now;
      } else if (raw.price !== undefined) {
        // Already processed price
        price = typeof raw.price === 'number' ? raw.price : parseFloat(raw.price);
        timestamp = raw.timestamp || raw.publishTime || now;
      }
      break;
    }

    case 'chainlink': {
      // Chainlink returns fixed-point with decimals
      // Format: { answer: bigint, updatedAt: number, decimals: number }
      if (raw.answer !== undefined && raw.decimals !== undefined) {
        price = Number(raw.answer) / Math.pow(10, raw.decimals);
        timestamp = raw.updatedAt ? raw.updatedAt * 1000 : now;
      } else {
        price = typeof raw.price === 'number' ? raw.price : parseFloat(raw.price);
        timestamp = raw.timestamp || now;
      }
      break;
    }

    default: {
      // Generic handling for exchange WebSockets and other sources
      price = typeof raw.price === 'number' ? raw.price : parseFloat(raw.price);
      timestamp = raw.timestamp || raw.updatedAt || raw.time || now;

      // Convert to milliseconds if needed
      if (timestamp < 1e12) {
        timestamp = timestamp * 1000;
      }
    }
  }

  // Calculate staleness in seconds
  const staleness = Math.floor((now - timestamp) / 1000);

  return {
    price,
    timestamp: new Date(timestamp),
    source,
    staleness,
    raw, // Keep original for debugging
  };
}

/**
 * Validate that a price is within reasonable bounds
 *
 * @param {number} price - Price to validate
 * @param {string} crypto - Cryptocurrency symbol
 * @returns {boolean} True if price is valid
 */
export function isValidPrice(price, crypto) {
  if (typeof price !== 'number' || isNaN(price) || !isFinite(price)) {
    return false;
  }

  if (price <= 0) {
    return false;
  }

  // Basic sanity checks for reasonable price ranges
  // These are loose bounds to catch obvious errors
  const bounds = {
    btc: { min: 1000, max: 1000000 },
    eth: { min: 100, max: 100000 },
    sol: { min: 1, max: 10000 },
    xrp: { min: 0.01, max: 100 },
  };

  const cryptoBounds = bounds[crypto];
  if (cryptoBounds) {
    return price >= cryptoBounds.min && price <= cryptoBounds.max;
  }

  // Unknown crypto, just check it's positive
  return true;
}

/**
 * Round price to appropriate precision for display
 *
 * @param {number} price - Price to round
 * @param {number} [decimals=2] - Number of decimal places
 * @returns {number} Rounded price
 */
export function roundPrice(price, decimals = 2) {
  const factor = Math.pow(10, decimals);
  return Math.round(price * factor) / factor;
}
