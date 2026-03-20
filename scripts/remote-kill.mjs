#!/usr/bin/env node
/**
 * Remote Kill Switch — DB-level emergency stop
 *
 * Sets kill_switch_level in runtime_controls table directly via PostgreSQL.
 * Works from anywhere with DB access — no Railway CLI needed.
 *
 * Usage:
 *   node scripts/remote-kill.mjs                # flatten (cancel orders + close positions)
 *   node scripts/remote-kill.mjs flatten        # same as above
 *   node scripts/remote-kill.mjs pause          # stop new entries, allow exits
 *   node scripts/remote-kill.mjs emergency      # immediate halt
 *   node scripts/remote-kill.mjs off            # resume normal trading
 *
 * Requires DATABASE_URL environment variable (or .env.local).
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const VALID_LEVELS = ['off', 'pause', 'flatten', 'emergency'];

// Load DATABASE_URL from .env.local if not in environment
function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  try {
    const envPath = resolve(__dirname, '..', '.env.local');
    const content = readFileSync(envPath, 'utf-8');
    const match = content.match(/^DATABASE_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // ignore
  }

  return null;
}

async function main() {
  const level = (process.argv[2] || 'flatten').toLowerCase();

  if (!VALID_LEVELS.includes(level)) {
    console.error(`Invalid level: "${level}". Valid: ${VALID_LEVELS.join(', ')}`);
    process.exit(1);
  }

  const databaseUrl = loadDatabaseUrl();
  if (!databaseUrl) {
    console.error('DATABASE_URL not found in environment or .env.local');
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('.railway.internal') ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();
    console.log('Connected to database.');

    // Upsert the kill switch level
    const result = await client.query(
      `INSERT INTO runtime_controls (key, value, updated_at)
       VALUES ('kill_switch_level', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
       RETURNING key, value, updated_at`,
      [level]
    );

    const row = result.rows[0];
    const timestamp = new Date(row.updated_at).toISOString();

    if (level === 'off') {
      console.log(`\u2713 Kill switch DISABLED at ${timestamp} — normal trading resumed.`);
    } else {
      console.log(`\u2713 Kill switch set to "${level}" at ${timestamp}`);
      console.log(`  The execution loop will pick this up within 1 second.`);
      if (level === 'flatten') {
        console.log('  Action: Cancel all open orders + close all positions.');
      } else if (level === 'pause') {
        console.log('  Action: Stop new entries, allow exits.');
      } else if (level === 'emergency') {
        console.log('  Action: Immediate halt of all trading activity.');
      }
    }

    // Also show current positions count for context
    try {
      const posResult = await client.query(
        "SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN'"
      );
      const openCount = parseInt(posResult.rows[0].count, 10);
      if (openCount > 0) {
        console.log(`\n  Open positions: ${openCount}`);
      } else {
        console.log('\n  No open positions.');
      }
    } catch {
      // positions table might not exist yet
    }

    // Show open orders count
    try {
      const orderResult = await client.query(
        "SELECT COUNT(*) as count FROM orders WHERE status = 'OPEN'"
      );
      const openOrders = parseInt(orderResult.rows[0].count, 10);
      if (openOrders > 0) {
        console.log(`  Open orders: ${openOrders}`);
      }
    } catch {
      // orders table might not exist yet
    }
  } catch (err) {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
