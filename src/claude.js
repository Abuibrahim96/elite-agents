const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const { logAgentAction } = require('./middleware/logger');
const { getOne, query } = require('./db');

const client = new Anthropic({ apiKey: config.anthropicApiKey });

/**
 * Run an agent's Claude tool-use loop.
 *
 * Flow:
 * 1. Load prior conversation context from agent_memory (if any)
 * 2. Build messages array with context + new user message
 * 3. Call Claude API with system prompt + tools
 * 4. If Claude returns tool_use → execute tools → feed results back → loop
 * 5. When Claude returns text (end_turn) → save memory, log, return
 *
 * @param {string} agentName - e.g., 'dispatch', 'boss'
 * @param {object} options
 * @param {string} options.systemPrompt - The agent's system prompt
 * @param {string} options.userMessage - The task/trigger message
 * @param {Array} options.tools - Claude tool definitions
 * @param {object} options.toolHandlers - { toolName: async (input) => result }
 * @param {string} [options.contextKey] - Memory key (e.g., 'daily', 'load:123')
 * @param {number} [options.maxTurns=10] - Max tool-use loop iterations
 * @returns {object} { response, actions, tokensUsed, durationMs }
 */
async function runAgent(agentName, { systemPrompt, userMessage, tools, toolHandlers, contextKey, maxTurns = 10 }) {
  const start = Date.now();
  const actions = [];
  let totalTokens = 0;

  // 1. Load prior memory if context key provided
  let messages = [];
  if (contextKey) {
    const memory = await getOne(
      'SELECT messages_json, summary FROM agent_memory WHERE agent = $1 AND context_key = $2',
      [agentName, contextKey]
    );
    if (memory) {
      // If we have a summary, prepend it as context
      if (memory.summary) {
        messages.push({
          role: 'user',
          content: `[Previous context summary]: ${memory.summary}`
        });
        messages.push({
          role: 'assistant',
          content: 'Understood. I have the context from our previous interaction.'
        });
      }
      // Add recent messages (keep last 10 exchanges to avoid token bloat)
      const prior = memory.messages_json || [];
      const recentMessages = prior.slice(-20);
      messages.push(...recentMessages);
    }
  }

  // 2. Add new user message
  messages.push({ role: 'user', content: userMessage });

  // 3. Tool-use loop
  let turns = 0;
  while (turns < maxTurns) {
    turns++;

    let response;
    try {
      response = await client.messages.create({
        model: config.claudeModel,
        max_tokens: 4096,
        system: systemPrompt,
        tools: tools,
        messages: messages,
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      await logAgentAction(agentName, 'claude_api_error', { userMessage }, { error: err.message }, {
        durationMs, success: false, errorMessage: err.message
      });
      throw err;
    }

    totalTokens += (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

    // Add assistant response to messages
    messages.push({ role: 'assistant', content: response.content });

    // 4. If end_turn — extract text and break
    if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop') {
      const textParts = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text);

      const durationMs = Date.now() - start;

      // 5. Save memory
      if (contextKey) {
        await saveMemory(agentName, contextKey, messages);
      }

      // 6. Log
      await logAgentAction(agentName, 'run_complete', { userMessage, contextKey }, {
        response: textParts.join('\n'),
        actionsCount: actions.length,
        turns,
      }, { tokensUsed: totalTokens, durationMs });

      return {
        response: textParts.join('\n'),
        actions,
        tokensUsed: totalTokens,
        durationMs,
        turns,
      };
    }

    // 5. If tool_use — execute each tool
    if (response.stop_reason === 'tool_use') {
      const toolResults = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        const handler = toolHandlers[block.name];
        let result;

        if (!handler) {
          result = { error: `Unknown tool: ${block.name}` };
        } else {
          try {
            result = await handler(block.input);
            actions.push({
              tool: block.name,
              input: block.input,
              result: result,
              success: true,
            });
          } catch (err) {
            result = { error: err.message };
            actions.push({
              tool: block.name,
              input: block.input,
              error: err.message,
              success: false,
            });
          }
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Unknown stop reason — break
    break;
  }

  // If we exhausted turns
  const durationMs = Date.now() - start;
  await logAgentAction(agentName, 'max_turns_reached', { userMessage, turns: maxTurns }, { actions }, {
    tokensUsed: totalTokens, durationMs, success: false, errorMessage: 'Max turns exceeded'
  });

  return {
    response: '[Agent reached maximum tool-use iterations. Please check the logs.]',
    actions,
    tokensUsed: totalTokens,
    durationMs,
    turns,
  };
}

/**
 * Save conversation to agent_memory, compressing if too long.
 */
async function saveMemory(agentName, contextKey, messages) {
  try {
    // Keep only the last 20 messages to prevent memory bloat
    const recentMessages = messages.slice(-20);

    // Generate summary if conversation is long
    let summary = null;
    if (messages.length > 20) {
      try {
        const summaryResponse = await client.messages.create({
          model: config.claudeModel,
          max_tokens: 500,
          system: 'Summarize the key facts and decisions from this agent conversation in 2-3 sentences. Focus on: actions taken, outcomes, and any pending items.',
          messages: [{ role: 'user', content: JSON.stringify(messages.slice(0, -20).map(m => {
            if (typeof m.content === 'string') return m.content;
            if (Array.isArray(m.content)) return m.content.filter(b => b.type === 'text' || b.text).map(b => b.text || JSON.stringify(b)).join(' ');
            return JSON.stringify(m.content);
          })) }],
        });
        summary = summaryResponse.content[0]?.text || null;
      } catch {
        // Summary generation failed — not critical, skip it
      }
    }

    await query(
      `INSERT INTO agent_memory (agent, context_key, messages_json, summary, last_used)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (agent, context_key) DO UPDATE SET
         messages_json = $3, summary = COALESCE($4, agent_memory.summary), last_used = NOW()`,
      [agentName, contextKey, JSON.stringify(recentMessages), summary]
    );
  } catch (err) {
    console.error(`Failed to save agent memory for ${agentName}:${contextKey}:`, err.message);
  }
}

module.exports = { runAgent };
