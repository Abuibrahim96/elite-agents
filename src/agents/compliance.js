const { runAgent } = require('../claude');
const { getOne, getMany, query } = require('../db');
const { sendSMS } = require('../services/twilioService');
const { sendEmail } = require('../services/sendgridService');
const { postMessage } = require('../services/slackService');
const { createApproval } = require('../services/approvalService');
const config = require('../config');
const SYSTEM_PROMPT = require('../prompts/compliance');

const tools = [
  {
    name: 'get_all_compliance_items',
    description: 'Get all compliance items across all drivers, grouped by urgency.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_driver_compliance',
    description: 'Get all compliance items for a specific driver.',
    input_schema: {
      type: 'object',
      properties: { driver_id: { type: 'integer' } },
      required: ['driver_id'],
    },
  },
  {
    name: 'send_compliance_reminder_sms',
    description: 'Send a compliance reminder SMS to a driver.',
    input_schema: {
      type: 'object',
      properties: {
        driver_id: { type: 'integer' },
        compliance_item_id: { type: 'integer' },
        message: { type: 'string' },
        urgency: { type: 'string', enum: ['informational', 'reminder', 'urgent', 'critical'] },
      },
      required: ['driver_id', 'compliance_item_id', 'message', 'urgency'],
    },
  },
  {
    name: 'send_compliance_reminder_email',
    description: 'Send a detailed compliance reminder email to a driver.',
    input_schema: {
      type: 'object',
      properties: {
        driver_id: { type: 'integer' },
        to_email: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['driver_id', 'to_email', 'subject', 'body'],
    },
  },
  {
    name: 'update_compliance_status',
    description: 'Update the status of a compliance item (e.g., mark as renewed, expiring_soon, expired).',
    input_schema: {
      type: 'object',
      properties: {
        item_id: { type: 'integer' },
        status: { type: 'string', enum: ['valid', 'expiring_soon', 'expired', 'renewed'] },
        notes: { type: 'string' },
      },
      required: ['item_id', 'status'],
    },
  },
  {
    name: 'request_driver_suspension',
    description: 'Create an approval request to suspend a driver due to expired compliance. Requires human approval before taking effect.',
    input_schema: {
      type: 'object',
      properties: {
        driver_id: { type: 'integer' },
        reason: { type: 'string', description: 'Why the driver should be suspended.' },
        expired_items: { type: 'string', description: 'List of expired compliance items.' },
      },
      required: ['driver_id', 'reason', 'expired_items'],
    },
  },
  {
    name: 'send_manager_alert',
    description: 'Send an urgent compliance alert to the Slack ops channel.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        priority: { type: 'string', enum: ['urgent', 'high', 'normal'] },
      },
      required: ['message'],
    },
  },
  {
    name: 'generate_compliance_report',
    description: 'Generate a summary compliance report for all drivers.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

const toolHandlers = {
  async get_all_compliance_items() {
    const expired = await getMany(`
      SELECT ci.*, d.first_name, d.last_name, d.phone, d.email, d.status as driver_status
      FROM compliance_items ci JOIN drivers d ON ci.driver_id = d.id
      WHERE ci.expiry_date < CURRENT_DATE AND ci.status != 'renewed'
      ORDER BY ci.expiry_date ASC
    `);
    const expiring7 = await getMany(`
      SELECT ci.*, d.first_name, d.last_name, d.phone, d.email
      FROM compliance_items ci JOIN drivers d ON ci.driver_id = d.id
      WHERE ci.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days' AND ci.status NOT IN ('expired','renewed')
      ORDER BY ci.expiry_date ASC
    `);
    const expiring30 = await getMany(`
      SELECT ci.*, d.first_name, d.last_name, d.phone, d.email
      FROM compliance_items ci JOIN drivers d ON ci.driver_id = d.id
      WHERE ci.expiry_date BETWEEN CURRENT_DATE + INTERVAL '8 days' AND CURRENT_DATE + INTERVAL '30 days' AND ci.status NOT IN ('expired','renewed')
      ORDER BY ci.expiry_date ASC
    `);
    const expiring90 = await getMany(`
      SELECT ci.*, d.first_name, d.last_name
      FROM compliance_items ci JOIN drivers d ON ci.driver_id = d.id
      WHERE ci.expiry_date BETWEEN CURRENT_DATE + INTERVAL '31 days' AND CURRENT_DATE + INTERVAL '90 days' AND ci.status NOT IN ('expired','renewed')
      ORDER BY ci.expiry_date ASC
    `);

    return {
      expired: { items: expired, count: expired.length },
      expiring_7_days: { items: expiring7, count: expiring7.length },
      expiring_30_days: { items: expiring30, count: expiring30.length },
      expiring_90_days: { items: expiring90, count: expiring90.length },
    };
  },

  async get_driver_compliance({ driver_id }) {
    const driver = await getOne('SELECT * FROM drivers WHERE id = $1', [driver_id]);
    if (!driver) return { error: `Driver ${driver_id} not found` };
    const items = await getMany('SELECT * FROM compliance_items WHERE driver_id = $1 ORDER BY expiry_date ASC', [driver_id]);
    return { driver, items };
  },

  async send_compliance_reminder_sms({ driver_id, compliance_item_id, message, urgency }) {
    const driver = await getOne('SELECT phone, first_name FROM drivers WHERE id = $1', [driver_id]);
    if (!driver?.phone) return { error: `Driver ${driver_id} not found or no phone` };

    await sendSMS({ to: driver.phone, body: message, agent: 'compliance', relatedType: 'driver', relatedId: driver_id });

    // Update reminder tracking
    await query(
      'UPDATE compliance_items SET last_reminder_at = NOW(), reminder_count = reminder_count + 1 WHERE id = $1',
      [compliance_item_id]
    );

    return { success: true, driver: driver.first_name, urgency };
  },

  async send_compliance_reminder_email({ driver_id, to_email, subject, body }) {
    await sendEmail({ to: to_email, subject, body, agent: 'compliance', relatedType: 'driver', relatedId: driver_id });
    return { success: true };
  },

  async update_compliance_status({ item_id, status, notes }) {
    await query(
      'UPDATE compliance_items SET status = $1, notes = COALESCE($2, notes), resolved_at = CASE WHEN $1 = $3 THEN NOW() ELSE resolved_at END WHERE id = $4',
      [status, notes, 'renewed', item_id]
    );
    return { success: true, message: `Compliance item ${item_id} updated to '${status}'` };
  },

  async request_driver_suspension({ driver_id, reason, expired_items }) {
    const driver = await getOne('SELECT first_name, last_name FROM drivers WHERE id = $1', [driver_id]);
    const driverName = driver ? `${driver.first_name} ${driver.last_name}` : `Driver ${driver_id}`;

    // Check if driver has active loads
    const activeLoad = await getOne("SELECT id, reference_number FROM loads WHERE driver_id = $1 AND status IN ('assigned','dispatched','in_transit')", [driver_id]);

    let summary = `${driverName} has expired compliance items: ${expired_items}. Requesting suspension from active dispatch.`;
    if (activeLoad) {
      summary += ` WARNING: Driver has an active load (${activeLoad.reference_number}) that will need reassignment.`;
    }

    const approval = await createApproval({
      agent: 'compliance',
      actionType: 'driver_suspension',
      priority: 'urgent',
      title: `Suspend ${driverName} — Expired Compliance`,
      summary,
      detailJson: { driver_id, expired_items, active_load_id: activeLoad?.id },
    });

    return { success: true, approval_id: approval.id, has_active_load: !!activeLoad };
  },

  async send_manager_alert({ message, priority = 'normal' }) {
    const emoji = priority === 'urgent' ? '🚨' : priority === 'high' ? '⚠️' : '📋';
    await postMessage({
      channel: config.slackOpsChannel || config.slackApprovalChannel,
      text: `${emoji} COMPLIANCE ALERT: ${message}`,
    });
    return { success: true };
  },

  async generate_compliance_report() {
    const summary = await getMany(`
      SELECT d.id, d.first_name, d.last_name, d.status as driver_status,
             COUNT(*) FILTER (WHERE ci.expiry_date < CURRENT_DATE AND ci.status != 'renewed')::int as expired_count,
             COUNT(*) FILTER (WHERE ci.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30 AND ci.status NOT IN ('expired','renewed'))::int as expiring_count,
             COUNT(*) FILTER (WHERE ci.status = 'valid' OR ci.status = 'renewed')::int as valid_count
      FROM drivers d
      LEFT JOIN compliance_items ci ON d.id = ci.driver_id
      GROUP BY d.id, d.first_name, d.last_name, d.status
      ORDER BY expired_count DESC, expiring_count DESC
    `);
    return { drivers: summary };
  },
};

async function runComplianceAgent({ trigger, context = {} }) {
  let userMessage;
  switch (trigger) {
    case 'scheduled':
      userMessage = `Run your daily compliance check: 1) Get all compliance items across all drivers. 2) For EXPIRED items: update status, send critical SMS, send manager Slack alert, and create suspension approval if needed. 3) For items expiring in 7 days: send urgent SMS reminder (if not already reminded today). 4) For items expiring in 30 days: send firm reminder (if not reminded in last 7 days). 5) For items expiring in 90 days: send informational notice (if not reminded in last 30 days). 6) Generate and report the compliance summary.`;
      break;
    case 'delegation':
      userMessage = context.instructions || 'Run a compliance check and report any issues.';
      break;
    case 'approval_callback':
      if (context.detail_json?.action === 'suspend') {
        userMessage = `Suspension approved for driver ${context.detail_json.driver_id}. Execute the suspension.`;
      } else {
        userMessage = `Approval resolved: ${JSON.stringify(context)}`;
      }
      break;
    default:
      userMessage = 'Run a full compliance check.';
  }

  return runAgent('compliance', {
    systemPrompt: SYSTEM_PROMPT, userMessage, tools, toolHandlers,
    contextKey: 'daily',
  });
}

module.exports = { runComplianceAgent, tools, toolHandlers };
