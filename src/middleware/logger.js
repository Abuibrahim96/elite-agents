const { query } = require('../db');

function requestLogger(req, res, next) {
  const start = Date.now();
  const { method, path } = req;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    console.log(`${method} ${path} ${status} ${duration}ms`);
  });

  next();
}

async function logAgentAction(agent, action, input, output, { tokensUsed = 0, durationMs = 0, success = true, errorMessage = null } = {}) {
  try {
    await query(
      `INSERT INTO agent_logs (agent, action, input_json, output_json, tokens_used, duration_ms, success, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [agent, action, JSON.stringify(input), JSON.stringify(output), tokensUsed, durationMs, success, errorMessage]
    );
  } catch (err) {
    console.error('Failed to log agent action:', err.message);
  }
}

module.exports = { requestLogger, logAgentAction };
