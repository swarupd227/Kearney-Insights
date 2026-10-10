'use strict';
/**
 * Pipeline and Win Agent (model 3): win probability per opportunity with plain-word reasons, stalled deals, coverage gap.
 */
const db = require('../db');
const engine = require('../metrics/engine');
const ref = require('../metrics/refcache');
const composer = require('./composer');
const { money, pct, listWords } = require('./util');

const DRIVER_WORDS = { 'Stage': { pos: 'late stage', neg: 'early stage' }, 'Relationship strength': { pos: 'a strong relationship', neg: 'a weak relationship' }, 'Prior work with the client': { pos: 'prior work with the client', neg: 'no prior work' }, 'Fee against typical': { pos: 'a fee below the typical size', neg: 'a fee above the typical size' }, 'Opportunity age': { pos: 'a fresh opportunity', neg: 'an ageing opportunity' }, 'Partner record': { pos: 'a partner with a strong record', neg: 'a partner below the average win rate' } };
function reasons(drivers) { return (drivers || []).map(d => { const w = DRIVER_WORDS[d.driver]; if (!w) return null; return (d.effect >= 0 ? w.pos : w.neg); }).filter(Boolean); }

async function room({ cut = {}, horizon = null, stalledDays = 30 }) {
  const P = new engine.Params();
  const opps = await db.query(`SELECT o.*, c.name AS client_name, c.is_public FROM opportunities o LEFT JOIN clients c ON c.id=o.client_id WHERE o.outcome IS NULL ${engine.cutWhere(cut, { region: 'o.region', unit: 'o.unit', practice: 'o.practice', industry: 'o.industry', client: 'o.client_id', partner: 'o.partner_id', stage: 'o.stage' }, P)} ORDER BY o.value DESC`, P.values);
  const stages = ['Qualify', 'Propose', 'Negotiate', 'Verbal'];
  const funnel = stages.map(s => { const rows = opps.filter(o => o.stage === s); return { stage: s, count: rows.length, value: rows.reduce((a, o) => a + o.value, 0), weighted: rows.reduce((a, o) => a + o.value * o.win_prob, 0) }; });
  const weighted = opps.reduce((a, o) => a + o.value * o.win_prob, 0); const total = opps.reduce((a, o) => a + o.value, 0);
  // coverage against plan for the next two quarters (planned revenue needing new bookings ≈ plan − booked)
  const months = []; for (let m = engine.addMonths(engine.LAST_CLOSED, 1), i = 0; i < 6; i++, m = engine.addMonths(m, 1)) months.push(m);
  const P2 = new engine.Params();
  const planRows = await db.query(`SELECT SUM(pl.revenue_plan) AS plan FROM plan pl JOIN units u ON u.id=pl.unit WHERE pl.month = ANY(${P2.add(months)}) ${engine.cutWhere(cut, { region: 'u.region', unit: 'pl.unit' }, P2)}`, P2.values);
  const plan6 = planRows[0] && planRows[0].plan ? planRows[0].plan : null;
  const P3 = new engine.Params();
  const booked = await db.query(`SELECT COALESCE(SUM(GREATEST(0, e.budget_fees - COALESCE(x.billed,0))),0) AS booked FROM engagements e LEFT JOIN (SELECT engagement_id, SUM(billed) billed FROM engagement_months GROUP BY 1) x ON x.engagement_id=e.id WHERE e.status IN ('live','planned') ${engine.cutWhere(cut, engine.ENG_DIMS, P3)}`, P3.values);
  const need = plan6 !== null ? Math.max(0, plan6 - booked[0].booked) : null;
  const coverage = need ? weighted / need : null;
  const stalled = opps.filter(o => (new Date(engine.TODAY) - new Date(o.last_activity)) / 86400000 > stalledDays).sort((a, b) => b.value - a.value);
  const ranked = [...opps].sort((a, b) => b.win_prob * b.value - a.win_prob * a.value).slice(0, 12).map(o => ({ ...o, reasons: reasons(o.win_drivers), label: o.client_name || o.client_id, practice_name: ref.labelOf('practice', o.practice) }));
  const scope = composer.scopeLabel(cut).replace(/^, /, '') || 'The firm';
  const narrative = `${scope} has ${opps.length} open opportunities worth ${money(total)}, ${money(weighted)} weighted by win probability.` + (coverage !== null ? ` Against the ${money(need)} of the next two quarters' plan not yet covered by booked work, that is ${coverage.toFixed(1)}x coverage.` : '') + ` ${stalled.length} opportunities have not moved for ${stalledDays} days${stalled[0] ? `, the largest being ${stalled[0].id} (${stalled[0].client_name || stalled[0].client_id}, ${money(stalled[0].value)})` : ''}.` + (ranked[0] ? ` The most valuable likely win is ${ranked[0].id} (${ranked[0].label}, ${pct(ranked[0].win_prob, 0)}) because of ${listWords(ranked[0].reasons.slice(0, 3))}.` : '');
  return { agent: 'Pipeline and Win Agent', model: { id: 3, name: 'Win probability', version: '1.0-seed' }, funnel, total, weighted, plan6, booked: booked[0].booked, need, coverage, stalled: stalled.slice(0, 10), ranked, narrative, spoken: `${scope} has ${money(weighted)} of weighted pipeline${coverage !== null ? `, ${coverage.toFixed(1)} times the uncovered plan for the next two quarters` : ''}. ${stalled.length} deals are stalled. Ask me which large deals have not moved.`,
    visual: { type: 'funnel', title: `Pipeline by stage${composer.scopeLabel(cut)}`, subtitle: 'Open opportunities, value and weighted value', stages: funnel, format: 'money', seeded: true, lineage: lineage(cut) },
    table: composer.table('Opportunities ranked by expected value', 'Win probability with reasons', [['id', 'Opportunity'], ['label', 'Client'], ['practice_name', 'Practice'], ['stage', 'Stage'], ['value', 'Value', 'money'], ['win_prob', 'Win probability', 'pct'], ['reasons', 'Reasons']], ranked, lineage(cut)),
    followUps: ['Which large deals have not moved for 30 days?', 'What is our pipeline coverage for Q1 in Europe?', 'Show win rate by practice for the last year'] };
}
async function stalledDeals({ cut = {}, days = 30 }) { const r = await room({ cut, stalledDays: days }); const rows = r.stalled.map(o => ({ ...o, label: o.client_name || o.client_id, days_idle: Math.round((new Date(engine.TODAY) - new Date(o.last_activity)) / 86400000), practice_name: ref.labelOf('practice', o.practice) })); return { ...r, narrative: `${rows.length} opportunities${composer.scopeLabel(cut)} have had no activity for more than ${days} days, worth ${money(rows.reduce((a, o) => a + o.value, 0))}. ${rows[0] ? `The largest is ${rows[0].id} (${rows[0].label}, ${money(rows[0].value)}, idle ${rows[0].days_idle} days).` : ''}`, spoken: `${rows.length} deals have stalled for more than ${days} days. The largest is ${rows[0] ? rows[0].id : 'none'}.`, table: composer.table('Stalled opportunities', `No activity for ${days}+ days`, [['id', 'Opportunity'], ['label', 'Client'], ['practice_name', 'Practice'], ['stage', 'Stage'], ['value', 'Value', 'money'], ['win_prob', 'Win probability', 'pct'], ['days_idle', 'Days idle']], rows, lineage(cut)), visual: null }; }
async function likelyToClose({ cut = {}, quarterEnd = '2026-12-01' }) {
  const P = new engine.Params();
  const opps = await db.query(`SELECT o.*, c.name AS client_name FROM opportunities o LEFT JOIN clients c ON c.id=o.client_id WHERE o.outcome IS NULL AND o.expected_close <= ${P.add(quarterEnd)}::date + 30 ${engine.cutWhere(cut, { region: 'o.region', unit: 'o.unit', practice: 'o.practice', industry: 'o.industry', client: 'o.client_id', partner: 'o.partner_id' }, P)} ORDER BY o.win_prob DESC LIMIT 15`, P.values);
  const rows = opps.map(o => ({ ...o, label: o.client_name || o.client_id, reasons: reasons(o.win_drivers), practice_name: ref.labelOf('practice', o.practice) }));
  return { agent: 'Pipeline and Win Agent', model: { id: 3, name: 'Win probability' }, rows, narrative: `${rows.length} opportunities${composer.scopeLabel(cut)} are expected to close this quarter. ${rows[0] ? `${rows[0].id} (${rows[0].label}) is the most likely at ${pct(rows[0].win_prob, 0)}, because of ${listWords(rows[0].reasons.slice(0, 3))}.` : ''} Expected value: ${money(rows.reduce((a, o) => a + o.value * o.win_prob, 0))}.`, spoken: `${rows[0] ? rows[0].id + ' is the most likely to close at ' + pct(rows[0].win_prob, 0) : 'No opportunities close this quarter'}.`, table: composer.table('Most likely to close this quarter', '', [['id', 'Opportunity'], ['label', 'Client'], ['practice_name', 'Practice'], ['stage', 'Stage'], ['value', 'Value', 'money'], ['win_prob', 'Win probability', 'pct'], ['expected_close', 'Expected close'], ['reasons', 'Reasons']], rows, lineage(cut)), visual: null, followUps: ['Which large deals have not moved for 30 days?', 'Show my pipeline coverage', 'Forecast revenue to year end'] };
}
function lineage(cut) { return { metric: 'win_probability', name: 'Win probability', formula: 'Calibrated classifier on stage, age, fee against typical, relationship strength, prior work and partner record', owner: 'Chief Commercial Officer', source_system: 'Salesforce', stub: 'stub:salesforce', tables: ['opportunities', 'plan', 'engagements'], filters: cut, model: 'Win probability v1.0-seed (AUC 0.79)', seeded: true, refreshed_at: engine.TODAY + 'T05:30:00Z' }; }
module.exports = { room, stalledDeals, likelyToClose, reasons };
