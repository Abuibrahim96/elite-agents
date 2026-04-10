#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const migrationDir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(migrationDir).filter(f => f.endsWith('.sql')).sort();

  console.log(`Found ${files.length} migration(s).\n`);

  for (const file of files) {
    const filePath = path.join(migrationDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    console.log(`Running: ${file}...`);
    try {
      await pool.query(sql);
      console.log(`  ✓ ${file} applied successfully.\n`);
    } catch (err) {
      console.error(`  ✗ ${file} FAILED: ${err.message}\n`);
      process.exit(1);
    }
  }

  console.log('All migrations complete.');
  await pool.end();
}

migrate().catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
