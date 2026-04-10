-- Elite Trucking — Sample seed data for development/testing
-- Run after migration: psql $DATABASE_URL -f db/seeds/001_sample_data.sql

-- ============================================================================
-- DRIVERS (5 Owner-Operators)
-- ============================================================================
INSERT INTO drivers (first_name, last_name, phone, email, mc_number, dot_number, truck_number, trailer_type, current_city, current_state, home_city, home_state, status, percentage_rate, cdl_expiry, medical_expiry, insurance_expiry, last_drug_test, hire_date)
VALUES
  ('Marcus', 'Johnson', '+15550101', 'marcus.j@email.com', 'MC-1234567', 'DOT-9876543', 'TRK-001', 'dry_van', 'Atlanta', 'GA', 'Atlanta', 'GA', 'available', 0.85, '2027-08-15', '2027-03-20', '2027-01-10', '2026-01-15', '2025-03-01'),
  ('Rosa', 'Martinez', '+15550102', 'rosa.m@email.com', 'MC-2345678', 'DOT-8765432', 'TRK-002', 'reefer', 'Houston', 'TX', 'Dallas', 'TX', 'available', 0.85, '2027-05-22', '2026-04-25', '2026-04-20', '2026-02-10', '2025-04-15'),
  ('James', 'Williams', '+15550103', 'james.w@email.com', 'MC-3456789', 'DOT-7654321', 'TRK-003', 'flatbed', 'Indianapolis', 'IN', 'Chicago', 'IL', 'on_load', 0.87, '2028-01-30', '2027-06-15', '2027-02-28', '2026-03-01', '2025-01-20'),
  ('Aisha', 'Thompson', '+15550104', 'aisha.t@email.com', 'MC-4567890', 'DOT-6543210', 'TRK-004', 'dry_van', 'Richmond', 'VA', 'Charlotte', 'NC', 'available', 0.85, '2027-11-10', '2027-04-30', '2027-03-15', '2026-01-20', '2025-06-01'),
  ('David', 'Chen', '+15550105', 'david.c@email.com', 'MC-5678901', 'DOT-5432109', 'TRK-005', 'reefer', 'Phoenix', 'AZ', 'Los Angeles', 'CA', 'available', 0.83, '2027-09-05', '2027-01-15', '2026-12-30', '2026-02-28', '2025-05-10')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- SHIPPERS (3 companies)
-- ============================================================================
INSERT INTO shippers (company_name, contact_name, phone, email, mc_number, type, credit_rating, avg_days_to_pay, preferred, payment_terms, notes)
VALUES
  ('Walmart Distribution', 'Tom Baker', '+15550201', 'tom.baker@walmart.com', 'MC-WMT001', 'shipper', 'good', 25, true, 'Net 25', 'High volume, reliable. Priority shipper.'),
  ('Amazon Freight', 'Sarah Lee', '+15550202', 'sarah.lee@amazon.com', 'MC-AMZ001', 'shipper', 'good', 15, true, 'Net 15', 'Quick pay available. Large volume.'),
  ('Tyson Foods', 'Mike Ross', '+15550203', 'mike.ross@tyson.com', 'MC-TYS001', 'shipper', 'fair', 35, false, 'Net 30', 'Reefer loads. Seasonal volume spikes Q2-Q3.')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- LOADS (7 loads — mix of statuses)
-- ============================================================================
INSERT INTO loads (reference_number, shipper_id, driver_id, status, origin_city, origin_state, dest_city, dest_state, pickup_date, delivery_date, weight_lbs, commodity, rate, rate_per_mile, miles, equipment_type, broker_load)
VALUES
  ('ELT-2001', 1, NULL, 'posted', 'Atlanta', 'GA', 'Miami', 'FL', NOW() + INTERVAL '1 day', NOW() + INTERVAL '2 days', 42000, 'General Merchandise', 2800.00, 4.24, 660, 'dry_van', false),
  ('ELT-2002', 2, NULL, 'posted', 'Dallas', 'TX', 'Chicago', 'IL', NOW() + INTERVAL '1 day', NOW() + INTERVAL '3 days', 38000, 'Electronics', 4200.00, 4.57, 920, 'reefer', false),
  ('ELT-2003', 1, NULL, 'posted', 'Charlotte', 'NC', 'New York', 'NY', NOW(), NOW() + INTERVAL '1 day', 44000, 'General Merchandise', 2400.00, 3.78, 635, 'dry_van', false),
  ('ELT-2004', 3, NULL, 'posted', 'Chicago', 'IL', 'Atlanta', 'GA', NOW() + INTERVAL '1 day', NOW() + INTERVAL '2 days', 35000, 'Steel Beams', 3100.00, 4.31, 720, 'flatbed', false),
  ('ELT-2005', 2, NULL, 'posted', 'Houston', 'TX', 'Los Angeles', 'CA', NOW() + INTERVAL '2 days', NOW() + INTERVAL '4 days', 40000, 'Frozen Goods', 5500.00, 3.55, 1550, 'reefer', false),
  ('ELT-2006', 1, 3, 'in_transit', 'Indianapolis', 'IN', 'Memphis', 'TN', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', 32000, 'Steel Products', 2200.00, 4.73, 465, 'flatbed', false),
  ('ELT-2007', 3, NULL, 'delivered', 'Atlanta', 'GA', 'Nashville', 'TN', NOW() - INTERVAL '3 days', NOW() - INTERVAL '2 days', 40000, 'Frozen Poultry', 1800.00, 7.20, 250, 'reefer', false)
ON CONFLICT (reference_number) DO NOTHING;

-- Update driver_pay and company_revenue for assigned/delivered loads
UPDATE loads SET driver_pay = rate * 0.87, company_revenue = rate * 0.13 WHERE reference_number = 'ELT-2006';
UPDATE loads SET driver_pay = rate * 0.85, company_revenue = rate * 0.15 WHERE reference_number = 'ELT-2007';

-- ============================================================================
-- COMPLIANCE ITEMS (per-driver tracking)
-- ============================================================================
INSERT INTO compliance_items (driver_id, item_type, description, expiry_date, status)
VALUES
  -- Marcus (all good)
  (1, 'cdl', 'Commercial Driver License', '2027-08-15', 'valid'),
  (1, 'medical_card', 'DOT Physical', '2027-03-20', 'valid'),
  (1, 'insurance', 'Auto Liability $1M', '2027-01-10', 'valid'),
  (1, 'drug_test', 'Pre-employment completed', '2027-01-15', 'valid'),

  -- Rosa (medical expired, insurance expiring soon)
  (2, 'cdl', 'Commercial Driver License', '2027-05-22', 'valid'),
  (2, 'medical_card', 'DOT Physical — EXPIRED', '2026-04-01', 'expired'),
  (2, 'insurance', 'Auto Liability $1M — Expiring', CURRENT_DATE + INTERVAL '12 days', 'expiring_soon'),
  (2, 'drug_test', 'Random completed', '2027-02-10', 'valid'),

  -- James (all good)
  (3, 'cdl', 'Commercial Driver License', '2028-01-30', 'valid'),
  (3, 'medical_card', 'DOT Physical', '2027-06-15', 'valid'),
  (3, 'insurance', 'Auto Liability $1M', '2027-02-28', 'valid'),

  -- Aisha (drug test expiring in 25 days)
  (4, 'cdl', 'Commercial Driver License', '2027-11-10', 'valid'),
  (4, 'insurance', 'Auto Liability $750K', '2027-03-15', 'valid'),
  (4, 'drug_test', 'Random — expiring soon', CURRENT_DATE + INTERVAL '25 days', 'expiring_soon'),

  -- David (all good)
  (5, 'cdl', 'Commercial Driver License', '2027-09-05', 'valid'),
  (5, 'medical_card', 'DOT Physical', '2027-01-15', 'valid'),
  (5, 'insurance', 'Auto Liability $1M', '2026-12-30', 'valid')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- PROSPECTS (outreach pipeline)
-- ============================================================================
INSERT INTO prospects (company_name, contact_name, email, phone, type, stage, source, lanes, estimated_volume, notes)
VALUES
  ('ABC Logistics', 'Jennifer Adams', 'j.adams@abclogistics.com', '+15550301', 'broker', 'identified', 'cold_outreach', 'TX→IL, GA→FL', '30 loads/month', 'Large broker, good reputation'),
  ('Fresh Direct Shipping', 'Robert Kim', 'rkim@freshdirect.com', '+15550302', 'shipper', 'contacted', 'referral', 'CA→AZ, TX→CA', '50 loads/month', 'Reefer loads, seasonal produce'),
  ('Southeastern Freight', 'Lisa Morgan', 'lmorgan@sefrt.com', '+15550303', 'broker', 'responded', 'dat', 'GA→NC, NC→NY', '20 loads/month', 'Interested in dry van capacity')
ON CONFLICT DO NOTHING;
