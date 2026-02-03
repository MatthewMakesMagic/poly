-- Poly Trading System - Database Schema
-- Version: 2.0.0 (PostgreSQL)
-- Foundation for write-ahead logging and crash recovery
-- V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation

-- Trade Intents Table
-- Core table for "no orphaned state" guarantee.
-- Every state-changing operation logs intent before execution.
CREATE TABLE IF NOT EXISTS trade_intents (
    id SERIAL PRIMARY KEY,
    intent_type TEXT NOT NULL CHECK(intent_type IN ('open_position', 'close_position', 'place_order', 'cancel_order')),
    window_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'executing', 'completed', 'failed')),
    created_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    result TEXT
);

-- Index on status for recovery queries: SELECT * FROM trade_intents WHERE status = 'executing'
CREATE INDEX IF NOT EXISTS idx_intents_status ON trade_intents(status);

-- Index on window_id for window-based queries
CREATE INDEX IF NOT EXISTS idx_intents_window ON trade_intents(window_id);

-- Schema Migrations Table
-- Tracks which migrations have been applied
CREATE TABLE IF NOT EXISTS schema_migrations (
    id SERIAL PRIMARY KEY,
    version TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL
);
