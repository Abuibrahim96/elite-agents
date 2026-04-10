const express = require('express');
const router = express.Router();
const { getOne, getMany } = require('../db');

/**
 * GET /api/dashboard/agents/status
 * Agent health: last run, success, duration
 */
router.get('/agents/status', async (req, res) => {
  try {
    const agents = ['boss', 'dispatch', 'outreach', 'load_update', 'compliance', 'acquisition'];
    const statuses = [];

    for (const agent of agents) {
      const lastRun = await getOne(
        'SELECT action, success, error_message, duration_ms, tokens_used, created_at FROM agent_logs WHERE agent = $1 ORDER BY created_at DESC LIMIT 1',
        [agent]
      );
      statuses.push({
        agent,
        last_run: lastRun?.created_at || null,
        last_action: lastRun?.action || null,
        last_success: lastRun?.success ?? null,
        last_error: lastRun?.error_message || null,
        last_duration_ms: lastRun?.duration_ms || null,
        last_tokens: lastRun?.tokens_used || null,
      });
    }

    res.json({ agents: statuses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/agents/:name/logs?limit=20
 */
router.get('/agents/:name/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '20', 10);
    const logs = await getMany(
      'SELECT * FROM agent_logs WHERE agent = $1 ORDER BY created_at DESC LIMIT $2',
      [req.params.name, limit]
    );
    res.json({ logs, count: logs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/loads/summary
 * Load pipeline counts by status
 */
router.get('/loads/summary', async (req, res) => {
  try {
    const summary = await getMany(`
      SELECT status, COUNT(*)::int as count, COALESCE(SUM(rate), 0)::numeric as total_revenue
      FROM loads GROUP BY status
      ORDER BY CASE status
        WHEN 'posted' THEN 1 WHEN 'quoting' THEN 2 WHEN 'assigned' THEN 3
        WHEN 'dispatched' THEN 4 WHEN 'in_transit' THEN 5 WHEN 'delivered' THEN 6
        WHEN 'invoiced' THEN 7 WHEN 'paid' THEN 8 WHEN 'cancelled' THEN 9
      END
    `);
    const totals = await getOne(`
      SELECT COUNT(*)::int as total_loads,
             COALESCE(SUM(rate), 0)::numeric as total_revenue,
             COALESCE(SUM(company_revenue), 0)::numeric as total_margin
      FROM loads WHERE status != 'cancelled'
    `);
    res.json({ pipeline: summary, totals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/drivers/summary
 */
router.get('/drivers/summary', async (req, res) => {
  try {
    const summary = await getMany(`
      SELECT status, COUNT(*)::int as count FROM drivers GROUP BY status
    `);
    const total = (await getOne('SELECT COUNT(*)::int as c FROM drivers')).c;
    res.json({ statuses: summary, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/compliance/alerts
 * Upcoming expirations across all drivers
 */
router.get('/compliance/alerts', async (req, res) => {
  try {
    const expired = await getMany(`
      SELECT ci.*, d.first_name, d.last_name
      FROM compliance_items ci JOIN drivers d ON ci.driver_id = d.id
      WHERE ci.expiry_date < CURRENT_DATE AND ci.status != 'renewed'
      ORDER BY ci.expiry_date ASC
    `);
    const expiringSoon = await getMany(`
      SELECT ci.*, d.first_name, d.last_name
      FROM compliance_items ci JOIN drivers d ON ci.driver_id = d.id
      WHERE ci.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
        AND ci.status NOT IN ('expired', 'renewed')
      ORDER BY ci.expiry_date ASC
    `);
    res.json({
      expired: { items: expired, count: expired.length },
      expiring_30_days: { items: expiringSoon, count: expiringSoon.length },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/outreach/pipeline
 * Prospect funnel counts
 */
router.get('/outreach/pipeline', async (req, res) => {
  try {
    const pipeline = await getMany(`
      SELECT stage, type, COUNT(*)::int as count
      FROM prospects GROUP BY stage, type
      ORDER BY stage, type
    `);
    const followupsDue = (await getOne("SELECT COUNT(*)::int as c FROM prospects WHERE next_followup <= NOW() AND stage NOT IN ('onboarded','lost')")).c;
    res.json({ pipeline, followups_due: followupsDue });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/communications?limit=50&agent=dispatch&channel=sms
 */
router.get('/communications', async (req, res) => {
  try {
    const { limit = '50', agent, channel, direction } = req.query;
    let sql = 'SELECT * FROM communications WHERE 1=1';
    const params = [];
    if (agent) { sql += ` AND agent = $${params.length + 1}`; params.push(agent); }
    if (channel) { sql += ` AND channel = $${params.length + 1}`; params.push(channel); }
    if (direction) { sql += ` AND direction = $${params.length + 1}`; params.push(direction); }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit, 10));

    const comms = await getMany(sql, params);
    res.json({ communications: comms, count: comms.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
