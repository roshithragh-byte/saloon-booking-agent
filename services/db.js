/**
 * PostgreSQL Database Connection & Schema Migration Service
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

    // Create tables for Customers and Appointments
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
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
      CREATE INDEX IF NOT EXISTS idx_appointments_customer_phone ON appointments(customer_phone);
    `);

    client.release();
    console.log("✅ PostgreSQL schema verified & ready.");
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
  }
};
