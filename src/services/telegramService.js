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
const supa = require('./supabaseService');

// Agent runners
const { runBossAgent } = require('../agents/boss');
const { runDispatchAgent } = require('../agents/dispatch');
const { runOutreachAgent } = require('../agents/outreach');
const { runLoadUpdateAgent } = require('../agents/loadUpdate');
const { runComplianceAgent } = require('../agents/compliance');
const { runAcquisitionAgent } = require('../agents/acquisition');

let bot = null;

// ─── Smart Router System Prompt ─────────────────────────────────────────────

const ROUTER_PROMPT = `You are the message router for Elite Truck Lines LLC. Your ONLY job is routing — respond with JSON only, never explanations.

CRITICAL: Simple commands (add driver, remove driver, add load, add task) are handled by pattern matching BEFORE you. You only see complex messages. Route them to the right agent and keep it short.

COMPANY CONTEXT:
- Company: Elite Truck Lines LLC, Portland, OR
- Commission: 10% (OO keeps 90%)
- Min rate: $3.00/mile dry van & flatbed, $5.00/mile reefer
- Equipment: dry van, reefer, flatbed, power only
- Factoring: OTR Solutions (immediate pay after POD)
- NO alcohol or pork freight
- Always ask team for approval before assigning loads or sending emails
- Current drivers: Hassan Abdullahi, Naol Tuffa, Maslah Hussein, Olliyad Tuffa (all Portland, OR)
- Current 4 drivers are REGIONAL ONLY: OR, WA, ID, UT, CO, NM, NV — NO CALIFORNIA. Future OOs may run nationwide.

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
- "add_shipper" — User is adding a new shipper/broker/contact
- "add_load" — User is adding a new load
- "add_task" — User is adding a task or to-do item
- "complete_task" — User wants to mark a task as done/completed/finished
- "remove_task" — User wants to delete, remove, cancel, or get rid of a task
- "remove_driver" — User wants to remove, delete, terminate, fire, drop, or get rid of a driver from the system. ANY word meaning "get this person out" should route here.
- "data_query" — User is asking about existing data (list drivers, show loads, etc.)

IMPORTANT ROUTING RULES:
- If the message says "fire", "remove", "delete", "terminate", "drop", "get rid of" followed by a person's name → ALWAYS route to "remove_driver". Do NOT route to boss or any agent. Example: "fire maslah" → remove_driver with data.name = "maslah"
- If the message says "done", "complete", "finished", "mark done" about a task → ALWAYS route to "complete_task"
- If the message says "delete task", "remove task", "cancel task" → ALWAYS route to "remove_task"
- If the message mentions checking a broker's DOT/MC, payment history, or reputation → route to "acquisition"
- If the message mentions any alcohol or pork freight → route to "dispatch" with instructions to REJECT it
- If the message mentions factoring, OTR Solutions, or payment → consider "boss" or "dispatch" depending on context
- If the message is about updating compliance dates (CDL expiry, medical card, etc.) → route to "compliance"

RESPOND WITH ONLY JSON (no markdown, no explanation):
{
  "route": "boss|dispatch|outreach|load_update|compliance|acquisition|add_driver|add_shipper|add_load|add_task|complete_task|remove_task|remove_driver|data_query",
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

  bot = new TelegramBot(config.telegramBotToken, { polling: false });

  // Use webhook mode — no polling conflicts, instant message delivery
  const webhookUrl = `https://web-production-9146c.up.railway.app/api/webhooks/telegram`;
  bot.setWebHook(webhookUrl).then(() => {
    console.log('[Telegram] Webhook set →', webhookUrl);
  }).catch(err => {
    console.error('[Telegram] Webhook setup failed:', err.message);
  });

  // Track active agent per chat — stays active until another agent is called
  const activeAgent = {};

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

    const lower = text.toLowerCase().trim();

    // ── CALLSIGN ROUTING — direct agent addressing ──
    const callsignMap = {
      'hq': 'boss', 'boss': 'boss', 'command': 'boss',
      'dispatch': 'dispatch', 'dis': 'dispatch',
      'sales': 'outreach', 'outreach': 'outreach',
      'loads': 'load_update', 'load': 'load_update',
      'comply': 'compliance', 'compliance': 'compliance',
      'acquire': 'acquisition', 'acq': 'acquisition',
    };

    // Check if message starts with a callsign
    let command = lower;
    let calledAgent = null;
    const firstWord = lower.split(/\s+/)[0];

    if (callsignMap[firstWord]) {
      calledAgent = callsignMap[firstWord];
      command = text.substring(firstWord.length).trim();
      activeAgent[chatId] = calledAgent; // Remember this agent for follow-ups

      // Just the callsign with no task — respond "Ready."
      if (!command) {
        return bot.sendMessage(chatId, 'Ready.');
      }
    }
    // No callsign — use the last active agent for this chat (context memory)
    else if (activeAgent[chatId]) {
      calledAgent = activeAgent[chatId];
      command = text.trim();
    }

    // ── If we have a command (either from callsign or context), handle it directly ──
    if (command && (calledAgent || true)) {
      const cmdLower = command.toLowerCase();

      // ADD DRIVER
      const addDriverCmd = command.match(/(?:add|new|hire|onboard|bring on)\s+(?:driver\s+|oo\s+)?(.+)/i);
      if (addDriverCmd) {
        const detail = addDriverCmd[1].trim();
        const parts = detail.split(',').map(s => s.trim());
        const nameParts = parts[0].split(/\s+/);
        const data = {
          first_name: nameParts[0] ? nameParts[0].charAt(0).toUpperCase() + nameParts[0].slice(1).toLowerCase() : '',
          last_name: nameParts.slice(1).map(n => n.charAt(0).toUpperCase() + n.slice(1).toLowerCase()).join(' '),
          trailer_type: 'dry_van',
          home_city: 'Portland',
          home_state: 'OR',
        };
        for (const p of parts) {
          const pl = p.toLowerCase();
          if (pl.includes('reefer')) data.trailer_type = 'reefer';
          else if (pl.includes('flatbed')) data.trailer_type = 'flatbed';
          else if (pl.includes('power only')) data.trailer_type = 'power_only';
        }
        for (const p of parts.slice(1)) {
          const stateMatch = p.match(/([a-zA-Z\s]+?)\s*,?\s*([A-Z]{2})$/i);
          if (stateMatch && stateMatch[2]) {
            data.home_city = stateMatch[1].trim();
            data.home_state = stateMatch[2].toUpperCase();
          }
        }
        if (data.first_name) return handleAddDriver(chatId, data);
      }

      // REMOVE DRIVER
      const removeCmd = cmdLower.match(/(?:fire|remove|delete|terminate|drop|kick|eject|let go|take off)\s+(?:driver\s+)?(.+)/i);
      if (removeCmd && !cmdLower.includes('task') && !cmdLower.includes('load')) {
        return handleRemoveDriver(chatId, {}, removeCmd[1].trim());
      }

      // SHOW DRIVERS
      if (/(?:show|list|pull up|who'?s on|display)\s+(?:driver|roster|fleet)/i.test(cmdLower) || cmdLower === 'drivers') {
        return handleDataQuery(chatId, 'list_drivers');
      }

      // SHOW LOADS
      if (/(?:show|list|pull up|display)\s+(?:load|freight)/i.test(cmdLower) || cmdLower === 'loads') {
        return handleDataQuery(chatId, 'list_loads');
      }

      // ADD TASK
      const taskCmd = command.match(/(?:add|new|create)\s+(?:a\s+)?task\s*:?\s*(.+)/i);
      if (taskCmd) {
        return handleAddTask(chatId, { title: taskCmd[1].trim() }, '');
      }

      // COMPLETE TASK
      const doneCmd = cmdLower.match(/(?:done|mark done|complete|finished)\s*:?\s*(.+)/i);
      if (doneCmd) {
        return handleCompleteTask(chatId, {}, doneCmd[1].trim());
      }

      // REMOVE TASK
      const rmTaskCmd = cmdLower.match(/(?:delete|remove|cancel)\s+task\s*:?\s*(.+)/i);
      if (rmTaskCmd) {
        return handleRemoveTask(chatId, {}, rmTaskCmd[1].trim());
      }

      // If a specific agent was called but no pattern matched — send to that agent via Claude
      if (calledAgent) {
        return handleAgentRun(chatId, calledAgent, 'manual', command);
      }
    }

    // Smart routing — use Claude for everything else
    try {
      await bot.sendChatAction(chatId, 'typing');
      const route = await routeMessage(text);

      if (route.route === 'add_driver') {
        await handleAddDriver(chatId, route.data || {});
      } else if (route.route === 'add_shipper') {
        await handleAddShipper(chatId, route.data || {});
      } else if (route.route === 'add_load') {
        await handleAddLoad(chatId, route.data || {});
      } else if (route.route === 'add_task') {
        await handleAddTask(chatId, route.data || {}, route.instructions || '');
      } else if (route.route === 'complete_task') {
        await handleCompleteTask(chatId, route.data || {}, route.instructions || '');
      } else if (route.route === 'remove_task') {
        await handleRemoveTask(chatId, route.data || {}, route.instructions || '');
      } else if (route.route === 'remove_driver') {
        await handleRemoveDriver(chatId, route.data || {}, route.instructions || '');
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
    const result = await supa.addDriver({
      name: `${data.first_name} ${data.last_name}`,
      first_name: data.first_name,
      last_name: data.last_name,
      phone: data.phone || '',
      email: data.email || '',
      mc_number: data.mc_number || '',
      dot_number: data.dot_number || '',
      truck_type: data.trailer_type || 'dry_van',
      home_city: data.home_city || '',
      home_state: data.home_state || '',
      current_city: data.home_city || '',
      current_state: data.home_state || '',
      status: 'available',
      percentage_rate: 0.90,
      region: data.region || 'nationwide',
    });

    if (result.error) throw new Error(result.error);

    bot.sendMessage(chatId,
      `✅ *New Driver Added to Dashboard*\n\n` +
      `Name: ${data.first_name} ${data.last_name}\n` +
      `Equipment: ${data.trailer_type || 'dry_van'}\n` +
      `Base: ${data.home_city || '?'}, ${data.home_state || '?'}\n` +
      `Phone: ${data.phone || 'Not set'}\n` +
      `MC#: ${data.mc_number || 'Not set'}\n` +
      `Rate: 90% (company keeps 10%)\n\n` +
      `_Driver is now visible on elitetrucking.xyz dashboard_`,
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
    const result = await supa.addContact({
      company: data.company_name,
      name: data.contact_name || '',
      phone: data.phone || '',
      email: data.email || '',
      type: data.type || 'shipper',
      credit_rating: data.credit_rating || 'unknown',
      notes: data.notes || '',
    });

    if (result.error) throw new Error(result.error);

    bot.sendMessage(chatId,
      `✅ *New Contact Added to Dashboard*\n\n` +
      `Company: ${data.company_name}\n` +
      `Contact: ${data.contact_name || 'Not set'}\n` +
      `Email: ${data.email || 'Not set'}\n` +
      `Type: ${data.type || 'shipper'}\n\n` +
      `_Contact is now visible on elitetrucking.xyz dashboard_`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Failed to add contact: ${err.message}`);
  }
}

async function handleAddLoad(chatId, data) {
  if (!data.origin_city || !data.dest_city || !data.rate) {
    return bot.sendMessage(chatId, `⚠️ Need at least: origin city/state, destination city/state, and rate.\n\nExample: "New load Dallas TX to Chicago IL, 42000 lbs, dry van, $3200, 920 miles"`);
  }

  try {
    const rpm = data.miles > 0 ? Math.round((data.rate / data.miles) * 100) / 100 : 0;

    const result = await supa.addLoad({
      origin: `${data.origin_city}, ${data.origin_state || ''}`,
      origin_city: data.origin_city,
      origin_state: data.origin_state || '',
      destination: `${data.dest_city}, ${data.dest_state || ''}`,
      dest_city: data.dest_city,
      dest_state: data.dest_state || '',
      rate: data.rate,
      miles: data.miles || 0,
      rate_per_mile: rpm,
      weight: data.weight_lbs || 0,
      equipment_type: data.equipment_type || 'dry_van',
      commodity: data.commodity || '',
      status: 'pending',
    });

    if (result.error) throw new Error(result.error);
    const ref = result.load?.reference_number || 'ELT-????';

    bot.sendMessage(chatId,
      `✅ *New Load Posted — ${ref}*\n\n` +
      `Route: ${data.origin_city}, ${data.origin_state || '?'} → ${data.dest_city}, ${data.dest_state || '?'}\n` +
      `Rate: $${data.rate.toLocaleString()} ($${rpm}/mi)\n` +
      `Miles: ${data.miles || '?'}\n` +
      `Equipment: ${data.equipment_type || 'dry_van'}\n` +
      `Weight: ${data.weight_lbs ? data.weight_lbs.toLocaleString() + ' lbs' : 'Not set'}\n\n` +
      `_Load is now on the elitetrucking.xyz dashboard. Say "assign load ${ref}" to match a driver._`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Failed to add load: ${err.message}`);
  }
}

async function handleAddTask(chatId, data, instructions) {
  const title = data.title || data.task || instructions || '';
  if (!title) {
    return bot.sendMessage(chatId, `⚠️ What's the task? Example: "Add task: Follow up with XPO Logistics about reefer loads"`);
  }

  try {
    const result = await supa.addTask({
      title: title,
      dept: data.dept || 'Operations',
      priority: data.priority || 'normal',
      assignee: data.assignee || '',
      notes: data.notes || '',
    });

    if (result.error) throw new Error(result.error);

    bot.sendMessage(chatId,
      `✅ *Task Added to Dashboard*\n\n` +
      `Task: ${title}\n` +
      `Dept: ${data.dept || 'Operations'}\n` +
      `Priority: ${data.priority || 'normal'}\n\n` +
      `_Task is now visible on elitetrucking.xyz dashboard_`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Failed to add task: ${err.message}`);
  }
}

async function handleCompleteTask(chatId, data, instructions) {
  const identifier = data.title || data.task || data.id || instructions || '';
  if (!identifier) {
    return bot.sendMessage(chatId, `⚠️ Which task? Example: "Mark done: Follow up with XPO" or "Complete task 3"`);
  }

  try {
    const result = await supa.completeTask(identifier);
    if (result.error) throw new Error(result.error);

    bot.sendMessage(chatId,
      `✅ *Task Completed*\n\n` +
      `Task: ${result.task.title || identifier}\n\n` +
      `_Updated on elitetrucking.xyz dashboard_`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Failed to complete task: ${err.message}`);
  }
}

async function handleRemoveTask(chatId, data, instructions) {
  const identifier = data.title || data.task || data.id || instructions || '';
  if (!identifier) {
    return bot.sendMessage(chatId, `⚠️ Which task? Example: "Remove task: Follow up with XPO" or "Delete task 3"`);
  }

  try {
    const result = await supa.removeTask(identifier);
    if (result.error) throw new Error(result.error);

    bot.sendMessage(chatId,
      `🗑️ *Task Removed*\n\n` +
      `Task: ${result.task.title || identifier}\n\n` +
      `_Removed from elitetrucking.xyz dashboard_`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Failed to remove task: ${err.message}`);
  }
}

async function handleRemoveDriver(chatId, data, instructions) {
  // Extract name from multiple possible sources
  let identifier = data.name || data.driver_name || data.first_name || data.id || '';

  // If no structured data, try to extract from instructions by removing action words
  if (!identifier && instructions) {
    identifier = instructions
      .replace(/\b(remove|delete|fire|terminate|drop|get rid of|kick|driver|oo|owner.?operator)\b/gi, '')
      .trim();
  }

  if (!identifier) {
    return bot.sendMessage(chatId, `⚠️ Which driver? Example: "Fire Hassan" or "Remove driver Maslah"`);
  }

  try {
    const result = await supa.removeDriver(identifier);
    if (result.error) throw new Error(result.error);

    const name = result.driver.name || `${result.driver.first_name || ''} ${result.driver.last_name || ''}`.trim();
    bot.sendMessage(chatId,
      `🗑️ *Driver Removed*\n\n` +
      `Driver: ${name}\n\n` +
      `_Removed from elitetrucking.xyz dashboard_`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Failed to remove driver: ${err.message}`);
  }
}

async function handleDataQuery(chatId, queryType) {
  try {
    if (queryType === 'list_drivers') {
      const drivers = await supa.getDrivers();
      if (!drivers.length) return bot.sendMessage(chatId, '📋 No drivers in the system yet.');

      const statusIcons = { available: '🟢', on_load: '🔵', 'on-load': '🔵', off_duty: '⚪', suspended: '🔴', maintenance: '🟡' };
      let msg = '🚛 *Drivers*\n\n';
      drivers.forEach(d => {
        const name = d.name || `${d.first_name || ''} ${d.last_name || ''}`.trim() || '?';
        msg += `${statusIcons[d.status] || '⚪'} *${name}* — ${d.truck_type || d.trailer_type || '?'}\n`;
        msg += `   ${d.current_city || d.home_city || '?'}, ${d.current_state || d.home_state || '?'} · ${d.status || 'unknown'}\n\n`;
      });
      return bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    }

    if (queryType === 'list_loads') {
      const loads = await supa.getLoads();
      if (!loads.length) return bot.sendMessage(chatId, '📋 No loads in the system yet.');

      const statusIcons = { pending: '📦', posted: '📦', assigned: '🟡', dispatched: '🔵', 'in-transit': '🚚', in_transit: '🚚', 'picked-up': '🚚', delivered: '✅', invoiced: '💰', paid: '💵', cancelled: '❌' };
      let msg = '📦 *Loads*\n\n';
      loads.slice(0, 15).forEach(l => {
        const ref = l.reference_number || l.id || '?';
        msg += `${statusIcons[l.status] || '📋'} *${ref}* — ${l.status || '?'}\n`;
        msg += `   ${l.origin || l.origin_city || '?'} → ${l.destination || l.dest_city || '?'}\n`;
        msg += `   $${l.rate?.toLocaleString() || '?'} · $${l.rate_per_mile || '?'}/mi · ${l.equipment_type || l.type || '?'}\n\n`;
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

function getBotInstance() { return bot; }

module.exports = { initTelegram, sendToGroup, getBotInstance };
