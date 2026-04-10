const { runAgent } = require('../claude');
const { getOne, getMany, query } = require('../db');
const { sendEmail } = require('../services/sendgridService');
const { createApproval } = require('../services/approvalService');
const SYSTEM_PROMPT = require('../prompts/outreach');

const tools = [
  {
    name: 'get_prospects_needing_followup',
    description: 'Get all prospects where next_followup date is today or earlier.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_prospect_history',
    description: 'Get all outreach history for a specific prospect.',
    input_schema: {
      type: 'object',
      properties: { prospect_id: { type: 'integer' } },
      required: ['prospect_id'],
    },
  },
  {
    name: 'search_prospects',
    description: 'Search prospects by type, stage, or company name.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'shipper, broker, or carrier' },
        stage: { type: 'string', description: 'identified, contacted, responded, negotiating, onboarded, lost' },
        company_name: { type: 'string', description: 'Partial company name search' },
      },
      required: [],
    },
  },
  {
    name: 'create_prospect',
    description: 'Add a new prospect to the database.',
    input_schema: {
      type: 'object',
      properties: {
        company_name: { type: 'string' },
        contact_name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        type: { type: 'string', enum: ['shipper', 'broker', 'carrier'] },
        source: { type: 'string' },
        lanes: { type: 'string', description: 'JSON string of lane info' },
        estimated_volume: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['company_name', 'type'],
    },
  },
  {
    name: 'draft_and_queue_email',
    description: 'Draft an outreach email. For first-contact emails, this creates an approval. For follow-ups, it sends directly.',
    input_schema: {
      type: 'object',
      properties: {
        prospect_id: { type: 'integer' },
        to_email: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        is_first_contact: { type: 'boolean', description: 'True if this is the first email to this prospect.' },
      },
      required: ['prospect_id', 'to_email', 'subject', 'body', 'is_first_contact'],
    },
  },
  {
    name: 'update_prospect_stage',
    description: 'Move a prospect to a new pipeline stage.',
    input_schema: {
      type: 'object',
      properties: {
        prospect_id: { type: 'integer' },
        stage: { type: 'string', enum: ['identified', 'contacted', 'responded', 'negotiating', 'onboarded', 'lost'] },
        notes: { type: 'string' },
      },
      required: ['prospect_id', 'stage'],
    },
  },
  {
    name: 'get_pipeline_summary',
    description: 'Get the full outreach pipeline summary with counts by stage.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

const toolHandlers = {
  async get_prospects_needing_followup() {
    const prospects = await getMany(`
      SELECT p.*, (SELECT COUNT(*) FROM outreach_log WHERE prospect_id = p.id) as email_count
      FROM prospects p
      WHERE p.next_followup <= NOW() AND p.stage NOT IN ('onboarded', 'lost')
      ORDER BY p.next_followup ASC
    `);
    return { prospects, count: prospects.length };
  },

  async get_prospect_history({ prospect_id }) {
    const prospect = await getOne('SELECT * FROM prospects WHERE id = $1', [prospect_id]);
    if (!prospect) return { error: `Prospect ${prospect_id} not found` };
    const history = await getMany(
      'SELECT * FROM outreach_log WHERE prospect_id = $1 ORDER BY created_at DESC',
      [prospect_id]
    );
    return { prospect, history, email_count: history.length };
  },

  async search_prospects({ type, stage, company_name } = {}) {
    let sql = 'SELECT * FROM prospects WHERE 1=1';
    const params = [];
    if (type) { sql += ` AND type = $${params.length + 1}`; params.push(type); }
    if (stage) { sql += ` AND stage = $${params.length + 1}`; params.push(stage); }
    if (company_name) { sql += ` AND company_name ILIKE $${params.length + 1}`; params.push(`%${company_name}%`); }
    sql += ' ORDER BY updated_at DESC LIMIT 50';
    const rows = await getMany(sql, params);
    return { prospects: rows, count: rows.length };
  },

  async create_prospect({ company_name, contact_name, email, phone, type, source, lanes, estimated_volume, notes }) {
    const result = await query(
      `INSERT INTO prospects (company_name, contact_name, email, phone, type, source, lanes, estimated_volume, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [company_name, contact_name, email, phone, type, source, lanes, estimated_volume, notes]
    );
    return { success: true, prospect: result.rows[0] };
  },

  async draft_and_queue_email({ prospect_id, to_email, subject, body, is_first_contact }) {
    if (is_first_contact) {
      // Requires approval
      const approval = await createApproval({
        agent: 'outreach',
        actionType: 'first_contact_email',
        priority: 'normal',
        title: `First outreach to prospect #${prospect_id}`,
        summary: `Draft email ready to send to ${to_email}. Subject: "${subject}"`,
        fullContent: `TO: ${to_email}\nSUBJECT: ${subject}\n\n${body}`,
        detailJson: { prospect_id, to_email, subject, body },
      });

      // Log the draft
      await query(
        `INSERT INTO outreach_log (prospect_id, agent, channel, direction, subject, body, status)
         VALUES ($1, 'outreach', 'email', 'outbound', $2, $3, 'pending_approval')`,
        [prospect_id, subject, body]
      );

      return { success: true, needs_approval: true, approval_id: approval.id, message: 'Email drafted and sent for approval.' };
    }

    // Follow-up — send directly
    await sendEmail({
      to: to_email, subject, body,
      agent: 'outreach', relatedType: 'prospect', relatedId: prospect_id,
    });

    await query(
      `INSERT INTO outreach_log (prospect_id, agent, channel, direction, subject, body, status, sent_at)
       VALUES ($1, 'outreach', 'email', 'outbound', $2, $3, 'sent', NOW())`,
      [prospect_id, subject, body]
    );

    // Update prospect follow-up tracking
    await query(
      `UPDATE prospects SET last_contacted = NOW(), followup_count = followup_count + 1,
       next_followup = CASE
         WHEN followup_count < 1 THEN NOW() + INTERVAL '3 days'
         WHEN followup_count < 2 THEN NOW() + INTERVAL '7 days'
         WHEN followup_count < 3 THEN NOW() + INTERVAL '14 days'
         ELSE NULL
       END
       WHERE id = $1`,
      [prospect_id]
    );

    return { success: true, needs_approval: false, message: 'Follow-up email sent.' };
  },

  async update_prospect_stage({ prospect_id, stage, notes }) {
    await query(
      'UPDATE prospects SET stage = $1, notes = COALESCE($2, notes) WHERE id = $3',
      [stage, notes, prospect_id]
    );
    return { success: true, message: `Prospect ${prospect_id} moved to '${stage}'` };
  },

  async get_pipeline_summary() {
    const pipeline = await getMany(`
      SELECT stage, COUNT(*)::int as count
      FROM prospects GROUP BY stage
      ORDER BY CASE stage WHEN 'identified' THEN 1 WHEN 'contacted' THEN 2
        WHEN 'responded' THEN 3 WHEN 'negotiating' THEN 4
        WHEN 'onboarded' THEN 5 WHEN 'lost' THEN 6 END
    `);
    return { pipeline };
  },
};

async function runOutreachAgent({ trigger, context = {} }) {
  let userMessage;
  switch (trigger) {
    case 'scheduled':
      userMessage = 'Run your daily outreach check: 1) Find all prospects needing follow-up today. 2) Draft and send follow-up emails. 3) For any new first-contact drafts, queue them for approval. 4) Report pipeline summary.';
      break;
    case 'delegation':
      userMessage = context.instructions || 'Check the outreach pipeline and handle any pending follow-ups.';
      break;
    case 'approval_callback':
      userMessage = `An outreach email was just approved (approval_id: ${context.approval_id}). Send the email now. Details: ${JSON.stringify(context.detail_json)}`;
      break;
    default:
      userMessage = context.instructions || 'Check for prospects needing follow-up and take action.';
  }

  return runAgent('outreach', {
    systemPrompt: SYSTEM_PROMPT, userMessage, tools, toolHandlers,
    contextKey: 'daily',
  });
}

module.exports = { runOutreachAgent, tools, toolHandlers };
