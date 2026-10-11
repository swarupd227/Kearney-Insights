'use strict';
/**
 * Scenario Agent: what-if simulations on the profit-per-partner driver model.
 * profit per partner = margin × revenue per professional × leverage. Every assumption is listed with the result.
 */
const db = require('../db');
const engine = require('../metrics/engine');
const ref = require('../metrics/refcache');
const composer = require('./composer');
const { money, pct, pts, dateLabel } = require('./util');

async function baseline(cut) {
  const p = engine.periodFor('ltm');
  const [em, ppl, util] = await Promise.all([engine.emAgg(cut, p, null), engine.pplAgg(cut, null), engine.pmAgg(cut, p, null)]);
  const E = em[0], P = ppl[0], U = util[0];
  const revenue = E.billed, std = E.std, staffCost = E.staff_cost, unrec = E.unrecovered;
  const overhead = P.bs * 25000 * 12;
  const realisation = E.billed / E.std; const utilisation = U.chargeable / U.available;
  const partners = P.partners, professionals = P.professionals, cs = P.cs;
  const profit = revenue - staffCost - unrec - overhead;
  return { period: p, revenue, std, hours: E.hours, staffCost, unrec, overhead, realisation, utilisation, partners, professionals, cs, profit, ppp: profit / partners, margin: (revenue - staffCost - unrec) / revenue, rpp: revenue / cs, leverage: professionals / partners, costPerHour: staffCost / E.hours, revPerHour: revenue / E.hours };
}
function apply(b, s) {
  const a = { ...b, assumptions: [] };
  let revenue = b.revenue, hours = b.hours, staffCost = b.staffCost, partners = b.partners, professionals = b.professionals, cs = b.cs, utilisation = b.utilisation, realisation = b.realisation;
  if (s.rate_pct) { revenue *= 1 + s.rate_pct / 100; a.assumptions.push(`Billing rates ${s.rate_pct > 0 ? '+' : ''}${s.rate_pct}% from ${s.start ? dateLabel(s.start) : 'the next engagement start'}; volume, realisation and cost unchanged (no demand response assumed)`); }
  if (s.util_points) { const f = (utilisation + s.util_points / 100) / utilisation; revenue *= f; hours *= f; utilisation += s.util_points / 100; a.assumptions.push(`Chargeable utilisation ${s.util_points > 0 ? '+' : ''}${s.util_points} points; chargeable hours and revenue scale with it; staff cost fixed`); }
  if (s.realisation_points) { revenue *= (realisation + s.realisation_points / 100) / realisation; realisation += s.realisation_points / 100; a.assumptions.push(`Billing realisation +${s.realisation_points} points on the same standard value; cost unchanged`); }
  if (s.hiring_freeze) { const share = { BA: 0.218, ASSOCIATE: 0.31, MANAGER: 0.21, PRINCIPAL: 0.13, AP: 0.06 }[s.hiring_freeze.level] || 0.3; const attritionQ = 0.035; const lost = Math.round(professionals * share * attritionQ * s.hiring_freeze.quarters); professionals -= lost; cs -= lost; const capF = (cs + lost) ? cs / (cs + lost) : 1; revenue *= 1 - (1 - capF) * 0.6; staffCost *= capF; hours *= capF; a.assumptions.push(`${ref.labelOf('level', s.hiring_freeze.level)} hiring frozen for ${s.hiring_freeze.quarters} quarter${s.hiring_freeze.quarters > 1 ? 's' : ''}: ${lost} fewer professionals through natural attrition (3.5% a quarter); 60% of the lost capacity would have been chargeable`); }
  if (s.fx_pct) { revenue *= 1 + s.fx_pct / 100 * 0.6; a.assumptions.push(`FX move of ${s.fx_pct}% on the 60% of revenue outside US dollars`); }
  if (s.fixed_fee_shift_pct) { revenue *= 1 - s.fixed_fee_shift_pct / 100 * 0.02; a.assumptions.push(`${s.fixed_fee_shift_pct}% of fees shift to fixed fee; realisation on that share falls by 2 points (from the overrun history)`); }
  const unrec = b.unrec * (revenue / b.revenue);
  const profit = revenue - staffCost - unrec - b.overhead;
  Object.assign(a, { revenue, hours, staffCost, unrec, partners, professionals, cs, utilisation, realisation, profit, ppp: profit / partners, margin: (revenue - staffCost - unrec) / revenue, rpp: revenue / cs, leverage: professionals / partners });
  return a;
}
async function run({ cut = {}, scenario, label }) {
  const b = await baseline(cut);
  const s = apply(b, scenario);
  const scope = composer.scopeLabel(cut).replace(/^, /, '') || 'the firm';
  const d = (k) => s[k] - b[k];
  const rows = [['Revenue', 'revenue', 'money'], ['Contribution margin', 'margin', 'pct'], ['Revenue per professional', 'rpp', 'money'], ['Leverage', 'leverage', 'ratio'], ['Utilisation', 'utilisation', 'pct'], ['Billing realisation', 'realisation', 'pct'], ['Profit per partner', 'ppp', 'money']].map(([name, k, f]) => ({ metric: name, baseline: b[k], scenario: s[k], change: d(k), format: f }));
  const narrative = `Scenario for ${scope} (${label || describe(scenario)}), on a baseline of the last twelve months: profit per partner moves from ${money(b.ppp)} to ${money(s.ppp)} (${pct(s.ppp / b.ppp - 1)}), revenue from ${money(b.revenue)} to ${money(s.revenue)}, margin from ${pct(b.margin)} to ${pct(s.margin)} (${pts(s.margin - b.margin)}), ${[['leverage', b.leverage.toFixed(1), s.leverage.toFixed(1)], ['utilisation', pct(b.utilisation), pct(s.utilisation)]].filter(x => x[1] !== x[2]).map(x => `${x[0]} ${x[1]} to ${x[2]}`).concat([['leverage', b.leverage.toFixed(1), s.leverage.toFixed(1)], ['utilisation', pct(b.utilisation), pct(s.utilisation)]].filter(x => x[1] === x[2]).length ? [[['leverage', b.leverage.toFixed(1), s.leverage.toFixed(1)], ['utilisation', pct(b.utilisation), pct(s.utilisation)]].filter(x => x[1] === x[2]).map(x => x[0]).join(' and ') + ' unchanged'] : []).join(', ')}. Assumptions: ${s.assumptions.join('; ')}.`;
  const spoken = `Profit per partner in ${scope} would move ${pct(s.ppp / b.ppp - 1)}, to ${money(s.ppp)}. Margin ${pts(s.margin - b.margin)}. The main assumption is ${s.assumptions[0] ? s.assumptions[0].split(';')[0].toLowerCase() : 'none'}. Every assumption is listed on screen.`;
  const steps = [{ label: 'Baseline', value: b.ppp, kind: 'start' }, { label: 'Scenario effect', value: s.ppp - b.ppp, kind: 'delta' }, { label: 'Scenario', value: s.ppp, kind: 'end' }];
  return { agent: 'Scenario Agent', baseline: b, scenario: s, assumptions: s.assumptions, rows, narrative, spoken, visual: { type: 'scenario', title: `Scenario: ${label || describe(scenario)}`, subtitle: `${scope}; baseline = last twelve months`, rows, seeded: true, lineage: lineage(cut) }, visual2: composer.waterfall('Profit per partner', 'Baseline to scenario', steps, 'money', lineage(cut)), followUps: ['Compare a 2% rate increase with a 5-point improvement in realisation', 'What happens to profit per partner if utilisation drops 3 points?', 'Freeze Associate hiring in Europe for two quarters'] };
}
async function compare({ cut = {}, scenarios }) {
  const b = await baseline(cut);
  const results = scenarios.map(sc => ({ label: sc.label, result: apply(b, sc.scenario) }));
  const scope = composer.scopeLabel(cut).replace(/^, /, '') || 'the firm';
  const narrative = `Compared on ${scope}: ${results.map(r => `${r.label} lifts profit per partner by ${pct(r.result.ppp / b.ppp - 1)} to ${money(r.result.ppp)} (margin ${pts(r.result.margin - b.margin)})`).join('; ')}. ${results.sort((x, y) => y.result.ppp - x.result.ppp)[0].label} is the larger effect.`;
  const rows = [['Revenue', 'revenue', 'money'], ['Contribution margin', 'margin', 'pct'], ['Leverage', 'leverage', 'ratio'], ['Utilisation', 'utilisation', 'pct'], ['Billing realisation', 'realisation', 'pct'], ['Profit per partner', 'ppp', 'money']].map(([name, k, f]) => ({ metric: name, baseline: b[k], format: f, ...Object.fromEntries(results.map(r => [r.label, r.result[k]])) }));
  return { agent: 'Scenario Agent', baseline: b, results, narrative, spoken: narrative, visual: { type: 'scenario', title: 'Scenario comparison', subtitle: `${scope}; baseline = last twelve months`, rows, scenarios: results.map(r => r.label), seeded: true, lineage: lineage(cut) }, assumptions: results.flatMap(r => r.result.assumptions.map(a => `${r.label}: ${a}`)), followUps: ['What would a 3% rate increase in North America do to profit per partner?', 'Freeze Associate hiring in Europe for two quarters', 'Show the profit-per-partner driver tree'] };
}
async function engagementStaffing({ engagementId, add, remove }) {
  const e = (await engine.engagementList({ engagement: engagementId }, null))[0]; if (!e) return null;
  const lvl = ref.get().levels.find(l => l.id === (add || remove).level) || ref.get().levels.find(l => l.id === 'ASSOCIATE');
  const factor = (ref.get().unitById[e.unit] ? ({ NA: 1.25, DACH: 1.15, UKI: 1.15, ME: 1.3, IND: 0.38 }[e.unit] || 1) : 1);
  const hours = (add ? add.count * add.weeks : -remove.count * remove.weeks) * 45;
  const cost = hours * lvl.cost_rate * factor;
  const extraFees = e.fee_model === 'fixed' ? 0 : hours * lvl.standard_rate * factor * 0.85;
  const fees = e.fee_model === 'fixed' ? e.budget_fees : Math.min(e.budget_fees * 1.15, e.std_to_date + Math.max(0, e.budget_hours - e.hours_to_date) * e.standard_rate) * 0.88;
  const eacNew = e.eac + cost; const marginNew = (fees + extraFees - eacNew - fees * 0.02) / (fees + extraFees);
  const rate = e.hours_to_date / Math.max(1, Math.round((new Date(engine.TODAY) - new Date(e.start_date)) / (30 * 86400000)));
  const daysShift = add ? -Math.round(hours / Math.max(1, rate) * 30 * 0.8) : Math.round(-hours / Math.max(1, rate) * 30 * 0.8);
  const narrative = `${add ? `Adding ${add.count} ${lvl.name}${add.count > 1 ? 's' : ''} for ${add.weeks} weeks` : `Rolling off ${remove.count} ${lvl.name}${remove.count > 1 ? 's' : ''} ${remove.weeks} weeks early`} on ${e.id} (${e.client_name}, ${e.fee_model === 'fixed' ? 'fixed fee' : 'time and materials'}): ${Math.abs(hours).toLocaleString()} ${add ? 'additional' : 'fewer'} hours at a loaded cost of ${money(Math.abs(cost))}. ${e.fee_model === 'fixed' ? 'On a fixed fee no extra fees are billable, so ' : `About ${money(Math.abs(extraFees))} of ${add ? 'extra' : 'lost'} fees at 85% realisation, so `}margin at completion moves from ${pct(e.margin_at_completion)} to ${pct(marginNew)} (${pts(marginNew - e.margin_at_completion)}) and the estimate at completion from ${money(e.eac)} to ${money(eacNew)}. The delivery date moves ${daysShift < 0 ? 'earlier' : 'later'} by about ${Math.abs(daysShift)} days${remove ? ' and the product flags a delivery risk on the ' + (e.workstreams || [{ name: 'main' }])[0].name + ' workstream' : ''}.`;
  return { agent: 'Scenario Agent', engagement: e, result: { hours, cost, extraFees, eacNew, marginNew, daysShift }, assumptions: [`${lvl.name} at ${money(lvl.standard_rate * factor)}/hour standard, ${money(lvl.cost_rate * factor)}/hour cost`, '45 chargeable hours a week', e.fee_model === 'fixed' ? 'Fixed fee: no incremental billing' : 'Time and materials: 85% realisation on added hours', 'Burn rate from hours to date'], narrative, spoken: `Margin at completion would move ${pts(marginNew - e.margin_at_completion)} to ${pct(marginNew)}, and delivery about ${Math.abs(daysShift)} days ${daysShift < 0 ? 'earlier' : 'later'}.`, visual: { type: 'scenario', title: `${e.id}: staffing what-if`, subtitle: e.client_name, rows: [{ metric: 'Estimate at completion', baseline: e.eac, scenario: eacNew, change: cost, format: 'money' }, { metric: 'Margin at completion', baseline: e.margin_at_completion, scenario: marginNew, change: marginNew - e.margin_at_completion, format: 'pct' }, { metric: 'Delivery date shift (days)', baseline: 0, scenario: daysShift, change: daysShift, format: 'number' }], seeded: true, lineage: lineage({ engagement: engagementId }) }, followUps: ['Which of my engagements will overrun budget, and by when?', 'What should I do about it?', `Show the burn-down for ${e.id}`] };
}
function describe(s) { const parts = []; if (s.rate_pct) parts.push(`rates ${s.rate_pct > 0 ? '+' : ''}${s.rate_pct}%`); if (s.util_points) parts.push(`utilisation ${s.util_points > 0 ? '+' : ''}${s.util_points} pts`); if (s.realisation_points) parts.push(`realisation +${s.realisation_points} pts`); if (s.hiring_freeze) parts.push(`${ref.labelOf('level', s.hiring_freeze.level)} hiring freeze, ${s.hiring_freeze.quarters} quarters`); if (s.fx_pct) parts.push(`FX ${s.fx_pct}%`); if (s.fixed_fee_shift_pct) parts.push(`fee mix shift ${s.fixed_fee_shift_pct}%`); return parts.join(', ') || 'no change'; }
function lineage(cut) { return { metric: 'scenario', name: 'Scenario (driver model)', formula: 'Profit per partner = margin × revenue per professional × leverage; overhead from business-services headcount', owner: 'Chief Financial Officer', source_system: 'SAP, IEM, PeopleSoft/Workday, Anaplan', stub: 'stub:sap + stub:iem + stub:peoplesoft', tables: ['engagement_months', 'person_months', 'people'], filters: cut, model: 'Driver model on forecast baseline; scenarios saved per user', seeded: true, refreshed_at: engine.TODAY + 'T05:30:00Z' }; }
module.exports = { run, compare, engagementStaffing, baseline, describe };
