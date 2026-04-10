const { runAgent } = require('../claude');
const { getOne, getMany, query } = require('../db');
const { createApproval } = require('../services/approvalService');
const SYSTEM_PROMPT = require('../prompts/acquisition');

const tools = [
  {
    name: 'get_lane_gaps',
    description: 'Analyze which lanes have drivers but not enough loads, or loads but not enough drivers.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_current_prospects',
    description: 'Get all prospects in the pipeline, optionally filtered by type or stage.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'broker, shipper, or carrier' },
        stage: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'create_prospect',
    description: 'Add a new prospect to the acquisition pipeline.',
    input_schema: {
      type: 'object',
      properties: {
        company_name: { type: 'string' },
        contact_name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        type: { type: 'string', enum: ['shipper', 'broker', 'carrier'] },
        source: { type: 'string' },
        lanes: { type: 'string', description: 'Target lanes as text description' },
        estimated_volume: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['company_name', 'type'],
    },
  },
  {
    name: 'draft_outreach_email',
    description: 'Draft a partnership outreach email for a prospect. Always requires approval before sending.',
    input_schema: {
      type: 'object',
      properties: {
        prospect_id: { type: 'integer' },
        to_email: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['prospect_id', 'to_email', 'subject', 'body'],
    },
  },
  {
    name: 'get_fleet_summary',
    description: 'Get a summary of current fleet: driver count by equipment type, home bases, and availability.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'request_blacklist',
    description: 'Request to blacklist a problematic broker (requires approval).',
    input_schema: {
      type: 'object',
      properties: {
        prospect_id: { type: 'integer' },
        reason: { type: 'string' },
      },
      required: ['prospect_id', 'reason'],
    },
  },
  {
    name: 'generate_weekly_report',
    description: 'Generate a weekly acquisition report showing new prospects, outreach activity, and pipeline changes.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

const toolHandlers = {
  async get_lane_gaps() {
    // Analyze where drivers are vs where loads are going
    const driverLocations = await getMany(`
      SELECT current_state, trailer_type, COUNT(*)::int as driver_count
      FROM drivers WHERE status IN ('available', 'on_load')
      GROUP BY current_state, trailer_type ORDER BY driver_count DESC
    `);
    const loadOrigins = await getMany(`
      SELECT origin_state, equipment_type, COUNT(*)::int as load_count
      FROM loads WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY origin_state, equipment_type ORDER BY load_count DESC
    `);
    const loadDestinations = await getMany(`
      SELECT dest_state, COUNT(*)::int as delivery_count
      FROM loads WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY dest_state ORDER BY delivery_count DESC
    `);

    return { driver_locations: driverLocations, load_origins: loadOrigins, load_destinations: loadDestinations };
  },

  async get_current_prospects({ type, stage } = {}) {
    let sql = 'SELECT * FROM prospects WHERE 1=1';
    const params = [];
    if (type) { sql += ` AND type = $${params.length + 1}`; params.push(type); }
    if (stage) { sql += ` AND stage = $${params.length + 1}`; params.push(stage); }
    sql += ' ORDER BY created_at DESC';
    const rows = await getMany(sql, params);
    return { prospects: rows, count: rows.length };
  },

  async create_prospect({ company_name, contact_name, email, phone, type, source, lanes, estimated_volume, notes }) {
    // Check for duplicates
    const existing = await getOne('SELECT id FROM prospects WHERE company_name ILIKE $1', [company_name]);
    if (existing) return { error: `Prospect '${company_name}' already exists (ID: ${existing.id})` };

    const result = await query(
      `INSERT INTO prospects (company_name, contact_name, email, phone, type, source, lanes, estimated_volume, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [company_name, contact_name, email, phone, type, source || 'acquisition_agent', lanes, estimated_volume, notes]
    );
    return { success: true, prospect: result.rows[0] };
  },

  async draft_outreach_email({ prospect_id, to_email, subject, body }) {
    const approval = await createApproval({
      agent: 'acquisition',
      actionType: 'partnership_outreach',
      priority: 'normal',
      title: `Outreach to prospect #${prospect_id}`,
      summary: `Partnership outreach email drafted for ${to_email}. Subject: "${subject}"`,
      fullContent: `TO: ${to_email}\nSUBJECT: ${subject}\n\n${body}`,
      detailJson: { prospect_id, to_email, subject, body, handoff_to: 'outreach' },
    });

    // Log the draft
    await query(
      `INSERT INTO outreach_log (prospect_id, agent, channel, direction, subject, body, status)
       VALUES ($1, 'acquisition', 'email', 'outbound', $2, $3, 'pending_approval')`,
      [prospect_id, subject, body]
    );

    return { success: true, approval_id: approval.id, message: 'Outreach email drafted and sent for approval.' };
  },

  async get_fleet_summary() {
    const byEquipment = await getMany(`
      SELECT trailer_type, COUNT(*)::int as count,
             COUNT(*) FILTER (WHERE status = 'available')::int as available
      FROM drivers GROUP BY trailer_type
    `);
    const byHomeState = await getMany(`
      SELECT home_state, COUNT(*)::int as count
      FROM drivers WHERE home_state IS NOT NULL
      GROUP BY home_state ORDER BY count DESC LIMIT 10
    `);
    const total = (await getOne('SELECT COUNT(*)::int as c FROM drivers')).c;
    return { total_drivers: total, by_equipment: byEquipment, by_home_state: byHomeState };
  },

  async request_blacklist({ prospect_id, reason }) {
    const prospect = await getOne('SELECT company_name FROM prospects WHERE id = $1', [prospect_id]);
    const approval = await createApproval({
      agent: 'acquisition',
      actionType: 'blacklist_broker',
      priority: 'high',
      title: `Blacklist: ${prospect?.company_name || prospect_id}`,
      summary: `Requesting to blacklist ${prospect?.company_name}. Reason: ${reason}`,
      detailJson: { prospect_id, reason },
    });
    return { success: true, approval_id: approval.id };
  },

  async generate_weekly_report() {
    const newProspects = (await getOne("SELECT COUNT(*)::int as c FROM prospects WHERE created_at > NOW() - INTERVAL '7 days'")).c;
    const emailsSent = (await getOne("SELECT COUNT(*)::int as c FROM outreach_log WHERE agent = 'acquisition' AND created_at > NOW() - INTERVAL '7 days'")).c;
    const pipeline = await getMany(`
      SELECT stage, COUNT(*)::int as count FROM prospects GROUP BY stage
      ORDER BY CASE stage WHEN 'identified' THEN 1 WHEN 'contacted' THEN 2
        WHEN 'responded' THEN 3 WHEN 'negotiating' THEN 4
        WHEN 'onboarded' THEN 5 WHEN 'lost' THEN 6 END
    `);

    return { new_prospects_this_week: newProspects, emails_drafted: emailsSent, pipeline };
  },
};

async function runAcquisitionAgent({ trigger, context = {} }) {
  let userMessage;
  switch (trigger) {
    case 'scheduled':
      userMessage = `It's Monday — time for your weekly acquisition run. 1) Analyze lane gaps — where do we have drivers but not enough freight? 2) Review the current prospect pipeline. 3) Get fleet summary for outreach talking points. 4) Based on lane gaps, identify what type of prospects we need (which lanes, what freight type). 5) Draft outreach emails for any new prospects that match our needs. 6) Generate the weekly acquisition report.`;
      break;
    case 'delegation':
      userMessage = context.instructions || 'Analyze our lane gaps and suggest prospect targets.';
      break;
    default:
      userMessage = 'Run acquisition analysis and report.';
  }

  return runAgent('acquisition', {
    systemPrompt: SYSTEM_PROMPT, userMessage, tools, toolHandlers,
    contextKey: 'weekly',
  });
}

module.exports = { runAcquisitionAgent, tools, toolHandlers };
