'use strict';
/**
 * Variance Agent: explains why a metric moved by splitting the change into its drivers and naming the largest contributors.
 * Realisation: rate discounts, write-offs, fixed-fee overruns, billing delays (exact decomposition).
 * Revenue against plan: volume and realisation effects by unit (exact decomposition).
 * Utilisation: demand (chargeable hours) and capacity (available hours) effects.
 * Profit per partner: margin, revenue per professional and leverage (log decomposition).
 * Any other metric: ranked member contributions.
 */
const db = require('../db');
const engine = require('../metrics/engine');
const ref = require('../metrics/refcache');
const composer = require('./composer');
const { money, pct, pts, listWords } = require('./util');

async function explain({ metricId, cut = {}, period, comparePeriod, compare = 'prior', by = null }) {
  const p = typeof period === 'string' || !period ? engine.periodFor(period || 'last_quarter') : period;
  const pA = comparePeriod || (compare === 'plan' ? null : compare === 'ly' ? engine.priorYear(p) : engine.priorPeriod(p));
  switch (metricId) {
    case 'billing_realisation': return realisation(cut, pA, p);
    case 'net_fee_revenue': case 'plan_attainment': return compare === 'plan' || metricId === 'plan_attainment' ? (by && by !== 'unit' ? revenueVsPlanBy(cut, p, by) : revenueVsPlan(cut, p)) : revenueVsPeriod(cut, pA, p);
    case 'utilisation': return utilisation(cut, pA, p);
    case 'profit_per_partner': return profitPerPartner(cut, pA, p);
    case 'contribution_margin': return margin(cut, pA, p);
    default: return generic(metricId, cut, pA, p);
  }
}

async function realisation(cut, pA, pB) {
  const [a, b] = await Promise.all([engine.emAgg(cut, pA, null), engine.emAgg(cut, pB, null)]);
  const A = a[0], B = b[0];
  if (!A || !B || !A.std || !B.std) return empty('billing_realisation', cut, pB);
  // exact: realisation = 1 - (discount + write_off + overrun + delayed - carry)/std, where carry = billed - (std - discount - write_off - overrun - delayed)
  const parts = r => { const carry = r.billed - (r.std - r.discount - r.write_off - r.overrun - r.delayed); return { 'Rate discounts': r.discount / r.std, 'Write-offs': r.write_off / r.std, 'Fixed-fee overruns': r.overrun / r.std, 'Billing delays': (r.delayed - carry) / r.std }; };
  const PA = parts(A), PB = parts(B);
  const realA = A.billed / A.std, realB = B.billed / B.std;
  const steps = [{ label: `${pA.label}`, value: realA, kind: 'start' }];
  const drivers = [];
  for (const k of Object.keys(PA)) { const effect = -(PB[k] - PA[k]); steps.push({ label: k, value: effect, kind: 'delta' }); drivers.push({ driver: k, effect, share_before: PA[k], share_after: PB[k] }); }
  steps.push({ label: `${pB.label}`, value: realB, kind: 'end' });
  // engagement contributors: change in each engagement's loss share of the total standard value
  const [ea, eb] = await Promise.all([engine.emAgg(cut, pA, 'engagement'), engine.emAgg(cut, pB, 'engagement')]);
  const lossA = Object.fromEntries(ea.map(r => [r.key, (r.std - r.billed)]));
  const contributors = eb.map(r => { const lossB = r.std - r.billed; const c = (lossB / B.std) - ((lossA[r.key] || 0) / A.std); return { engagement: r.key, contribution: -c, loss_share_b: lossB / B.std, std: r.std, billed: r.billed, realisation: r.billed / r.std, discount: r.discount, write_off: r.write_off, overrun: r.overrun }; }).sort((x, y) => x.contribution - y.contribution).slice(0, 6);
  const ids = contributors.map(c => c.engagement);
  const meta = ids.length ? await db.query(`SELECT e.id, e.fee_model, e.partner_id, e.principal_id, e.status, e.overrun_prob, e.predicted_overrun_date, e.practice, c.name AS client_name, c.is_public FROM engagements e JOIN clients c ON c.id=e.client_id WHERE e.id = ANY($1)`, [ids]) : [];
  const mm = Object.fromEntries(meta.map(r => [r.id, r]));
  contributors.forEach(c => Object.assign(c, mm[c.engagement] || {}));
  const topShare = contributors.slice(0, 3).reduce((s, c) => s + c.contribution, 0) / (realB - realA || 1);
  drivers.sort((x, y) => x.effect - y.effect);
  const worst = drivers.filter(d => d.effect < -0.002);
  const narrative = `Billing realisation${composer.scopeLabel(cut)} moved from ${pct(realA)} in ${pA.label} to ${pct(realB)} in ${pB.label}, ${pts(realB - realA)}. ` +
    (worst.length ? `The decline splits into ${listWords(worst.map(d => `${d.driver.toLowerCase()} (${pts(d.effect)})`))}. ` : 'No driver moved materially. ') +
    (contributors.length ? `Three engagements explain ${pct(Math.min(1, Math.abs(topShare)), 0)} of the change: ${listWords(contributors.slice(0, 3).map(c => `${c.engagement} (${c.client_name || 'client'}, ${c.fee_model === 'fixed' ? 'fixed fee' : c.fee_model === 'tm' ? 'time and materials' : 'value-based'}, realisation ${pct(c.realisation, 0)})`))}.` : '');
  const spoken = `Realisation${composer.scopeLabel(cut)} fell ${pts(realB - realA)} to ${pct(realB)}. ${worst[0] ? worst[0].driver + ' is the largest driver' : 'No single driver dominates'}, and ${contributors[0] ? contributors[0].engagement + ' contributes most' : 'no engagement stands out'}. Ask me whether it will get worse.`;
  return {
    agent: 'Variance Agent', metric: 'billing_realisation', from: { period: pA, value: realA }, to: { period: pB, value: realB }, delta: realB - realA,
    drivers, contributors, narrative, spoken,
    visual: composer.waterfall(`Realisation bridge${composer.scopeLabel(cut)}`, `${pA.label} to ${pB.label}`, steps, 'pct', lineageFor('billing_realisation', cut, pB, ['engagement_months', 'engagements'])),
    table: composer.table('Largest contributors', 'Change in loss share of standard value', [['engagement', 'Engagement'], ['client_name', 'Client'], ['fee_model', 'Fee model'], ['realisation', 'Realisation', 'pct'], ['contribution', 'Contribution', 'pts'], ['overrun_prob', 'Overrun probability', 'pct'], ['predicted_overrun_date', 'Predicted overrun']], contributors, lineageFor('billing_realisation', cut, pB, ['engagement_months'])),
    followUps: ['Will it get worse?', 'What should I do about it?', `Show realisation by unit for ${pB.label}`]
  };
}

async function revenueVsPlan(cut, p) {
  // Decompose actual - plan by unit into volume (standard value) and realisation effects, with prior-year realisation as plan realisation.
  const pLY = engine.priorYear(p);
  const [cur, ly, planRows] = await Promise.all([engine.emAgg(cut, p, 'unit'), engine.emAgg(cut, pLY, 'unit'), planByUnit(cut, p)]);
  const lyMap = Object.fromEntries(ly.map(r => [r.key, r]));
  const units = cur.map(r => {
    const plan = planRows[r.key] || 0; const l = lyMap[r.key]; const realPlan = l && l.std ? l.billed / l.std : 0.9; const realAct = r.std ? r.billed / r.std : realPlan;
    const stdPlan = plan / realPlan; const volume = (r.std - stdPlan) * realPlan; const realisation = r.std * (realAct - realPlan);
    return { unit: r.key, label: ref.labelOf('unit', r.key), actual: r.billed, plan, gap: r.billed - plan, attainment: plan ? r.billed / plan : null, volume_effect: volume, realisation_effect: realisation, realisation: realAct, realisation_plan: realPlan };
  }).sort((a, b) => a.gap - b.gap);
  const totalActual = units.reduce((s, u) => s + u.actual, 0), totalPlan = units.reduce((s, u) => s + u.plan, 0);
  const gap = totalActual - totalPlan;
  const behind = units.filter(u => u.gap < 0);
  const steps = [{ label: 'Plan', value: totalPlan, kind: 'start' }];
  for (const u of units.slice(0, 6)) steps.push({ label: u.label, value: u.gap, kind: 'delta' });
  const rest = units.slice(6).reduce((s, u) => s + u.gap, 0); if (units.length > 6) steps.push({ label: 'Other units', value: rest, kind: 'delta' });
  steps.push({ label: 'Actual', value: totalActual, kind: 'end' });
  const vol = units.reduce((s, u) => s + u.volume_effect, 0), real = units.reduce((s, u) => s + u.realisation_effect, 0);
  const driverSteps = [{ label: 'Plan', value: totalPlan, kind: 'start' }, { label: 'Volume (standard value)', value: vol, kind: 'delta' }, { label: 'Realisation', value: real, kind: 'delta' }, { label: 'Actual', value: totalActual, kind: 'end' }];
  const narrative = `Revenue${composer.scopeLabel(cut)} was ${money(totalActual)} against a plan of ${money(totalPlan)} for ${p.label}, a gap of ${money(gap)} (${pct(totalActual / totalPlan - 1)}). ` +
    (behind.length ? `${listWords(behind.slice(0, 3).map(u => `${u.label} (${money(u.gap)})`))} ${behind.length > 1 ? 'are' : 'is'} behind plan. ` : 'Every unit is at or above plan. ') +
    `Of the gap, ${money(vol)} comes from volume (fewer standard-value hours than the plan assumed) and ${money(real)} from realisation.` +
    (behind.some(u => u.realisation_effect < -1e5) ? ` ${[...behind].sort((a, b) => a.realisation_effect - b.realisation_effect)[0].label} shows the largest realisation effect; ask why realisation dropped there.` : '');
  const spoken = `${(cut.region || cut.unit) ? ref.labelOf(cut.region ? 'region' : 'unit', cut.region || cut.unit) : 'The firm'} is ${money(Math.abs(gap))} ${gap < 0 ? 'behind' : 'ahead of'} plan for ${p.label}. ${behind[0] ? behind[0].label + ' is the largest gap' : 'No unit is behind'}, ${Math.abs(real) > Math.abs(vol) ? 'mainly through realisation' : 'mainly through lower volume'}. Ask why realisation moved in ${behind[0] ? behind[0].label : 'any unit'}.`;
  return {
    agent: 'Variance Agent', metric: 'plan_attainment', period: p, total: { actual: totalActual, plan: totalPlan, gap }, units, drivers: [{ driver: 'Volume', effect: vol }, { driver: 'Realisation', effect: real }], narrative, spoken,
    visual: composer.waterfall(`Plan to actual${composer.scopeLabel(cut)}`, p.label + ', by unit', steps, 'money', lineageFor('plan_attainment', cut, p, ['engagement_months', 'plan'])),
    visual2: composer.waterfall('Gap by driver', 'Volume and realisation effects', driverSteps, 'money', lineageFor('plan_attainment', cut, p, ['engagement_months', 'plan'])),
    table: composer.table('Units against plan', p.label, [['label', 'Unit'], ['actual', 'Actual', 'money'], ['plan', 'Plan', 'money'], ['gap', 'Gap', 'money'], ['attainment', 'Attainment', 'pct'], ['volume_effect', 'Volume effect', 'money'], ['realisation_effect', 'Realisation effect', 'money']], units, lineageFor('plan_attainment', cut, p, ['engagement_months', 'plan'])),
    followUps: [behind.length ? `Why did realisation drop in ${[...behind].sort((a, b) => a.realisation_effect - b.realisation_effect)[0].label} last quarter?` : 'Show revenue by unit', 'Forecast revenue to year end', 'What should I do about it?']
  };
}
// Plan is held by unit; for another dimension (practice, industry) each unit's plan is allocated across members by their
// share of that unit's prior-year revenue, so the gap can be attributed to the practices that are bringing it down.
async function revenueVsPlanBy(cut, p, by) {
  const dimName = by === 'industry' ? 'industry' : 'practice';
  const pLY = engine.priorYear(p);
  const [cur, lyRows, planRows] = await Promise.all([engine.emAgg(cut, p, dimName), engine.emAgg(cut, pLY, dimName), planByUnit(cut, p)]);
  const totalPlan = Object.values(planRows).reduce((a, v) => a + v, 0);
  const lyTotal = lyRows.reduce((a, r) => a + r.billed, 0);
  const lyMap = Object.fromEntries(lyRows.map(r => [r.key, r]));
  const members = cur.map(r => {
    const l = lyMap[r.key]; const share = lyTotal ? (l ? l.billed : 0) / lyTotal : 1 / cur.length; const plan = totalPlan * share;
    const realPlan = l && l.std ? l.billed / l.std : 0.9; const realAct = r.std ? r.billed / r.std : realPlan; const stdPlan = plan / realPlan;
    return { member: r.key, label: ref.labelOf(dimName, r.key), actual: r.billed, plan, gap: r.billed - plan, attainment: plan ? r.billed / plan : null, growth: l && l.billed ? r.billed / l.billed - 1 : null, volume_effect: (r.std - stdPlan) * realPlan, realisation_effect: r.std * (realAct - realPlan), realisation: realAct };
  }).sort((a, b) => a.gap - b.gap);
  const totalActual = members.reduce((s, m) => s + m.actual, 0); const gap = totalActual - totalPlan;
  const behind = members.filter(m => m.gap < 0); const best = members[members.length - 1];
  const steps = [{ label: 'Plan', value: totalPlan, kind: 'start' }];
  for (const m of members.slice(0, 7)) steps.push({ label: m.label, value: m.gap, kind: 'delta' });
  const rest = members.slice(7).reduce((s, m) => s + m.gap, 0); if (members.length > 7) steps.push({ label: 'Other ' + dimName + 's', value: rest, kind: 'delta' });
  steps.push({ label: 'Actual', value: totalActual, kind: 'end' });
  const scope = composer.scopeLabel(cut).replace(/^, /, '') || 'The firm';
  const Dim = dimName[0].toUpperCase() + dimName.slice(1);
  const narrative = `${scope}: revenue ${money(totalActual)} against ${money(totalPlan)} of plan for ${p.label}, a gap of ${money(gap)} (${pct(totalActual / totalPlan - 1)}), with plan allocated to ${dimName}s by their prior-year mix. ` +
    (behind.length ? `${listWords(behind.slice(0, 3).map(m => `${m.label} (${money(m.gap)}${m.growth !== null ? ', ' + pct(m.growth) + ' year on year' : ''})`))} ${behind.length > 1 ? 'are' : 'is'} bringing it down. ` : `Every ${dimName} is at or above its allocated plan. `) +
    (best && best.gap > 0 ? `${best.label} is ahead by ${money(best.gap)}.` : '');
  const spoken = `${scope} is ${money(Math.abs(gap))} ${gap < 0 ? 'behind' : 'ahead of'} plan. ${behind[0] ? behind[0].label + ' is the largest drag at ' + money(behind[0].gap) + '.' : ''} Plan was allocated to ${dimName}s by the prior-year mix.`;
  const lin = lineageFor('plan_attainment', cut, p, ['engagement_months', 'plan']);
  return { agent: 'Variance Agent', metric: 'plan_attainment', period: p, total: { actual: totalActual, plan: totalPlan, gap }, units: members, contributors: members, narrative, spoken,
    visual: composer.waterfall(`Plan to actual by ${dimName}${composer.scopeLabel(cut)}`, `${p.label}; plan allocated to ${dimName}s by prior-year revenue mix`, steps, 'money', lin),
    table: composer.table(`${Dim}s against allocated plan`, p.label, [['label', Dim], ['actual', 'Actual', 'money'], ['plan', 'Allocated plan', 'money'], ['gap', 'Gap', 'money'], ['attainment', 'Attainment', 'pct'], ['growth', 'Growth YoY', 'pct'], ['realisation', 'Realisation', 'pct']], members, lin),
    followUps: [behind[0] ? `Why did ${behind[0].label} revenue fall?` : `Show revenue by ${dimName}`, 'Break the gap down by unit', 'What should I do about it?'] };
}
async function planByUnit(cut, p) {
  const P = new engine.Params();
  const rows = await db.query(`SELECT pl.unit, SUM(pl.revenue_plan) AS plan FROM plan pl JOIN units u ON u.id=pl.unit WHERE pl.month BETWEEN ${P.add(p.from)} AND ${P.add(p.to)} ${engine.cutWhere(cut, { region: 'u.region', unit: 'pl.unit' }, P)} GROUP BY 1`, P.values);
  return Object.fromEntries(rows.map(r => [r.unit, r.plan]));
}
async function revenueVsPeriod(cut, pA, pB) { return generic('net_fee_revenue', cut, pA, pB); }

async function utilisation(cut, pA, pB) {
  const [a, b] = await Promise.all([engine.pmAgg(cut, pA, null), engine.pmAgg(cut, pB, null)]);
  const A = a[0], B = b[0]; if (!A || !B) return empty('utilisation', cut, pB);
  const uA = A.chargeable / A.available, uB = B.chargeable / B.available;
  const demand = (B.chargeable - A.chargeable) / B.available; const capacity = A.chargeable / B.available - A.chargeable / A.available;
  const steps = [{ label: pA.label, value: uA, kind: 'start' }, { label: 'Chargeable hours (demand)', value: demand, kind: 'delta' }, { label: 'Available hours (capacity)', value: capacity, kind: 'delta' }, { label: pB.label, value: uB, kind: 'end' }];
  const g = cut.unit ? 'level' : 'unit';
  const [ga, gb] = await Promise.all([engine.pmAgg(cut, pA, g), engine.pmAgg(cut, pB, g)]);
  const am = Object.fromEntries(ga.map(r => [r.key, r]));
  const contributors = gb.map(r => { const x = am[r.key]; const before = x ? x.chargeable / x.available : null; const after = r.chargeable / r.available; return { member: r.key, label: ref.labelOf(g, r.key), before, after, change: before !== null ? after - before : null, contribution: before !== null ? (after - before) * (r.available / B.available) : null, people: r.people }; }).sort((x, y) => (x.contribution || 0) - (y.contribution || 0));
  const narrative = `Utilisation${composer.scopeLabel(cut)} moved from ${pct(uA)} in ${pA.label} to ${pct(uB)} in ${pB.label} (${pts(uB - uA)}). Chargeable demand contributed ${pts(demand)} and available capacity ${pts(capacity)}. ${contributors[0] ? `${contributors[0].label} contributed most (${pts(contributors[0].contribution)}).` : ''}`;
  return { agent: 'Variance Agent', metric: 'utilisation', from: { period: pA, value: uA }, to: { period: pB, value: uB }, delta: uB - uA, drivers: [{ driver: 'Demand', effect: demand }, { driver: 'Capacity', effect: capacity }], contributors, narrative, spoken: narrative,
    visual: composer.waterfall(`Utilisation bridge${composer.scopeLabel(cut)}`, `${pA.label} to ${pB.label}`, steps, 'pct', lineageFor('utilisation', cut, pB, ['person_months', 'people'])),
    table: composer.table(`Contribution by ${g}`, '', [['label', g === 'level' ? 'Level' : 'Unit'], ['before', pA.label, 'pct'], ['after', pB.label, 'pct'], ['change', 'Change', 'pts'], ['contribution', 'Contribution', 'pts'], ['people', 'People']], contributors, lineageFor('utilisation', cut, pB, ['person_months'])),
    followUps: ['Forecast utilisation for the next six weeks', 'Who is on the bench in this unit?', 'What should I do about it?'] };
}
async function profitPerPartner(cut, pA, pB) {
  const [ma, mb, ra, rb, la, lb, pa, pb] = await Promise.all([engine.compute('contribution_margin', { cut, period: pA }), engine.compute('contribution_margin', { cut, period: pB }), engine.compute('revenue_per_professional', { cut, period: pA }), engine.compute('revenue_per_professional', { cut, period: pB }), engine.compute('leverage', { cut, period: pA }), engine.compute('leverage', { cut, period: pB }), engine.compute('profit_per_partner', { cut, period: pA }), engine.compute('profit_per_partner', { cut, period: pB })]);
  const v = r => r.total.value;
  const dl = (b, a) => Math.log(b / a);
  const total = dl(v(pb), v(pa)) || 1e-9; const parts = { 'Contribution margin': dl(v(mb), v(ma)), 'Revenue per professional': dl(v(rb), v(ra)), 'Leverage': dl(v(lb), v(la)) };
  const sumParts = Object.values(parts).reduce((s, x) => s + x, 0) || 1e-9;
  const gap = v(pb) - v(pa);
  const steps = [{ label: pA.label, value: v(pa), kind: 'start' }];
  const drivers = Object.entries(parts).map(([k, x]) => ({ driver: k, effect: gap * x / sumParts })); drivers.forEach(d => steps.push({ label: d.driver, value: d.effect, kind: 'delta' }));
  steps.push({ label: pB.label, value: v(pb), kind: 'end' });
  const narrative = `Profit per partner${composer.scopeLabel(cut)} moved from ${money(v(pa))} to ${money(v(pb))} (${pct(v(pb) / v(pa) - 1)}). Margin went from ${pct(v(ma))} to ${pct(v(mb))}, revenue per professional from ${money(v(ra))} to ${money(v(rb))} and leverage from ${v(la).toFixed(1)} to ${v(lb).toFixed(1)}. ${drivers.sort((x, y) => Math.abs(y.effect) - Math.abs(x.effect))[0].driver} moved profit per partner most.`;
  return { agent: 'Variance Agent', metric: 'profit_per_partner', drivers, narrative, spoken: narrative, tree: { ppp: [v(pa), v(pb)], margin: [v(ma), v(mb)], rpp: [v(ra), v(rb)], leverage: [v(la), v(lb)] },
    visual: composer.waterfall('Profit per partner driver tree', `${pA.label} to ${pB.label}`, steps, 'money', pb.lineage), followUps: ['What would a 3% rate increase in North America do to profit per partner?', 'Show margin by region', 'Show leverage by unit'] };
}
async function margin(cut, pA, pB) {
  const [a, b] = await Promise.all([engine.emAgg(cut, pA, null), engine.emAgg(cut, pB, null)]);
  const A = a[0], B = b[0]; if (!A || !B) return empty('contribution_margin', cut, pB);
  const mA = (A.billed - A.staff_cost - A.unrecovered) / A.billed, mB = (B.billed - B.staff_cost - B.unrecovered) / B.billed;
  const cost = -((B.staff_cost / B.billed) - (A.staff_cost / A.billed)); const unrec = -((B.unrecovered / B.billed) - (A.unrecovered / A.billed));
  const steps = [{ label: pA.label, value: mA, kind: 'start' }, { label: 'Staff cost ratio', value: cost, kind: 'delta' }, { label: 'Unrecovered expenses', value: unrec, kind: 'delta' }, { label: pB.label, value: mB, kind: 'end' }];
  const narrative = `Contribution margin${composer.scopeLabel(cut)} moved from ${pct(mA)} to ${pct(mB)} (${pts(mB - mA)}): staff cost ratio ${pts(cost)}, unrecovered expenses ${pts(unrec)}.`;
  return { agent: 'Variance Agent', metric: 'contribution_margin', drivers: [{ driver: 'Staff cost ratio', effect: cost }, { driver: 'Unrecovered expenses', effect: unrec }], narrative, spoken: narrative, visual: composer.waterfall('Margin bridge', `${pA.label} to ${pB.label}`, steps, 'pct', lineageFor('contribution_margin', cut, pB, ['engagement_months'])), followUps: ['Show margin by unit', 'Which engagements have the lowest margin?', 'Forecast margin to year end'] };
}
async function generic(metricId, cut, pA, pB) {
  const g = cut.unit ? 'practice' : cut.region ? 'unit' : 'region';
  const [a, b, ta, tb] = await Promise.all([engine.compute(metricId, { cut, period: pA, groupBy: g }), engine.compute(metricId, { cut, period: pB, groupBy: g }), engine.compute(metricId, { cut, period: pA }), engine.compute(metricId, { cut, period: pB })]);
  const am = Object.fromEntries(a.rows.map(r => [r.key, r.value]));
  const m = a.metric; const additive = m.format === 'money' && !['revenue_per_partner', 'revenue_per_professional', 'profit_per_partner', 'effective_rate', 'eac'].includes(m.id);
  const contributors = b.rows.map(r => ({ member: r.key, label: r.label, before: am[r.key] ?? null, after: r.value, change: am[r.key] != null ? r.value - am[r.key] : null })).sort((x, y) => (x.change || 0) - (y.change || 0));
  const total = { before: ta.total.value, after: tb.total.value };
  const steps = [{ label: pA.label, value: total.before, kind: 'start' }];
  if (additive) { for (const c of contributors) steps.push({ label: c.label, value: c.change || 0, kind: 'delta' }); }
  steps.push({ label: pB.label, value: total.after, kind: 'end' });
  const { fmt } = require('./util');
  const narrative = `${m.name}${composer.scopeLabel(cut)} moved from ${fmt(total.before, m.format)} in ${pA.label} to ${fmt(total.after, m.format)} in ${pB.label}. ${contributors.length ? `The largest fall was in ${contributors[0].label} and the largest rise in ${contributors[contributors.length - 1].label}.` : ''}`;
  return { agent: 'Variance Agent', metric: metricId, contributors, narrative, spoken: narrative, visual: additive ? composer.waterfall(`${m.name} bridge`, `${pA.label} to ${pB.label}`, steps, m.format, tb.lineage) : composer.fromMetric(b, { compareMap: am, compareName: pA.label }), followUps: [`Forecast ${m.name.toLowerCase()} to year end`, `Show ${m.name.toLowerCase()} by month`, 'What should I do about it?'] };
}
function empty(metricId, cut, p) { return { agent: 'Variance Agent', metric: metricId, narrative: 'There is not enough data in this cut and period to build a bridge.', spoken: 'There is not enough data for a bridge here.', drivers: [], contributors: [], visual: null, followUps: [] }; }
function lineageFor(metricId, cut, p, tables) { const c = require('../metrics/catalogue').byId[metricId]; return { metric: metricId, name: c.name, formula: c.formula, owner: c.owner, source_system: c.source, stub: 'stub:sap + stub:iem', tables, filters: cut, period: p, model: 'Variance decomposition (exact, additive)', path: ['Source system', 'Connector stub', 'Lakehouse', 'Semantic model: ' + c.name, 'Variance Agent', 'Visual'], refreshed_at: engine.TODAY + 'T05:30:00Z', seeded: true }; }
module.exports = { explain };
