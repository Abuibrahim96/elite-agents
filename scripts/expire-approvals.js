#!/usr/bin/env node
/**
 * Expire stale approvals that have passed their deadline.
 * Run via cron every 15 minutes: */15 * * * * node /path/to/expire-approvals.js
 * Or via n8n scheduled trigger.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { expireStaleApprovals } = require('../src/services/approvalService');

async function main() {
  try {
    const result = await expireStaleApprovals();
    if (result.expired > 0) {
      console.log(`Expired ${result.expired} stale approval(s).`);
    }
    process.exit(0);
  } catch (err) {
    console.error('Error expiring approvals:', err.message);
    process.exit(1);
  }
}

main();
