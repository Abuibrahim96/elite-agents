const express = require('express');
const router = express.Router();
const { parseInboundSMS } = require('../services/twilioService');
const { resolveApproval } = require('../services/approvalService');
const { query, getOne, getMany } = require('../db');

// Agent runners for delegation/callbacks
const { runDispatchAgent } = require('../agents/dispatch');
const { runLoadUpdateAgent } = require('../agents/loadUpdate');
const { runOutreachAgent } = require('../agents/outreach');
const { runComplianceAgent } = require('../agents/compliance');

/**
 * POST /api/webhooks/twilio/sms
 * Inbound SMS from drivers. Twilio sends a POST with From, Body, etc.
 */
router.post('/twilio/sms', async (req, res) => {
  try {
    const sms = parseInboundSMS(req.body);
    console.log(`[INBOUND SMS] From: ${sms.from} Body: ${sms.body}`);

    // Log the inbound message
    await query(
      `INSERT INTO communications (agent, channel, direction, from_addr, to_addr, body, external_id, status)
       VALUES ('system', 'sms', 'inbound', $1, $2, $3, $4, 'received')`,
      [sms.from, sms.to, sms.body, sms.messageSid]
    );

    // Find the driver by phone number
    const driver = await getOne('SELECT id, first_name, last_name FROM drivers WHERE phone = $1', [sms.from]);
    if (!driver) {
      console.log(`[INBOUND SMS] Unknown phone number: ${sms.from}`);
      res.type('text/xml').send('<Response></Response>');
      return;
    }

    // Check if driver has an active load (for load update agent)
    const activeLoad = await getOne(
      "SELECT id, reference_number FROM loads WHERE driver_id = $1 AND status IN ('assigned','dispatched','in_transit') ORDER BY assigned_at DESC LIMIT 1",
      [driver.id]
    );

    const replyText = sms.body.trim().toUpperCase();

    // If reply is YES/NO — this is likely a load offer response → Dispatch Agent
    if (replyText === 'YES' || replyText === 'NO') {
      // Find the most recent load offer SMS to this driver
      const recentOffer = await getOne(
        `SELECT related_id as load_id FROM communications
         WHERE agent = 'dispatch' AND related_type = 'load' AND to_addr = $1 AND direction = 'outbound'
         ORDER BY created_at DESC LIMIT 1`,
        [sms.from]
      );

      if (recentOffer) {
        // Async — don't block the Twilio response
        runDispatchAgent({
          trigger: 'driver_reply',
          context: {
            driver_id: driver.id,
            driver_name: `${driver.first_name} ${driver.last_name}`,
            load_id: recentOffer.load_id,
            reply_text: sms.body,
          },
        }).catch(err => console.error('[SMS→Dispatch] Error:', err.message));
      }
    }
    // Otherwise it's a status update → Load Update Agent
    else if (activeLoad) {
      runLoadUpdateAgent({
        trigger: 'driver_reply',
        context: {
          driver_id: driver.id,
          driver_name: `${driver.first_name} ${driver.last_name}`,
          load_id: activeLoad.id,
          reply_text: sms.body,
        },
      }).catch(err => console.error('[SMS→LoadUpdate] Error:', err.message));
    }

    // Twilio expects TwiML response
    res.type('text/xml').send('<Response></Response>');
  } catch (err) {
    console.error('[Twilio SMS Webhook Error]:', err.message);
    res.type('text/xml').send('<Response></Response>');
  }
});

/**
 * POST /api/webhooks/twilio/voice
 * Inbound voice call handler (basic — just logs and returns TwiML)
 */
router.post('/twilio/voice', (req, res) => {
  console.log(`[INBOUND CALL] From: ${req.body.From}`);
  res.type('text/xml').send(`
    <Response>
      <Say>Thank you for calling Elite Trucking. Please leave a message or text us for faster service.</Say>
      <Record maxLength="120" />
    </Response>
  `);
});

/**
 * POST /api/webhooks/slack/interactive
 * Slack interactive button callbacks (approval approve/reject)
 */
router.post('/slack/interactive', async (req, res) => {
  try {
    // Slack sends the payload as a URL-encoded "payload" field
    const payload = JSON.parse(req.body.payload || '{}');
    const action = payload.actions?.[0];

    if (!action) {
      return res.status(400).json({ error: 'No action found' });
    }

    const approvalId = parseInt(action.value, 10);
    const user = payload.user?.name || payload.user?.username || 'slack_user';

    let status;
    if (action.action_id === 'approval_approve') {
      status = 'approved';
    } else if (action.action_id === 'approval_reject') {
      status = 'rejected';
    } else {
      return res.json({ text: 'Unknown action' });
    }

    await resolveApproval(approvalId, { status, resolvedBy: user });

    // Respond to Slack immediately
    res.json({ text: `${status === 'approved' ? '✅' : '❌'} ${status.toUpperCase()} by ${user}` });
  } catch (err) {
    console.error('[Slack Interactive Error]:', err.message);
    res.json({ text: `Error: ${err.message}` });
  }
});

/**
 * POST /api/webhooks/sendgrid/events
 * SendGrid event webhooks (open, click, bounce, etc.)
 */
router.post('/sendgrid/events', async (req, res) => {
  try {
    const events = req.body || [];
    for (const event of events) {
      if (event.sg_message_id) {
        await query(
          "UPDATE communications SET status = $1 WHERE external_id LIKE $2",
          [event.event, `${event.sg_message_id.split('.')[0]}%`]
        );
      }
    }
    res.status(200).send('ok');
  } catch (err) {
    console.error('[SendGrid Event Error]:', err.message);
    res.status(200).send('ok');
  }
});

/**
 * POST /api/webhooks/trigger/:agentName
 * Manual trigger from dashboard or n8n delegation
 */
router.post('/trigger/:agentName', async (req, res) => {
  const { agentName } = req.params;
  const { trigger = 'manual', context = {} } = req.body;

  const runners = {
    boss: require('../agents/boss').runBossAgent,
    dispatch: runDispatchAgent,
    outreach: runOutreachAgent,
    load_update: runLoadUpdateAgent,
    compliance: runComplianceAgent,
    acquisition: require('../agents/acquisition').runAcquisitionAgent,
  };

  const runner = runners[agentName];
  if (!runner) {
    return res.status(404).json({ error: `Unknown agent: ${agentName}` });
  }

  try {
    const result = await runner({ trigger, context });
    res.json({ agent: agentName, response: result.response, actions: result.actions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/webhooks/telegram
 * Telegram webhook — receives messages instantly, no polling
 */
router.post('/telegram', (req, res) => {
  try {
    const TelegramBot = require('node-telegram-bot-api');
    const config = require('../config');
    // Get the bot instance from telegramService
    const { getBotInstance } = require('../services/telegramService');
    const bot = getBotInstance();
    if (bot) {
      bot.processUpdate(req.body);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('[Telegram Webhook] Error:', err.message);
    res.sendStatus(200);
  }
});

module.exports = router;
