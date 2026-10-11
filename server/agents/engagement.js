'use strict';
/**
 * Engagement Health Agent (models 4 and 5): budget overrun, margin at completion and write-off risk for live engagements.
 */
const db = require('../db');
const engine = require('../metrics/engine');
const ref = require('../metrics/refcache');
const composer = require('./composer');
const { money, pct, dateLabel, listWords } = require('./util');

async function board({ cut = {}, limit = 15 }) {
  const rows = (await engine.engagementList(cut, 'live')).map(e => ({ ...e, burn: e.budget_hours ? e.hours_to_date / e.budget_hours : null, practice_name: ref.labelOf('practice', e.practice), unit_name: ref.labelOf('unit', e.unit), drivers: driversFor(e) }));
  rows.sort((a, b) => (b.overrun_prob || 0) - (a.overrun_prob || 0));
  const top = rows.slice(0, limit);
  const atRisk = rows.filter(e => e.overrun_prob >= 0.5);
  const scope = composer.scopeLabel(cut).replace(/^, /, '') || 'the firm';
  const narrative = `${rows.length} live engagements in ${scope}; ${atRisk.length} have an overrun probability above 50%. ` + (top[0] ? `${top[0].id} (${top[0].client_name}, ${top[0].fee_model === 'fixed' ? 'fixed fee' : 'time and materials'}) is the most at risk at ${pct(top[0].overrun_prob, 0)}: burn ${pct(top[0].burn, 0)} of budget hours at ${pct(top[0].elapsed, 0)} of elapsed time, predicted overrun ${top[0].predicted_overrun_date ? dateLabel(top[0].predicted_overrun_date) : 'not before completion'}, margin at completion ${pct(top[0].margin_at_completion, 0)}. ` : '') + (atRisk.length > 1 ? `Also at risk: ${listWords(atRisk.slice(1, 4).map(e => `${e.id} (${pct(e.overrun_prob, 0)}, ${e.predicted_overrun_date ? dateLabel(e.predicted_overrun_date) : 'date not set'})`))}.` : '');
  const spoken = top[0] ? `${atRisk.length} engagements are likely to overrun. ${top[0].id} is first, at ${pct(top[0].overrun_prob, 0)}, ${top[0].predicted_overrun_date ? 'around ' + dateLabel(top[0].predicted_overrun_date) : 'before completion'}. Ask what to do about it.` : 'No live engagements in this scope.';
  return { agent: 'Engagement Health Agent', model: { id: 4, name: 'Engagement overrun', version: '1.0-seed' }, engagements: top, atRisk: atRisk.length, narrative, spoken,
    visual: { type: 'scatter', title: `Engagement health${composer.scopeLabel(cut)}`, subtitle: 'Burn against elapsed time; size = budget; colour = overrun probability', points: top.map(e => ({ id: e.id, x: e.elapsed, y: e.burn, size: e.budget_fees, prob: e.overrun_prob, label: `${e.id} · ${e.client_name}` })), format: 'pct', seeded: true, lineage: lineage(cut) },
    table: composer.table('Live engagements by overrun risk', '', [['id', 'Engagement'], ['client_name', 'Client'], ['unit_name', 'Unit'], ['fee_model', 'Fee model'], ['health_score', 'Health'], ['burn', 'Burn', 'pct'], ['elapsed', 'Elapsed', 'pct'], ['overrun_prob', 'Overrun probability', 'pct'], ['predicted_overrun_date', 'Predicted overrun'], ['realisation_forecast', 'Realisation forecast', 'pct'], ['margin_at_completion', 'Margin at completion', 'pct']], top, lineage(cut)),
    followUps: [top[0] ? `Show the burn-down for ${top[0].id}` : 'Show my engagements', 'What should I do about it?', top[0] ? `If I add one Associate for four weeks on ${top[0].id}, what happens to my margin?` : 'Show realisation by unit'] };
}
function driversFor(e) {
  const d = [];
  if (e.budget_hours && e.hours_to_date / e.budget_hours > e.elapsed + 0.05) d.push(`Burn ${pct(e.hours_to_date / e.budget_hours, 0)} ahead of ${pct(e.elapsed, 0)} elapsed`);
  if (e.scope_changes > 0) d.push(`${e.scope_changes} scope change${e.scope_changes > 1 ? 's' : ''}`);
  if (e.fee_model === 'fixed') d.push('Fixed fee: overrun hours are unbillable');
  if (e.write_off_risk > 0.3) d.push(`Write-off risk ${pct(e.write_off_risk, 0)}`);
  return d.length ? d : ['Burn in line with elapsed time'];
}
async function burndown(engagementId) {
  const e = (await engine.engagementList({ engagement: engagementId }, null))[0];
  if (!e) return null;
  const months = await db.query('SELECT month, hours, standard_value, billed, write_off, overrun_unbilled, discount FROM engagement_months WHERE engagement_id=$1 ORDER BY month', [engagementId]);
  let cum = 0; const actual = months.map(m => { cum += m.hours; return { month: m.month, value: cum }; });
  const rate = cum / Math.max(1, months.length);
  const forecast = []; const endM = engine.monthOf(e.end_date); let f = cum; let m = engine.addMonths(engine.LAST_CLOSED, 1);
  for (let i = 0; i < 8 && m <= engine.addMonths(endM, 2); i++, m = engine.addMonths(m, 1)) { f += rate * (e.overrun_prob > 0.5 ? 1.05 : 0.95); forecast.push({ month: m, p50: f, p10: f * (1 - 0.06 * Math.sqrt(i + 1)), p90: f * (1 + 0.06 * Math.sqrt(i + 1)) }); }
  const ws = (e.workstreams || []).map(w => ({ name: w.name, hours: cum * w.share, budget: e.budget_hours * w.share, burn: (cum * w.share) / (e.budget_hours * w.share) * (1 + ((w.name.length % 3) - 1) * 0.08) }));
  const narrative = `${e.id} (${e.client_name}, ${ref.labelOf('practice', e.practice)}, ${e.fee_model === 'fixed' ? 'fixed fee' : 'time and materials'}) has consumed ${pct(cum / e.budget_hours, 0)} of its ${Math.round(e.budget_hours).toLocaleString()} budget hours at ${pct(e.elapsed, 0)} of elapsed time. At the current burn rate the budget is exhausted ${e.predicted_overrun_date ? 'around ' + dateLabel(e.predicted_overrun_date) : 'after the planned end date'}; the estimate at completion is ${money(e.eac)} against a budget cost of ${money(e.budget_hours * e.standard_rate * 0.42)}, giving a margin at completion of ${pct(e.margin_at_completion, 0)}.${ws.length ? ` ${ws.sort((a, b) => b.burn - a.burn)[0].name} is the workstream burning fastest.` : ''}`;
  return { agent: 'Engagement Health Agent', model: { id: 4, name: 'Engagement overrun' }, engagement: e, actual, forecast, workstreams: ws, narrative, spoken: narrative,
    visual: { type: 'burndown', title: `${e.id} burn against budget`, subtitle: `${e.client_name}; budget ${Math.round(e.budget_hours).toLocaleString()} hours`, x: [...actual.map(a => a.month), ...forecast.map(f => f.month)].map(m => require('./util').monthLabel(m)), actual: [...actual.map(a => a.value), ...forecast.map(() => null)], p50: [...actual.map(() => null), ...forecast.map(f => f.p50)], p10: [...actual.map(() => null), ...forecast.map(f => f.p10)], p90: [...actual.map(() => null), ...forecast.map(f => f.p90)], budget: e.budget_hours, splitIndex: actual.length, format: 'number', seeded: true, lineage: lineage({ engagement: engagementId }) },
    table: composer.table('Workstreams', 'Hours against budget', [['name', 'Workstream'], ['hours', 'Hours', 'number'], ['budget', 'Budget hours', 'number'], ['burn', 'Burn', 'pct']], ws, lineage({ engagement: engagementId })),
    followUps: ['What should I do about it?', `If I add one Associate for four weeks, what happens to my margin?`, 'Which of my engagements will overrun budget, and by when?'] };
}
async function willItGetWorse({ engagements, cut = {} }) {
  const ids = engagements && engagements.length ? engagements : null;
  const rows = (await engine.engagementList(ids ? { engagement: ids } : cut, 'live')).map(e => ({ ...e, burn: e.budget_hours ? e.hours_to_date / e.budget_hours : null, drivers: driversFor(e) }));
  rows.sort((a, b) => (b.overrun_prob || 0) - (a.overrun_prob || 0));
  const worse = rows.filter(e => e.overrun_prob >= 0.5);
  const narrative = worse.length ? `Yes for ${worse.length} of the ${rows.length} engagements. ${listWords(worse.slice(0, 3).map(e => `${e.id} (${pct(e.overrun_prob, 0)} overrun probability, predicted ${e.predicted_overrun_date ? dateLabel(e.predicted_overrun_date) : 'before completion'}, realisation forecast ${pct(e.realisation_forecast, 0)})`))}. ${rows.length - worse.length ? `The other ${rows.length - worse.length} are forecast to finish within budget.` : ''}` : `No: all ${rows.length} engagements are forecast to finish within budget.`;
  return { agent: 'Engagement Health Agent', model: { id: 4, name: 'Engagement overrun' }, engagements: rows.slice(0, 10), narrative, spoken: worse.length ? `Yes. ${worse[0].id} is forecast to overrun ${worse[0].predicted_overrun_date ? 'around ' + dateLabel(worse[0].predicted_overrun_date) : 'before completion'}, with ${pct(worse[0].overrun_prob, 0)} probability. Ask what to do about it.` : 'No, the engagements are forecast to finish within budget.',
    visual: { type: 'bar', title: 'Overrun probability', subtitle: 'Probability of exceeding budget hours before completion', x: rows.slice(0, 10).map(e => `${e.id} · ${e.client_name}`), keys: rows.slice(0, 10).map(e => e.id), dim: 'engagement', series: [{ name: 'Overrun probability', data: rows.slice(0, 10).map(e => e.overrun_prob) }], format: 'pct', horizontal: true, seeded: true, lineage: lineage(cut) },
    table: composer.table('Engagement forecast', '', [['id', 'Engagement'], ['client_name', 'Client'], ['fee_model', 'Fee model'], ['burn', 'Burn', 'pct'], ['elapsed', 'Elapsed', 'pct'], ['overrun_prob', 'Overrun probability', 'pct'], ['predicted_overrun_date', 'Predicted overrun'], ['realisation_forecast', 'Realisation forecast', 'pct'], ['margin_at_completion', 'Margin at completion', 'pct'], ['drivers', 'Drivers']], rows.slice(0, 10), lineage(cut)),
    followUps: ['What should I do about it?', worse[0] ? `Show the burn-down for ${worse[0].id}` : 'Show realisation by unit', 'Open the action centre'] };
}
function lineage(cut) { return { metric: 'engagement_overrun', name: 'Engagement overrun', formula: 'Quantile regression on burn rate, elapsed time, scope changes, team mix and similar past engagements', owner: 'Chief Financial Officer', source_system: 'IEM, SAP, staffing plan', stub: 'stub:iem + stub:sap', tables: ['engagements', 'engagement_months'], filters: cut, model: 'Engagement overrun v1.0-seed; Write-off risk v1.0-seed', seeded: true, refreshed_at: engine.TODAY + 'T05:30:00Z' }; }
module.exports = { board, burndown, willItGetWorse };
