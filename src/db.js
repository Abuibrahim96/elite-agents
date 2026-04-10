const config = require('./config');

// ============================================================================
// Database layer — uses in-memory store for agent logs/approvals,
// Supabase handles all business data (drivers, loads, contacts, tasks).
// ============================================================================

// In-memory store for agent_logs, approval_queue, agent_memory, communications
const memStore = {
  agent_logs: [],
  approval_queue: [],
  agent_memory: {},
  communications: [],
};

let nextId = { agent_logs: 1, approval_queue: 1, communications: 1 };

async function query(text, params = []) {
  // Parse simple INSERT/SELECT/UPDATE for in-memory tables
  const sql = text.trim().toUpperCase();

  if (sql.startsWith('INSERT INTO AGENT_LOGS') || sql.includes('INTO AGENT_LOGS')) {
    const id = nextId.agent_logs++;
    memStore.agent_logs.push({ id, params, created_at: new Date().toISOString() });
    return { rows: [{ id }], rowCount: 1 };
  }

  if (sql.startsWith('INSERT INTO APPROVAL_QUEUE') || sql.includes('INTO APPROVAL_QUEUE')) {
    const id = nextId.approval_queue++;
    const item = { id, status: 'pending', created_at: new Date().toISOString() };
    memStore.approval_queue.push(item);
    return { rows: [item], rowCount: 1 };
  }

  if (sql.startsWith('INSERT INTO COMMUNICATIONS') || sql.includes('INTO COMMUNICATIONS')) {
    const id = nextId.communications++;
    memStore.communications.push({ id, params, created_at: new Date().toISOString() });
    return { rows: [{ id }], rowCount: 1 };
  }

  if (sql.includes('INSERT INTO AGENT_MEMORY') || sql.includes('INTO AGENT_MEMORY')) {
    return { rows: [{ id: 1 }], rowCount: 1 };
  }

  // SELECT queries return empty by default — Supabase handles real data
  return { rows: [], rowCount: 0 };
}

async function getOne(text, params = []) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

async function getMany(text, params = []) {
  const result = await query(text, params);
  return result.rows;
}

async function transaction(callback) {
  return callback({ query });
}

console.log('[DB] Using Supabase for business data, in-memory for agent logs');

module.exports = { query, getOne, getMany, transaction };