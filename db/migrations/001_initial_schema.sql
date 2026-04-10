-- Elite Trucking AI Agent System — PostgreSQL Schema
-- Run with: node scripts/migrate.js

-- ============================================================================
-- ENUMS
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE driver_status AS ENUM ('available', 'on_load', 'off_duty', 'maintenance', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE load_status AS ENUM ('posted', 'quoting', 'assigned', 'dispatched', 'in_transit', 'delivered', 'invoiced', 'paid', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE prospect_stage AS ENUM ('identified', 'contacted', 'responded', 'negotiating', 'onboarded', 'lost');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================================
-- TABLES
-- ============================================================================

-- DRIVERS (Owner-Operators)
CREATE TABLE IF NOT EXISTS drivers (
    id              SERIAL PRIMARY KEY,
    first_name      VARCHAR(100) NOT NULL,
    last_name       VARCHAR(100) NOT NULL,
    phone           VARCHAR(20),
    email           VARCHAR(255),
    mc_number       VARCHAR(20),
    dot_number      VARCHAR(20),
    truck_number    VARCHAR(50),
    trailer_type    VARCHAR(50),       -- dry_van, reefer, flatbed, step_deck
    current_city    VARCHAR(100),
    current_state   VARCHAR(2),
    home_city       VARCHAR(100),
    home_state      VARCHAR(2),
    status          driver_status DEFAULT 'available',
    percentage_rate NUMERIC(4,2) DEFAULT 0.85,  -- OO keeps 85%
    cdl_expiry      DATE,
    medical_expiry  DATE,
    insurance_expiry DATE,
    last_drug_test  DATE,
    next_drug_test  DATE,
    hire_date       DATE,
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- SHIPPERS / BROKERS
CREATE TABLE IF NOT EXISTS shippers (
    id              SERIAL PRIMARY KEY,
    company_name    VARCHAR(255) NOT NULL,
    contact_name    VARCHAR(200),
    phone           VARCHAR(20),
    email           VARCHAR(255),
    mc_number       VARCHAR(20),
    dot_number      VARCHAR(20),
    type            VARCHAR(20) DEFAULT 'shipper',  -- shipper, broker
    credit_rating   VARCHAR(20) DEFAULT 'unknown',  -- good, fair, poor, unknown
    avg_days_to_pay INTEGER DEFAULT 30,
    preferred       BOOLEAN DEFAULT FALSE,
    avg_rate_per_mile NUMERIC(6,2),
    payment_terms   VARCHAR(50) DEFAULT 'Net 30',
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- LOADS
CREATE TABLE IF NOT EXISTS loads (
    id              SERIAL PRIMARY KEY,
    reference_number VARCHAR(50) UNIQUE,
    shipper_id      INTEGER REFERENCES shippers(id),
    driver_id       INTEGER REFERENCES drivers(id),
    status          load_status DEFAULT 'posted',
    origin_city     VARCHAR(100) NOT NULL,
    origin_state    VARCHAR(2) NOT NULL,
    dest_city       VARCHAR(100) NOT NULL,
    dest_state      VARCHAR(2) NOT NULL,
    pickup_date     TIMESTAMPTZ,
    delivery_date   TIMESTAMPTZ,
    actual_pickup   TIMESTAMPTZ,
    actual_delivery TIMESTAMPTZ,
    weight_lbs      INTEGER,
    commodity       VARCHAR(255),
    rate            NUMERIC(10,2),
    driver_pay      NUMERIC(10,2),
    company_revenue NUMERIC(10,2),
    rate_per_mile   NUMERIC(6,2),
    miles           INTEGER,
    equipment_type  VARCHAR(50),
    special_instructions TEXT,
    broker_load     BOOLEAN DEFAULT FALSE,
    last_known_city VARCHAR(100),
    last_known_state VARCHAR(2),
    last_update_at  TIMESTAMPTZ,
    assigned_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- PROSPECTS (outreach pipeline)
CREATE TABLE IF NOT EXISTS prospects (
    id              SERIAL PRIMARY KEY,
    company_name    VARCHAR(255) NOT NULL,
    contact_name    VARCHAR(200),
    phone           VARCHAR(20),
    email           VARCHAR(255),
    type            VARCHAR(50),       -- shipper, broker, carrier
    stage           prospect_stage DEFAULT 'identified',
    source          VARCHAR(100),      -- dat, truckstop, referral, cold_outreach
    lanes           TEXT,              -- JSON array of lane objects
    estimated_volume VARCHAR(100),     -- "50 loads/month"
    last_contacted  TIMESTAMPTZ,
    next_followup   TIMESTAMPTZ,
    followup_count  INTEGER DEFAULT 0,
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- OUTREACH LOG (email/call tracking for prospects)
CREATE TABLE IF NOT EXISTS outreach_log (
    id              SERIAL PRIMARY KEY,
    prospect_id     INTEGER REFERENCES prospects(id),
    agent           VARCHAR(50) NOT NULL,
    channel         VARCHAR(20) NOT NULL,    -- email, sms, call
    direction       VARCHAR(10) NOT NULL,    -- outbound, inbound
    subject         VARCHAR(500),
    body            TEXT,
    status          VARCHAR(50) DEFAULT 'sent', -- sent, delivered, opened, replied, bounced
    external_id     VARCHAR(255),            -- SendGrid message ID
    scheduled_at    TIMESTAMPTZ,
    sent_at         TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- COMMUNICATIONS (all SMS/email between system and drivers/shippers)
CREATE TABLE IF NOT EXISTS communications (
    id              SERIAL PRIMARY KEY,
    agent           VARCHAR(50),
    channel         VARCHAR(20) NOT NULL,    -- sms, email, voice, slack
    direction       VARCHAR(10) NOT NULL,    -- outbound, inbound
    from_addr       VARCHAR(255),
    to_addr         VARCHAR(255),
    subject         VARCHAR(500),
    body            TEXT,
    related_type    VARCHAR(50),             -- driver, load, shipper, prospect
    related_id      INTEGER,
    external_id     VARCHAR(255),            -- Twilio SID, SendGrid ID
    status          VARCHAR(50) DEFAULT 'sent',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- COMPLIANCE ITEMS (per-driver document/certification tracking)
CREATE TABLE IF NOT EXISTS compliance_items (
    id              SERIAL PRIMARY KEY,
    driver_id       INTEGER REFERENCES drivers(id) NOT NULL,
    item_type       VARCHAR(100) NOT NULL,   -- cdl, medical_card, drug_test, insurance, annual_inspection, mvr, ifta, authority
    description     VARCHAR(500),
    expiry_date     DATE,
    status          VARCHAR(50) DEFAULT 'valid', -- valid, expiring_soon, expired, renewed
    last_reminder_at TIMESTAMPTZ,
    reminder_count  INTEGER DEFAULT 0,
    resolved_at     TIMESTAMPTZ,
    document_url    VARCHAR(500),
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- APPROVAL QUEUE (human-in-the-loop)
CREATE TABLE IF NOT EXISTS approval_queue (
    id              SERIAL PRIMARY KEY,
    agent           VARCHAR(50) NOT NULL,
    action_type     VARCHAR(100) NOT NULL,
    priority        VARCHAR(20) DEFAULT 'normal',  -- urgent, high, normal
    title           VARCHAR(500) NOT NULL,
    summary         TEXT NOT NULL,
    full_content    TEXT,
    detail_json     JSONB NOT NULL DEFAULT '{}',
    status          approval_status DEFAULT 'pending',
    requested_at    TIMESTAMPTZ DEFAULT NOW(),
    expires_at      TIMESTAMPTZ,
    resolved_by     VARCHAR(100),
    resolved_at     TIMESTAMPTZ,
    modified_content TEXT,
    callback_url    VARCHAR(500),
    slack_ts        VARCHAR(50),
    slack_channel   VARCHAR(50),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- AGENT LOGS (every agent invocation and action)
CREATE TABLE IF NOT EXISTS agent_logs (
    id              SERIAL PRIMARY KEY,
    agent           VARCHAR(50) NOT NULL,
    action          VARCHAR(200) NOT NULL,
    input_json      JSONB,
    output_json     JSONB,
    tokens_used     INTEGER,
    duration_ms     INTEGER,
    success         BOOLEAN DEFAULT TRUE,
    error_message   TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- AGENT MEMORY (conversation context persistence)
CREATE TABLE IF NOT EXISTS agent_memory (
    id              SERIAL PRIMARY KEY,
    agent           VARCHAR(50) NOT NULL,
    context_key     VARCHAR(200) NOT NULL,
    messages_json   JSONB NOT NULL DEFAULT '[]',
    summary         TEXT,
    last_used       TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(agent, context_key)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status);
CREATE INDEX IF NOT EXISTS idx_loads_status ON loads(status);
CREATE INDEX IF NOT EXISTS idx_loads_driver ON loads(driver_id);
CREATE INDEX IF NOT EXISTS idx_loads_shipper ON loads(shipper_id);
CREATE INDEX IF NOT EXISTS idx_loads_pickup ON loads(pickup_date);
CREATE INDEX IF NOT EXISTS idx_compliance_driver ON compliance_items(driver_id);
CREATE INDEX IF NOT EXISTS idx_compliance_expiry ON compliance_items(expiry_date);
CREATE INDEX IF NOT EXISTS idx_compliance_status ON compliance_items(status);
CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_queue(status);
CREATE INDEX IF NOT EXISTS idx_approval_expires ON approval_queue(expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_logs_agent ON agent_logs(agent, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_memory_lookup ON agent_memory(agent, context_key);
CREATE INDEX IF NOT EXISTS idx_outreach_prospect ON outreach_log(prospect_id);
CREATE INDEX IF NOT EXISTS idx_prospects_stage ON prospects(stage);
CREATE INDEX IF NOT EXISTS idx_comms_related ON communications(related_type, related_id);
CREATE INDEX IF NOT EXISTS idx_comms_agent ON communications(agent, created_at);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_drivers_updated ON drivers;
CREATE TRIGGER trg_drivers_updated BEFORE UPDATE ON drivers FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_shippers_updated ON shippers;
CREATE TRIGGER trg_shippers_updated BEFORE UPDATE ON shippers FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_loads_updated ON loads;
CREATE TRIGGER trg_loads_updated BEFORE UPDATE ON loads FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_prospects_updated ON prospects;
CREATE TRIGGER trg_prospects_updated BEFORE UPDATE ON prospects FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_compliance_updated ON compliance_items;
CREATE TRIGGER trg_compliance_updated BEFORE UPDATE ON compliance_items FOR EACH ROW EXECUTE FUNCTION update_updated_at();
