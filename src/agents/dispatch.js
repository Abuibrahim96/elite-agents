const { runAgent } = require('../claude');
const { getOne, getMany, query } = require('../db');
const { sendSMS } = require('../services/twilioService');
const { sendEmail } = require('../services/sendgridService');
const { createApproval } = require('../services/approvalService');
const SYSTEM_PROMPT = require('../prompts/dispatch');

// ============================================================================
// TOOL DEFINITIONS (sent to Claude API)
// ============================================================================

const tools = [
  {
    name: 'get_available_drivers',
    description: 'Get all owner-operators with status "available", including their current location and equipment type.',
    input_schema: {
      type: 'object',
      properties: {
        trailer_type: { type: 'string', description: 'Filter by trailer type: dry_van, reefer, flatbed, step_deck. Leave empty for all.' },
        state: { type: 'string', description: 'Filter by current state (2-letter code). Leave empty for all.' },
      },
      required: [],
    },
  },
  {
    name: 'get_unassigned_loads',
    description: 'Get all loads with status "posted" or "quoting" that need a driver assigned.',
    input_schema: {
      type: 'object',
      properties: {
        equipment_type: { type: 'string', description: 'Filter by equipment type.' },
        origin_state: { type: 'string', description: 'Filter by origin state.' },
      },
      required: [],
    },
  },
  {
    name: 'get_driver_detail',
    description: 'Get full details for a specific driver including compliance status and recent load history.',
    input_schema: {
      type: 'object',
      properties: {
        driver_id: { type: 'integer', description: 'The driver ID.' },
      },
      required: ['driver_id'],
    },
  },
  {
    name: 'get_load_detail',
    description: 'Get full details for a specific load.',
    input_schema: {
      type: 'object',
      properties: {
        load_id: { type: 'integer', description: 'The load ID.' },
      },
      required: ['load_id'],
    },
  },
  {
    name: 'assign_load_to_driver',
    description: 'Assign a load to a driver. Calculates pay split automatically. Use this for standard rate assignments. Will be rejected if rate_per_mile < $2.00 — use request_approval instead.',
    input_schema: {
      type: 'object',
      properties: {
        load_id: { type: 'integer', description: 'The load ID to assign.' },
        driver_id: { type: 'integer', description: 'The driver ID to assign.' },
      },
      required: ['load_id', 'driver_id'],
    },
  },
  {
    name: 'send_driver_load_offer_sms',
    description: 'Send an SMS to a driver with a load opportunity. Driver can reply YES or NO.',
    input_schema: {
      type: 'object',
      properties: {
        driver_id: { type: 'integer', description: 'Driver to text.' },
        load_id: { type: 'integer', description: 'Load to offer.' },
        message: { type: 'string', description: 'The SMS message to send.' },
      },
      required: ['driver_id', 'load_id', 'message'],
    },
  },
  {
    name: 'send_load_confirmation_email',
    description: 'Send a load confirmation email to the driver and/or shipper after assignment.',
    input_schema: {
      type: 'object',
      properties: {
        to_email: { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string', description: 'Email subject.' },
        body: { type: 'string', description: 'Email body text.' },
        load_id: { type: 'integer', description: 'Related load ID.' },
      },
      required: ['to_email', 'subject', 'body', 'load_id'],
    },
  },
  {
    name: 'update_load_status',
    description: 'Update the status of a load (e.g., assigned, dispatched, in_transit, delivered).',
    input_schema: {
      type: 'object',
      properties: {
        load_id: { type: 'integer', description: 'Load ID.' },
        status: { type: 'string', enum: ['posted', 'quoting', 'assigned', 'dispatched', 'in_transit', 'delivered', 'invoiced', 'paid', 'cancelled'], description: 'New status.' },
      },
      required: ['load_id', 'status'],
    },
  },
  {
    name: 'update_driver_location',
    description: 'Update a driver\'s current location.',
    input_schema: {
      type: 'object',
      properties: {
        driver_id: { type: 'integer', description: 'Driver ID.' },
        city: { type: 'string', description: 'Current city.' },
        state: { type: 'string', description: 'Current state (2-letter).' },
      },
      required: ['driver_id', 'city', 'state'],
    },
  },
  {
    name: 'request_approval',
    description: 'Create an approval request for actions that need human sign-off (low rates, rate negotiations, driver removal from load).',
    input_schema: {
      type: 'object',
      properties: {
        action_type: { type: 'string', description: 'Type: low_rate_assignment, rate_negotiation, driver_removal' },
        title: { type: 'string', description: 'Short title for the approval.' },
        summary: { type: 'string', description: '2-3 sentence summary of what needs approval and why.' },
        full_content: { type: 'string', description: 'Full details — rate breakdown, driver info, etc.' },
        priority: { type: 'string', enum: ['urgent', 'high', 'normal'], description: 'Priority level.' },
        detail_json: { type: 'object', description: 'Structured data for the callback (load_id, driver_id, rate, etc.).' },
      },
      required: ['action_type', 'title', 'summary', 'priority'],
    },
  },
  {
    name: 'get_dashboard_snapshot',
    description: 'Get a quick overview: available drivers count, unassigned loads count, loads in transit, recent assignments.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ============================================================================
// TOOL HANDLERS (executed when Claude calls a tool)
// ============================================================================

const toolHandlers = {
  async get_available_drivers({ trailer_type, state } = {}) {
    let sql = `SELECT id, first_name, last_name, phone, email, trailer_type, current_city, current_state, percentage_rate, status
               FROM drivers WHERE status = 'available'`;
    const params = [];
    if (trailer_type) { sql += ` AND trailer_type = $${params.length + 1}`; params.push(trailer_type); }
    if (state) { sql += ` AND current_state = $${params.length + 1}`; params.push(state); }
    sql += ' ORDER BY last_name';
    const rows = await getMany(sql, params);
    return { drivers: rows, count: rows.length };
  },

  async get_unassigned_loads({ equipment_type, origin_state } = {}) {
    let sql = `SELECT l.*, s.company_name as shipper_name
               FROM loads l LEFT JOIN shippers s ON l.shipper_id = s.id
               WHERE l.status IN ('posted', 'quoting') AND l.driver_id IS NULL`;
    const params = [];
    if (equipment_type) { sql += ` AND l.equipment_type = $${params.length + 1}`; params.push(equipment_type); }
    if (origin_state) { sql += ` AND l.origin_state = $${params.length + 1}`; params.push(origin_state); }
    sql += ' ORDER BY l.pickup_date ASC';
    const rows = await getMany(sql, params);
    return { loads: rows, count: rows.length };
  },

  async get_driver_detail({ driver_id }) {
    const driver = await getOne('SELECT * FROM drivers WHERE id = $1', [driver_id]);
    if (!driver) return { error: `Driver ${driver_id} not found` };

    const recentLoads = await getMany(
      `SELECT id, reference_number, origin_city, origin_state, dest_city, dest_state, rate, rate_per_mile, miles, status, pickup_date
       FROM loads WHERE driver_id = $1 ORDER BY pickup_date DESC LIMIT 10`,
      [driver_id]
    );
    const compliance = await getMany(
      `SELECT item_type, expiry_date, status FROM compliance_items WHERE driver_id = $1`,
      [driver_id]
    );

    return { driver, recent_loads: recentLoads, compliance };
  },

  async get_load_detail({ load_id }) {
    const load = await getOne(
      `SELECT l.*, s.company_name as shipper_name, s.contact_name as shipper_contact, s.phone as shipper_phone, s.email as shipper_email,
              d.first_name as driver_first, d.last_name as driver_last, d.phone as driver_phone
       FROM loads l
       LEFT JOIN shippers s ON l.shipper_id = s.id
       LEFT JOIN drivers d ON l.driver_id = d.id
       WHERE l.id = $1`, [load_id]
    );
    if (!load) return { error: `Load ${load_id} not found` };
    return { load };
  },

  async assign_load_to_driver({ load_id, driver_id }) {
    const load = await getOne('SELECT * FROM loads WHERE id = $1', [load_id]);
    if (!load) return { error: `Load ${load_id} not found` };
    if (load.driver_id) return { error: `Load ${load_id} already assigned to driver ${load.driver_id}` };

    const driver = await getOne('SELECT * FROM drivers WHERE id = $1', [driver_id]);
    if (!driver) return { error: `Driver ${driver_id} not found` };
    if (driver.status !== 'available') return { error: `Driver ${driver.first_name} ${driver.last_name} is not available (status: ${driver.status})` };

    // Check rate per mile
    if (load.rate_per_mile && load.rate_per_mile < 2.00) {
      return { error: `Rate per mile ($${load.rate_per_mile}) is below $2.00 minimum. Use request_approval tool to get human sign-off before assigning.` };
    }

    const driverPay = Math.round(load.rate * driver.percentage_rate * 100) / 100;
    const companyRevenue = Math.round((load.rate - driverPay) * 100) / 100;

    await query(
      `UPDATE loads SET driver_id = $1, driver_pay = $2, company_revenue = $3, status = 'assigned', assigned_at = NOW() WHERE id = $4`,
      [driver_id, driverPay, companyRevenue, load_id]
    );
    await query(`UPDATE drivers SET status = 'on_load' WHERE id = $1`, [driver_id]);

    return {
      success: true,
      message: `Load ${load.reference_number} assigned to ${driver.first_name} ${driver.last_name}`,
      rate: load.rate,
      driver_pay: driverPay,
      company_revenue: companyRevenue,
      driver_percentage: `${driver.percentage_rate * 100}%`,
    };
  },

  async send_driver_load_offer_sms({ driver_id, load_id, message }) {
    const driver = await getOne('SELECT phone, first_name FROM drivers WHERE id = $1', [driver_id]);
    if (!driver || !driver.phone) return { error: `Driver ${driver_id} not found or has no phone` };

    const result = await sendSMS({
      to: driver.phone,
      body: message,
      agent: 'dispatch',
      relatedType: 'load',
      relatedId: load_id,
    });

    return { success: true, driver: driver.first_name, ...result };
  },

  async send_load_confirmation_email({ to_email, subject, body, load_id }) {
    const result = await sendEmail({
      to: to_email,
      subject,
      body,
      agent: 'dispatch',
      relatedType: 'load',
      relatedId: load_id,
    });
    return { success: true, ...result };
  },

  async update_load_status({ load_id, status }) {
    const load = await getOne('SELECT reference_number, driver_id FROM loads WHERE id = $1', [load_id]);
    if (!load) return { error: `Load ${load_id} not found` };

    await query('UPDATE loads SET status = $1 WHERE id = $2', [status, load_id]);

    // If delivered, free up the driver
    if (status === 'delivered' && load.driver_id) {
      await query(`UPDATE drivers SET status = 'available' WHERE id = $1`, [load.driver_id]);
    }
    // If cancelled, free up driver
    if (status === 'cancelled' && load.driver_id) {
      await query(`UPDATE drivers SET status = 'available' WHERE id = $1`, [load.driver_id]);
      await query('UPDATE loads SET driver_id = NULL, driver_pay = NULL, company_revenue = NULL WHERE id = $1', [load_id]);
    }

    return { success: true, message: `Load ${load.reference_number} status updated to '${status}'` };
  },

  async update_driver_location({ driver_id, city, state }) {
    await query('UPDATE drivers SET current_city = $1, current_state = $2 WHERE id = $3', [city, state, driver_id]);
    return { success: true, message: `Driver ${driver_id} location updated to ${city}, ${state}` };
  },

  async request_approval({ action_type, title, summary, full_content, priority = 'normal', detail_json = {} }) {
    const approval = await createApproval({
      agent: 'dispatch',
      actionType: action_type,
      priority,
      title,
      summary,
      fullContent: full_content,
      detailJson: detail_json,
    });
    return { success: true, approval_id: approval.id, message: `Approval request created: ${title}` };
  },

  async get_dashboard_snapshot() {
    const stats = {};
    stats.available_drivers = (await getOne('SELECT COUNT(*)::int as c FROM drivers WHERE status = $1', ['available'])).c;
    stats.on_load_drivers = (await getOne('SELECT COUNT(*)::int as c FROM drivers WHERE status = $1', ['on_load'])).c;
    stats.unassigned_loads = (await getOne("SELECT COUNT(*)::int as c FROM loads WHERE status IN ('posted','quoting') AND driver_id IS NULL")).c;
    stats.assigned_loads = (await getOne("SELECT COUNT(*)::int as c FROM loads WHERE status = 'assigned'")).c;
    stats.in_transit = (await getOne("SELECT COUNT(*)::int as c FROM loads WHERE status IN ('dispatched','in_transit')")).c;
    stats.delivered_today = (await getOne("SELECT COUNT(*)::int as c FROM loads WHERE status = 'delivered' AND actual_delivery::date = CURRENT_DATE")).c;

    const recentAssignments = await getMany(
      `SELECT l.reference_number, l.origin_city, l.origin_state, l.dest_city, l.dest_state, l.rate,
              d.first_name, d.last_name, l.assigned_at
       FROM loads l JOIN drivers d ON l.driver_id = d.id
       WHERE l.assigned_at IS NOT NULL ORDER BY l.assigned_at DESC LIMIT 5`
    );
    stats.recent_assignments = recentAssignments;
    return stats;
  },
};

// ============================================================================
// AGENT RUNNER
// ============================================================================

async function runDispatchAgent({ trigger, context = {} }) {
  let userMessage;

  switch (trigger) {
    case 'new_load':
      userMessage = `A new load has been entered in the system (load_id: ${context.load_id}). Look up the load details, find the best available driver match, and either assign it or text the top driver candidates. If the rate is below $2/mile, create an approval request instead of assigning directly.`;
      break;

    case 'delegation':
      userMessage = `The Boss Agent has delegated a task to you: ${context.instructions || 'Check for unassigned loads and match them to available drivers.'}`;
      break;

    case 'driver_reply':
      userMessage = `Driver ${context.driver_name} (ID: ${context.driver_id}) replied to a load offer via SMS: "${context.reply_text}". The load in question is load_id: ${context.load_id}. Process this reply — if they said yes, assign the load. If they declined, move to the next candidate.`;
      break;

    case 'scheduled':
    case 'manual':
    default:
      userMessage = `Run your standard dispatch check: 1) Check for unassigned loads that need drivers. 2) Check for available drivers that need loads. 3) Make the best matches and take action. Report what you did.`;
      break;
  }

  return runAgent('dispatch', {
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    tools,
    toolHandlers,
    contextKey: context.load_id ? `load:${context.load_id}` : 'daily',
  });
}

module.exports = { runDispatchAgent, tools, toolHandlers };
