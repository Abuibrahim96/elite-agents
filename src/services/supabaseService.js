/**
 * supabaseService.js — Connects agents to the dashboard's Supabase database.
 *
 * The dashboard stores data in Supabase tables: drivers, loads, broker_loads, contacts, app_settings
 * Each row has: { id: string, data: JSON }
 * This service reads/writes to those same tables so agents and dashboard stay in sync.
 */

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

let sb = null;

function getClient() {
  if (!sb && config.supabaseUrl && config.supabaseKey) {
    sb = createClient(config.supabaseUrl, config.supabaseKey);
  }
  return sb;
}

// ═════════════════════════════════════════════════════════════════════════════
//  DRIVERS
// ═════════════════════════════════════════════════════════════════════════════

async function getDrivers() {
  const client = getClient();
  if (!client) return [];
  const { data, error } = await client.from('drivers').select('*');
  if (error) { console.error('[Supabase] getDrivers error:', error.message); return []; }
  return (data || []).map(row => row.data);
}

async function getDriverById(id) {
  const drivers = await getDrivers();
  return drivers.find(d => String(d.id) === String(id)) || null;
}

async function addDriver(driver) {
  const client = getClient();
  if (!client) return { error: 'Supabase not configured' };

  // Generate ID
  const drivers = await getDrivers();
  const maxId = drivers.reduce((max, d) => Math.max(max, parseInt(d.id) || 0), 0);
  driver.id = String(maxId + 1);
  driver.status = driver.status || 'available';
  driver.percentage_rate = driver.percentage_rate || 0.90;
  driver.created_at = new Date().toISOString();

  const { error } = await client.from('drivers').upsert({ id: driver.id, data: driver });
  if (error) { console.error('[Supabase] addDriver error:', error.message); return { error: error.message }; }
  return { success: true, driver };
}

async function updateDriver(id, updates) {
  const client = getClient();
  if (!client) return { error: 'Supabase not configured' };

  const drivers = await getDrivers();
  const driver = drivers.find(d => String(d.id) === String(id));
  if (!driver) return { error: `Driver ${id} not found` };

  const updated = { ...driver, ...updates, updated_at: new Date().toISOString() };
  const { error } = await client.from('drivers').upsert({ id: String(id), data: updated });
  if (error) return { error: error.message };
  return { success: true, driver: updated };
}

// ═════════════════════════════════════════════════════════════════════════════
//  LOADS
// ═════════════════════════════════════════════════════════════════════════════

async function getLoads() {
  const client = getClient();
  if (!client) return [];
  const { data, error } = await client.from('loads').select('*');
  if (error) { console.error('[Supabase] getLoads error:', error.message); return []; }
  return (data || []).map(row => row.data);
}

async function addLoad(load) {
  const client = getClient();
  if (!client) return { error: 'Supabase not configured' };

  const loads = await getLoads();
  const maxId = loads.reduce((max, l) => Math.max(max, parseInt(l.id) || 0), 0);
  load.id = String(maxId + 1);
  load.status = load.status || 'pending';
  load.created_at = new Date().toISOString();

  // Generate reference number
  const maxRef = loads.reduce((max, l) => {
    const m = (l.reference_number || '').match(/ELT-(\d+)/);
    return m ? Math.max(max, parseInt(m[1])) : max;
  }, 2000);
  load.reference_number = load.reference_number || `ELT-${maxRef + 1}`;

  // Calculate RPM
  if (load.rate && load.miles && load.miles > 0) {
    load.rate_per_mile = Math.round((load.rate / load.miles) * 100) / 100;
  }

  const { error } = await client.from('loads').upsert({ id: load.id, data: load });
  if (error) return { error: error.message };
  return { success: true, load };
}

async function updateLoad(id, updates) {
  const client = getClient();
  if (!client) return { error: 'Supabase not configured' };

  const loads = await getLoads();
  const load = loads.find(l => String(l.id) === String(id) || l.reference_number === id);
  if (!load) return { error: `Load ${id} not found` };

  const updated = { ...load, ...updates, updated_at: new Date().toISOString() };
  const { error } = await client.from('loads').upsert({ id: String(load.id), data: updated });
  if (error) return { error: error.message };
  return { success: true, load: updated };
}

// ═════════════════════════════════════════════════════════════════════════════
//  CONTACTS (brokers/shippers)
// ═════════════════════════════════════════════════════════════════════════════

async function getContacts() {
  const client = getClient();
  if (!client) return [];
  const { data, error } = await client.from('contacts').select('*');
  if (error) { console.error('[Supabase] getContacts error:', error.message); return []; }
  return (data || []).map(row => row.data);
}

async function addContact(contact) {
  const client = getClient();
  if (!client) return { error: 'Supabase not configured' };

  const contacts = await getContacts();
  const maxId = contacts.reduce((max, c) => Math.max(max, parseInt(c.id) || 0), 0);
  contact.id = String(maxId + 1);
  contact.created_at = new Date().toISOString();

  const { error } = await client.from('contacts').upsert({ id: contact.id, data: contact });
  if (error) return { error: error.message };
  return { success: true, contact };
}

// ═════════════════════════════════════════════════════════════════════════════
//  BROKER LOADS
// ═════════════════════════════════════════════════════════════════════════════

async function getBrokerLoads() {
  const client = getClient();
  if (!client) return [];
  const { data, error } = await client.from('broker_loads').select('*');
  if (error) { console.error('[Supabase] getBrokerLoads error:', error.message); return []; }
  return (data || []).map(row => row.data);
}

async function addBrokerLoad(load) {
  const client = getClient();
  if (!client) return { error: 'Supabase not configured' };

  const loads = await getBrokerLoads();
  const maxId = loads.reduce((max, l) => Math.max(max, parseInt(l.id) || 0), 0);
  load.id = String(maxId + 1);
  load.created_at = new Date().toISOString();

  const { error } = await client.from('broker_loads').upsert({ id: load.id, data: load });
  if (error) return { error: error.message };
  return { success: true, load };
}

// ═════════════════════════════════════════════════════════════════════════════
//  TASKS (stored in app_settings)
// ═════════════════════════════════════════════════════════════════════════════

async function getTasks() {
  const client = getClient();
  if (!client) return [];
  const { data, error } = await client.from('app_settings').select('*').eq('key', 'tasks');
  if (error || !data || !data[0]) return [];
  return data[0].value || [];
}

async function addTask(task) {
  const client = getClient();
  if (!client) return { error: 'Supabase not configured' };

  const tasks = await getTasks();
  const maxId = tasks.reduce((max, t) => Math.max(max, parseInt(t.id) || 0), 0);
  task.id = maxId + 1;
  task.done = false;
  task.created = new Date().toISOString();
  tasks.push(task);

  const { error } = await client.from('app_settings').upsert({ key: 'tasks', value: tasks }, { onConflict: 'key' });
  if (error) return { error: error.message };
  return { success: true, task };
}

async function getPriorityTasks() {
  const client = getClient();
  if (!client) return [];
  const { data, error } = await client.from('app_settings').select('*').eq('key', 'priority_tasks');
  if (error || !data || !data[0]) return [];
  return data[0].value || [];
}

async function addPriorityTask(task) {
  const client = getClient();
  if (!client) return { error: 'Supabase not configured' };

  const tasks = await getPriorityTasks();
  const maxId = tasks.reduce((max, t) => Math.max(max, parseInt(t.id) || 0), 0);
  task.id = maxId + 1;
  task.done = false;
  task.created = new Date().toISOString();
  tasks.push(task);

  const { error } = await client.from('app_settings').upsert({ key: 'priority_tasks', value: tasks }, { onConflict: 'key' });
  if (error) return { error: error.message };
  return { success: true, task };
}

// ═════════════════════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ═════════════════════════════════════════════════════════════════════════════

async function isConnected() {
  const client = getClient();
  if (!client) return false;
  try {
    const { error } = await client.from('drivers').select('id').limit(1);
    return !error;
  } catch { return false; }
}

module.exports = {
  getDrivers, getDriverById, addDriver, updateDriver,
  getLoads, addLoad, updateLoad,
  getContacts, addContact,
  getBrokerLoads, addBrokerLoad,
  getTasks, addTask,
  getPriorityTasks, addPriorityTask,
  isConnected,
};