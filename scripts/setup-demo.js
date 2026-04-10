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

const drivers = [
  ['Marcus', 'Johnson', '+15550101', 'marcus.j@email.com', 'MC-1234567', 'DOT-9876543', 'TRK-001', 'dry_van', 'Atlanta', 'GA', 'Atlanta', 'GA', 'available', 0.85, '2027-08-15', '2027-03-20', '2027-01-10', '2026-01-15', '2025-03-01'],
  ['Rosa', 'Martinez', '+15550102', 'rosa.m@email.com', 'MC-2345678', 'DOT-8765432', 'TRK-002', 'reefer', 'Houston', 'TX', 'Dallas', 'TX', 'available', 0.85, '2027-05-22', '2026-04-01', '2026-04-22', '2026-02-10', '2025-04-15'],
  ['James', 'Williams', '+15550103', 'james.w@email.com', 'MC-3456789', 'DOT-7654321', 'TRK-003', 'flatbed', 'Indianapolis', 'IN', 'Chicago', 'IL', 'on_load', 0.87, '2028-01-30', '2027-06-15', '2027-02-28', '2026-03-01', '2025-01-20'],
  ['Aisha', 'Thompson', '+15550104', 'aisha.t@email.com', 'MC-4567890', 'DOT-6543210', 'TRK-004', 'dry_van', 'Richmond', 'VA', 'Charlotte', 'NC', 'available', 0.85, '2027-11-10', '2027-04-30', '2027-03-15', '2026-01-20', '2025-06-01'],
  ['David', 'Chen', '+15550105', 'david.c@email.com', 'MC-5678901', 'DOT-5432109', 'TRK-005', 'reefer', 'Phoenix', 'AZ', 'Los Angeles', 'CA', 'available', 0.83, '2027-09-05', '2027-01-15', '2026-12-30', '2026-02-28', '2025-05-10'],
];
for (const d of drivers) insertDriver.run(...d);
console.log('✓ 5 drivers seeded.');

// Shippers
const insertShipper = db.prepare(`
  INSERT INTO shippers (company_name, contact_name, phone, email, mc_number, type, credit_rating, avg_days_to_pay, preferred, payment_terms, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
insertShipper.run('Walmart Distribution', 'Tom Baker', '+15550201', 'tom.baker@walmart.com', 'MC-WMT001', 'shipper', 'good', 25, 1, 'Net 25', 'High volume, reliable. Priority shipper.');
insertShipper.run('Amazon Freight', 'Sarah Lee', '+15550202', 'sarah.lee@amazon.com', 'MC-AMZ001', 'shipper', 'good', 15, 1, 'Net 15', 'Quick pay available. Large volume.');
insertShipper.run('Tyson Foods', 'Mike Ross', '+15550203', 'mike.ross@tyson.com', 'MC-TYS001', 'shipper', 'fair', 35, 0, 'Net 30', 'Reefer loads. Seasonal volume spikes Q2-Q3.');
console.log('✓ 3 shippers seeded.');

// Loads
const insertLoad = db.prepare(`
  INSERT INTO loads (reference_number, shipper_id, driver_id, status, origin_city, origin_state, dest_city, dest_state, pickup_date, delivery_date, weight_lbs, commodity, rate, driver_pay, company_revenue, rate_per_mile, miles, equipment_type, broker_load)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
insertLoad.run('ELT-2001', 1, null, 'posted', 'Atlanta', 'GA', 'Miami', 'FL', '2026-04-11', '2026-04-12', 42000, 'General Merchandise', 2800, null, null, 4.24, 660, 'dry_van', 0);
insertLoad.run('ELT-2002', 2, null, 'posted', 'Dallas', 'TX', 'Chicago', 'IL', '2026-04-11', '2026-04-13', 38000, 'Electronics', 4200, null, null, 4.57, 920, 'reefer', 0);
insertLoad.run('ELT-2003', 1, null, 'posted', 'Charlotte', 'NC', 'New York', 'NY', '2026-04-10', '2026-04-11', 44000, 'General Merchandise', 2400, null, null, 3.78, 635, 'dry_van', 0);
insertLoad.run('ELT-2004', 3, null, 'posted', 'Chicago', 'IL', 'Atlanta', 'GA', '2026-04-11', '2026-04-12', 35000, 'Steel Beams', 3100, null, null, 4.31, 720, 'flatbed', 0);
insertLoad.run('ELT-2005', 2, null, 'posted', 'Houston', 'TX', 'Los Angeles', 'CA', '2026-04-12', '2026-04-15', 40000, 'Frozen Goods', 5500, null, null, 3.55, 1550, 'reefer', 0);
insertLoad.run('ELT-2006', 1, 3, 'in_transit', 'Indianapolis', 'IN', 'Memphis', 'TN', '2026-04-09', '2026-04-11', 32000, 'Steel Products', 2200, 1914, 286, 4.73, 465, 'flatbed', 0);
insertLoad.run('ELT-2007', 3, null, 'delivered', 'Atlanta', 'GA', 'Nashville', 'TN', '2026-04-07', '2026-04-08', 40000, 'Frozen Poultry', 1800, 1530, 270, 7.20, 250, 'reefer', 0);
console.log('✓ 7 loads seeded.');

// Compliance items
const insertCompliance = db.prepare(`
  INSERT INTO compliance_items (driver_id, item_type, description, expiry_date, status)
  VALUES (?, ?, ?, ?, ?)
`);
// Marcus — all good
insertCompliance.run(1, 'cdl', 'Commercial Driver License', '2027-08-15', 'valid');
insertCompliance.run(1, 'medical_card', 'DOT Physical', '2027-03-20', 'valid');
insertCompliance.run(1, 'insurance', 'Auto Liability $1M', '2027-01-10', 'valid');
insertCompliance.run(1, 'drug_test', 'Pre-employment completed', '2027-01-15', 'valid');
// Rosa — medical expired, insurance expiring
insertCompliance.run(2, 'cdl', 'Commercial Driver License', '2027-05-22', 'valid');
insertCompliance.run(2, 'medical_card', 'DOT Physical — EXPIRED', '2026-04-01', 'expired');
insertCompliance.run(2, 'insurance', 'Auto Liability $1M — Expiring', '2026-04-22', 'expiring_soon');
insertCompliance.run(2, 'drug_test', 'Random completed', '2027-02-10', 'valid');
// James — all good
insertCompliance.run(3, 'cdl', 'Commercial Driver License', '2028-01-30', 'valid');
insertCompliance.run(3, 'medical_card', 'DOT Physical', '2027-06-15', 'valid');
insertCompliance.run(3, 'insurance', 'Auto Liability $1M', '2027-02-28', 'valid');
// Aisha — drug test coming up
insertCompliance.run(4, 'cdl', 'Commercial Driver License', '2027-11-10', 'valid');
insertCompliance.run(4, 'insurance', 'Auto Liability $750K', '2027-03-15', 'valid');
insertCompliance.run(4, 'drug_test', 'Random — due soon', '2026-05-05', 'expiring_soon');
// David — all good
insertCompliance.run(5, 'cdl', 'Commercial Driver License', '2027-09-05', 'valid');
insertCompliance.run(5, 'medical_card', 'DOT Physical', '2027-01-15', 'valid');
insertCompliance.run(5, 'insurance', 'Auto Liability $1M', '2026-12-30', 'valid');
console.log('✓ 17 compliance items seeded.');

// Prospects
const insertProspect = db.prepare(`
  INSERT INTO prospects (company_name, contact_name, email, phone, type, stage, source, lanes, estimated_volume, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
insertProspect.run('ABC Logistics', 'Jennifer Adams', 'j.adams@abclogistics.com', '+15550301', 'broker', 'identified', 'cold_outreach', 'TX to IL, GA to FL', '30 loads/month', 'Large broker, good reputation');
insertProspect.run('Fresh Direct Shipping', 'Robert Kim', 'rkim@freshdirect.com', '+15550302', 'shipper', 'contacted', 'referral', 'CA to AZ, TX to CA', '50 loads/month', 'Reefer loads, seasonal produce');
insertProspect.run('Southeastern Freight', 'Lisa Morgan', 'lmorgan@sefrt.com', '+15550303', 'broker', 'responded', 'dat', 'GA to NC, NC to NY', '20 loads/month', 'Interested in dry van capacity');
console.log('✓ 3 prospects seeded.');

console.log('\n✅ Demo database ready! (' + dbPath + ')\n');
db.close();
