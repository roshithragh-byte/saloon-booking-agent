/**
 * PostgreSQL Database Connection, Transaction Management & Schema Migrations
 */
"use strict";

const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
    });
  }
  return pool;
}

async function initDatabase() {
  const p = getPool();
  if (!p) {
    console.log("ℹ️ No DATABASE_URL found. Running with in-memory storage fallback.");
    return;
  }

  try {
    const client = await p.connect();
    console.log("🐘 Connected to PostgreSQL successfully!");

    // Execute idempotent migrations
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        phone VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        total_visits INTEGER DEFAULT 0,
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS appointments (
        id VARCHAR(50) PRIMARY KEY,
        customer_phone VARCHAR(50) REFERENCES customers(phone) ON DELETE SET NULL,
        customer_name VARCHAR(255) NOT NULL,
        service_id VARCHAR(100),
        service_name VARCHAR(255) NOT NULL,
        duration_min INTEGER NOT NULL DEFAULT 45,
        price VARCHAR(50) NOT NULL,
        staff_name VARCHAR(255),
        date VARCHAR(20) NOT NULL,
        time VARCHAR(20) NOT NULL,
        status VARCHAR(50) DEFAULT 'confirmed',
        calendar_event_link TEXT,
        location VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Persistent conversation sessions across restarts & scaling
      CREATE TABLE IF NOT EXISTS conversation_sessions (
        phone VARCHAR(50) PRIMARY KEY,
        state VARCHAR(50) NOT NULL,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Integration outbox for resilient retryable synchronization
      CREATE TABLE IF NOT EXISTS integration_outbox (
        id VARCHAR(50) PRIMARY KEY,
        booking_id VARCHAR(50) REFERENCES appointments(id) ON DELETE CASCADE,
        target VARCHAR(50) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(50) DEFAULT 'PENDING',
        attempts INTEGER DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Webhook deduplication log
      CREATE TABLE IF NOT EXISTS processed_webhooks (
        message_id VARCHAR(100) PRIMARY KEY,
        processed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
      CREATE INDEX IF NOT EXISTS idx_appointments_customer_phone ON appointments(customer_phone);
      CREATE INDEX IF NOT EXISTS idx_outbox_status ON integration_outbox(status);
    `);

    client.release();
    console.log("✅ PostgreSQL schema & migration tables verified & ready.");
  } catch (err) {
    console.error("❌ PostgreSQL initialization error:", err.message);
  }
}

module.exports = {
  getPool,
  initDatabase,

  async query(text, params) {
    const p = getPool();
    if (!p) return null;
    return p.query(text, params);
  },

  async getClient() {
    const p = getPool();
    if (!p) return null;
    return p.connect();
  }
};
