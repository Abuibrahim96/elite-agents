const { runAgent } = require('../claude');
const { getOne, getMany, query } = require('../db');
const { sendSMS } = require('../services/twilioService');
const { sendEmail } = require('../services/sendgridService');
const { postMessage } = require('../services/slackService');
const { createApproval } = require('../services/approvalService');
const config = require('../config');
const SYSTEM_PROMPT = require('../prompts/loadUpdate');

const tools = [
  {
    name: 'get_active_loads',
    description: 'Get all loads currently in transit or dispatched, with driver and shipper info.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_last_driver_checkin',
    description: 'Get the most recent SMS communication with a driver for a specific load.',
    input_schema: {
      type: 'object',
      properties: {
        driver_id: { type: 'integer' },
        load_id: { type: 'integer' },
      },
      required: ['driver_id'],
    },
  },
  {
    name: 'send_driver_checkin_sms',
    description: 'Send a check-in SMS to a driver asking for location/ETA update.',
    input_schema: {
      type: 'object',
      properties: {
        driver_id: { type: 'integer' },
        load_id: { type: 'integer' },
        message: { type: 'string' },
      },
      required: ['driver_id', 'load_id', 'message'],
    },
  },
  {
    name: 'parse_and_update_location',
    description: 'Update a load\'s last known location and ETA based on parsed driver response.',
    input_schema: {
      type: 'object',
      properties: {
        load_id: { type: 'integer' },
        city: { type: 'string' },
        state: { type: 'string' },
        estimated_delivery: { type: 'string', description: 'Updated ETA in ISO format or natural language.' },
        notes: { type: 'string', description: 'Any notes from the driver.' },
      },
      required: ['load_id'],
    },
  },
  {
    name: 'send_shipper_update_email',
    description: 'Send a professional status update email to the shipper/broker for a load.',
    input_schema: {
      type: 'object',
      properties: {
        load_id: { type: 'integer' },
        to_email: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['load_id', 'to_email', 'subject', 'body'],
    },
  },
  {
    name: 'mark_load_delivered',
    description: 'Mark a load as delivered. Updates load status and frees up the driver.',
    input_schema: {
      type: 'object',
      properties: {
        load_id: { type: 'integer' },
      },
      required: ['load_id'],
    },
  },
  {
    name: 'flag_issue',
    description: 'Flag a load issue (delay, breakdown, etc.) — sends Slack alert and optionally creates approval.',
    input_schema: {
      type: 'object',
      properties: {
        load_id: { type: 'integer' },
        issue_type: { type: 'string', enum: ['delay', 'breakdown', 'refused', 'detention', 'driver_unreachable'] },
        description: { type: 'string' },
        needs_approval: { type: 'boolean', description: 'Whether this needs human approval before taking action.' },
      },
      required: ['load_id', 'issue_type', 'description'],
    },
  },
];

const toolHandlers = {
  async get_active_loads() {
    const loads = await getMany(`
      SELECT l.*,
             d.first_name as driver_first, d.last_name as driver_last, d.phone as driver_phone, d.email as driver_email,
             s.company_name as shipper_name, s.contact_name as shipper_contact, s.email as shipper_email, s.phone as shipper_phone
      FROM loads l
      LEFT JOIN drivers d ON l.driver_id = d.id
      LEFT JOIN shippers s ON l.shipper_id = s.id
      WHERE l.status IN ('dispatched', 'in_transit')
      ORDER BY l.delivery_date ASC
    `);
    return { loads, count: loads.length };
  },

  async get_last_driver_checkin({ driver_id, load_id }) {
    let sql = `SELECT * FROM communications WHERE related_type = 'driver' AND related_id = $1 AND channel = 'sms' ORDER BY created_at DESC LIMIT 5`;
    const params = [driver_id];
    const comms = await getMany(sql, params);
    return { communications: comms, count: comms.length };
  },

  async send_driver_checkin_sms({ driver_id, load_id, message }) {
    const driver = await getOne('SELECT phone, first_name FROM drivers WHERE id = $1', [driver_id]);
    if (!driver || !driver.phone) return { error: `Driver ${driver_id} not found or no phone` };

    const result = await sendSMS({
      to: driver.phone, body: message,
      agent: 'load_update', relatedType: 'load', relatedId: load_id,
    });
    return { success: true, driver: driver.first_name, ...result };
  },

  async parse_and_update_location({ load_id, city, state, estimated_delivery, notes }) {
    const updates = ['last_update_at = NOW()'];
    const params = [];
    let idx = 1;

    if (city) { updates.push(`last_known_city = $${idx++}`); params.push(city); }
    if (state) { updates.push(`last_known_state = $${idx++}`); params.push(state); }
    if (estimated_delivery) { updates.push(`delivery_date = $${idx++}`); params.push(estimated_delivery); }
    if (notes) { updates.push(`special_instructions = COALESCE(special_instructions, '') || E'\\n' || $${idx++}`); params.push(`[Update] ${notes}`); }

    params.push(load_id);
    await query(`UPDATE loads SET ${updates.join(', ')} WHERE id = $${idx}`, params);

    // Also update driver location
    if (city && state) {
      const load = await getOne('SELECT driver_id FROM loads WHERE id = $1', [load_id]);
      if (load?.driver_id) {
        await query('UPDATE drivers SET current_city = $1, current_state = $2 WHERE id = $3', [city, state, load.driver_id]);
      }
    }

    return { success: true, message: `Load ${load_id} location updated to ${city || '?'}, ${state || '?'}` };
  },

  async send_shipper_update_email({ load_id, to_email, subject, body }) {
    await sendEmail({
      to: to_email, subject, body,
      agent: 'load_update', relatedType: 'load', relatedId: load_id,
    });
    return { success: true, message: `Shipper update sent for load ${load_id}` };
  },

  async mark_load_delivered({ load_id }) {
    const load = await getOne('SELECT * FROM loads WHERE id = $1', [load_id]);
    if (!load) return { error: `Load ${load_id} not found` };

    await query("UPDATE loads SET status = 'delivered', actual_delivery = NOW() WHERE id = $1", [load_id]);
    if (load.driver_id) {
      await query("UPDATE drivers SET status = 'available', current_city = $1, current_state = $2 WHERE id = $3",
        [load.dest_city, load.dest_state, load.driver_id]);
    }
    return { success: true, message: `Load ${load.reference_number} marked as delivered.` };
  },

  async flag_issue({ load_id, issue_type, description, needs_approval = false }) {
    const load = await getOne(
      `SELECT l.reference_number, l.origin_city, l.origin_state, l.dest_city, l.dest_state,
              d.first_name, d.last_name FROM loads l LEFT JOIN drivers d ON l.driver_id = d.id WHERE l.id = $1`,
      [load_id]
    );

    const alertText = `🚨 LOAD ISSUE — ${issue_type.toUpperCase()}\nLoad: ${load?.reference_number || load_id}\nRoute: ${load?.origin_city},${load?.origin_state} → ${load?.dest_city},${load?.dest_state}\nDriver: ${load?.first_name || 'N/A'} ${load?.last_name || ''}\nIssue: ${description}`;

    // Always post to Slack
    await postMessage({ channel: config.slackOpsChannel || config.slackApprovalChannel, text: alertText });

    if (needs_approval) {
      const approval = await createApproval({
        agent: 'load_update',
        actionType: `load_issue_${issue_type}`,
        priority: issue_type === 'breakdown' ? 'urgent' : 'high',
        title: `Load ${load?.reference_number || load_id}: ${issue_type}`,
        summary: description,
        detailJson: { load_id, issue_type },
      });
      return { success: true, slack_alert: true, approval_id: approval.id };
    }

    return { success: true, slack_alert: true, message: 'Issue flagged and Slack alert sent.' };
  },
};

async function runLoadUpdateAgent({ trigger, context = {} }) {
  let userMessage;
  switch (trigger) {
    case 'scheduled':
      userMessage = 'Run your scheduled check-in cycle: 1) Get all active loads (in_transit or dispatched). 2) For each load, check when the last driver check-in was. 3) If no check-in in the last 2 hours, text the driver. 4) Report summary of all active loads and any issues.';
      break;
    case 'driver_reply':
      userMessage = `Driver ${context.driver_name} (ID: ${context.driver_id}) replied to a check-in for load ${context.load_id}: "${context.reply_text}". Parse this reply to extract location and ETA. Update the load record. If the reply indicates any issues (delay, breakdown, etc.), flag it appropriately. Then send a status update email to the shipper.`;
      break;
    case 'delegation':
      userMessage = context.instructions || 'Check on all active loads and report status.';
      break;
    default:
      userMessage = 'Check on all active loads and provide status update.';
  }

  return runAgent('load_update', {
    systemPrompt: SYSTEM_PROMPT, userMessage, tools, toolHandlers,
    contextKey: context.load_id ? `load:${context.load_id}` : 'cycle',
  });
}

module.exports = { runLoadUpdateAgent, tools, toolHandlers };
