#!/usr/bin/env node
/**
 * Sets up SQLite demo database with schema + seed data.
 * No PostgreSQL required — runs entirely local.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.USE_SQLITE = 'true';

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, '..', 'elite_agents_demo.db');

// Delete existing DB for clean start
const fs = require('fs');
if (fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
  console.log('Removed existing demo database.');
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('Creating demo database...\n');

// ============================================================================
// SCHEMA
// ============================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS drivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    mc_number TEXT,
    dot_number TEXT,
    truck_number TEXT,
    trailer_type TEXT,
    current_city TEXT,
    current_state TEXT,
    home_city TEXT,
    home_state TEXT,
    status TEXT DEFAULT 'available',
    percentage_rate REAL DEFAULT 0.85,
    cdl_expiry TEXT,
    medical_expiry TEXT,
    insurance_expiry TEXT,
    last_drug_test TEXT,
    next_drug_test TEXT,
    hire_date TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS shippers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    contact_name TEXT,
    phone TEXT,
    email TEXT,
    mc_number TEXT,
    dot_number TEXT,
    type TEXT DEFAULT 'shipper',
    credit_rating TEXT DEFAULT 'unknown',
    avg_days_to_pay INTEGER DEFAULT 30,
    preferred INTEGER DEFAULT 0,
    avg_rate_per_mile REAL,
    payment_terms TEXT DEFAULT 'Net 30',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS loads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference_number TEXT UNIQUE,
    shipper_id INTEGER REFERENCES shippers(id),
    driver_id INTEGER REFERENCES drivers(id),
    status TEXT DEFAULT 'posted',
    origin_city TEXT NOT NULL,
    origin_state TEXT NOT NULL,
    dest_city TEXT NOT NULL,
    dest_state TEXT NOT NULL,
    pickup_date TEXT,
    delivery_date TEXT,
    actual_pickup TEXT,
    actual_delivery TEXT,
    weight_lbs INTEGER,
    commodity TEXT,
    rate REAL,
    driver_pay REAL,
    company_revenue REAL,
    rate_per_mile REAL,
    miles INTEGER,
    equipment_type TEXT,
    special_instructions TEXT,
    broker_load INTEGER DEFAULT 0,
    last_known_city TEXT,
    last_known_state TEXT,
    last_update_at TEXT,
    assigned_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS prospects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    contact_name TEXT,
    phone TEXT,
    email TEXT,
    type TEXT,
    stage TEXT DEFAULT 'identified',
    source TEXT,
    lanes TEXT,
    estimated_volume TEXT,
    last_contacted TEXT,
    next_followup TEXT,
    followup_count INTEGER DEFAULT 0,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS outreach_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prospect_id INTEGER REFERENCES prospects(id),
    agent TEXT NOT NULL,
    channel TEXT NOT NULL,
    direction TEXT NOT NULL,
    subject TEXT,
    body TEXT,
    status TEXT DEFAULT 'sent',
    external_id TEXT,
    scheduled_at TEXT,
    sent_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS communications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT,
    channel TEXT NOT NULL,
    direction TEXT NOT NULL,
    from_addr TEXT,
    to_addr TEXT,
    subject TEXT,
    body TEXT,
    related_type TEXT,
    related_id INTEGER,
    external_id TEXT,
    status TEXT DEFAULT 'sent',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS compliance_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_id INTEGER REFERENCES drivers(id) NOT NULL,
    item_type TEXT NOT NULL,
    description TEXT,
    expiry_date TEXT,
    status TEXT DEFAULT 'valid',
    last_reminder_at TEXT,
    reminder_count INTEGER DEFAULT 0,
    resolved_at TEXT,
    document_url TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS approval_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    action_type TEXT NOT NULL,
    priority TEXT DEFAULT 'normal',
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    full_content TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}',
    status TEXT DEFAULT 'pending',
    requested_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,
    resolved_by TEXT,
    resolved_at TEXT,
    modified_content TEXT,
    callback_url TEXT,
    slack_ts TEXT,
    slack_channel TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    action TEXT NOT NULL,
    input_json TEXT,
    output_json TEXT,
    tokens_used INTEGER,
    duration_ms INTEGER,
    success INTEGER DEFAULT 1,
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    context_key TEXT NOT NULL,
    messages_json TEXT NOT NULL DEFAULT '[]',
    summary TEXT,
    last_used TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(agent, context_key)
  );
`);

console.log('✓ 10 tables created.\n');

// ============================================================================
// SEED DATA
// ============================================================================

// Drivers
const insertDriver = db.prepare(`
  INSERT INTO drivers (first_name, last_name, phone, email, mc_number, dot_number, truck_number, trailer_type, current_city, current_state, home_city, home_state, status, percentage_rate, cdl_expiry, medical_expiry, insurance_expiry, last_drug_test, hire_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Elite Truck Lines LLC — real drivers
const drivers = [
  ['Hassan', 'Abdullahi', null, null, null, null, null, 'dry_van', 'Portland', 'OR', 'Portland', 'OR', 'available', 0.90, null, null, null, null, '2026-04-01'],
  ['Naol', 'Tuffa', null, null, null, null, null, 'dry_van', 'Portland', 'OR', 'Portland', 'OR', 'available', 0.90, null, null, null, null, '2026-04-01'],
  ['Maslah', 'Hussein', null, null, null, null, null, 'dry_van', 'Portland', 'OR', 'Portland', 'OR', 'available', 0.90, null, null, null, null, '2026-04-01'],
  ['Olliyad', 'Tuffa', null, null, null, null, null, 'dry_van', 'Portland', 'OR', 'Portland', 'OR', 'available', 0.90, null, null, null, null, '2026-04-01'],
];
for (const d of drivers) insertDriver.run(...d);
console.log('✓ 4 drivers seeded (Elite Truck Lines LLC).');

// No fake shippers — start clean, add real ones via Telegram or dashboard
console.log('✓ 0 shippers seeded (add real ones via Telegram).');

// No fake loads — start clean
console.log('✓ 0 loads seeded (add real ones via Telegram).');

// Compliance items — placeholder, update with real dates via Telegram
const insertCompliance = db.prepare(`
  INSERT INTO compliance_items (driver_id, item_type, description, expiry_date, status)
  VALUES (?, ?, ?, ?, ?)
`);
// Hassan Abdullahi
insertCompliance.run(1, 'cdl', 'Commercial Driver License', null, 'valid');
insertCompliance.run(1, 'medical_card', 'DOT Physical', null, 'valid');
insertCompliance.run(1, 'insurance', 'Auto Liability', null, 'valid');
insertCompliance.run(1, 'drug_test', 'Pre-employment', null, 'valid');
// Naol Tuffa
insertCompliance.run(2, 'cdl', 'Commercial Driver License', null, 'valid');
insertCompliance.run(2, 'medical_card', 'DOT Physical', null, 'valid');
insertCompliance.run(2, 'insurance', 'Auto Liability', null, 'valid');
insertCompliance.run(2, 'drug_test', 'Pre-employment', null, 'valid');
// Maslah Hussein
insertCompliance.run(3, 'cdl', 'Commercial Driver License', null, 'valid');
insertCompliance.run(3, 'medical_card', 'DOT Physical', null, 'valid');
insertCompliance.run(3, 'insurance', 'Auto Liability', null, 'valid');
insertCompliance.run(3, 'drug_test', 'Pre-employment', null, 'valid');
// Olliyad Tuffa
insertCompliance.run(4, 'cdl', 'Commercial Driver License', null, 'valid');
insertCompliance.run(4, 'medical_card', 'DOT Physical', null, 'valid');
insertCompliance.run(4, 'insurance', 'Auto Liability', null, 'valid');
insertCompliance.run(4, 'drug_test', 'Pre-employment', null, 'valid');
console.log('✓ 16 compliance items seeded (dates TBD — update via Telegram).');

// No fake prospects — add real ones via Telegram
console.log('✓ 0 prospects seeded (add real ones via Telegram).');

console.log('\n✅ Demo database ready! (' + dbPath + ')\n');
db.close();
