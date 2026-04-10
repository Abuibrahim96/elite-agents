const express = require('express');
const router = express.Router();

// Agent runners
const { runBossAgent } = require('../agents/boss');
const { runDispatchAgent } = require('../agents/dispatch');
const { runOutreachAgent } = require('../agents/outreach');
const { runLoadUpdateAgent } = require('../agents/loadUpdate');
const { runComplianceAgent } = require('../agents/compliance');
const { runAcquisitionAgent } = require('../agents/acquisition');

const agentRunners = {
  boss: runBossAgent,
  dispatch: runDispatchAgent,
  outreach: runOutreachAgent,
  load_update: runLoadUpdateAgent,
  compliance: runComplianceAgent,
  acquisition: runAcquisitionAgent,
};

/**
 * POST /api/agent/:agentName/run
 *
 * Invoke an agent. Body:
 * {
 *   trigger: 'scheduled' | 'manual' | 'delegation' | 'new_load' | 'driver_reply' | 'approval_callback',
 *   context: { ... agent-specific context }
 * }
 */
router.post('/:agentName/run', async (req, res) => {
  const { agentName } = req.params;
  const { trigger = 'manual', context = {} } = req.body;

  const runner = agentRunners[agentName];
  if (!runner) {
    return res.status(404).json({
      error: `Unknown agent: ${agentName}`,
      available: Object.keys(agentRunners),
    });
  }

  console.log(`\n[AGENT RUN] ${agentName} | trigger: ${trigger} | context: ${JSON.stringify(context).substring(0, 200)}`);

  try {
    const result = await runner({ trigger, context });
    res.json({
      agent: agentName,
      trigger,
      response: result.response,
      actions: result.actions,
      tokensUsed: result.tokensUsed,
      durationMs: result.durationMs,
      turns: result.turns,
    });
  } catch (err) {
    console.error(`[AGENT ERROR] ${agentName}:`, err.message);
    res.status(500).json({
      error: `Agent ${agentName} failed`,
      message: err.message,
    });
  }
});

/**
 * GET /api/agent/status
 * Quick health check — which agents are available
 */
router.get('/status', (req, res) => {
  res.json({
    agents: Object.keys(agentRunners).map(name => ({ name, status: 'ready' })),
  });
});

module.exports = router;
