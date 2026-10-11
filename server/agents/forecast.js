'use strict';
/**
 * Forecast Agent: revenue, margin, utilisation, cash and headcount with P10, P50, P90 and the gap to plan.
 * Revenue (model 1): bottom-up (booked unbilled work on live engagements + weighted pipeline with start lag) reconciled with a
 * top-down seasonal time series. The band comes from a rolling backtest on the seeded history.
 */
const db = require('../db');
const engine = require('../metrics/engine');
const ref = require('../metrics/refcache');
const composer = require('./composer');
const { money, pct, monthLabel } = require('./util');

const Z90 = 1.2816;
function addMonths(s, n) { return engine.addMonths(s, n); }
function normalCdf(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; }

async function monthlySeries(metricId, cut, from, to) {
  const r = await engine.compute(metricId, { cut, period: { from, to, label: '' }, groupBy: 'month' });
  const map = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
  const out = []; for (let m = from; m <= to; m = addMonths(m, 1)) out.push({ month: m, value: map[m] ?? null });
  return { series: out, lineage: r.lineage, metric: r.metric };
}
function topDown(history, horizonMonths) {
  // seasonal naive with trend: level = mean of last 12, seasonal index by month-of-year from up to 24 months, trend = growth of last 12 vs prior 12
  const vals = history.map(h => h.value); const n = vals.length;
  const last12 = vals.slice(-12), prior12 = vals.slice(-24, -12);
  const level = last12.reduce((a, b) => a + b, 0) / last12.length;
  const growth = prior12.length === 12 ? (last12.reduce((a, b) => a + b, 0) / prior12.reduce((a, b) => a + b, 0)) : 1.08;
  const idx = {}; const cnt = {};
  history.slice(-24).forEach(h => { const mo = h.month.slice(5, 7); idx[mo] = (idx[mo] || 0) + h.value; cnt[mo] = (cnt[mo] || 0) + 1; });
  const mean24 = history.slice(-24).reduce((a, h) => a + h.value, 0) / Math.min(24, n);
  const seasonal = mo => (idx[mo] ? (idx[mo] / cnt[mo]) / mean24 : 1);
  const out = []; const lastMonth = history[n - 1].month;
  for (let h = 1; h <= horizonMonths; h++) { const m = addMonths(lastMonth, h); out.push({ month: m, value: level * seasonal(m.slice(5, 7)) * Math.pow(growth, (h + 6) / 12) }); }
  return { out, growth, level };
}
function backtest(history) {
  // rolling one-step-ahead errors over the last 6 points using the top-down model
  const errs = [];
  for (let k = 6; k >= 1; k--) { const train = history.slice(0, history.length - k); if (train.length < 15) continue; const f = topDown(train, 1).out[0]; const actual = history[history.length - k].value; errs.push((f.value - actual) / actual); }
  const mape = errs.length ? errs.reduce((a, e) => a + Math.abs(e), 0) / errs.length : 0.04;
  const sd = errs.length ? Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length) : 0.05;
  return { mape, sd, n: errs.length };
}
async function bottomUp(cut, fromMonth, horizonMonths) {
  // booked unbilled work: remaining budget of live engagements spread to their end date; pipeline: value × win_prob × realisation, spread over 6 months from expected start
  const P = new engine.Params();
  const live = await db.query(`SELECT e.id, e.budget_fees, e.start_date, e.end_date, COALESCE(x.billed,0) billed FROM engagements e LEFT JOIN (SELECT engagement_id, SUM(billed) billed FROM engagement_months GROUP BY 1) x ON x.engagement_id=e.id WHERE e.status IN ('live','planned') ${engine.cutWhere(cut, engine.ENG_DIMS, P)}`, P.values);
  const P2 = new engine.Params();
  const opps = await db.query(`SELECT value, win_prob, expected_start FROM opportunities o WHERE o.outcome IS NULL ${engine.cutWhere(cut, { region: 'o.region', unit: 'o.unit', practice: 'o.practice', industry: 'o.industry', client: 'o.client_id', partner: 'o.partner_id' }, P2)}`, P2.values);
  const months = []; for (let h = 0; h < horizonMonths; h++) months.push(addMonths(fromMonth, h));
  const booked = Object.fromEntries(months.map(m => [m, 0])); const pipe = Object.fromEntries(months.map(m => [m, 0]));
  for (const e of live) {
    const remaining = Math.max(0, e.budget_fees - e.billed); const endM = engine.monthOf(e.end_date); const startM = fromMonth > engine.monthOf(e.start_date) ? fromMonth : engine.monthOf(e.start_date);
    const n = Math.max(1, engine.monthsBetween(startM, endM) + 1);
    for (let i = 0; i < n; i++) { const m = addMonths(startM, i); if (booked[m] !== undefined) booked[m] += remaining / n; }
  }
  for (const o of opps) { const s = engine.monthOf(o.expected_start) < fromMonth ? fromMonth : engine.monthOf(o.expected_start); for (let i = 0; i < 6; i++) { const m = addMonths(s, i); if (pipe[m] !== undefined) pipe[m] += o.value * o.win_prob * 0.88 / 6; } }
  return months.map(m => ({ month: m, booked: booked[m], pipeline: pipe[m], value: booked[m] + pipe[m] }));
}
async function planSeries(cut, months) {
  const P = new engine.Params();
  const rows = await db.query(`SELECT pl.month, SUM(pl.revenue_plan) AS plan FROM plan pl JOIN units u ON u.id=pl.unit WHERE pl.month = ANY(${P.add(months)}) ${engine.cutWhere(cut, { region: 'u.region', unit: 'pl.unit' }, P)} GROUP BY 1 ORDER BY 1`, P.values);
  const m = Object.fromEntries(rows.map(r => [typeof r.month === 'string' ? r.month : r.month.toISOString().slice(0, 10), r.plan]));
  return months.map(x => m[x] ?? null);
}

async function revenue({ cut = {}, horizon = { toYearEnd: true } }) {
  const last = engine.LAST_CLOSED;
  const { series: history, lineage } = await monthlySeries('net_fee_revenue', cut, '2024-01-01', last);
  const hist = history.filter(h => h.value !== null);
  const months = horizon.months || (horizon.toYearEnd ? engine.monthsBetween(last, '2026-12-01') : horizon.year ? engine.monthsBetween(last, horizon.year + '-12-01') : horizon.quarter ? engine.monthsBetween(last, `${horizon.year}-${String(horizon.quarter * 3).padStart(2, '0')}-01`) : 3);
  const td = topDown(hist, months); const bu = await bottomUp(cut, addMonths(last, 1), months); const bt = backtest(hist);
  const planScoped = !cut.practice && !cut.client && !cut.industry && !cut.engagement;
  const forecast = td.out.map((t, i) => {
    const b = bu[i]; const buAdj = b.value * (td.out[0].value / Math.max(1, bu[0].value)) * 0.5 + b.value * 0.5; // reconcile scale of bottom-up to history
    const p50 = 0.5 * t.value + 0.5 * buAdj; const sd = bt.sd * Math.sqrt(i + 1) * p50;
    return { month: t.month, p50, p10: p50 - Z90 * sd, p90: p50 + Z90 * sd, top_down: t.value, bottom_up: b.value, booked: b.booked, pipeline: b.pipeline, sd };
  });
  const fMonths = forecast.map(f => f.month); const plan = planScoped ? await planSeries(cut, [...hist.map(h => h.month), ...fMonths]) : null;
  const year = String(parseInt(last.slice(0, 4), 10));
  const ytd = hist.filter(h => h.month.startsWith(year)).reduce((a, h) => a + h.value, 0);
  const restOfYear = forecast.filter(f => f.month.startsWith(year));
  const fy = { actual_ytd: ytd, forecast_rest: restOfYear.reduce((a, f) => a + f.p50, 0) };
  fy.p50 = fy.actual_ytd + fy.forecast_rest; const sdFy = Math.sqrt(restOfYear.reduce((a, f) => a + f.sd * f.sd, 0)); fy.p10 = fy.p50 - Z90 * sdFy; fy.p90 = fy.p50 + Z90 * sdFy;
  if (plan) { const idx = hist.length; fy.plan = plan.slice(0, idx).filter((v, i) => hist[i].month.startsWith(year)).reduce((a, v) => a + (v || 0), 0) + plan.slice(idx).filter((v, i) => fMonths[i].startsWith(year)).reduce((a, v) => a + (v || 0), 0); fy.gap = fy.p50 - fy.plan; fy.prob_reach_plan = sdFy ? 1 - normalCdf((fy.plan - fy.p50) / sdFy) : null; }
  const scope = composer.scopeLabel(cut).replace(/^, /, '') || 'The firm';
  const narrative = `${scope} is forecast at ${money(fy.p50)} for ${year} (P10 ${money(fy.p10)}, P90 ${money(fy.p90)}), of which ${money(fy.actual_ytd)} is booked to ${monthLabel(last)}.` + (plan ? ` Against a full-year plan of ${money(fy.plan)} that is a gap of ${money(fy.gap)} (${pct(fy.p50 / fy.plan - 1)}); the probability of reaching plan is ${pct(fy.prob_reach_plan, 0)}.` : '') + ` The forecast blends booked work (${money(forecast.reduce((a, f) => a + f.booked, 0))} over the horizon), weighted pipeline (${money(forecast.reduce((a, f) => a + f.pipeline, 0))}) and the seasonal trend. Backtest error ${pct(bt.mape)} over the last ${bt.n} months.`;
  const spoken = plan ? `${scope} is ${fy.gap >= 0 ? 'on track' : 'behind'}: forecast ${money(fy.p50)} against plan ${money(fy.plan)}, with ${pct(fy.prob_reach_plan, 0)} probability of reaching plan. ${fy.gap < 0 ? 'Ask me why, and I will show the units behind it.' : 'Europe is the region to watch; ask me why.'}` : `${scope} is forecast at ${money(fy.p50)} for ${year}, with a band from ${money(fy.p10)} to ${money(fy.p90)}.`;
  const drivers = [{ driver: 'Booked unbilled work on live engagements', effect: forecast.reduce((a, f) => a + f.booked, 0) }, { driver: 'Weighted pipeline with start lag', effect: forecast.reduce((a, f) => a + f.pipeline, 0) }, { driver: 'Seasonal trend (12-month growth)', effect: td.growth - 1, format: 'pct' }];
  return { agent: 'Forecast Agent', model: { id: 1, name: 'Revenue forecast', version: '1.0-seed', method: 'Bottom-up engagement forecast reconciled with top-down time series', backtest: bt }, history: hist, forecast, plan, fullYear: fy, narrative, spoken, drivers,
    visual: composer.forecastChart(`Revenue forecast${composer.scopeLabel(cut)}`, `Monthly, P10–P90 band${plan ? ', against plan' : ''}`, hist, forecast, plan, 'money', { ...lineage, model: 'Revenue forecast v1.0-seed', backtest: bt, drivers: drivers.map(d => d.driver) }),
    followUps: [fy.gap < 0 ? 'Why are we behind plan?' : 'Which units will miss plan this quarter?', 'What would a 3% rate increase in North America do to profit per partner?', 'Show the forecast by region'] };
}
async function unitsAtRisk({ cut = {}, period = 'qtd' }) {
  // probability of reaching plan per unit for the current quarter: actual QTD + forecast of remaining months vs plan
  const last = engine.LAST_CLOSED; const qs = engine.quarterStart(engine.monthOf(engine.TODAY)); const qEnd = addMonths(qs, 2);
  const units = (await db.query(`SELECT u.id, u.name, u.region FROM units u WHERE 1=1 ${cut.region ? `AND u.region='${cut.region}'` : ''} ORDER BY name`));
  const out = [];
  for (const u of units) {
    const { series } = await monthlySeries('net_fee_revenue', { unit: u.id }, '2024-01-01', last); const hist = series.filter(h => h.value !== null);
    const n = engine.monthsBetween(last, qEnd); const td = topDown(hist, n); const bt = backtest(hist);
    const months = []; for (let m = qs; m <= qEnd; m = addMonths(m, 1)) months.push(m);
    const plan = (await planSeries({ unit: u.id }, months)).reduce((a, v) => a + (v || 0), 0);
    const actual = hist.filter(h => h.month >= qs).reduce((a, h) => a + h.value, 0);
    // blend the top-down forecast with the same months last year grown at the trailing growth rate (the plan's own basis)
    const lyMonths = td.out.filter(f => f.month >= qs && f.month <= qEnd).map(f => hist.find(h => h.month === addMonths(f.month, -12))).filter(Boolean);
    const lyGrown = lyMonths.reduce((a, h) => a + h.value, 0) * td.growth;
    const fcTd = td.out.filter(f => f.month >= qs && f.month <= qEnd).reduce((a, f) => a + f.value, 0);
    const fc = lyMonths.length === n ? 0.5 * fcTd + 0.5 * lyGrown : fcTd;
    const p50 = actual + fc; const sd = bt.sd * Math.sqrt(n) * fc;
    out.push({ unit: u.id, label: u.name, region: u.region, plan, actual_to_date: actual, forecast: p50, gap: p50 - plan, attainment: p50 / plan, prob_reach_plan: sd ? 1 - normalCdf((plan - p50) / sd) : (p50 >= plan ? 1 : 0) });
  }
  out.sort((a, b) => a.gap - b.gap);
  const miss = out.filter(u => u.gap < 0);
  const narrative = `${miss.length} of ${out.length} units are forecast to miss plan for ${engine.quarterLabel(qs)}: ${miss.slice(0, 4).map(u => `${u.label} (${money(u.gap)}, ${pct(u.prob_reach_plan, 0)} chance of reaching plan)`).join('; ')}. The total forecast gap is ${money(miss.reduce((a, u) => a + u.gap, 0))}.`;
  return { agent: 'Forecast Agent', model: { id: 1, name: 'Revenue forecast' }, units: out, narrative, spoken: `${miss.length} units are forecast to miss plan this quarter, led by ${miss[0] ? miss[0].label : 'none'}. Ask me why for any unit.`,
    visual: { type: 'bar', title: `Forecast gap to plan by unit, ${engine.quarterLabel(qs)}`, subtitle: 'Quarter-end forecast minus plan', x: out.map(u => u.label), keys: out.map(u => u.unit), dim: 'unit', series: [{ name: 'Gap to plan', data: out.map(u => u.gap) }, { name: 'Probability of reaching plan', data: out.map(u => u.prob_reach_plan), kind: 'secondary', format: 'pct' }], format: 'money', horizontal: true, seeded: true, lineage: { metric: 'plan_attainment', name: 'Plan attainment', formula: 'Forecast ÷ plan', model: 'Revenue forecast v1.0-seed', stub: 'stub:sap + stub:anaplan', tables: ['engagement_months', 'plan', 'opportunities'], seeded: true } },
    table: composer.table('Units against plan', engine.quarterLabel(qs), [['label', 'Unit'], ['plan', 'Plan', 'money'], ...(out.some(r => r.actual_to_date) ? [['actual_to_date', 'Actual to date', 'money']] : []), ['forecast', 'Forecast', 'money'], ['gap', 'Gap', 'money'], ['prob_reach_plan', 'Chance of plan', 'pct']], out, null),
    followUps: [miss[0] ? `Why is ${miss[0].label} behind plan?` : 'Forecast revenue to year end', 'Forecast revenue to year end with the confidence band', 'What should I do about it?'] };
}
async function utilisation({ cut = {}, weeks = 6 }) {
  const last = engine.LAST_CLOSED;
  const { series, lineage } = await monthlySeries('utilisation', cut, '2024-01-01', last); const hist = series.filter(h => h.value !== null);
  const P = new engine.Params();
  const roll = await db.query(`SELECT COUNT(*)::int AS n FROM people p WHERE p.status='active' AND p.client_service AND p.roll_off_date BETWEEN ${P.add(engine.TODAY)} AND ${P.add(engine.TODAY)}::date + ${weeks * 7} ${engine.cutWhere(cut, engine.PPL_DIMS, P)}`, P.values);
  const P2 = new engine.Params();
  const head = await db.query(`SELECT COUNT(*)::int AS n FROM people p WHERE p.status='active' AND p.client_service AND p.type='employee' ${engine.cutWhere(cut, engine.PPL_DIMS, P2)}`, P2.values);
  const rollShare = head[0].n ? roll[0].n / head[0].n : 0;
  const td = topDown(hist, 2); const bt = backtest(hist);
  const forecast = td.out.map((t, i) => { const p50 = t.value - rollShare * 0.5 * (i + 1) / 2; const sd = 0.02 * Math.sqrt(i + 1); return { month: t.month, p50, p10: p50 - Z90 * sd, p90: p50 + Z90 * sd, sd }; });
  const narrative = `Utilisation${composer.scopeIn(cut)} is forecast at ${pct(forecast[0].p50)} next month and ${pct(forecast[1].p50)} the month after (band ±${pct(Z90 * forecast[1].sd)}). ${roll[0].n} people roll off engagements in the next ${weeks} weeks (${pct(rollShare)} of client-service staff), which is the main downward pressure.`;
  return { agent: 'Forecast Agent', model: { id: 2, name: 'Utilisation forecast', version: '1.0-seed', backtest: bt }, history: hist, forecast, narrative, spoken: narrative, drivers: [{ driver: 'Roll-offs in the window', effect: roll[0].n }, { driver: 'Seasonal pattern', effect: td.growth - 1 }], visual: composer.forecastChart(`Utilisation forecast${composer.scopeLabel(cut)}`, 'Monthly with band', hist.slice(-12), forecast, null, 'pct', { ...lineage, model: 'Utilisation forecast v1.0-seed' }), followUps: ['Who is rolling off in the next three weeks?', 'Which units are below 70% utilisation at Associate level?', 'Show the bench by office'] };
}
module.exports = { revenue, unitsAtRisk, utilisation, topDown, backtest, normalCdf };
