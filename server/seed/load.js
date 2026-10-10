'use strict';
/**
 * Loads the generated seed into Postgres. Idempotent: `--force` drops and reloads.
 * Usage: node server/seed/load.js [--force]
 */
const path = require('path');
const fs = require('fs');
const db = require('../db');

const TABLE_ORDER = ['regions', 'units', 'offices', 'kearney_companies', 'practices', 'industries', 'levels', 'people', 'clients', 'engagements',
  'engagement_months', 'person_months', 'invoices', 'opportunities', 'plan', 'fx_rates', 'contacts', 'knowledge_assets', 'knowledge_search_topics',
  'app_adoption', 'staffing_roles', 'calendar_events', 'agent_runs', 'model_registry', 'seed_meta'];
const ALL_TABLES = [...TABLE_ORDER, 'servicenow_tickets', 'actions', 'audit_log', 'boards', 'metric_anomalies'];

function jsonCols(table) {
  return { people: ['flight_drivers', 'skills', 'languages'], clients: ['sentiment_themes'], engagements: ['workstreams'], invoices: ['late_drivers'], opportunities: ['win_drivers'], staffing_roles: ['skills'], calendar_events: ['attachments'], agent_runs: ['agents', 'guardian'], model_registry: ['accuracy'] }[table] || [];
}
const ARRAY_COLS = { people: ['skills', 'languages'], staffing_roles: ['skills'] };
const DROP_COLS = { people: ['bs_function'] };

function prepare(table, rows) {
  const jc = jsonCols(table); const ac = ARRAY_COLS[table] || []; const dc = DROP_COLS[table] || [];
  return rows.map(r => { const o = {}; for (const [k, v] of Object.entries(r)) { if (dc.includes(k)) continue; o[k] = ac.includes(k) ? v : (jc.includes(k) && v !== null ? JSON.stringify(v) : v); } return o; });
}

async function loadServiceNow() {
  const file = path.join(__dirname, '..', '..', 'data', 'servicenow_tickets.csv');
  if (!fs.existsSync(file)) return 0;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  const header = lines.shift().split(',').map(s => s.trim());
  const rows = lines.map(l => { const c = l.split(','); const o = {}; header.forEach((h, i) => o[h] = c[i] ? c[i].trim() : null); return { month: o.month, application: o.application, incidents: parseInt(o.incidents || '0', 10), requests: parseInt(o.requests || '0', 10), source: o.source || 'rfp-pack:ticket-extract' }; });
  await db.bulkInsert('servicenow_tickets', rows);
  return rows.length;
}

async function load({ force = false, log = console.log } = {}) {
  await db.migrate();
  const existing = await db.isSeeded();
  if (existing && !force) { log(`Database already seeded (version ${existing}). Use --force to reload.`); return false; }
  if (existing || force) { log('Clearing tables…'); await db.pool.query('TRUNCATE ' + ALL_TABLES.join(', ') + ' RESTART IDENTITY CASCADE'); }
  const gen = require('./generate');
  const t0 = Date.now();
  for (const table of TABLE_ORDER) {
    const rows = prepare(table, gen.tables[table]);
    await db.bulkInsert(table, rows, table === 'person_months' || table === 'engagement_months' ? 2000 : 500);
    log(`  ${table}: ${rows.length} rows`);
  }
  const sn = await loadServiceNow(); log(`  servicenow_tickets: ${sn} rows (from data/servicenow_tickets.csv)`);
  await db.pool.query('ANALYZE');
  log(`Seed loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return true;
}
module.exports = { load };
if (require.main === module) {
  load({ force: process.argv.includes('--force') }).then(() => db.pool.end()).catch(e => { console.error(e); process.exit(1); });
}
