/**
 * Multi-Source Price Feed Collector
 *
 * Connects to multiple price sources simultaneously for comparison and analysis.
 * Goal: Find which source best predicts Polymarket resolution.
 *
 * Sources:
 * - Oracles: Pyth, RedStone, Band Protocol
 * - Exchanges: Binance (existing), Coinbase, Kraken, OKX
 * - Aggregators: CoinCap, CoinGecko
 */

import WebSocket from 'ws';
import axios from 'axios';
import EventEmitter from 'events';

const CONFIG = {
    // Supported cryptos
    CRYPTOS: ['btc', 'eth', 'sol', 'xrp'],

    // Pyth Network
    PYTH_HERMES_URL: 'https://hermes.pyth.network',
    PYTH_PRICE_IDS: {
        btc: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
        eth: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
        sol: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
        xrp: '0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8'
    },

    // Coinbase
    COINBASE_WS: 'wss://ws-feed.exchange.coinbase.com',
    COINBASE_SYMBOLS: {
        btc: 'BTC-USD',
        eth: 'ETH-USD',
        sol: 'SOL-USD',
        xrp: 'XRP-USD'
    },

    // Kraken
    KRAKEN_WS: 'wss://ws.kraken.com',
    KRAKEN_SYMBOLS: {
        btc: 'XBT/USD',
        eth: 'ETH/USD',
        sol: 'SOL/USD',
        xrp: 'XRP/USD'
    },

    // OKX
    OKX_WS: 'wss://ws.okx.com:8443/ws/v5/public',
    OKX_SYMBOLS: {
        btc: 'BTC-USDT',
        eth: 'ETH-USDT',
        sol: 'SOL-USDT',
        xrp: 'XRP-USDT'
    },

    // CoinCap
    COINCAP_WS: 'wss://ws.coincap.io/prices',
    COINCAP_ASSETS: {
        btc: 'bitcoin',
        eth: 'ethereum',
        sol: 'solana',
        xrp: 'xrp'
    },

    // CoinGecko (REST - rate limited)
    COINGECKO_API: 'https://api.coingecko.com/api/v3',
    COINGECKO_IDS: {
        btc: 'bitcoin',
        eth: 'ethereum',
        sol: 'solana',
        xrp: 'ripple'
    },

    // RedStone (REST)
    REDSTONE_API: 'https://api.redstone.finance',

    // Timeouts and intervals
    TIMEOUT_MS: 5000,
    RECONNECT_DELAY_MS: 5000,
    PYTH_POLL_INTERVAL_MS: 1000,
    REST_POLL_INTERVAL_MS: 5000,
    COINGECKO_POLL_INTERVAL_MS: 30000, // Rate limited

    // Error thresholds
    MAX_CONSECUTIVE_ERRORS: 10
};

/**
 * Individual price source collectors
 */

class PythCollector {
    constructor() {
        this.name = 'pyth';
        this.prices = {};
        this.lastUpdate = {};
        this.errors = 0;
        this.consecutiveErrors = 0;
        this.disabled = false;
        this.eventSource = null;
    }

    async initialize() {
        try {
            // Test connection
            const testUrl = `${CONFIG.PYTH_HERMES_URL}/v2/updates/price/latest?ids[]=${CONFIG.PYTH_PRICE_IDS.btc}`;
            await axios.get(testUrl, { timeout: CONFIG.TIMEOUT_MS });
            console.log('[Pyth] Connected successfully');
            return true;
        } catch (error) {
            console.error('[Pyth] Failed to initialize:', error.message);
            this.disabled = true;
            return false;
        }
    }

    async fetchPrices() {
        if (this.disabled) return null;

        try {
            const ids = Object.values(CONFIG.PYTH_PRICE_IDS);
            const url = `${CONFIG.PYTH_HERMES_URL}/v2/updates/price/latest?${ids.map(id => `ids[]=${id}`).join('&')}`;

            const response = await axios.get(url, { timeout: CONFIG.TIMEOUT_MS });
            const now = Date.now();

            if (response.data?.parsed) {
                for (const update of response.data.parsed) {
                    const crypto = Object.keys(CONFIG.PYTH_PRICE_IDS).find(
                        k => CONFIG.PYTH_PRICE_IDS[k] === '0x' + update.id
                    );

                    if (crypto && update.price) {
                        const price = parseFloat(update.price.price) * Math.pow(10, update.price.expo);
                        const publishTime = update.price.publish_time * 1000;

                        this.prices[crypto] = {
                            price,
                            timestamp: publishTime,
                            staleness: Math.floor((now - publishTime) / 1000),
                            fetchedAt: now,
                            source: 'pyth'
                        };
                        this.lastUpdate[crypto] = now;
                    }
                }
            }

            this.consecutiveErrors = 0;
            return this.prices;
        } catch (error) {
            this.errors++;
            this.consecutiveErrors++;

            if (this.consecutiveErrors >= CONFIG.MAX_CONSECUTIVE_ERRORS) {
                console.error('[Pyth] Too many errors, disabling');
                this.disabled = true;
            }
            return null;
        }
    }

    getPrice(crypto) {
        return this.prices[crypto] || null;
    }

    getStats() {
        return {
            name: this.name,
            disabled: this.disabled,
            errors: this.errors,
            consecutiveErrors: this.consecutiveErrors,
            lastUpdate: this.lastUpdate,
            priceCount: Object.keys(this.prices).length
        };
    }
}

class CoinbaseCollector {
    constructor() {
        this.name = 'coinbase';
        this.prices = {};
        this.lastUpdate = {};
        this.errors = 0;
        this.consecutiveErrors = 0;
        this.disabled = false;
        this.ws = null;
        this.reconnectTimeout = null;
    }

    async initialize() {
        return new Promise((resolve) => {
            try {
                this.connect();

                // Give it 5 seconds to connect
                setTimeout(() => {
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        console.log('[Coinbase] Connected successfully');
                        resolve(true);
                    } else {
                        console.error('[Coinbase] Failed to connect');
                        this.disabled = true;
                        resolve(false);
                    }
                }, 5000);
            } catch (error) {
                console.error('[Coinbase] Failed to initialize:', error.message);
                this.disabled = true;
                resolve(false);
            }
        });
    }

    connect() {
        if (this.disabled) return;

        try {
            this.ws = new WebSocket(CONFIG.COINBASE_WS);

            this.ws.on('open', () => {
                this.consecutiveErrors = 0;
                this.subscribe();
            });

            this.ws.on('message', (data) => {
                this.handleMessage(data);
            });

            this.ws.on('error', (error) => {
                this.errors++;
                this.consecutiveErrors++;
                console.error('[Coinbase] WebSocket error:', error.message);
            });

            this.ws.on('close', () => {
                console.log('[Coinbase] WebSocket closed, reconnecting...');
                this.scheduleReconnect();
            });
        } catch (error) {
            console.error('[Coinbase] Connection error:', error.message);
            this.scheduleReconnect();
        }
    }

    subscribe() {
        const msg = {
            type: 'subscribe',
            product_ids: Object.values(CONFIG.COINBASE_SYMBOLS),
            channels: ['ticker']
        };
        this.ws.send(JSON.stringify(msg));
    }

    handleMessage(rawData) {
        try {
            const data = JSON.parse(rawData);

            if (data.type === 'ticker' && data.price) {
                const crypto = Object.keys(CONFIG.COINBASE_SYMBOLS).find(
                    k => CONFIG.COINBASE_SYMBOLS[k] === data.product_id
                );

                if (crypto) {
                    const now = Date.now();
                    const timestamp = new Date(data.time).getTime();

                    this.prices[crypto] = {
                        price: parseFloat(data.price),
                        timestamp,
                        staleness: Math.floor((now - timestamp) / 1000),
                        fetchedAt: now,
                        source: 'coinbase',
                        volume24h: parseFloat(data.volume_24h) || 0
                    };
                    this.lastUpdate[crypto] = now;
                }
            }
        } catch (error) {
            // Ignore parse errors
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);

        if (this.consecutiveErrors >= CONFIG.MAX_CONSECUTIVE_ERRORS) {
            console.error('[Coinbase] Too many errors, disabling');
            this.disabled = true;
            return;
        }

        this.reconnectTimeout = setTimeout(() => {
            this.connect();
        }, CONFIG.RECONNECT_DELAY_MS);
    }

    getPrice(crypto) {
        return this.prices[crypto] || null;
    }

    getStats() {
        return {
            name: this.name,
            disabled: this.disabled,
            connected: this.ws?.readyState === WebSocket.OPEN,
            errors: this.errors,
            consecutiveErrors: this.consecutiveErrors,
            lastUpdate: this.lastUpdate,
            priceCount: Object.keys(this.prices).length
        };
    }

    close() {
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        if (this.ws) this.ws.close();
    }
}

class KrakenCollector {
    constructor() {
        this.name = 'kraken';
        this.prices = {};
        this.lastUpdate = {};
        this.errors = 0;
        this.consecutiveErrors = 0;
        this.disabled = false;
        this.ws = null;
        this.reconnectTimeout = null;
    }

    async initialize() {
        return new Promise((resolve) => {
            try {
                this.connect();

                setTimeout(() => {
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        console.log('[Kraken] Connected successfully');
                        resolve(true);
                    } else {
                        console.error('[Kraken] Failed to connect');
                        this.disabled = true;
                        resolve(false);
                    }
                }, 5000);
            } catch (error) {
                console.error('[Kraken] Failed to initialize:', error.message);
                this.disabled = true;
                resolve(false);
            }
        });
    }

    connect() {
        if (this.disabled) return;

        try {
            this.ws = new WebSocket(CONFIG.KRAKEN_WS);

            this.ws.on('open', () => {
                this.consecutiveErrors = 0;
                this.subscribe();
            });

            this.ws.on('message', (data) => {
                this.handleMessage(data);
            });

            this.ws.on('error', (error) => {
                this.errors++;
                this.consecutiveErrors++;
                console.error('[Kraken] WebSocket error:', error.message);
            });

            this.ws.on('close', () => {
                console.log('[Kraken] WebSocket closed, reconnecting...');
                this.scheduleReconnect();
            });
        } catch (error) {
            console.error('[Kraken] Connection error:', error.message);
            this.scheduleReconnect();
        }
    }

    subscribe() {
        const msg = {
            event: 'subscribe',
            pair: Object.values(CONFIG.KRAKEN_SYMBOLS),
            subscription: { name: 'ticker' }
        };
        this.ws.send(JSON.stringify(msg));
    }

    handleMessage(rawData) {
        try {
            const data = JSON.parse(rawData);

            // Kraken sends arrays for ticker data: [channelID, data, channelName, pair]
            if (Array.isArray(data) && data.length >= 4) {
                const tickerData = data[1];
                const pair = data[3];

                const crypto = Object.keys(CONFIG.KRAKEN_SYMBOLS).find(
                    k => CONFIG.KRAKEN_SYMBOLS[k] === pair
                );

                if (crypto && tickerData?.c) {
                    const now = Date.now();
                    // c = last trade closed [price, lot volume]
                    const price = parseFloat(tickerData.c[0]);

                    this.prices[crypto] = {
                        price,
                        timestamp: now,
                        staleness: 0,
                        fetchedAt: now,
                        source: 'kraken',
                        bid: parseFloat(tickerData.b?.[0]) || 0,
                        ask: parseFloat(tickerData.a?.[0]) || 0
                    };
                    this.lastUpdate[crypto] = now;
                }
            }
        } catch (error) {
            // Ignore parse errors
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);

        if (this.consecutiveErrors >= CONFIG.MAX_CONSECUTIVE_ERRORS) {
            console.error('[Kraken] Too many errors, disabling');
            this.disabled = true;
            return;
        }

        this.reconnectTimeout = setTimeout(() => {
            this.connect();
        }, CONFIG.RECONNECT_DELAY_MS);
    }

    getPrice(crypto) {
        return this.prices[crypto] || null;
    }

    getStats() {
        return {
            name: this.name,
            disabled: this.disabled,
            connected: this.ws?.readyState === WebSocket.OPEN,
            errors: this.errors,
            consecutiveErrors: this.consecutiveErrors,
            lastUpdate: this.lastUpdate,
            priceCount: Object.keys(this.prices).length
        };
    }

    close() {
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        if (this.ws) this.ws.close();
    }
}

class OKXCollector {
    constructor() {
        this.name = 'okx';
        this.prices = {};
        this.lastUpdate = {};
        this.errors = 0;
        this.consecutiveErrors = 0;
        this.disabled = false;
        this.ws = null;
        this.reconnectTimeout = null;
    }

    async initialize() {
        return new Promise((resolve) => {
            try {
                this.connect();

                setTimeout(() => {
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        console.log('[OKX] Connected successfully');
                        resolve(true);
                    } else {
                        console.error('[OKX] Failed to connect');
                        this.disabled = true;
                        resolve(false);
                    }
                }, 5000);
            } catch (error) {
                console.error('[OKX] Failed to initialize:', error.message);
                this.disabled = true;
                resolve(false);
            }
        });
    }

    connect() {
        if (this.disabled) return;

        try {
            this.ws = new WebSocket(CONFIG.OKX_WS);

            this.ws.on('open', () => {
                this.consecutiveErrors = 0;
                this.subscribe();
            });

            this.ws.on('message', (data) => {
                this.handleMessage(data);
            });

            this.ws.on('error', (error) => {
                this.errors++;
                this.consecutiveErrors++;
                console.error('[OKX] WebSocket error:', error.message);
            });

            this.ws.on('close', () => {
                console.log('[OKX] WebSocket closed, reconnecting...');
                this.scheduleReconnect();
            });
        } catch (error) {
            console.error('[OKX] Connection error:', error.message);
            this.scheduleReconnect();
        }
    }

    subscribe() {
        const args = Object.values(CONFIG.OKX_SYMBOLS).map(instId => ({
            channel: 'tickers',
            instId
        }));

        const msg = {
            op: 'subscribe',
            args
        };
        this.ws.send(JSON.stringify(msg));
    }

    handleMessage(rawData) {
        try {
            const data = JSON.parse(rawData);

            if (data.data && Array.isArray(data.data)) {
                for (const ticker of data.data) {
                    const crypto = Object.keys(CONFIG.OKX_SYMBOLS).find(
                        k => CONFIG.OKX_SYMBOLS[k] === ticker.instId
                    );

                    if (crypto && ticker.last) {
                        const now = Date.now();
                        const timestamp = parseInt(ticker.ts) || now;

                        this.prices[crypto] = {
                            price: parseFloat(ticker.last),
                            timestamp,
                            staleness: Math.floor((now - timestamp) / 1000),
                            fetchedAt: now,
                            source: 'okx',
                            bid: parseFloat(ticker.bidPx) || 0,
                            ask: parseFloat(ticker.askPx) || 0,
                            volume24h: parseFloat(ticker.vol24h) || 0
                        };
                        this.lastUpdate[crypto] = now;
                    }
                }
            }
        } catch (error) {
            // Ignore parse errors
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);

        if (this.consecutiveErrors >= CONFIG.MAX_CONSECUTIVE_ERRORS) {
            console.error('[OKX] Too many errors, disabling');
            this.disabled = true;
            return;
        }

        this.reconnectTimeout = setTimeout(() => {
            this.connect();
        }, CONFIG.RECONNECT_DELAY_MS);
    }

    getPrice(crypto) {
        return this.prices[crypto] || null;
    }

    getStats() {
        return {
            name: this.name,
            disabled: this.disabled,
            connected: this.ws?.readyState === WebSocket.OPEN,
            errors: this.errors,
            consecutiveErrors: this.consecutiveErrors,
            lastUpdate: this.lastUpdate,
            priceCount: Object.keys(this.prices).length
        };
    }

    close() {
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        if (this.ws) this.ws.close();
    }
}

class CoinCapCollector {
    constructor() {
        this.name = 'coincap';
        this.prices = {};
        this.lastUpdate = {};
        this.errors = 0;
        this.consecutiveErrors = 0;
        this.disabled = false;
        this.ws = null;
        this.reconnectTimeout = null;
    }

    async initialize() {
        return new Promise((resolve) => {
            try {
                this.connect();

                setTimeout(() => {
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        console.log('[CoinCap] Connected successfully');
                        resolve(true);
                    } else {
                        console.error('[CoinCap] Failed to connect');
                        this.disabled = true;
                        resolve(false);
                    }
                }, 5000);
            } catch (error) {
                console.error('[CoinCap] Failed to initialize:', error.message);
                this.disabled = true;
                resolve(false);
            }
        });
    }

    connect() {
        if (this.disabled) return;

        try {
            const assets = Object.values(CONFIG.COINCAP_ASSETS).join(',');
            const url = `${CONFIG.COINCAP_WS}?assets=${assets}`;

            this.ws = new WebSocket(url);

            this.ws.on('open', () => {
                this.consecutiveErrors = 0;
                console.log('[CoinCap] WebSocket connected');
            });

            this.ws.on('message', (data) => {
                this.handleMessage(data);
            });

            this.ws.on('error', (error) => {
                this.errors++;
                this.consecutiveErrors++;
                console.error('[CoinCap] WebSocket error:', error.message);
            });

            this.ws.on('close', () => {
                console.log('[CoinCap] WebSocket closed, reconnecting...');
                this.scheduleReconnect();
            });
        } catch (error) {
            console.error('[CoinCap] Connection error:', error.message);
            this.scheduleReconnect();
        }
    }

    handleMessage(rawData) {
        try {
            const data = JSON.parse(rawData);
            const now = Date.now();

            // CoinCap sends: { bitcoin: "42000.50", ethereum: "2500.25", ... }
            for (const [asset, priceStr] of Object.entries(data)) {
                const crypto = Object.keys(CONFIG.COINCAP_ASSETS).find(
                    k => CONFIG.COINCAP_ASSETS[k] === asset
                );

                if (crypto) {
                    this.prices[crypto] = {
                        price: parseFloat(priceStr),
                        timestamp: now,
                        staleness: 0,
                        fetchedAt: now,
                        source: 'coincap'
                    };
                    this.lastUpdate[crypto] = now;
                }
            }
        } catch (error) {
            // Ignore parse errors
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);

        if (this.consecutiveErrors >= CONFIG.MAX_CONSECUTIVE_ERRORS) {
            console.error('[CoinCap] Too many errors, disabling');
            this.disabled = true;
            return;
        }

        this.reconnectTimeout = setTimeout(() => {
            this.connect();
        }, CONFIG.RECONNECT_DELAY_MS);
    }

    getPrice(crypto) {
        return this.prices[crypto] || null;
    }

    getStats() {
        return {
            name: this.name,
            disabled: this.disabled,
            connected: this.ws?.readyState === WebSocket.OPEN,
            errors: this.errors,
            consecutiveErrors: this.consecutiveErrors,
            lastUpdate: this.lastUpdate,
            priceCount: Object.keys(this.prices).length
        };
    }

    close() {
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        if (this.ws) this.ws.close();
    }
}

class CoinGeckoCollector {
    constructor() {
        this.name = 'coingecko';
        this.prices = {};
        this.lastUpdate = {};
        this.errors = 0;
        this.consecutiveErrors = 0;
        this.disabled = false;
        this.pollingInterval = null;
    }

    async initialize() {
        try {
            // Test connection
            const ids = Object.values(CONFIG.COINGECKO_IDS).join(',');
            const url = `${CONFIG.COINGECKO_API}/simple/price?ids=${ids}&vs_currencies=usd&include_last_updated_at=true`;

            await axios.get(url, { timeout: CONFIG.TIMEOUT_MS });
            console.log('[CoinGecko] Connected successfully');
            return true;
        } catch (error) {
            console.error('[CoinGecko] Failed to initialize:', error.message);
            this.disabled = true;
            return false;
        }
    }

    async fetchPrices() {
        if (this.disabled) return null;

        try {
            const ids = Object.values(CONFIG.COINGECKO_IDS).join(',');
            const url = `${CONFIG.COINGECKO_API}/simple/price?ids=${ids}&vs_currencies=usd&include_last_updated_at=true`;

            const response = await axios.get(url, { timeout: CONFIG.TIMEOUT_MS });
            const now = Date.now();

            for (const [id, data] of Object.entries(response.data)) {
                const crypto = Object.keys(CONFIG.COINGECKO_IDS).find(
                    k => CONFIG.COINGECKO_IDS[k] === id
                );

                if (crypto && data.usd) {
                    const timestamp = (data.last_updated_at || Math.floor(now / 1000)) * 1000;

                    this.prices[crypto] = {
                        price: data.usd,
                        timestamp,
                        staleness: Math.floor((now - timestamp) / 1000),
                        fetchedAt: now,
                        source: 'coingecko'
                    };
                    this.lastUpdate[crypto] = now;
                }
            }

            this.consecutiveErrors = 0;
            return this.prices;
        } catch (error) {
            this.errors++;
            this.consecutiveErrors++;

            if (error.response?.status === 429) {
                console.warn('[CoinGecko] Rate limited');
            }

            if (this.consecutiveErrors >= CONFIG.MAX_CONSECUTIVE_ERRORS) {
                console.error('[CoinGecko] Too many errors, disabling');
                this.disabled = true;
            }
            return null;
        }
    }

    getPrice(crypto) {
        return this.prices[crypto] || null;
    }

    getStats() {
        return {
            name: this.name,
            disabled: this.disabled,
            errors: this.errors,
            consecutiveErrors: this.consecutiveErrors,
            lastUpdate: this.lastUpdate,
            priceCount: Object.keys(this.prices).length
        };
    }
}

class RedStoneCollector {
    constructor() {
        this.name = 'redstone';
        this.prices = {};
        this.lastUpdate = {};
        this.errors = 0;
        this.consecutiveErrors = 0;
        this.disabled = false;
    }

    async initialize() {
        try {
            // Test with BTC price
            const url = `${CONFIG.REDSTONE_API}/prices?symbol=BTC&provider=redstone&limit=1`;
            await axios.get(url, { timeout: CONFIG.TIMEOUT_MS });
            console.log('[RedStone] Connected successfully');
            return true;
        } catch (error) {
            console.error('[RedStone] Failed to initialize:', error.message);
            this.disabled = true;
            return false;
        }
    }

    async fetchPrices() {
        if (this.disabled) return null;

        try {
            const symbols = ['BTC', 'ETH', 'SOL', 'XRP'];
            const url = `${CONFIG.REDSTONE_API}/prices?symbols=${symbols.join(',')}&provider=redstone`;

            const response = await axios.get(url, { timeout: CONFIG.TIMEOUT_MS });
            const now = Date.now();

            for (const [symbol, data] of Object.entries(response.data)) {
                const crypto = symbol.toLowerCase();

                if (CONFIG.CRYPTOS.includes(crypto) && data.value) {
                    this.prices[crypto] = {
                        price: data.value,
                        timestamp: data.timestamp || now,
                        staleness: Math.floor((now - (data.timestamp || now)) / 1000),
                        fetchedAt: now,
                        source: 'redstone'
                    };
                    this.lastUpdate[crypto] = now;
                }
            }

            this.consecutiveErrors = 0;
            return this.prices;
        } catch (error) {
            this.errors++;
            this.consecutiveErrors++;

            if (this.consecutiveErrors >= CONFIG.MAX_CONSECUTIVE_ERRORS) {
                console.error('[RedStone] Too many errors, disabling');
                this.disabled = true;
            }
            return null;
        }
    }

    getPrice(crypto) {
        return this.prices[crypto] || null;
    }

    getStats() {
        return {
            name: this.name,
            disabled: this.disabled,
            errors: this.errors,
            consecutiveErrors: this.consecutiveErrors,
            lastUpdate: this.lastUpdate,
            priceCount: Object.keys(this.prices).length
        };
    }
}

/**
 * Main Multi-Source Price Collector
 * Orchestrates all individual collectors
 */
export class MultiSourcePriceCollector extends EventEmitter {
    constructor() {
        super();
        this.collectors = {};
        this.pollingIntervals = {};
        this.initialized = false;
        this.startTime = null;
        this.tickCount = 0;
    }

    async initialize() {
        console.log('\n=== Initializing Multi-Source Price Collector ===\n');
        this.startTime = Date.now();

        // Initialize all collectors in parallel
        const initPromises = [
            { name: 'pyth', collector: new PythCollector() },
            { name: 'coinbase', collector: new CoinbaseCollector() },
            { name: 'kraken', collector: new KrakenCollector() },
            { name: 'okx', collector: new OKXCollector() },
            { name: 'coincap', collector: new CoinCapCollector() },
            { name: 'coingecko', collector: new CoinGeckoCollector() },
            { name: 'redstone', collector: new RedStoneCollector() }
        ];

        const results = await Promise.all(
            initPromises.map(async ({ name, collector }) => {
                const success = await collector.initialize();
                return { name, collector, success };
            })
        );

        // Store collectors
        for (const { name, collector, success } of results) {
            this.collectors[name] = collector;
            console.log(`  ${success ? '✅' : '❌'} ${name}: ${success ? 'Ready' : 'Failed'}`);
        }

        const successCount = results.filter(r => r.success).length;
        console.log(`\n${successCount}/${results.length} sources initialized\n`);

        this.initialized = true;
        return this;
    }

    startPolling() {
        if (!this.initialized) {
            throw new Error('Must initialize before starting polling');
        }

        console.log('Starting price polling...\n');

        // Pyth - poll every 1 second (fast, free)
        this.pollingIntervals.pyth = setInterval(async () => {
            if (!this.collectors.pyth.disabled) {
                await this.collectors.pyth.fetchPrices();
            }
        }, CONFIG.PYTH_POLL_INTERVAL_MS);

        // REST APIs - poll every 5 seconds
        this.pollingIntervals.rest = setInterval(async () => {
            const restCollectors = ['redstone'];
            for (const name of restCollectors) {
                if (this.collectors[name] && !this.collectors[name].disabled) {
                    await this.collectors[name].fetchPrices();
                }
            }
        }, CONFIG.REST_POLL_INTERVAL_MS);

        // CoinGecko - poll every 30 seconds (rate limited)
        this.pollingIntervals.coingecko = setInterval(async () => {
            if (!this.collectors.coingecko.disabled) {
                await this.collectors.coingecko.fetchPrices();
            }
        }, CONFIG.COINGECKO_POLL_INTERVAL_MS);

        // Emit price updates every second
        this.pollingIntervals.emit = setInterval(() => {
            this.tickCount++;
            const snapshot = this.getPriceSnapshot();
            this.emit('prices', snapshot);
        }, 1000);

        return this;
    }

    /**
     * Get current prices from all sources for a specific crypto
     */
    getPrices(crypto) {
        const prices = {};

        for (const [name, collector] of Object.entries(this.collectors)) {
            const price = collector.getPrice(crypto);
            if (price) {
                prices[name] = price;
            }
        }

        return prices;
    }

    /**
     * Get snapshot of all prices from all sources
     */
    getPriceSnapshot() {
        const snapshot = {
            timestamp: Date.now(),
            cryptos: {}
        };

        for (const crypto of CONFIG.CRYPTOS) {
            snapshot.cryptos[crypto] = this.getPrices(crypto);
        }

        return snapshot;
    }

    /**
     * Get price from a specific source
     */
    getPrice(source, crypto) {
        return this.collectors[source]?.getPrice(crypto) || null;
    }

    /**
     * Calculate consensus price (median of all sources)
     */
    getConsensusPrice(crypto) {
        const prices = this.getPrices(crypto);
        const values = Object.values(prices)
            .map(p => p.price)
            .filter(p => p > 0)
            .sort((a, b) => a - b);

        if (values.length === 0) return null;

        const mid = Math.floor(values.length / 2);
        const median = values.length % 2 !== 0
            ? values[mid]
            : (values[mid - 1] + values[mid]) / 2;

        return {
            price: median,
            sourceCount: values.length,
            min: values[0],
            max: values[values.length - 1],
            spread: values[values.length - 1] - values[0],
            spreadPct: ((values[values.length - 1] - values[0]) / median) * 100
        };
    }

    /**
     * Get divergence between two sources
     */
    getDivergence(source1, source2, crypto) {
        const price1 = this.getPrice(source1, crypto);
        const price2 = this.getPrice(source2, crypto);

        if (!price1 || !price2) return null;

        const diff = price1.price - price2.price;
        const pctDiff = (diff / price2.price) * 100;

        return {
            source1: { name: source1, price: price1.price },
            source2: { name: source2, price: price2.price },
            difference: diff,
            percentDifference: pctDiff,
            staleness1: price1.staleness,
            staleness2: price2.staleness
        };
    }

    /**
     * Get stats for all collectors
     */
    getStats() {
        const stats = {
            uptime: this.startTime ? Date.now() - this.startTime : 0,
            tickCount: this.tickCount,
            sources: {}
        };

        for (const [name, collector] of Object.entries(this.collectors)) {
            stats.sources[name] = collector.getStats();
        }

        return stats;
    }

    /**
     * Stop all polling and close connections
     */
    stop() {
        console.log('\nStopping Multi-Source Price Collector...');

        // Clear all intervals
        for (const interval of Object.values(this.pollingIntervals)) {
            clearInterval(interval);
        }

        // Close WebSocket connections
        for (const collector of Object.values(this.collectors)) {
            if (typeof collector.close === 'function') {
                collector.close();
            }
        }

        console.log('Stopped.');
    }
}

// Singleton instance
let instance = null;

export async function getMultiSourcePriceCollector() {
    if (!instance) {
        instance = new MultiSourcePriceCollector();
        await instance.initialize();
    }
    return instance;
}

export { CONFIG as MULTI_SOURCE_CONFIG };
