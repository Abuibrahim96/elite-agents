const path = require('path');
const config = require('./config');

// ============================================================================
// Dual-mode DB: PostgreSQL in production, SQLite for local demo
// All agents use query/getOne/getMany — this module swaps the backend.
// ============================================================================

const USE_SQLITE = !config.databaseUrl || config.databaseUrl.includes('password@localhost') || process.env.USE_SQLITE === 'true';

let db; // SQLite instance (if used)

if (USE_SQLITE) {
  const Database = require('better-sqlite3');
  const dbPath = path.join(__dirname, '..', 'elite_agents_demo.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  console.log(`[DB] SQLite demo mode → ${dbPath}`);
} else {
  console.log(`[DB] PostgreSQL mode → ${config.databaseUrl.replace(/:[^:@]+@/, ':***@')}`);
}

/**
 * Convert $1, $2, ... placeholders to ? for SQLite.
 * Also handles simple PG-specific syntax conversions.
 */
function pgToSqlite(text) {
  if (!USE_SQLITE) return text;

  let sql = text;
  // $1, $2 → ?
  sql = sql.replace(/\$\d+/g, '?');
  // ::int, ::numeric, ::text → remove
  sql = sql.replace(/::(int|integer|numeric|text|date|timestamptz?)/gi, '');
  // INTERVAL '...' → simplified for SQLite
  sql = sql.replace(/NOW\(\)/gi, "datetime('now')");
  sql = sql.replace(/CURRENT_DATE/gi, "date('now')");
  sql = sql.replace(/CURRENT_TIMESTAMP/gi, "datetime('now')");
  // INTERVAL handling
  sql = sql.replace(/datetime\('now'\)\s*\+\s*INTERVAL\s*'(\d+)\s*days?'/gi, "datetime('now', '+$1 days')");
  sql = sql.replace(/datetime\('now'\)\s*-\s*INTERVAL\s*'(\d+)\s*days?'/gi, "datetime('now', '-$1 days')");
  sql = sql.replace(/datetime\('now'\)\s*\+\s*INTERVAL\s*'(\d+)\s*hours?'/gi, "datetime('now', '+$1 hours')");
  sql = sql.replace(/date\('now'\)\s*\+\s*INTERVAL\s*'(\d+)\s*days?'/gi, "date('now', '+$1 days')");
  sql = sql.replace(/date\('now'\)\s*-\s*INTERVAL\s*'(\d+)\s*days?'/gi, "date('now', '-$1 days')");
  sql = sql.replace(/INTERVAL\s*'1\s*hour'\s*\*\s*\?/gi, "(? || ' hours')");
  // ILIKE → LIKE (SQLite is case-insensitive by default for ASCII)
  sql = sql.replace(/ILIKE/gi, 'LIKE');
  // FILTER (WHERE ...) → not supported in SQLite, we'll handle in code
  // TIMESTAMPTZ → TEXT in SQLite (already handled by schema)
  // COALESCE, CASE, etc. work in both
  // RETURNING * → not well supported, remove
  sql = sql.replace(/\s+RETURNING\s+\*/gi, '');
  // ON CONFLICT ... DO UPDATE SET → simplified
  // JSONB → TEXT in SQLite
  return sql;
}

// ============================================================================
// PostgreSQL backend
// ============================================================================
let pool;
if (!USE_SQLITE) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: config.databaseUrl });
  pool.on('error', (err) => console.error('PG pool error:', err.message));
}

// ============================================================================
// Unified query interface
// ============================================================================

async function query(text, params = []) {
  if (USE_SQLITE) {
    const sql = pgToSqlite(text);
    const trimmed = sql.trim().toUpperCase();
    try {
      if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
        const rows = db.prepare(sql).all(...params);
        return { rows, rowCount: rows.length };
      } else if (trimmed.startsWith('INSERT')) {
        const info = db.prepare(sql).run(...params);
        // Simulate RETURNING * by fetching the inserted row
        return { rows: [{ id: info.lastInsertRowid }], rowCount: info.changes };
      } else {
        const info = db.prepare(sql).run(...params);
        return { rows: [], rowCount: info.changes };
      }
    } catch (err) {
      // If the SQL fails, log it for debugging
      if (process.env.DEBUG_SQL) {
        console.error(`[SQL ERROR] ${sql}\n  Params: ${JSON.stringify(params)}\n  Error: ${err.message}`);
      }
      throw err;
    }
  } else {
    return pool.query(text, params);
  }
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
  if (USE_SQLITE) {
    const tx = db.transaction(() => callback({ query: (t, p) => query(t, p) }));
    return tx();
  } else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { pool, query, getOne, getMany, transaction, USE_SQLITE, db };
