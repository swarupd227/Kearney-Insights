'use strict';
/**
 * Cash and billing helpers used by the forecast (model 6, late payment) and the cash and billing desk screen.
 */
const db = require('../db');
const engine = require('../metrics/engine');
const ref = require('../metrics/refcache');
const composer = require('./composer');
const { money, pct, listWords } = require('./util');

async function lateInvoices({ cut = {}, limit = 15 }) {
  const P = new engine.Params();
  const rows = await db.query(`SELECT i.*, c.name AS client_name, (${P.add(engine.TODAY)}::date - i.due_date) AS days_past_due FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.status<>'paid' ${engine.cutWhere(cut, { region: 'i.region', unit: 'i.unit', client: 'i.client_id', engagement: 'i.engagement_id' }, P)} ORDER BY i.late_prob DESC, i.amount DESC LIMIT ${limit}`, P.values);
  const P2 = new engine.Params();
  const tot = await db.query(`SELECT COUNT(*)::int AS n, SUM(amount) AS open, SUM(amount*late_prob) AS expected_late, SUM(CASE WHEN status='overdue' THEN amount ELSE 0 END) AS overdue FROM invoices i WHERE i.status<>'paid' ${engine.cutWhere(cut, { region: 'i.region', unit: 'i.unit', client: 'i.client_id' }, P2)}`, P2.values);
  const list = rows.map(r => ({ ...r, unit_name: ref.labelOf('unit', r.unit), drivers: r.late_drivers }));
  const t = tot[0];
  const narrative = `${t.n} invoices worth ${money(t.open)} are open${composer.scopeLabel(cut)}; ${money(t.overdue)} is already overdue and the model expects ${money(t.expected_late)} to pass 90 days. ${list[0] ? `${list[0].id} (${list[0].client_name}, ${money(list[0].amount)}) is the most likely at ${pct(list[0].late_prob, 0)}: ${listWords(list[0].drivers)}.` : ''}`;
  const byClient = {}; list.forEach(r => { byClient[r.client_name] = (byClient[r.client_name] || 0) + r.amount * r.late_prob; });
  return { agent: 'Forecast Agent', model: { id: 6, name: 'Late payment', version: '1.0-seed' }, invoices: list, totals: t, narrative, spoken: `${money(t.expected_late)} of open invoices is likely to go past 90 days. ${list[0] ? list[0].client_name + ' is the client to call first.' : ''}`,
    visual: { type: 'bar', title: 'Expected late value by client', subtitle: 'Amount × probability of passing 90 days', x: Object.keys(byClient).slice(0, 10), series: [{ name: 'Expected late value', data: Object.values(byClient).slice(0, 10) }], format: 'money', horizontal: true, seeded: true, lineage: lineage(cut) },
    table: composer.table('Invoices ranked by late-payment probability', '', [['id', 'Invoice'], ['client_name', 'Client'], ['unit_name', 'Unit'], ['amount', 'Amount', 'money'], ['due_date', 'Due'], ['days_past_due', 'Days past due'], ['late_prob', 'Chance past 90 days', 'pct'], ['drivers', 'Drivers']], list, lineage(cut)),
    followUps: ['How much WIP is held up by missing timesheets?', 'Show lock-up days by unit', 'What should I do about it?'] };
}
async function wipHeldByTimesheets({ cut = {} }) {
  const P = new engine.Params();
  const late = await db.query(`SELECT p.unit, SUM(pm.timesheets_late)::int AS late, COUNT(DISTINCT CASE WHEN pm.timesheets_late>0 THEN p.id END)::int AS people FROM person_months pm JOIN people p ON p.id=pm.person_id WHERE pm.month=${P.add(engine.LAST_CLOSED)} ${engine.cutWhere(cut, engine.PPL_DIMS, P)} GROUP BY 1`, P.values);
  const wip = await engine.compute('wip_ageing', { cut, groupBy: 'unit' });
  const over60 = wip.rows.filter(r => r.key === '61–90 days' || r.key === 'over 90 days');
  const totalOver60 = over60.reduce((a, r) => a + r.value, 0);
  const held = totalOver60 * 0.35;
  const rows = late.map(l => ({ unit: l.unit, label: ref.labelOf('unit', l.unit), late_timesheets: l.late, people: l.people, wip_over_60: over60.filter(r => r.dim === l.unit).reduce((a, r) => a + r.value, 0) })).sort((a, b) => b.wip_over_60 - a.wip_over_60);
  const narrative = `${money(totalOver60)} of unbilled work is older than 60 days${composer.scopeLabel(cut)}; about ${money(held)} of it is held up by missing timesheets (${late.reduce((a, l) => a + l.late, 0)} late timesheets from ${late.reduce((a, l) => a + l.people, 0)} people last month). ${rows[0] ? `${rows[0].label} has the most (${money(rows[0].wip_over_60)}).` : ''}`;
  return { agent: 'Engagement Health Agent', rows, totals: { over60: totalOver60, held }, narrative, spoken: narrative, visual: { type: 'bar', title: 'Unbilled work over 60 days by unit', subtitle: 'WIP ageing (61–90 and over 90 days)', x: rows.map(r => r.label), series: [{ name: 'WIP over 60 days', data: rows.map(r => r.wip_over_60) }, { name: 'Late timesheets', data: rows.map(r => r.late_timesheets), kind: 'secondary', format: 'number' }], format: 'money', horizontal: true, seeded: true, lineage: lineage(cut) }, table: composer.table('By unit', '', [['label', 'Unit'], ['wip_over_60', 'WIP over 60 days', 'money'], ['late_timesheets', 'Late timesheets'], ['people', 'People late']], rows, lineage(cut)), followUps: ['What should I do about it?', 'Which invoices are most likely to go past 90 days?', 'Show time entry compliance by unit'] };
}
function lineage(cut) { return { metric: 'late_payment', name: 'Late payment', formula: 'Classifier on client payment history, invoice value, region and disputes', owner: 'Billing and collections lead', source_system: 'SAP, Kyriba', stub: 'stub:sap + stub:kyriba', tables: ['invoices', 'engagement_months', 'person_months'], filters: cut, model: 'Late payment v1.0-seed (precision 0.71, recall 0.64)', seeded: true, refreshed_at: engine.TODAY + 'T05:30:00Z' }; }
module.exports = { lateInvoices, wipHeldByTimesheets };
