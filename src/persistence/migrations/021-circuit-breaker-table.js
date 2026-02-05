/**
 * Migration 021: Circuit Breaker Tables
 *
 * Creates the circuit_breaker singleton table for CB state persistence
 * and circuit_breaker_audit table for audit trail.
 *
 * V3 Stage 5: Circuit Breaker + Verify-Before-Act
 */

import { exec } from '../database.js';

export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS circuit_breaker (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      state TEXT NOT NULL DEFAULT 'CLOSED',
      trip_reason TEXT,
      trip_context JSONB,
      tripped_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO circuit_breaker (id, state)
    VALUES (1, 'CLOSED')
    ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS circuit_breaker_audit (
      id SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      reason TEXT,
      context JSONB,
      operator_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export async function down() {
  await exec(`
    DROP TABLE IF EXISTS circuit_breaker_audit;
    DROP TABLE IF EXISTS circuit_breaker;
  `);
}
