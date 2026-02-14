/**
 * Migration 029: Add coingecko_price column to vwap_snapshots
 *
 * Stores the CoinGecko aggregated price alongside our VWAP and Chainlink prices.
 * CoinGecko VWAP aggregates across 1,700+ exchanges with outlier filtering,
 * providing a better Chainlink proxy than our 21-exchange VWAP for non-BTC.
 */
import persistence from '../index.js';

export async function up() {
  await persistence.run(`
    ALTER TABLE vwap_snapshots
    ADD COLUMN IF NOT EXISTS coingecko_price DECIMAL(20, 8)
  `);
}
