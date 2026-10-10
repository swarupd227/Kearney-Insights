'use strict';
// Reference data cache: dimension members and their labels, loaded once from Postgres.
const db = require('../db');
let cache = null;
async function load() {
  if (cache) return cache;
  const [regions, units, offices, practices, industries, levels, clients, companies] = await Promise.all([
    db.query('SELECT * FROM regions ORDER BY users DESC'), db.query('SELECT * FROM units'), db.query('SELECT * FROM offices ORDER BY users DESC'),
    db.query('SELECT * FROM practices'), db.query('SELECT * FROM industries'), db.query('SELECT * FROM levels ORDER BY rank DESC'),
    db.query("SELECT id, name, is_public, industry, region, unit, public_work, public_year, public_source, relationship_partner, fortune_g500 FROM clients WHERE name NOT LIKE 'Prospect%'"), db.query('SELECT * FROM kearney_companies')
  ]);
  const label = {};
  const put = (dim, id, name) => { label[dim + ':' + id] = name; };
  regions.forEach(r => put('region', r.id, r.name)); units.forEach(u => put('unit', u.id, u.name)); offices.forEach(o => put('office', o.id, o.city));
  practices.forEach(p => put('practice', p.id, p.name)); industries.forEach(i => put('industry', i.id, i.name)); levels.forEach(l => put('level', l.id, l.name));
  clients.forEach(c => put('client', c.id, c.name)); companies.forEach(k => put('kearney_company', k.id, k.name));
  put('fee_model', 'tm', 'Time and materials'); put('fee_model', 'fixed', 'Fixed fee'); put('fee_model', 'value', 'Value-based');
  cache = { regions, units, offices, practices, industries, levels, clients, companies, label, unitById: Object.fromEntries(units.map(u => [u.id, u])), officeById: Object.fromEntries(offices.map(o => [o.id, o])), clientById: Object.fromEntries(clients.map(c => [c.id, c])) };
  return cache;
}
function labelOf(dim, id) { if (!cache) return id; if (dim === 'month' || dim === 'quarter' || dim === 'year') return id; return cache.label[dim + ':' + id] || id; }
module.exports = { load, labelOf, get: () => cache };
