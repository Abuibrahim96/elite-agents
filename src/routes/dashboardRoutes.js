const express = require('express');
const router = express.Router();
const supa = require('../services/supabaseService');

/**
 * GET /api/dashboard/agents/status
 */
router.get('/agents/status', async (req, res) => {
  try {
    const agents = ['boss', 'dispatch', 'outreach', 'load_update', 'compliance', 'acquisition'];
    const statuses = agents.map(agent => ({
      agent,
      last_run: null,
      last_action: null,
      last_success: null,
      last_error: null,
      last_duration_ms: null,
      last_tokens: null,
    }));
    res.json({ agents: statuses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/agents/:name/logs
 */
router.get('/agents/:name/logs', async (req, res) => {
  res.json({ logs: [], count: 0 });
});

/**
 * GET /api/dashboard/loads/summary
 */
router.get('/loads/summary', async (req, res) => {
  try {
    const loads = await supa.getLoads();
    const pipeline = {};
    let totalRevenue = 0;
    let totalMargin = 0;

    loads.forEach(l => {
      const status = l.status || 'pending';
      if (!pipeline[status]) pipeline[status] = { status, count: 0, total_revenue: 0 };
      pipeline[status].count++;
      pipeline[status].total_revenue += parseFloat(l.rate) || 0;
      if (status !== 'cancelled') {
        totalRevenue += parseFloat(l.rate) || 0;
        totalMargin += parseFloat(l.company_revenue) || 0;
      }
    });

    res.json({
      pipeline: Object.values(pipeline),
      totals: { total_loads: loads.length, total_revenue: totalRevenue, total_margin: totalMargin },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/drivers/summary
 */
router.get('/drivers/summary', async (req, res) => {
  try {
    const drivers = await supa.getDrivers();
    const statusCounts = {};
    drivers.forEach(d => {
      const s = d.status || 'available';
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    });
    const statuses = Object.entries(statusCounts).map(([status, count]) => ({ status, count }));
    res.json({ statuses, total: drivers.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/compliance/alerts
 */
router.get('/compliance/alerts', async (req, res) => {
  try {
    // For now return empty — compliance data will come from Supabase when added
    res.json({
      expired: { items: [], count: 0 },
      expiring_30_days: { items: [], count: 0 },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/outreach/pipeline
 */
router.get('/outreach/pipeline', async (req, res) => {
  try {
    res.json({ pipeline: [], followups_due: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/communications
 */
router.get('/communications', async (req, res) => {
  try {
    res.json({ communications: [], count: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;