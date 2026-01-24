/**
 * Chainlink Price Feed Collector
 * 
 * Fetches prices from Chainlink oracles on Polygon.
 * These are the ACTUAL prices used for Polymarket resolution.
 * 
 * Key insight: Polymarket displays Binance prices on charts but resolves
 * using Chainlink. This creates potential divergence opportunities.
 */

import { ethers } from 'ethers';

// Chainlink AggregatorV3Interface ABI (minimal)
const AGGREGATOR_ABI = [
    {
        "inputs": [],
        "name": "latestRoundData",
        "outputs": [
            { "name": "roundId", "type": "uint80" },
            { "name": "answer", "type": "int256" },
            { "name": "startedAt", "type": "uint256" },
            { "name": "updatedAt", "type": "uint256" },
            { "name": "answeredInRound", "type": "uint80" }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "decimals",
        "outputs": [{ "name": "", "type": "uint8" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "description",
        "outputs": [{ "name": "", "type": "string" }],
        "stateMutability": "view",
        "type": "function"
    }
];

// Chainlink Price Feed addresses on Polygon Mainnet
// Source: https://docs.chain.link/data-feeds/price-feeds/addresses?network=polygon
const CHAINLINK_FEEDS = {
    btc: {
        address: '0xc907E116054Ad103354f2D350FD2514433D57F6f',
        pair: 'BTC/USD',
        decimals: 8
    },
    eth: {
        address: '0xF9680D99D6C9589e2a93a78A04A279e509205945',
        pair: 'ETH/USD',
        decimals: 8
    },
    sol: {
        address: '0x10C8264C0935b3B9870013e057f330Ff3e9C56dC',
        pair: 'SOL/USD',
        decimals: 8
    },
    // XRP doesn't have a direct Chainlink feed on Polygon
    // Polymarket may use a different source or cross-chain feed
    xrp: null
};

// Polygon RPC endpoints (free, public)
const POLYGON_RPC_URLS = [
    'https://polygon-rpc.com',
    'https://rpc-mainnet.matic.quiknode.pro',
    'https://polygon-mainnet.public.blastapi.io',
    'https://polygon.llamarpc.com'
];

export class ChainlinkPriceCollector {
    constructor() {
        this.provider = null;
        this.contracts = {};
        this.prices = {};
        this.lastUpdate = {};
        this.errors = 0;
        this.rpcIndex = 0;
    }
    
    /**
     * Initialize provider and contracts
     */
    async initialize() {
        console.log('🔗 Initializing Chainlink price feeds...');
        
        // Try to connect to a working RPC
        for (let i = 0; i < POLYGON_RPC_URLS.length; i++) {
            try {
                const url = POLYGON_RPC_URLS[i];
                this.provider = new ethers.JsonRpcProvider(url);
                
                // Test connection
                await this.provider.getBlockNumber();
                console.log(`✅ Connected to Polygon via ${url}`);
                this.rpcIndex = i;
                break;
            } catch (error) {
                console.log(`⚠️  RPC ${POLYGON_RPC_URLS[i]} failed, trying next...`);
            }
        }
        
        if (!this.provider) {
            throw new Error('Failed to connect to any Polygon RPC');
        }
        
        // Initialize contracts for each feed
        for (const [crypto, feed] of Object.entries(CHAINLINK_FEEDS)) {
            if (feed) {
                try {
                    this.contracts[crypto] = new ethers.Contract(
                        feed.address,
                        AGGREGATOR_ABI,
                        this.provider
                    );
                    console.log(`   ${crypto.toUpperCase()}: ${feed.pair} @ ${feed.address.slice(0, 10)}...`);
                } catch (error) {
                    console.error(`❌ Failed to init ${crypto} contract:`, error.message);
                }
            } else {
                console.log(`   ${crypto.toUpperCase()}: No Chainlink feed available`);
            }
        }
        
        // Fetch initial prices
        await this.fetchAllPrices();
        
        return this;
    }
    
    /**
     * Fetch price from a single feed
     */
    async fetchPrice(crypto) {
        const contract = this.contracts[crypto];
        const feed = CHAINLINK_FEEDS[crypto];
        
        if (!contract || !feed) {
            return null;
        }
        
        try {
            const [roundId, answer, startedAt, updatedAt, answeredInRound] = 
                await contract.latestRoundData();
            
            // Convert from fixed-point to decimal
            const price = Number(answer) / Math.pow(10, feed.decimals);
            
            // Calculate staleness
            const now = Math.floor(Date.now() / 1000);
            const staleness = now - Number(updatedAt);
            
            this.prices[crypto] = {
                price,
                roundId: roundId.toString(),
                updatedAt: Number(updatedAt),
                staleness,
                fetchedAt: Date.now()
            };
            
            this.lastUpdate[crypto] = Date.now();
            
            return this.prices[crypto];
            
        } catch (error) {
            this.errors++;
            
            // Try rotating to a different RPC if we get errors
            if (this.errors % 5 === 0) {
                await this.rotateRpc();
            }
            
            return null;
        }
    }
    
    /**
     * Fetch all prices
     */
    async fetchAllPrices() {
        const results = {};
        
        for (const crypto of Object.keys(CHAINLINK_FEEDS)) {
            if (CHAINLINK_FEEDS[crypto]) {
                results[crypto] = await this.fetchPrice(crypto);
            }
        }
        
        return results;
    }
    
    /**
     * Get current price for a crypto
     */
    getPrice(crypto) {
        return this.prices[crypto] || null;
    }
    
    /**
     * Get all current prices
     */
    getAllPrices() {
        return { ...this.prices };
    }
    
    /**
     * Calculate divergence between Chainlink and Binance
     */
    calculateDivergence(crypto, binancePrice) {
        const chainlink = this.prices[crypto];
        
        if (!chainlink || !binancePrice) {
            return null;
        }
        
        const divergence = binancePrice - chainlink.price;
        const divergencePct = (divergence / chainlink.price) * 100;
        
        return {
            chainlinkPrice: chainlink.price,
            binancePrice,
            divergence,
            divergencePct,
            chainlinkStaleness: chainlink.staleness,
            // If Binance is higher than Chainlink, UP is favored by Binance but may not resolve UP
            binanceFavorsUp: binancePrice > chainlink.price
        };
    }
    
    /**
     * Rotate to a different RPC endpoint
     */
    async rotateRpc() {
        this.rpcIndex = (this.rpcIndex + 1) % POLYGON_RPC_URLS.length;
        const url = POLYGON_RPC_URLS[this.rpcIndex];
        
        try {
            this.provider = new ethers.JsonRpcProvider(url);
            await this.provider.getBlockNumber();
            console.log(`🔄 Rotated to RPC: ${url}`);
            
            // Reinitialize contracts with new provider
            for (const [crypto, feed] of Object.entries(CHAINLINK_FEEDS)) {
                if (feed) {
                    this.contracts[crypto] = new ethers.Contract(
                        feed.address,
                        AGGREGATOR_ABI,
                        this.provider
                    );
                }
            }
        } catch (error) {
            console.error(`❌ RPC rotation failed:`, error.message);
        }
    }
    
    /**
     * Start periodic price fetching
     */
    startPolling(intervalMs = 5000) {
        console.log(`🔄 Starting Chainlink polling every ${intervalMs}ms`);
        
        this.pollingInterval = setInterval(async () => {
            await this.fetchAllPrices();
        }, intervalMs);
        
        return this;
    }
    
    /**
     * Stop polling
     */
    stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }
    
    /**
     * Get stats
     */
    getStats() {
        return {
            errors: this.errors,
            lastUpdates: { ...this.lastUpdate },
            feedsAvailable: Object.keys(this.contracts).length,
            currentPrices: this.getAllPrices()
        };
    }
}

// Singleton instance
let instance = null;

export async function getChainlinkCollector() {
    if (!instance) {
        instance = new ChainlinkPriceCollector();
        await instance.initialize();
    }
    return instance;
}

export default ChainlinkPriceCollector;
