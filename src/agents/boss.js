const { runAgent } = require('../claude');
const { getOne, getMany, query } = require('../db');
const { postOpsBriefing } = require('../services/slackService');
const { createApproval, listApprovals } = require('../services/approvalService');
const SYSTEM_PROMPT = require('../prompts/boss');
const config = require('../config');

const tools = [
  {
    name: 'get_operations_snapshot',
    description: 'Get a comprehensive overview of the entire operation: drivers, loads, compliance, approvals, outreach pipeline.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_pending_approvals',
    description: 'Get all pending approval requests across all agents.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_compliance_alerts',
    description: 'Get all compliance items that are expired or expiring within 30 days.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_outreach_pipeline',
    description: 'Get summary of prospect pipeline by stage.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'delegate_to_agent',
    description: 'Delegate a specific task to a sub-agent by triggering it via n8n webhook.',
    input_schema: {
      type: 'object',
      properties: {
        agent_name: { type: 'string', enum: ['dispatch', 'outreach', 'load_update', 'compliance', 'acquisition'], description: 'Which agent to delegate to.' },
        instructions: { type: 'string', description: 'Specific instructions for the agent.' },
        priority: { type: 'string', enum: ['urgent', 'high', 'normal'], description: 'Priority of the delegation.' },
      },
      required: ['agent_name', 'instructions'],
    },
  },
  {
    name: 'post_daily_briefing',
    description: 'Post the daily briefing to the Slack ops channel.',
    input_schema: {
      type: 'object',
      properties: {
        briefing_text: { type: 'string', description: 'The full daily briefing text formatted with sections.' },
      },
      required: ['briefing_text'],
    },
  },
  {
    name: 'get_recent_agent_activity',
    description: 'Check recent agent logs to see which agents ran successfully and which had errors.',
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: 'integer', description: 'Look back this many hours. Default 24.' },
      },
      required: [],
    },
  },
];

const toolHandlers = {
  async get_operations_snapshot() {
    const drivers = await getOne(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'available')::int as available,
        COUNT(*) FILTER (WHERE status = 'on_load')::int as on_load,
        COUNT(*) FILTER (WHERE status = 'off_duty')::int as off_duty,
        COUNT(*) FILTER (WHERE status = 'suspended')::int as suspended,
        COUNT(*)::int as total
      FROM drivers
    `);
    const loads = await getOne(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('posted','quoting') AND driver_id IS NULL)::int as unassigned,
        COUNT(*) FILTER (WHERE status = 'assigned')::int as assigned,
        COUNT(*) FILTER (WHERE status IN ('dispatched','in_transit'))::int as in_transit,
        COUNT(*) FILTER (WHERE status = 'delivered')::int as delivered_pending,
        COUNT(*) FILTER (WHERE status = 'invoiced')::int as invoiced,
        COUNT(*)::int as total
      FROM loads
    `);
    const pendingApprovals = (await getOne("SELECT COUNT(*)::int as c FROM approval_queue WHERE status = 'pending'")).c;
    const complianceAlerts = (await getOne("SELECT COUNT(*)::int as c FROM compliance_items WHERE status IN ('expired','expiring_soon')")).c;
    const prospectsPipeline = (await getOne("SELECT COUNT(*)::int as c FROM prospects WHERE stage NOT IN ('lost','onboarded')")).c;

    return { drivers, loads, pending_approvals: pendingApprovals, compliance_alerts: complianceAlerts, prospects_in_pipeline: prospectsPipeline };
  },

  async get_pending_approvals() {
    const approvals = await listApprovals({ status: 'pending' });
    return { approvals, count: approvals.length };
  },

  async get_compliance_alerts() {
    const items = await getMany(`
      SELECT ci.*, d.first_name, d.last_name
      FROM compliance_items ci
      JOIN drivers d ON ci.driver_id = d.id
      WHERE ci.status IN ('expired', 'expiring_soon')
         OR ci.expiry_date <= CURRENT_DATE + INTERVAL '30 days'
      ORDER BY ci.expiry_date ASC
    `);
    return { alerts: items, count: items.length };
  },

  async get_outreach_pipeline() {
    const pipeline = await getMany(`
      SELECT stage, COUNT(*)::int as count
      FROM prospects
      GROUP BY stage
      ORDER BY CASE stage
        WHEN 'identified' THEN 1 WHEN 'contacted' THEN 2
        WHEN 'responded' THEN 3 WHEN 'negotiating' THEN 4
        WHEN 'onboarded' THEN 5 WHEN 'lost' THEN 6
      END
    `);
    const followupsDue = (await getOne("SELECT COUNT(*)::int as c FROM prospects WHERE next_followup <= NOW()")).c;
    return { pipeline, followups_due_today: followupsDue };
  },

  async delegate_to_agent({ agent_name, instructions, priority = 'normal' }) {
    // In production this would call n8n webhook. For now we log the delegation.
    const webhookUrl = `${config.n8nBaseUrl}/webhook/${agent_name}-delegate`;
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: 'delegation', context: { instructions, priority, delegated_by: 'boss' } }),
      });
      return { success: true, message: `Delegated to ${agent_name}: ${instructions}` };
    } catch (err) {
      // If n8n isn't running, just log it
      console.log(`[DELEGATION] → ${agent_name}: ${instructions}`);
      return { success: true, message: `Delegation logged for ${agent_name} (n8n webhook not reachable): ${instructions}` };
    }
  },

  async post_daily_briefing({ briefing_text }) {
    await postOpsBriefing(briefing_text);
    return { success: true, message: 'Daily briefing posted to Slack.' };
  },

  async get_recent_agent_activity({ hours = 24 } = {}) {
    const logs = await getMany(`
      SELECT agent, action, success, error_message, tokens_used, duration_ms, created_at
      FROM agent_logs
      WHERE created_at > NOW() - INTERVAL '1 hour' * $1
      ORDER BY created_at DESC LIMIT 50
    `, [hours]);
    return { logs, count: logs.length };
  },
};

async function runBossAgent({ trigger, context = {} }) {
  let userMessage;

  switch (trigger) {
    case 'scheduled':
      userMessage = `It's 6AM — time for the daily operations review. Pull the full operations snapshot, check compliance alerts, review pending approvals, check the outreach pipeline, and review recent agent activity. Then: 1) Produce a daily briefing and post it to Slack. 2) Delegate any urgent tasks to the appropriate sub-agents. 3) Summarize what you found and what actions you took.`;
      break;
    case 'manual':
      userMessage = context.instructions || 'Give me a current operations snapshot and flag anything that needs attention.';
      break;
    default:
      userMessage = 'Run a quick operations check and report anything that needs attention.';
  }

  return runAgent('boss', {
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    tools,
    toolHandlers,
    contextKey: 'daily',
  });
}

module.exports = { runBossAgent, tools, toolHandlers };
