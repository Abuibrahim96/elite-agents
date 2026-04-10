/**
 * telegramService.js — Telegram bot integration.
 *
 * Connects the agent system to a Telegram group chat.
 * You text instructions, the bot routes to the right agent,
 * and posts the response back to the group.
 */

const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const { runAgent } = require('../claude');
const { query, getOne, getMany } = require('../db');

// Agent runners
const { runBossAgent } = require('../agents/boss');
const { runDispatchAgent } = require('../agents/dispatch');
const { runOutreachAgent } = require('../agents/outreach');
const { runLoadUpdateAgent } = require('../agents/loadUpdate');
const { runComplianceAgent } = require('../agents/compliance');
const { runAcquisitionAgent } = require('../agents/acquisition');

let bot = null;

// ─── Smart Router System Prompt ─────────────────────────────────────────────

const ROUTER_PROMPT = `You are the message router for Elite Truck Lines LLC, a carrier and brokerage based in Portland, Oregon.

COMPANY CONTEXT:
- Company: Elite Truck Lines LLC, Portland, OR
- Commission: 10% (OO keeps 90%)
- Min rate: $3.00/mile
- Equipment: dry van, reefer, flatbed, power only
- Factoring: OTR Solutions (immediate pay after POD)
- NO alcohol or pork freight
- Always ask team for approval before assigning loads or sending emails
- Current drivers: Hassan Abdullahi, Naol Tuffa, Maslah Hussein, Olliyad Tuffa (all Portland, OR)

Your ONLY job is to read a message and decide which agent should handle it. You also extract structured data from the message.

THE 6 AGENTS:
1. "boss" — Daily briefings, operations overview, general status questions
2. "dispatch" — Anything about loads, drivers, assigning loads, driver availability, matching, finding loads
3. "outreach" — Emailing brokers/shippers, outreach, follow-ups, prospecting emails
4. "load_update" — Check-ins on active loads, ETAs, delivery status, driver location updates
5. "compliance" — Driver documents, CDL, medical cards, insurance, drug tests, expirations, DOT/MC checks
6. "acquisition" — Research new brokers/shippers, find partners, market analysis, vet brokers, check broker payment history

SPECIAL COMMANDS (not routed to an agent):
- "add_driver" — User is adding a new owner-operator
- "add_shipper" — User is adding a new shipper/broker
- "add_load" — User is adding a new load
- "data_query" — User is asking about existing data (list drivers, show loads, etc.)

IMPORTANT ROUTING RULES:
- If the message mentions checking a broker's DOT/MC, payment history, or reputation → route to "acquisition"
- If the message mentions any alcohol or pork freight → route to "dispatch" with instructions to REJECT it
- If the message mentions factoring, OTR Solutions, or payment → consider "boss" or "dispatch" depending on context
- If the message is about updating compliance dates (CDL expiry, medical card, etc.) → route to "compliance"

RESPOND WITH ONLY JSON (no markdown, no explanation):
{
  "route": "boss|dispatch|outreach|load_update|compliance|acquisition|add_driver|add_shipper|add_load|data_query",
  "trigger": "manual|scheduled",
  "instructions": "rewrite the user's message as clear instructions for the agent",
  "data": { ... any structured data extracted from the message ... }
}

EXAMPLES:
User: "Add new OO John Smith, dry van, based in Seattle WA, phone 555-0101, MC-1234567"
→ {"route":"add_driver","trigger":"manual","instructions":"","data":{"first_name":"John","last_name":"Smith","trailer_type":"dry_van","home_city":"Seattle","home_state":"WA","phone":"+15550101","mc_number":"MC-1234567"}}

User: "What loads do we have available?"
→ {"route":"dispatch","trigger":"manual","instructions":"Show all available loads and recommend matches with available drivers. Remember minimum $3/mile and always ask before assigning."}

User: "Send an email to XPO Logistics about our capacity"
→ {"route":"outreach","trigger":"manual","instructions":"Draft an outreach email to XPO Logistics highlighting our dry van and reefer capacity. Present the draft for approval before sending."}

User: "Check Hassan's compliance"
→ {"route":"compliance","trigger":"manual","instructions":"Check all compliance items for driver Hassan Abdullahi and flag anything expiring or expired."}

User: "Is this broker legit? MC-123456"
→ {"route":"acquisition","trigger":"manual","instructions":"Vet broker with MC-123456. Check their payment history, whether they work with factoring companies (especially OTR Solutions), any disputes or complaints, and their overall reputation."}

User: "Got a load of beer from Portland to LA"
→ {"route":"dispatch","trigger":"manual","instructions":"REJECT this load — it is alcohol freight. Elite Truck Lines does not haul alcohol under any circumstances."}

User: "New load Portland OR to Phoenix AZ, 40000 lbs, dry van, $4500, 1400 miles"
→ {"route":"add_load","trigger":"manual","instructions":"","data":{"origin_city":"Portland","origin_state":"OR","dest_city":"Phoenix","dest_state":"AZ","weight_lbs":40000,"equipment_type":"dry_van","rate":4500,"miles":1400}}

User: "How's the operation today?"
→ {"route":"boss","trigger":"scheduled","instructions":"Run a full operations snapshot and report status for Elite Truck Lines."}

User: "Update Hassan's CDL expiry to 2028-06-15"
→ {"route":"compliance","trigger":"manual","instructions":"Update CDL expiration date for driver Hassan Abdullahi to 2028-06-15."}`;

// ─── Initialize Bot ─────────────────────────────────────────────────────────

function initTelegram() {
  if (!config.telegramBotToken) {
    console.log('[Telegram] No bot token — Telegram disabled');
    return null;
  }

  bot = new TelegramBot(config.telegramBotToken, { polling: true });
  console.log('[Telegram] Bot started — listening for messages');

  // Handle all messages
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Ignore non-text messages
    if (!text) return;

    // Log the group ID on first message (helpful for setup)
    if (!config.telegramGroupId) {
      console.log(`[Telegram] Chat ID: ${chatId} — add TELEGRAM_GROUP_ID=${chatId} to your Railway variables`);
    }

    // Handle /start command
    if (text === '/start') {
      return bot.sendMessage(chatId,
        `🚛 *Elite Trucking AI Agents*\n\n` +
        `Just text me like a team member. I'll route your message to the right agent.\n\n` +
        `*Examples:*\n` +
        `• "What loads are available?"\n` +
        `• "Add new OO John Smith, flatbed, Chicago IL"\n` +
        `• "Check compliance for all drivers"\n` +
        `• "Email ABC Logistics about our dry van capacity"\n` +
        `• "How's the operation today?"\n` +
        `• "New load Dallas TX to Miami FL, 40k lbs, dry van, $2800, 1300 miles"\n\n` +
        `*Commands:*\n` +
        `/status — Quick operations overview\n` +
        `/drivers — List all drivers\n` +
        `/loads — List all loads\n` +
        `/compliance — Run compliance check\n` +
        `/run boss — Run any agent by name`,
        { parse_mode: 'Markdown' }
      );
    }

    // Quick commands
    if (text === '/status') {
      return handleAgentRun(chatId, 'boss', 'scheduled', 'Give me a quick operations snapshot.');
    }
    if (text === '/drivers') {
      return handleDataQuery(chatId, 'list_drivers');
    }
    if (text === '/loads') {
      return handleDataQuery(chatId, 'list_loads');
    }
    if (text === '/compliance') {
      return handleAgentRun(chatId, 'compliance', 'scheduled', null);
    }
    if (text.startsWith('/run ')) {
      const agentName = text.replace('/run ', '').trim().toLowerCase();
      return handleAgentRun(chatId, agentName, 'manual', null);
    }

    // Smart routing — use Claude to figure out what the user wants
    try {
      await bot.sendChatAction(chatId, 'typing');
      const route = await routeMessage(text);

      if (route.route === 'add_driver') {
        await handleAddDriver(chatId, route.data || {});
      } else if (route.route === 'add_shipper') {
        await handleAddShipper(chatId, route.data || {});
      } else if (route.route === 'add_load') {
        await handleAddLoad(chatId, route.data || {});
      } else if (route.route === 'data_query') {
        await handleDataQuery(chatId, route.instructions);
      } else {
        await handleAgentRun(chatId, route.route, route.trigger || 'manual', route.instructions);
      }
    } catch (err) {
      console.error('[Telegram] Error:', err.message);
      bot.sendMessage(chatId, `⚠️ Error: ${err.message}`);
    }
  });

  return bot;
}

// ─── Smart Router ───────────────────────────────────────────────────────────

async function routeMessage(text) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const response = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 500,
    system: ROUTER_PROMPT,
    messages: [{ role: 'user', content: text }],
  });

  const raw = response.content[0].text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    // If Claude didn't return clean JSON, default to boss
    return { route: 'boss', trigger: 'manual', instructions: text };
  }
}

// ─── Handlers ───────────────────────────────────────────────────────────────

async function handleAgentRun(chatId, agentName, trigger, instructions) {
  const runners = {
    boss: runBossAgent,
    dispatch: runDispatchAgent,
    outreach: runOutreachAgent,
    load_update: runLoadUpdateAgent,
    compliance: runComplianceAgent,
    acquisition: runAcquisitionAgent,
  };

  const runner = runners[agentName];
  if (!runner) {
    return bot.sendMessage(chatId, `❓ Unknown agent: ${agentName}\n\nAvailable: boss, dispatch, outreach, load_update, compliance, acquisition`);
  }

  await bot.sendChatAction(chatId, 'typing');
  const agentIcons = { boss: '👔', dispatch: '🚛', outreach: '📧', load_update: '📍', compliance: '📋', acquisition: '🔍' };
  bot.sendMessage(chatId, `${agentIcons[agentName] || '🤖'} *${agentName.charAt(0).toUpperCase() + agentName.slice(1)} Agent* is working...`, { parse_mode: 'Markdown' });

  try {
    const result = await runner({
      trigger: trigger || 'manual',
      context: { instructions: instructions || '' },
    });

    // Telegram has a 4096 char limit — truncate if needed
    let response = result.response || 'No response from agent.';
    if (response.length > 4000) {
      response = response.substring(0, 3950) + '\n\n... (truncated)';
    }

    const meta = `\n\n_${result.turns || 0} turns · ${result.tokensUsed || 0} tokens · ${((result.durationMs || 0) / 1000).toFixed(1)}s_`;
    await bot.sendMessage(chatId, response + meta, { parse_mode: 'Markdown' }).catch(() => {
      // If Markdown fails, send as plain text
      bot.sendMessage(chatId, response + meta);
    });
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Agent error: ${err.message}`);
  }
}

async function handleAddDriver(chatId, data) {
  const required = ['first_name', 'last_name'];
  for (const field of required) {
    if (!data[field]) {
      return bot.sendMessage(chatId, `⚠️ Missing required field: ${field}\n\nExample: "Add new OO John Smith, dry van, Atlanta GA, 555-0101, MC-1234567"`);
    }
  }

  try {
    const result = await query(
      `INSERT INTO drivers (first_name, last_name, phone, email, mc_number, dot_number, trailer_type, home_city, home_state, current_city, current_state, status, percentage_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', 0.85)`,
      [data.first_name, data.last_name, data.phone || null, data.email || null,
       data.mc_number || null, data.dot_number || null, data.trailer_type || 'dry_van',
       data.home_city || null, data.home_state || null,
       data.home_city || null, data.home_state || null]
    );

    bot.sendMessage(chatId,
      `✅ *New Driver Added*\n\n` +
      `Name: ${data.first_name} ${data.last_name}\n` +
      `Equipment: ${data.trailer_type || 'dry_van'}\n` +
      `Base: ${data.home_city || '?'}, ${data.home_state || '?'}\n` +
      `Phone: ${data.phone || 'Not set'}\n` +
      `MC#: ${data.mc_number || 'Not set'}\n` +
      `Rate: 85% (default)`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Failed to add driver: ${err.message}`);
  }
}

async function handleAddShipper(chatId, data) {
  if (!data.company_name) {
    return bot.sendMessage(chatId, `⚠️ Need at least a company name.\n\nExample: "Add shipper Walmart Distribution, contact Tom Baker, tom@walmart.com"`);
  }

  try {
    await query(
      `INSERT INTO shippers (company_name, contact_name, phone, email, type, credit_rating, avg_days_to_pay, payment_terms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.company_name, data.contact_name || null, data.phone || null, data.email || null,
       data.type || 'shipper', data.credit_rating || 'unknown', data.avg_days_to_pay || 30, 'Net 30']
    );

    bot.sendMessage(chatId,
      `✅ *New Shipper Added*\n\n` +
      `Company: ${data.company_name}\n` +
      `Contact: ${data.contact_name || 'Not set'}\n` +
      `Email: ${data.email || 'Not set'}\n` +
      `Credit: ${data.credit_rating || 'unknown'}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Failed to add shipper: ${err.message}`);
  }
}

async function handleAddLoad(chatId, data) {
  if (!data.origin_city || !data.dest_city || !data.rate) {
    return bot.sendMessage(chatId, `⚠️ Need at least: origin city/state, destination city/state, and rate.\n\nExample: "New load Dallas TX to Chicago IL, 42000 lbs, dry van, $3200, 920 miles"`);
  }

  try {
    // Generate reference number
    const last = await getOne("SELECT reference_number FROM loads ORDER BY id DESC LIMIT 1");
    let num = 2001;
    if (last?.reference_number?.startsWith('ELT-')) {
      num = parseInt(last.reference_number.split('-')[1]) + 1;
    }
    const ref = `ELT-${num}`;
    const rpm = data.miles > 0 ? Math.round((data.rate / data.miles) * 100) / 100 : 0;

    await query(
      `INSERT INTO loads (reference_number, status, origin_city, origin_state, dest_city, dest_state, weight_lbs, equipment_type, rate, miles, rate_per_mile, commodity)
       VALUES (?, 'posted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ref, data.origin_city, data.origin_state || '', data.dest_city, data.dest_state || '',
       data.weight_lbs || null, data.equipment_type || 'dry_van', data.rate, data.miles || 0, rpm,
       data.commodity || null]
    );

    bot.sendMessage(chatId,
      `✅ *New Load Posted — ${ref}*\n\n` +
      `Route: ${data.origin_city}, ${data.origin_state || '?'} → ${data.dest_city}, ${data.dest_state || '?'}\n` +
      `Rate: $${data.rate.toLocaleString()} ($${rpm}/mi)\n` +
      `Miles: ${data.miles || '?'}\n` +
      `Equipment: ${data.equipment_type || 'dry_van'}\n` +
      `Weight: ${data.weight_lbs ? data.weight_lbs.toLocaleString() + ' lbs' : 'Not set'}\n\n` +
      `_Want me to find a driver? Just say "assign load ${ref}"_`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Failed to add load: ${err.message}`);
  }
}

async function handleDataQuery(chatId, queryType) {
  try {
    if (queryType === 'list_drivers') {
      const drivers = await getMany('SELECT id, first_name, last_name, trailer_type, current_city, current_state, status FROM drivers ORDER BY status, last_name');
      if (!drivers.length) return bot.sendMessage(chatId, '📋 No drivers in the system yet.');

      const statusIcons = { available: '🟢', on_load: '🔵', off_duty: '⚪', suspended: '🔴', maintenance: '🟡' };
      let msg = '🚛 *Drivers*\n\n';
      drivers.forEach(d => {
        msg += `${statusIcons[d.status] || '⚪'} *${d.first_name} ${d.last_name}* — ${d.trailer_type || '?'}\n`;
        msg += `   ${d.current_city || '?'}, ${d.current_state || '?'} · ${d.status}\n\n`;
      });
      return bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    }

    if (queryType === 'list_loads') {
      const loads = await getMany('SELECT reference_number, origin_city, origin_state, dest_city, dest_state, rate, rate_per_mile, status, equipment_type FROM loads ORDER BY status, id DESC LIMIT 15');
      if (!loads.length) return bot.sendMessage(chatId, '📋 No loads in the system yet.');

      const statusIcons = { posted: '📦', assigned: '🟡', dispatched: '🔵', in_transit: '🚚', delivered: '✅', invoiced: '💰', paid: '💵', cancelled: '❌' };
      let msg = '📦 *Loads*\n\n';
      loads.forEach(l => {
        msg += `${statusIcons[l.status] || '📋'} *${l.reference_number}* — ${l.status}\n`;
        msg += `   ${l.origin_city},${l.origin_state} → ${l.dest_city},${l.dest_state}\n`;
        msg += `   $${l.rate?.toLocaleString() || '?'} · $${l.rate_per_mile || '?'}/mi · ${l.equipment_type || '?'}\n\n`;
      });
      return bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    }

    // Generic — route to boss agent for general questions
    return handleAgentRun(chatId, 'boss', 'manual', queryType);
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Query error: ${err.message}`);
  }
}

// ─── Send message to group (agents can call this) ───────────────────────────

async function sendToGroup(text) {
  if (!bot || !config.telegramGroupId) return;
  try {
    await bot.sendMessage(config.telegramGroupId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[Telegram] Failed to send to group:', err.message);
  }
}

module.exports = { initTelegram, sendToGroup };
