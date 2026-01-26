/**
 * Claim Service
 *
 * Monitors resolved markets and handles claiming/redemption of winning positions.
 *
 * Current limitations:
 * - Polymarket has no official redeem API for Safe/proxy wallets
 * - Direct CTF contract calls don't work because positions are held by Safe
 *
 * Approach:
 * 1. Track all live trades and their window epochs
 * 2. Query for resolved markets
 * 3. For winning positions:
 *    - Option A: Sell at 0.99 after resolution (loses ~1% but automated)
 *    - Option B: Log for manual claiming via UI
 * 4. Future: Add proper CTF redeem when API is available
 *
 * References:
 * - CTF Contract: 0x4d97dcd97ec945f40cf65f87097ace5ea0476045
 * - USDC: 0x2791bca1f2de4661ed88a30c99a7a9449aa84174
 * - GitHub Issue: https://github.com/Polymarket/py-clob-client/issues/139
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';

// Configuration
const CONFIG = {
    // How often to check for claimable positions (ms)
    CHECK_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes

    // Price to sell at for auto-claim (loses ~1%)
    AUTO_CLAIM_SELL_PRICE: 0.99,

    // Minimum position value to auto-claim ($)
    MIN_CLAIM_VALUE: 1.0,

    // How long after resolution to attempt auto-sell (ms)
    // Markets need time for price to reach 0.99
    POST_RESOLUTION_DELAY_MS: 2 * 60 * 1000, // 2 minutes

    // How old can a position be before we stop tracking (hours)
    MAX_POSITION_AGE_HOURS: 48,
};

/**
 * Position to be claimed
 */
class PendingClaim {
    constructor(params) {
        this.id = params.id || `${params.strategyName}_${params.crypto}_${params.windowEpoch}`;
        this.strategyName = params.strategyName;
        this.crypto = params.crypto;
        this.windowEpoch = params.windowEpoch;
        this.side = params.side; // 'up' or 'down'
        this.tokenId = params.tokenId;
        this.shares = params.shares;
        this.entryPrice = params.entryPrice;
        this.entryTimestamp = params.entryTimestamp;

        // Resolution status
        this.resolved = false;
        this.outcome = null; // 'up' or 'down'
        this.resolvedAt = null;
        this.isWinner = null;

        // Claim status
        this.claimed = false;
        this.claimMethod = null; // 'auto_sell', 'manual', 'ctf_redeem'
        this.claimTxHash = null;
        this.claimAmount = null;
        this.claimTimestamp = null;

        // Tracking
        this.checkCount = 0;
        this.lastChecked = null;
        this.errors = [];
    }

    calculateExpectedPayout() {
        if (!this.resolved || !this.isWinner) return 0;
        return this.shares; // Winner gets $1 per share
    }
}

/**
 * Claim Service - Main class
 */
export class ClaimService {
    constructor(options = {}) {
        this.options = {
            checkIntervalMs: CONFIG.CHECK_INTERVAL_MS,
            autoClaimEnabled: options.autoClaimEnabled ?? false, // Disabled by default
            autoClaimSellPrice: CONFIG.AUTO_CLAIM_SELL_PRICE,
            minClaimValue: CONFIG.MIN_CLAIM_VALUE,
            ...options
        };

        // SDK client reference (set externally)
        this.sdkClient = null;

        // Pending claims: id -> PendingClaim
        this.pendingClaims = new Map();

        // Completed claims (for reporting)
        this.completedClaims = [];
        this.maxCompletedClaims = 100;

        // Interval handle
        this.checkInterval = null;

        // Stats
        this.stats = {
            positionsTracked: 0,
            positionsResolved: 0,
            positionsWon: 0,
            positionsLost: 0,
            totalClaimed: 0,
            totalClaimedValue: 0,
            autoClaimAttempts: 0,
            autoClaimSuccesses: 0,
            errors: 0
        };

        console.log('[ClaimService] Initialized with options:', {
            autoClaimEnabled: this.options.autoClaimEnabled,
            checkIntervalMs: this.options.checkIntervalMs
        });
    }

    /**
     * Set SDK client reference
     */
    setSDKClient(client) {
        this.sdkClient = client;
        console.log('[ClaimService] SDK client linked');
    }

    /**
     * Start periodic checking
     */
    start() {
        if (this.checkInterval) {
            console.log('[ClaimService] Already running');
            return;
        }

        console.log('[ClaimService] Starting periodic claim checks...');
        this.checkInterval = setInterval(
            () => this.checkAllPendingClaims(),
            this.options.checkIntervalMs
        );

        // Run initial check
        this.checkAllPendingClaims();
    }

    /**
     * Stop periodic checking
     */
    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
            console.log('[ClaimService] Stopped');
        }
    }

    // =========================================================================
    // POSITION TRACKING
    // =========================================================================

    /**
     * Track a new position (called when trade is executed)
     */
    trackPosition(params) {
        const {
            strategyName,
            crypto,
            windowEpoch,
            side,
            tokenId,
            shares,
            entryPrice,
            entryTimestamp
        } = params;

        const claim = new PendingClaim({
            strategyName,
            crypto,
            windowEpoch,
            side,
            tokenId,
            shares,
            entryPrice,
            entryTimestamp: entryTimestamp || Date.now()
        });

        this.pendingClaims.set(claim.id, claim);
        this.stats.positionsTracked++;

        console.log(`[ClaimService] Tracking: ${claim.id} | ${side} | ${shares} shares @ ${entryPrice}`);

        return claim.id;
    }

    /**
     * Update position shares (if additional buys)
     */
    updatePosition(id, additionalShares) {
        const claim = this.pendingClaims.get(id);
        if (claim) {
            claim.shares += additionalShares;
            console.log(`[ClaimService] Updated ${id}: now ${claim.shares} shares`);
        }
    }

    /**
     * Remove a position (if sold before resolution)
     */
    removePosition(id) {
        if (this.pendingClaims.has(id)) {
            this.pendingClaims.delete(id);
            console.log(`[ClaimService] Removed: ${id}`);
        }
    }

    // =========================================================================
    // RESOLUTION CHECKING
    // =========================================================================

    /**
     * Check all pending claims for resolution and claim status
     */
    async checkAllPendingClaims() {
        const now = Date.now();
        const cutoff = now - (CONFIG.MAX_POSITION_AGE_HOURS * 60 * 60 * 1000);

        console.log(`[ClaimService] Checking ${this.pendingClaims.size} pending claims...`);

        for (const [id, claim] of this.pendingClaims.entries()) {
            // Skip very old positions
            if (claim.entryTimestamp < cutoff) {
                console.log(`[ClaimService] Removing stale position: ${id}`);
                this.pendingClaims.delete(id);
                continue;
            }

            // Skip already claimed
            if (claim.claimed) {
                this.moveToCompleted(claim);
                continue;
            }

            try {
                await this.checkClaim(claim);
            } catch (error) {
                console.error(`[ClaimService] Error checking ${id}: ${error.message}`);
                claim.errors.push({ timestamp: now, error: error.message });
                this.stats.errors++;
            }

            claim.checkCount++;
            claim.lastChecked = now;
        }
    }

    /**
     * Check a single claim
     */
    async checkClaim(claim) {
        // Step 1: Check if market is resolved
        if (!claim.resolved) {
            await this.checkResolution(claim);
        }

        // Step 2: If resolved and winner, attempt to claim
        if (claim.resolved && claim.isWinner && !claim.claimed) {
            // Check if enough time has passed for price to stabilize
            const timeSinceResolution = Date.now() - claim.resolvedAt;

            if (timeSinceResolution >= CONFIG.POST_RESOLUTION_DELAY_MS) {
                if (this.options.autoClaimEnabled && this.sdkClient) {
                    await this.attemptAutoClaim(claim);
                } else {
                    // Log for manual claiming
                    this.logForManualClaim(claim);
                }
            }
        }
    }

    /**
     * Check if market is resolved
     */
    async checkResolution(claim) {
        try {
            // Calculate market end time from epoch
            const marketEndTime = (claim.windowEpoch + 900) * 1000; // 15 min window

            // If market hasn't ended yet, skip
            if (Date.now() < marketEndTime) {
                return;
            }

            // Query Gamma API for market status
            const slug = `${claim.crypto}-updown-15m-${claim.windowEpoch}`;
            const response = await fetch(`${GAMMA_API}/markets?slug=${slug}`);
            const markets = await response.json();

            if (!markets || markets.length === 0) {
                return; // Market not found yet
            }

            const market = markets[0];

            // Check if resolved
            if (market.closed || market.resolved) {
                claim.resolved = true;
                claim.resolvedAt = Date.now();

                // Determine outcome
                // outcomePrices: [YES_price, NO_price] - winner has price = 1
                const outcomePrices = JSON.parse(market.outcomePrices || '[]');
                if (outcomePrices.length >= 2) {
                    claim.outcome = parseFloat(outcomePrices[0]) > 0.5 ? 'up' : 'down';
                    claim.isWinner = claim.side === claim.outcome;

                    this.stats.positionsResolved++;
                    if (claim.isWinner) {
                        this.stats.positionsWon++;
                        console.log(`[ClaimService] ✅ WINNER: ${claim.id} | ${claim.side} | ${claim.shares} shares`);
                    } else {
                        this.stats.positionsLost++;
                        console.log(`[ClaimService] ❌ LOSER: ${claim.id} | ${claim.side} vs ${claim.outcome}`);
                    }
                }
            }
        } catch (error) {
            console.error(`[ClaimService] Resolution check failed for ${claim.id}: ${error.message}`);
        }
    }

    // =========================================================================
    // CLAIMING
    // =========================================================================

    /**
     * Attempt auto-claim by selling at 0.99
     */
    async attemptAutoClaim(claim) {
        if (!this.sdkClient) {
            console.warn('[ClaimService] No SDK client, cannot auto-claim');
            return;
        }

        const expectedValue = claim.shares * this.options.autoClaimSellPrice;
        if (expectedValue < this.options.minClaimValue) {
            console.log(`[ClaimService] Position too small to auto-claim: $${expectedValue.toFixed(2)}`);
            return;
        }

        console.log(`[ClaimService] Attempting auto-claim: ${claim.id} | ${claim.shares} shares @ $0.99`);
        this.stats.autoClaimAttempts++;

        try {
            // Sell at 0.99
            const result = await this.sdkClient.sell(
                claim.tokenId,
                claim.shares,
                this.options.autoClaimSellPrice,
                'FOK' // Fill or Kill
            );

            if (result.filled) {
                claim.claimed = true;
                claim.claimMethod = 'auto_sell';
                claim.claimTxHash = result.tx;
                claim.claimAmount = result.value;
                claim.claimTimestamp = Date.now();

                this.stats.autoClaimSuccesses++;
                this.stats.totalClaimed++;
                this.stats.totalClaimedValue += result.value;

                console.log(`[ClaimService] ✅ Auto-claimed: ${claim.id} | $${result.value.toFixed(2)}`);

                this.moveToCompleted(claim);
            } else {
                console.log(`[ClaimService] Auto-claim not filled: ${claim.id} | status=${result.status}`);
                // Will retry on next check
            }
        } catch (error) {
            console.error(`[ClaimService] Auto-claim failed for ${claim.id}: ${error.message}`);
            claim.errors.push({ timestamp: Date.now(), error: error.message });
        }
    }

    /**
     * Log position for manual claiming
     */
    logForManualClaim(claim) {
        const expectedPayout = claim.calculateExpectedPayout();
        console.log(`[ClaimService] 💰 MANUAL CLAIM NEEDED:`);
        console.log(`   Position: ${claim.id}`);
        console.log(`   Crypto: ${claim.crypto}`);
        console.log(`   Side: ${claim.side} (won)`);
        console.log(`   Shares: ${claim.shares}`);
        console.log(`   Expected: $${expectedPayout.toFixed(2)}`);
        console.log(`   Token ID: ${claim.tokenId}`);
        console.log(`   Claim via: https://polymarket.com/portfolio`);
    }

    /**
     * Move claim to completed list
     */
    moveToCompleted(claim) {
        this.pendingClaims.delete(claim.id);
        this.completedClaims.push({
            ...claim,
            completedAt: Date.now()
        });

        // Trim completed list
        while (this.completedClaims.length > this.maxCompletedClaims) {
            this.completedClaims.shift();
        }
    }

    // =========================================================================
    // MANUAL CLAIM TRIGGERS
    // =========================================================================

    /**
     * Manually trigger claim attempt for a position
     */
    async manualClaim(id) {
        const claim = this.pendingClaims.get(id);
        if (!claim) {
            return { success: false, error: 'Position not found' };
        }

        if (!claim.resolved) {
            return { success: false, error: 'Market not yet resolved' };
        }

        if (!claim.isWinner) {
            return { success: false, error: 'Position is not a winner' };
        }

        if (claim.claimed) {
            return { success: false, error: 'Already claimed' };
        }

        await this.attemptAutoClaim(claim);

        return {
            success: claim.claimed,
            claimAmount: claim.claimAmount,
            txHash: claim.claimTxHash
        };
    }

    /**
     * Get list of positions needing manual claim
     */
    getPendingManualClaims() {
        const pending = [];
        for (const claim of this.pendingClaims.values()) {
            if (claim.resolved && claim.isWinner && !claim.claimed) {
                pending.push({
                    id: claim.id,
                    crypto: claim.crypto,
                    side: claim.side,
                    shares: claim.shares,
                    expectedPayout: claim.calculateExpectedPayout(),
                    tokenId: claim.tokenId,
                    resolvedAt: claim.resolvedAt
                });
            }
        }
        return pending;
    }

    // =========================================================================
    // REPORTING
    // =========================================================================

    /**
     * Get claim summary report
     */
    getReport() {
        const pendingManual = this.getPendingManualClaims();
        const totalPendingValue = pendingManual.reduce((sum, c) => sum + c.expectedPayout, 0);

        return {
            stats: this.stats,
            pendingClaims: this.pendingClaims.size,
            pendingManualClaims: pendingManual.length,
            totalPendingValue: `$${totalPendingValue.toFixed(2)}`,
            totalClaimedValue: `$${this.stats.totalClaimedValue.toFixed(2)}`,
            autoClaimEnabled: this.options.autoClaimEnabled,
            autoClaimSuccessRate: this.stats.autoClaimAttempts > 0
                ? `${((this.stats.autoClaimSuccesses / this.stats.autoClaimAttempts) * 100).toFixed(1)}%`
                : 'N/A',
            recentCompleted: this.completedClaims.slice(-10).map(c => ({
                id: c.id,
                method: c.claimMethod,
                amount: c.claimAmount,
                timestamp: new Date(c.claimTimestamp).toISOString()
            }))
        };
    }

    /**
     * Get all pending claims
     */
    getAllPendingClaims() {
        const claims = [];
        for (const claim of this.pendingClaims.values()) {
            claims.push({
                id: claim.id,
                crypto: claim.crypto,
                side: claim.side,
                shares: claim.shares,
                entryPrice: claim.entryPrice,
                resolved: claim.resolved,
                outcome: claim.outcome,
                isWinner: claim.isWinner,
                claimed: claim.claimed,
                claimMethod: claim.claimMethod,
                claimAmount: claim.claimAmount
            });
        }
        return claims;
    }

    getStats() {
        return this.stats;
    }
}

// Singleton
let claimServiceInstance = null;

export function getClaimService(options = {}) {
    if (!claimServiceInstance) {
        claimServiceInstance = new ClaimService(options);
    }
    return claimServiceInstance;
}

export default ClaimService;
