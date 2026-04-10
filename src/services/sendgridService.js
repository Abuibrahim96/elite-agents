const config = require('../config');
const { query } = require('../db');

let sgMail = null;

function getClient() {
  if (!sgMail && config.sendgridApiKey && !config.stubMode) {
    sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(config.sendgridApiKey);
  }
  return sgMail;
}

/**
 * Send an email via SendGrid.
 * In stub mode, logs to console + DB instead of actually sending.
 */
async function sendEmail({ to, subject, body, html = null, agent = 'system', relatedType = null, relatedId = null }) {
  const logEntry = {
    agent,
    channel: 'email',
    direction: 'outbound',
    from_addr: config.sendgridFromEmail,
    to_addr: to,
    subject,
    body,
    related_type: relatedType,
    related_id: relatedId,
    status: 'sent',
    external_id: null,
  };

  if (config.stubMode) {
    console.log(`[STUB EMAIL] To: ${to}\n  Subject: ${subject}\n  Body: ${body?.substring(0, 200)}...\n`);
    logEntry.status = 'stub';
    logEntry.external_id = `stub-${Date.now()}`;
  } else {
    const client = getClient();
    if (!client) {
      throw new Error('SendGrid not configured. Set SENDGRID_API_KEY.');
    }
    const msg = {
      to,
      from: { email: config.sendgridFromEmail, name: config.sendgridFromName },
      subject,
      text: body,
    };
    if (html) msg.html = html;

    const [response] = await client.send(msg);
    logEntry.external_id = response?.headers?.['x-message-id'] || `sg-${Date.now()}`;
    logEntry.status = 'sent';
  }

  // Log to communications table
  await query(
    `INSERT INTO communications (agent, channel, direction, from_addr, to_addr, subject, body, related_type, related_id, external_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [logEntry.agent, logEntry.channel, logEntry.direction, logEntry.from_addr, logEntry.to_addr,
     logEntry.subject, logEntry.body, logEntry.related_type, logEntry.related_id, logEntry.external_id, logEntry.status]
  );

  return { success: true, externalId: logEntry.external_id, status: logEntry.status };
}

module.exports = { sendEmail };
