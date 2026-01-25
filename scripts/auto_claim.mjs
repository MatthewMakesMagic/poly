#!/usr/bin/env node
/**
 * Auto-Claim Script
 * 
 * Automatically claims/redeems winning positions after market resolution.
 * 
 * How it works:
 * 1. Fetches all conditional token balances
 * 2. Checks which markets have resolved
 * 3. Calls redeemPositions on the CTF contract
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { ethers, Contract, Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';

// ═══════════════════════════════════════════════════════════════════════════
// CONTRACT ADDRESSES (Polygon)
// ═══════════════════════════════════════════════════════════════════════════

const CONTRACTS = {
    CTF: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',          // Conditional Token Framework
    NEG_RISK_CTF: '0xC5d563A36AE78145C45a50134d48A1215220f80a',  // Neg Risk CTF Adapter
    USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',         // USDC on Polygon
    EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'       // CTF Exchange
};

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const RPC_URL = 'https://polygon-rpc.com';

// CTF ABI for redemption
const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
    'function balanceOfBatch(address[] owners, uint256[] ids) view returns (uint256[])',
    'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
    'event PositionsMerge(address indexed stakeholder, address collateralToken, bytes32 indexed parentCollectionId, bytes32 indexed conditionId, uint256[] partition, uint256 amount)',
    'event PayoutRedemption(address indexed redeemer, address indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 payout)'
];

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function createCompatibleWallet(privateKey) {
    const wallet = new Wallet(privateKey);
    wallet._signTypedData = (d, t, v) => wallet.signTypedData(d, t, v);
    return wallet;
}

/**
 * Get condition ID from token ID
 * For Polymarket, the token ID encodes the condition ID
 */
function getConditionIdFromTokenId(tokenId) {
    // Polymarket token IDs are derived from condition ID + outcome index
    // This is a simplification - actual derivation is more complex
    return null; // We'll get condition IDs from the API instead
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('\n' + '═'.repeat(60));
    console.log('     AUTO-CLAIM WINNINGS');
    console.log('═'.repeat(60) + '\n');
    
    const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
    const funder = process.env.POLYMARKET_FUNDER_ADDRESS;
    
    if (!privateKey || !funder) {
        console.error('Missing POLYMARKET_PRIVATE_KEY or POLYMARKET_FUNDER_ADDRESS');
        process.exit(1);
    }
    
    // Setup wallet and provider
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const signer = new Wallet(privateKey, provider);
    
    console.log(`Signer: ${signer.address}`);
    console.log(`Funder (Proxy): ${funder}`);
    
    // Setup CLOB client
    const wallet = createCompatibleWallet(privateKey);
    const baseClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
    const creds = await baseClient.deriveApiKey();
    const client = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds, 2, funder);
    
    // Get recent trades to find resolved markets
    console.log('\n📊 Fetching recent trades and markets...');
    const trades = await client.getTrades(100);
    
    // Get unique condition IDs from trades
    const conditionIds = new Set();
    const marketInfo = new Map();
    
    for (const trade of trades || []) {
        if (trade.market) {
            conditionIds.add(trade.market);
            if (!marketInfo.has(trade.market)) {
                marketInfo.set(trade.market, {
                    conditionId: trade.market,
                    outcome: trade.outcome,
                    assetId: trade.asset_id
                });
            }
        }
    }
    
    console.log(`Found ${conditionIds.size} unique markets in trade history`);
    
    // Setup CTF contract
    const ctf = new Contract(CONTRACTS.NEG_RISK_CTF, CTF_ABI, signer);
    
    // Check each condition for claimable positions
    console.log('\n🔍 Checking for claimable positions...\n');
    
    const claimable = [];
    
    for (const [conditionId, info] of marketInfo) {
        try {
            // Check if market is resolved by checking payout denominator
            const denominator = await ctf.payoutDenominator(conditionId);
            
            if (denominator > 0n) {
                // Market is resolved - check balances
                const tokenId = BigInt(info.assetId);
                const balance = await ctf.balanceOf(funder, tokenId);
                
                if (balance > 0n) {
                    // Check payout
                    const outcomeIndex = info.outcome === 'Up' ? 0 : 1;
                    const numerator = await ctf.payoutNumerators(conditionId, outcomeIndex);
                    const payoutRatio = Number(numerator) / Number(denominator);
                    
                    if (payoutRatio > 0) {
                        const balanceNum = Number(balance) / 1e6;
                        const payout = balanceNum * payoutRatio;
                        
                        claimable.push({
                            conditionId,
                            tokenId: tokenId.toString(),
                            outcome: info.outcome,
                            balance: balanceNum,
                            payoutRatio,
                            expectedPayout: payout
                        });
                        
                        console.log(`✅ Claimable: ${info.outcome} - ${balanceNum.toFixed(4)} tokens → $${payout.toFixed(2)}`);
                    }
                }
            }
        } catch (e) {
            // Market not resolved or error - skip
        }
    }
    
    if (claimable.length === 0) {
        console.log('No claimable positions found.\n');
        console.log('Note: Positions may need to be redeemed through the Polymarket web UI');
        console.log('or the market may not be fully resolved yet.\n');
        return;
    }
    
    console.log(`\n📋 Found ${claimable.length} claimable positions\n`);
    
    // Calculate total expected payout
    const totalPayout = claimable.reduce((sum, c) => sum + c.expectedPayout, 0);
    console.log(`Total expected payout: $${totalPayout.toFixed(2)}\n`);
    
    // Ask for confirmation
    const args = process.argv.slice(2);
    const autoConfirm = args.includes('--yes') || args.includes('-y');
    
    if (!autoConfirm) {
        console.log('Run with --yes to auto-confirm redemption');
        console.log('Example: node scripts/auto_claim.mjs --yes\n');
        return;
    }
    
    // Execute redemptions
    console.log('─'.repeat(50));
    console.log('     EXECUTING REDEMPTIONS');
    console.log('─'.repeat(50) + '\n');
    
    for (const claim of claimable) {
        try {
            console.log(`Redeeming ${claim.outcome} position...`);
            
            // Call redeemPositions
            // indexSets: [1] for outcome 0, [2] for outcome 1, [1, 2] for both
            const indexSets = claim.outcome === 'Up' ? [1n] : [2n];
            
            const tx = await ctf.redeemPositions(
                CONTRACTS.USDC,
                ethers.zeroPadValue('0x', 32), // parentCollectionId = 0
                claim.conditionId,
                indexSets,
                { gasLimit: 200000 }
            );
            
            console.log(`   Tx: ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);
            
        } catch (e) {
            console.log(`   ❌ Failed: ${e.message}`);
        }
    }
    
    console.log('\n✅ Redemption complete!\n');
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
