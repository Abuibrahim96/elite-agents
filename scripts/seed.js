#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const seedFile = path.join(__dirname, '..', 'db', 'seeds', '001_sample_data.sql');
  const sql = fs.readFileSync(seedFile, 'utf8');

  console.log('Seeding database...');
  try {
    await pool.query(sql);
    console.log('✓ Seed data applied successfully.');
  } catch (err) {
    console.error('✗ Seed failed:', err.message);
  }

  await pool.end();
}

seed();
