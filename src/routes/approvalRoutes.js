const express = require('express');
const router = express.Router();
const { listApprovals, resolveApproval, expireStaleApprovals } = require('../services/approvalService');
const { getOne } = require('../db');

/**
 * GET /api/approvals
 * List approvals with optional filters: ?status=pending&agent=dispatch&limit=50
 */
router.get('/', async (req, res) => {
  try {
    const { status, agent, limit } = req.query;
    const approvals = await listApprovals({
      status: status || null,
      agent: agent || null,
      limit: parseInt(limit || '50', 10),
    });
    res.json({ approvals, count: approvals.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/approvals/:id
 * Get a single approval by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const approval = await getOne('SELECT * FROM approval_queue WHERE id = $1', [req.params.id]);
    if (!approval) return res.status(404).json({ error: 'Approval not found' });
    res.json({ approval });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/approvals/:id
 * Resolve an approval: { status: 'approved'|'rejected', resolvedBy: 'username', modifiedContent: '...' }
 */
router.patch('/:id', async (req, res) => {
  try {
    const { status, resolvedBy, modifiedContent } = req.body;
    if (!status || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
    }

    const result = await resolveApproval(parseInt(req.params.id, 10), {
      status,
      resolvedBy: resolvedBy || 'dashboard',
      modifiedContent: modifiedContent || null,
    });

    res.json(result);
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 400).json({ error: err.message });
  }
});

/**
 * POST /api/approvals/expire
 * Manually trigger expiration of stale approvals
 */
router.post('/expire', async (req, res) => {
  try {
    const result = await expireStaleApprovals();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
