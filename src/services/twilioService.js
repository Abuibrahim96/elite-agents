const config = require('../config');
const { query } = require('../db');

let twilioClient = null;

function getClient() {
  if (!twilioClient && config.twilioAccountSid && config.twilioAuthToken && !config.stubMode) {
    const twilio = require('twilio');
    twilioClient = twilio(config.twilioAccountSid, config.twilioAuthToken);
  }
  return twilioClient;
}

/**
 * Send an SMS to a phone number.
 * In stub mode, logs to console + DB instead of actually sending.
 */
async function sendSMS({ to, body, agent = 'system', relatedType = null, relatedId = null }) {
  const logEntry = {
    agent,
    channel: 'sms',
    direction: 'outbound',
    from_addr: config.twilioPhoneNumber,
    to_addr: to,
    subject: null,
    body,
    related_type: relatedType,
    related_id: relatedId,
    status: 'sent',
    external_id: null,
  };

  if (config.stubMode) {
    console.log(`[STUB SMS] To: ${to}\n  Body: ${body}\n`);
    logEntry.status = 'stub';
    logEntry.external_id = `stub-${Date.now()}`;
  } else {
    const client = getClient();
    if (!client) {
      throw new Error('Twilio not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.');
    }
    const message = await client.messages.create({
      body,
      from: config.twilioPhoneNumber,
      to,
    });
    logEntry.external_id = message.sid;
    logEntry.status = message.status;
  }

  // Log to communications table
  await query(
    `INSERT INTO communications (agent, channel, direction, from_addr, to_addr, body, related_type, related_id, external_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [logEntry.agent, logEntry.channel, logEntry.direction, logEntry.from_addr, logEntry.to_addr,
     logEntry.body, logEntry.related_type, logEntry.related_id, logEntry.external_id, logEntry.status]
  );

  return { success: true, externalId: logEntry.external_id, status: logEntry.status };
}

/**
 * Parse an inbound SMS from Twilio webhook.
 */
function parseInboundSMS(body) {
  return {
    from: body.From,
    to: body.To,
    body: body.Body,
    messageSid: body.MessageSid,
    numMedia: parseInt(body.NumMedia || '0', 10),
  };
}

module.exports = { sendSMS, parseInboundSMS };
