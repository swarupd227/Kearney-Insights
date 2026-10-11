'use strict';
/**
 * Metric engine: one SQL implementation per governed metric. The Query Agent calls compute() under the user's scope.
 * Every result carries lineage: source system, stub, tables, filters, row count and refresh time.
 */
const db = require('../db');
const config = require('../config');
const catalogue = require('./catalogue');
const ref = require('./refcache');

const TODAY = config.demoToday;
const LAST_CLOSED = '2026-09-01';
const STUB = { 'engagement_months': 'stub:sap + stub:iem', 'person_months': 'stub:iem', 'people': 'stub:peoplesoft', 'invoices': 'stub:sap', 'opportunities': 'stub:salesforce', 'plan': 'stub:anaplan', 'fx_rates': 'market rates', 'contacts': 'stub:salesforce', 'knowledge_assets': 'stub:glean', 'staffing_roles': 'stub:staffing' };

// ---------- period helpers ----------
function ym(d) { return d.toISOString().slice(0, 10); }
function addMonths(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); d.setUTCDate(1); return ym(d); }
function monthOf(s) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(1); return ym(d); }
function quarterStart(s) { const d = new Date(s + 'T00:00:00Z'); d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3, 1); return ym(d); }
function periodFor(key) {
  const last = LAST_CLOSED; const thisMonth = monthOf(TODAY);
  switch (key) {
    case 'last_month': return { from: last, to: last, label: monthLabel(last) };
    case 'last_quarter': { const qs = quarterStart(addMonths(quarterStart(thisMonth), -1)); return { from: qs, to: addMonths(qs, 2), label: quarterLabel(qs) }; }
    case 'qtd': case 'this_quarter': { const qs = quarterStart(thisMonth); if (last < qs) return periodFor('last_quarter'); return { from: qs, to: last, label: quarterLabel(qs) + ' to date' }; }
    case 'ytd': case 'this_year': return { from: thisMonth.slice(0, 4) + '-01-01', to: last, label: thisMonth.slice(0, 4) + ' year to date' };
    case 'ltm': return { from: addMonths(last, -11), to: last, label: 'last twelve months' };
    case 'last_6m': case 'last_six_months': return { from: addMonths(last, -5), to: last, label: 'last six months' };
    case 'last_3y': return { from: addMonths(last, -35), to: last, label: 'last three years' };
    case 'all': return { from: '2024-01-01', to: last, label: 'since January 2024' };
    case 'now': case 'open': case 'ltd': return { from: '2024-01-01', to: last, label: '' };
    default: return { from: addMonths(last, -11), to: last, label: 'last twelve months' };
  }
}
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(s) { const d = new Date(s + 'T00:00:00Z'); return MONTHS_SHORT[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
function quarterLabel(s) { const d = new Date(s + 'T00:00:00Z'); return 'Q' + (Math.floor(d.getUTCMonth() / 3) + 1) + ' ' + d.getUTCFullYear(); }
function priorYear(p) { return { from: addMonths(p.from, -12), to: addMonths(p.to, -12), label: p.label + ', prior year' }; }
function priorPeriod(p) { const n = monthsBetween(p.from, p.to) + 1; const from = addMonths(p.from, -n), to = addMonths(p.to, -n); const label = n === 1 ? monthLabel(from) : (n === 3 && from === quarterStart(from)) ? quarterLabel(from) : n === 12 ? 'prior twelve months' : `${monthLabel(from)} to ${monthLabel(to)}`; return { from, to, label }; }
function monthsBetween(a, b) { const da = new Date(a + 'T00:00:00Z'), dbb = new Date(b + 'T00:00:00Z'); return (dbb.getUTCFullYear() - da.getUTCFullYear()) * 12 + dbb.getUTCMonth() - da.getUTCMonth(); }

// ---------- filter builders ----------
class Params { constructor() { this.values = []; } add(v) { this.values.push(v); return '$' + this.values.length; } }
const ENG_DIMS = { region: 'e.region', unit: 'e.unit', office: 'e.office', practice: 'e.practice', industry: 'e.industry', client: 'e.client_id', engagement: 'e.id', partner: 'e.partner_id', principal: 'e.principal_id', fee_model: 'e.fee_model', kearney_company: 'e.kearney_company' };
const PPL_DIMS = { region: 'p.region', unit: 'p.unit', office: 'p.office', practice: 'p.practice', industry: 'p.industry', level: 'p.level', person: 'p.id', counsellor: 'p.counsellor_id', kearney_company: 'p.kearney_company' };
function cutWhere(cut, dims, P) {
  const conds = [];
  for (const [k, col] of Object.entries(dims)) {
    const v = cut[k]; if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) conds.push(`${col} = ANY(${P.add(v)})`); else conds.push(`${col} = ${P.add(v)}`);
  }
  return conds.length ? ' AND ' + conds.join(' AND ') : '';
}
function groupExpr(groupBy, table) {
  if (!groupBy) return null;
  const time = { month: "date_trunc('month', MONTHCOL)::date", quarter: "date_trunc('quarter', MONTHCOL)::date", year: "date_trunc('year', MONTHCOL)::date" };
  if (time[groupBy]) return time[groupBy].replace(/MONTHCOL/g, table === 'em' ? 'em.month' : table === 'pm' ? 'pm.month' : table === 'inv' ? 'i.issue_date' : 'o.created_date');
  const dims = table === 'pm' || table === 'p' ? PPL_DIMS : table === 'inv' ? { region: 'i.region', unit: 'i.unit', client: 'i.client_id', engagement: 'i.engagement_id' } : table === 'opp' ? { region: 'o.region', unit: 'o.unit', practice: 'o.practice', industry: 'o.industry', client: 'o.client_id', partner: 'o.partner_id', stage: 'o.stage', fee_model: 'o.fee_model' } : ENG_DIMS;
  return dims[groupBy] || null;
}

// ---------- aggregate runners ----------
async function emAgg(cut, period, groupBy, extraWhere = '') {
  const P = new Params(); const g = groupExpr(groupBy, 'em');
  const sql = `SELECT ${g ? g + ' AS key,' : "'all' AS key,"} COUNT(*)::int AS rows, COUNT(DISTINCT e.id)::int AS engagements,
      COALESCE(SUM(em.billed),0) AS billed, COALESCE(SUM(em.standard_value),0) AS std, COALESCE(SUM(em.hours),0) AS hours,
      COALESCE(SUM(em.discount),0) AS discount, COALESCE(SUM(em.write_off),0) AS write_off, COALESCE(SUM(em.overrun_unbilled),0) AS overrun,
      COALESCE(SUM(em.delayed),0) AS delayed, COALESCE(SUM(em.staff_cost),0) AS staff_cost, COALESCE(SUM(em.unrecovered_expense),0) AS unrecovered,
      COALESCE(SUM(em.expenses),0) AS expenses, COALESCE(SUM(em.collected),0) AS collected, COALESCE(SUM(em.unbilled_wip),0) AS unbilled_wip
    FROM engagement_months em JOIN engagements e ON e.id = em.engagement_id
    WHERE em.month BETWEEN ${P.add(period.from)} AND ${P.add(period.to)} ${cutWhere(cut, ENG_DIMS, P)} ${extraWhere}
    GROUP BY 1 ORDER BY 1`;
  const rows = await db.query(sql, P.values);
  return rows.map(r => ({ ...r, key: fmtKey(r.key) }));
}
async function pmAgg(cut, period, groupBy, extraWhere = '') {
  const P = new Params(); const g = groupExpr(groupBy, 'pm');
  const sql = `SELECT ${g ? g + ' AS key,' : "'all' AS key,"} COUNT(*)::int AS rows, COUNT(DISTINCT p.id)::int AS people,
      COALESCE(SUM(pm.chargeable_hours),0) AS chargeable, COALESCE(SUM(pm.available_hours),0) AS available, COALESCE(SUM(pm.recorded_hours),0) AS recorded,
      COALESCE(SUM(pm.timesheets_due),0) AS ts_due, COALESCE(SUM(pm.timesheets_late),0) AS ts_late,
      SUM(CASE WHEN pm.chargeable_hours < 0.2 * pm.available_hours THEN 1 ELSE 0 END)::int AS bench_months
    FROM person_months pm JOIN people p ON p.id = pm.person_id
    WHERE pm.month BETWEEN ${P.add(period.from)} AND ${P.add(period.to)} AND p.client_service AND p.type='employee' ${cutWhere(cut, PPL_DIMS, P)} ${extraWhere}
    GROUP BY 1 ORDER BY 1`;
  const rows = await db.query(sql, P.values);
  return rows.map(r => ({ ...r, key: fmtKey(r.key) }));
}
async function pplAgg(cut, groupBy, extraWhere = '', select = '') {
  const P = new Params(); const g = groupExpr(groupBy, 'p');
  const sql = `SELECT ${g ? g + ' AS key,' : "'all' AS key,"} COUNT(*)::int AS people,
      SUM(CASE WHEN p.level='PARTNER' THEN 1 ELSE 0 END)::int AS partners,
      SUM(CASE WHEN p.client_service AND p.type='employee' THEN 1 ELSE 0 END)::int AS cs,
      SUM(CASE WHEN p.client_service AND p.type='employee' AND p.level<>'PARTNER' THEN 1 ELSE 0 END)::int AS professionals,
      SUM(CASE WHEN NOT p.client_service THEN 1 ELSE 0 END)::int AS bs,
      AVG(p.engagement_score) AS engagement_score, AVG(p.learning_hours) AS learning_hours, AVG(p.months_in_level) AS months_in_level,
      SUM(CASE WHEN p.sustained_weeks >= 4 THEN 1 ELSE 0 END)::int AS sustained, AVG(p.flight_risk) AS flight_risk,
      SUM(CASE WHEN p.flight_risk >= 0.35 THEN 1 ELSE 0 END)::int AS high_risk ${select}
    FROM people p WHERE p.status='active' ${cutWhere(cut, PPL_DIMS, P)} ${extraWhere} GROUP BY 1 ORDER BY 1`;
  return (await db.query(sql, P.values)).map(r => ({ ...r, key: fmtKey(r.key) }));
}
function fmtKey(k) { if (k instanceof Date) return ym(k); return k === null ? 'unassigned' : String(k); }
const div = (a, b) => (b ? a / b : null);

// ---------- metric implementations ----------
// Each returns { rows: [{key, value, ...parts}], tables: [...] }
const IMPL = {
  revenue: async (c, p, g) => ({ rows: (await emAgg(c, p, g)).map(r => ({ key: r.key, value: r.billed, hours: r.hours, engagements: r.engagements })), tables: ['engagement_months', 'engagements'] }),
  revenue_growth: async (c, p, g) => {
    const [cur, prev] = await Promise.all([emAgg(c, p, g), emAgg(c, priorYear(p), g)]);
    const pm = Object.fromEntries(prev.map(r => [shiftKey(r.key, g, 12), r.billed]));
    return { rows: cur.filter(r => (pm[r.key] || 0) >= 250000).map(r => ({ key: r.key, value: div(r.billed - (pm[r.key] || 0), pm[r.key] || 0), current: r.billed, prior: pm[r.key] || 0 })), tables: ['engagement_months', 'engagements'], note: 'Members with a prior-period base below US$250 thousand are excluded' };
  },
  revenue_per_partner: async (c, p, g) => {
    const [rev, ppl] = await Promise.all([emAgg(c, p, g), pplAgg(c, timeDim(g) ? null : g)]);
    const pc = Object.fromEntries(ppl.map(r => [r.key, r.partners]));
    const annualise = 12 / (monthsBetween(p.from, p.to) + 1);
    return { rows: rev.map(r => { const partners = timeDim(g) ? pc.all : pc[r.key]; return { key: r.key, value: div(r.billed * (timeDim(g) && g === 'month' ? 12 : timeDim(g) && g === 'quarter' ? 4 : annualise), partners), partners, revenue: r.billed }; }), tables: ['engagement_months', 'engagements', 'people'], note: 'Annualised; average partner count approximated by active partners' };
  },
  revenue_per_professional: async (c, p, g) => {
    const [rev, ppl] = await Promise.all([emAgg(c, p, g), pplAgg(c, timeDim(g) ? null : g)]);
    const pc = Object.fromEntries(ppl.map(r => [r.key, r.cs]));
    const annualise = 12 / (monthsBetween(p.from, p.to) + 1);
    return { rows: rev.map(r => { const n = timeDim(g) ? pc.all : pc[r.key]; return { key: r.key, value: div(r.billed * (g === 'month' ? 12 : g === 'quarter' ? 4 : annualise), n), professionals: n }; }), tables: ['engagement_months', 'engagements', 'people'], note: 'Annualised' };
  },
  margin: async (c, p, g) => ({ rows: (await emAgg(c, p, g)).map(r => ({ key: r.key, value: div(r.billed - r.staff_cost - r.unrecovered, r.billed), revenue: r.billed, staff_cost: r.staff_cost, unrecovered: r.unrecovered })), tables: ['engagement_months', 'engagements'] }),
  engagement_margin: async (c, p, g) => IMPL.margin(c, p, g || 'engagement'),
  profit_per_partner: async (c, p, g) => {
    const [rev, ppl] = await Promise.all([emAgg(c, p, g), pplAgg(c, timeDim(g) ? null : g)]);
    const pc = Object.fromEntries(ppl.map(r => [r.key, r])); const months = monthsBetween(p.from, p.to) + 1;
    return { rows: rev.map(r => { const pp = timeDim(g) ? pc.all : pc[r.key]; if (!pp) return { key: r.key, value: null }; const overhead = pp.bs * 25000 * (g === 'month' ? 1 : g === 'quarter' ? 3 : months); const profit = r.billed - r.staff_cost - r.unrecovered - overhead; const ann = g === 'month' ? 12 : g === 'quarter' ? 4 : 12 / months; return { key: r.key, value: div(profit * ann, pp.partners), profit: profit * ann, partners: pp.partners, overhead: overhead * ann, revenue: r.billed * ann }; }), tables: ['engagement_months', 'engagements', 'people', 'plan'], note: 'Annualised. Overhead modelled from business-services headcount; distributable profit before partner remuneration', sensitive: 'partner_comp_aggregate' };
  },
  overhead_ratio: async (c, p, g) => {
    const [rev, ppl] = await Promise.all([emAgg(c, p, g), pplAgg(c, timeDim(g) ? null : g)]);
    const pc = Object.fromEntries(ppl.map(r => [r.key, r])); const months = monthsBetween(p.from, p.to) + 1;
    return { rows: rev.map(r => { const pp = timeDim(g) ? pc.all : pc[r.key]; if (!pp) return { key: r.key, value: null }; const overhead = pp.bs * 25000 * (g === 'month' ? 1 : g === 'quarter' ? 3 : months); return { key: r.key, value: div(overhead, r.billed), overhead, revenue: r.billed, bs_headcount: pp.bs }; }), tables: ['engagement_months', 'people'], note: 'Overhead modelled from business-services headcount' };
  },
  lockup_days: async (c, p, g) => {
    const P = new Params();
    const rows = await db.query(`SELECT ${groupExpr(g, 'inv') || "'all'"} AS key, COALESCE(SUM(CASE WHEN i.status<>'paid' THEN i.amount END),0) AS receivables FROM invoices i WHERE i.issue_date <= ${P.add(TODAY)} ${cutWhere(c, { region: 'i.region', unit: 'i.unit', client: 'i.client_id', engagement: 'i.engagement_id' }, P)} GROUP BY 1`, P.values);
    const rev = await emAgg(c, { from: addMonths(LAST_CLOSED, -2), to: LAST_CLOSED }, timeDim(g) ? null : g);
    const rm = Object.fromEntries(rev.map(r => [r.key, r]));
    return { rows: rows.map(r => { const rr = timeDim(g) ? rm.all : rm[r.key]; if (!rr) return { key: r.key, value: null }; const perDay = rr.billed / 91; return { key: fmtKey(r.key), value: div(r.receivables, perDay) + div(rr.unbilled_wip, perDay), debtor_days: div(r.receivables, perDay), wip_days: div(rr.unbilled_wip, perDay), receivables: r.receivables, wip: rr.unbilled_wip }; }), tables: ['invoices', 'engagement_months'], note: 'Revenue per day from the last 91 days' };
  },
  dso: async (c, p, g) => { const r = await IMPL.lockup_days(c, p, g); return { rows: r.rows.map(x => ({ key: x.key, value: x.debtor_days, receivables: x.receivables })), tables: ['invoices', 'engagement_months'] }; },
  cash_vs_forecast: async (c, p, g) => {
    const P = new Params();
    const coll = await db.query(`SELECT ${g === 'month' ? "date_trunc('month', i.paid_date)::date" : (groupExpr(g, 'inv') || "'all'")} AS key, COALESCE(SUM(i.amount),0) AS collected FROM invoices i WHERE i.paid_date BETWEEN ${P.add(p.from)} AND ${P.add(addMonths(p.to, 1))} ${cutWhere(c, { region: 'i.region', unit: 'i.unit', client: 'i.client_id' }, P)} GROUP BY 1 ORDER BY 1`, P.values);
    const P2 = new Params();
    const planRows = await db.query(`SELECT ${g === 'month' ? 'pl.month' : g === 'unit' ? 'pl.unit' : g === 'region' ? 'u.region' : "'all'"} AS key, SUM(pl.collections_plan) AS plan FROM plan pl JOIN units u ON u.id=pl.unit WHERE pl.month BETWEEN ${P2.add(p.from)} AND ${P2.add(p.to)} ${cutWhere(c, { region: 'u.region', unit: 'pl.unit' }, P2)} GROUP BY 1`, P2.values);
    const pm = Object.fromEntries(planRows.map(r => [fmtKey(r.key), r.plan]));
    return { rows: coll.map(r => ({ key: fmtKey(r.key), value: div(r.collected, pm[fmtKey(r.key)]), collected: r.collected, plan: pm[fmtKey(r.key)] })), tables: ['invoices', 'plan'] };
  },
  fx_impact: async (c, p, g) => {
    const rev = await emAgg(c, p, g);
    const P = new Params();
    const fx = await db.query(`SELECT currency, AVG(actual_rate/plan_rate - 1) AS move, AVG(revenue_share) AS share FROM fx_rates WHERE month BETWEEN ${P.add(p.from)} AND ${P.add(p.to)} GROUP BY 1`, P.values);
    const factor = fx.reduce((a, f) => a + f.share * f.move, 0);
    return { rows: rev.map(r => ({ key: r.key, value: r.billed * factor, revenue: r.billed, factor })), tables: ['engagement_months', 'fx_rates'], note: 'Revenue at actual rates minus revenue at plan rates, using currency revenue shares' };
  },
  plan_attainment: async (c, p, g) => {
    const rev = await emAgg(c, p, g);
    const P = new Params();
    const gk = g === 'month' ? 'pl.month' : g === 'quarter' ? "date_trunc('quarter', pl.month)::date" : g === 'year' ? "date_trunc('year', pl.month)::date" : g === 'unit' ? 'pl.unit' : g === 'region' ? 'u.region' : "'all'";
    const planRows = await db.query(`SELECT ${gk} AS key, SUM(pl.revenue_plan) AS plan FROM plan pl JOIN units u ON u.id=pl.unit WHERE pl.month BETWEEN ${P.add(p.from)} AND ${P.add(p.to)} ${cutWhere(c, { region: 'u.region', unit: 'pl.unit' }, P)} GROUP BY 1`, P.values);
    const pm = Object.fromEntries(planRows.map(r => [fmtKey(r.key), r.plan]));
    const planScoped = !c.practice && !c.client && !c.office && !c.engagement;
    return { rows: rev.map(r => ({ key: r.key, value: planScoped ? div(r.billed, pm[r.key]) : null, actual: r.billed, plan: planScoped ? pm[r.key] : null, gap: planScoped ? r.billed - (pm[r.key] || 0) : null })), tables: ['engagement_months', 'plan'], note: planScoped ? null : 'Plan is held by unit; no plan exists at this cut' };
  },
  realisation: async (c, p, g) => ({ rows: (await emAgg(c, p, g)).map(r => ({ key: r.key, value: div(r.billed, r.std), billed: r.billed, std: r.std, discount: r.discount, write_off: r.write_off, overrun: r.overrun, delayed: r.delayed })), tables: ['engagement_months', 'engagements'] }),
  collection_realisation: async (c, p, g) => {
    const P = new Params();
    const rows = await db.query(`SELECT ${groupExpr(g, 'inv') || "'all'"} AS key, SUM(amount) AS billed, SUM(CASE WHEN status='paid' THEN amount ELSE 0 END) AS paid FROM invoices i WHERE i.issue_date BETWEEN ${P.add(p.from)} AND ${P.add(addMonths(p.to, 1))} ${cutWhere(c, { region: 'i.region', unit: 'i.unit', client: 'i.client_id', engagement: 'i.engagement_id' }, P)} GROUP BY 1 ORDER BY 1`, P.values);
    return { rows: rows.map(r => ({ key: fmtKey(r.key), value: div(r.paid, r.billed), paid: r.paid, billed: r.billed })), tables: ['invoices'] };
  },
  effective_rate: async (c, p, g) => ({ rows: (await emAgg(c, p, g)).map(r => ({ key: r.key, value: div(r.billed, r.hours), billed: r.billed, hours: r.hours })), tables: ['engagement_months', 'engagements'] }),
  budget_burn: async (c, p, g) => {
    const rows = await engagementList(c, 'live');
    return { rows: rows.map(e => ({ key: e.id, label: e.id, value: div(e.hours_to_date, e.budget_hours), elapsed: e.elapsed, overrun_prob: e.overrun_prob, predicted_overrun_date: e.predicted_overrun_date, client: e.client_name, unit: e.unit, fee_model: e.fee_model })), tables: ['engagement_months', 'engagements'] };
  },
  eac: async (c, p, g) => { const rows = await engagementList(c, 'live'); return { rows: rows.map(e => ({ key: e.id, value: e.eac, budget_cost: e.budget_hours * e.standard_rate * 0.42, variance: e.eac - e.budget_hours * e.standard_rate * 0.42 })), tables: ['engagements', 'engagement_months'] }; },
  write_off_rate: async (c, p, g) => ({ rows: (await emAgg(c, p, g)).map(r => ({ key: r.key, value: div(r.write_off, r.std), write_off: r.write_off, std: r.std })), tables: ['engagement_months', 'engagements'] }),
  wip_ageing: async (c, p, g) => {
    const P = new Params();
    const rows = await db.query(`SELECT CASE WHEN em.month >= ${P.add(LAST_CLOSED)} THEN '0–30 days' WHEN em.month >= ${P.add(addMonths(LAST_CLOSED, -1))} THEN '31–60 days' WHEN em.month >= ${P.add(addMonths(LAST_CLOSED, -2))} THEN '61–90 days' ELSE 'over 90 days' END AS key, ${g && !timeDim(g) ? groupExpr(g, 'em') : "'all'"} AS dim, SUM(em.unbilled_wip) AS wip FROM engagement_months em JOIN engagements e ON e.id=em.engagement_id WHERE em.unbilled_wip > 0 ${cutWhere(c, ENG_DIMS, P)} GROUP BY 1,2 ORDER BY 1`, P.values);
    return { rows: rows.map(r => ({ key: r.key, dim: fmtKey(r.dim), value: r.wip })), tables: ['engagement_months'], bands: true };
  },
  fee_model_mix: async (c, p, g) => { const rows = await emAgg(c, p, 'fee_model'); const t = rows.reduce((a, r) => a + r.billed, 0); return { rows: rows.map(r => ({ key: r.key, value: div(r.billed, t), revenue: r.billed })), tables: ['engagement_months', 'engagements'] }; },
  scope_change_rate: async (c, p, g) => { const P = new Params(); const rows = await db.query(`SELECT ${groupExpr(g, 'e') || "'all'"} AS key, COUNT(*)::int AS n, SUM(CASE WHEN scope_changes>0 THEN 1 ELSE 0 END)::int AS changed FROM engagements e WHERE e.start_date BETWEEN ${P.add(p.from)} AND ${P.add(addMonths(p.to, 1))} ${cutWhere(c, ENG_DIMS, P)} GROUP BY 1 ORDER BY 1`, P.values); return { rows: rows.map(r => ({ key: fmtKey(r.key), value: div(r.changed, r.n), engagements: r.n })), tables: ['engagements'] }; },
  utilisation: async (c, p, g) => ({ rows: (await pmAgg(c, p, g)).map(r => ({ key: r.key, value: div(r.chargeable, r.available), chargeable: r.chargeable, available: r.available, people: r.people })), tables: ['person_months', 'people'] }),
  bench_rate: async (c, p, g) => ({ rows: (await pmAgg(c, p, g)).map(r => ({ key: r.key, value: div(r.bench_months, r.rows), bench: r.bench_months, people: r.people })), tables: ['person_months', 'people'] }),
  leverage: async (c, p, g) => ({ rows: (await pplAgg(c, timeDim(g) ? null : g)).map(r => ({ key: r.key, value: div(r.professionals, r.partners), professionals: r.professionals, partners: r.partners })), tables: ['people'] }),
  staffing_fill_rate: async (c, p, g) => { const P = new Params(); const rows = await db.query(`SELECT ${g === 'unit' ? 's.unit' : g === 'level' ? 's.level' : "'all'"} AS key, COUNT(*)::int AS requested, SUM(CASE WHEN status='filled' THEN 1 ELSE 0 END)::int AS filled, AVG(CASE WHEN filled_date IS NOT NULL THEN filled_date - requested_date END) AS days FROM staffing_roles s WHERE 1=1 ${cutWhere(c, { unit: 's.unit', level: 's.level', engagement: 's.engagement_id' }, P)} GROUP BY 1`, P.values); return { rows: rows.map(r => ({ key: fmtKey(r.key), value: div(r.filled, r.requested), filled: r.filled, requested: r.requested, days: r.days })), tables: ['staffing_roles'] }; },
  time_to_staff: async (c, p, g) => { const r = await IMPL.staffing_fill_rate(c, p, g); return { rows: r.rows.map(x => ({ key: x.key, value: x.days, filled: x.filled })), tables: ['staffing_roles'] }; },
  regretted_attrition: async (c, p, g) => {
    if (timeDim(g)) {
      const rows = []; const months = []; for (let m = p.from; m <= p.to; m = addMonths(m, 1)) months.push(m);
      for (const m of months) {
        const P = new Params(); const start = addMonths(m, -11); const end = addMonths(m, 1);
        const r = await db.one(`SELECT SUM(CASE WHEN p.status='left' AND p.regretted AND p.left_date >= ${P.add(start)} AND p.left_date < ${P.add(end)} THEN 1 ELSE 0 END)::int AS regretted, SUM(CASE WHEN p.hire_date < $2 AND (p.left_date IS NULL OR p.left_date >= $2) THEN 1 ELSE 0 END)::int AS headcount FROM people p WHERE p.client_service AND p.type='employee' ${cutWhere(c, PPL_DIMS, P)}`, P.values);
        rows.push({ key: m, value: div(r.regretted, r.headcount), regretted: r.regretted, headcount: r.headcount });
      }
      return { rows, tables: ['people'], note: 'Trailing twelve months at each month end' };
    }
    const P = new Params(); const from = addMonths(LAST_CLOSED, -11);
    const rows = await db.query(`SELECT ${groupExpr(g, 'p') && !timeDim(g) ? groupExpr(g, 'p') : "'all'"} AS key, SUM(CASE WHEN p.status='left' AND p.regretted AND p.left_date >= ${P.add(from)} THEN 1 ELSE 0 END)::int AS regretted, SUM(CASE WHEN p.status='left' AND p.left_date >= $1 THEN 1 ELSE 0 END)::int AS leavers, SUM(CASE WHEN p.status='active' THEN 1 ELSE 0 END)::int AS headcount FROM people p WHERE p.client_service AND p.type='employee' ${cutWhere(c, PPL_DIMS, P)} GROUP BY 1 ORDER BY 1`, P.values);
    return { rows: rows.map(r => ({ key: fmtKey(r.key), value: div(r.regretted, r.headcount), regretted: r.regretted, leavers: r.leavers, headcount: r.headcount })), tables: ['people'], note: 'Last twelve months, annualised against active headcount' };
  },
  promotion_velocity: async (c, p, g) => ({ rows: (await pplAgg(c, timeDim(g) ? 'level' : (g || 'level'), " AND p.client_service AND p.type='employee' AND p.level<>'PARTNER'")).map(r => ({ key: r.key, value: r.months_in_level, people: r.people })), tables: ['people'] }),
  sustained_hours: async (c, p, g) => ({ rows: (await pplAgg(c, timeDim(g) ? null : g, " AND p.client_service AND p.type='employee'")).map(r => ({ key: r.key, value: div(r.sustained, r.people), people: r.people, sustained: r.sustained })), tables: ['people', 'person_months'] }),
  engagement_score: async (c, p, g) => ({ rows: (await pplAgg(c, timeDim(g) ? null : g, " AND p.type='employee'")).map(r => ({ key: r.key, value: r.engagement_score, people: r.people })), tables: ['people'], source: 'stub:glint (aggregated only)' }),
  learning_hours: async (c, p, g) => ({ rows: (await pplAgg(c, timeDim(g) ? null : g, " AND p.type='employee'")).map(r => ({ key: r.key, value: r.learning_hours, people: r.people })), tables: ['people'], source: 'stub:degreed' }),
  recruiting_conversion: async (c, p, g) => {
    const P = new Params();
    const rows = await db.query(`SELECT ${g === 'region' ? 'u.region' : g === 'unit' ? 'pl.unit' : "'all'"} AS key, SUM(pl.headcount_plan)::int AS plan FROM plan pl JOIN units u ON u.id=pl.unit WHERE pl.month = ${P.add(LAST_CLOSED)} ${cutWhere(c, { region: 'u.region', unit: 'pl.unit' }, P)} GROUP BY 1`, P.values);
    const ppl = await pplAgg(c, g === 'region' || g === 'unit' ? g : null, " AND p.type='employee'");
    const hm = Object.fromEntries(ppl.map(r => [r.key, r.people]));
    return { rows: rows.map(r => ({ key: fmtKey(r.key), value: 0.78 + ((hm[fmtKey(r.key)] || 0) % 7) / 100, hires_vs_plan: div(hm[fmtKey(r.key)], r.plan), headcount: hm[fmtKey(r.key)], headcount_plan: r.plan })), tables: ['plan', 'people'], source: 'stub:taleo', note: 'Offer acceptance seeded; hires against plan from headcount and Anaplan plan' };
  },
  time_entry_compliance: async (c, p, g) => ({ rows: (await pmAgg(c, p, g)).map(r => ({ key: r.key, value: 1 - div(r.ts_late, r.ts_due), late: r.ts_late, due: r.ts_due })), tables: ['person_months'] }),
  pipeline_value: async (c, p, g) => oppAgg(c, g, "o.outcome IS NULL", r => ({ key: r.key, value: r.value, count: r.n })),
  weighted_pipeline: async (c, p, g) => oppAgg(c, g, "o.outcome IS NULL", r => ({ key: r.key, value: r.weighted, pipeline: r.value, count: r.n })),
  win_rate: async (c, p, g) => oppAgg(c, g, `o.outcome IS NOT NULL AND o.decided_date >= '${addMonths(LAST_CLOSED, -11)}'`, r => ({ key: r.key, value: div(r.won, r.n), won: r.won, decided: r.n, value_won: r.won_value, value_decided: r.value })),
  proposal_cycle_time: async (c, p, g) => oppAgg(c, g, `o.outcome IS NOT NULL AND o.decided_date >= '${addMonths(LAST_CLOSED, -11)}'`, r => ({ key: r.key, value: r.cycle, decided: r.n })),
  book_to_bill: async (c, p, g) => {
    const [opp, rev] = await Promise.all([oppAgg(c, timeDim(g) ? null : g, `o.outcome='won' AND o.decided_date BETWEEN '${p.from}' AND '${addMonths(p.to, 1)}'`, r => r), emAgg(c, p, timeDim(g) ? null : g)]);
    const rm = Object.fromEntries(rev.map(r => [r.key, r.billed]));
    return { rows: opp.rows.map(r => ({ key: r.key, value: div(r.won_value, rm[r.key]), bookings: r.won_value, revenue: rm[r.key] })), tables: ['opportunities', 'engagement_months'] };
  },
  client_concentration: async (c, p, g) => {
    const rows = await emAgg(c, p, 'client'); rows.sort((a, b) => b.billed - a.billed); const t = rows.reduce((a, r) => a + r.billed, 0);
    const top = n => rows.slice(0, n).reduce((a, r) => a + r.billed, 0) / t;
    return { rows: [{ key: 'Top 20', value: top(20) }, { key: 'Top 50', value: top(50) }, { key: 'Top 10', value: top(10) }], top_clients: rows.slice(0, 20).map(r => ({ client: r.key, revenue: r.billed, share: r.billed / t })), tables: ['engagement_months', 'engagements'] };
  },
  account_growth: async (c, p, g) => IMPL.revenue_growth(c, p, g || 'client'),
  cross_practice_penetration: async (c, p, g) => {
    const P = new Params();
    const rows = await db.query(`SELECT ${g && !timeDim(g) && g !== 'client' ? groupExpr(g, 'e') : "'all'"} AS key, COUNT(DISTINCT e.client_id)::int AS clients, COUNT(DISTINCT e.client_id || e.practice)::int AS pairs, SUM(CASE WHEN x.n=1 THEN 1 ELSE 0 END)::int AS single FROM engagements e JOIN (SELECT client_id, COUNT(DISTINCT practice) n FROM engagements WHERE start_date >= ${P.add(p.from)} GROUP BY 1) x ON x.client_id=e.client_id WHERE e.start_date >= $1 ${cutWhere(c, ENG_DIMS, P)} GROUP BY 1`, P.values);
    return { rows: rows.map(r => ({ key: fmtKey(r.key), value: div(r.pairs, r.clients), clients: r.clients })), tables: ['engagements'] };
  },
  repeat_business: async (c, p, g) => {
    const P = new Params();
    const rows = await db.query(`SELECT ${groupExpr(g, 'em') || "'all'"} AS key, SUM(em.billed) AS billed, SUM(CASE WHEN EXISTS (SELECT 1 FROM engagements e2 WHERE e2.client_id=e.client_id AND e2.start_date < e.start_date - INTERVAL '1 day' AND e2.start_date >= e.start_date - INTERVAL '2 years') THEN em.billed ELSE 0 END) AS repeat FROM engagement_months em JOIN engagements e ON e.id=em.engagement_id WHERE em.month BETWEEN ${P.add(p.from)} AND ${P.add(p.to)} ${cutWhere(c, ENG_DIMS, P)} GROUP BY 1 ORDER BY 1`, P.values);
    return { rows: rows.map(r => ({ key: fmtKey(r.key), value: div(r.repeat, r.billed) })), tables: ['engagement_months', 'engagements'] };
  },
  new_clients: async (c, p, g) => oppAgg(c, g, `o.outcome='won' AND o.is_new_client AND o.decided_date BETWEEN '${p.from}' AND '${addMonths(p.to, 1)}'`, r => ({ key: r.key, value: r.n, value_won: r.won_value })),
  client_satisfaction: async (c, p, g) => {
    const P = new Params();
    const rows = await db.query(`SELECT ${g && !timeDim(g) ? ({ region: 'c.region', unit: 'c.unit', industry: 'c.industry', client: 'c.id' }[g] || "'all'") : "'all'"} AS key, AVG(c.satisfaction) AS value, AVG(c.satisfaction_prev) AS prev, COUNT(*)::int AS clients FROM clients c WHERE c.satisfaction IS NOT NULL ${cutWhere(c, { region: 'c.region', unit: 'c.unit', industry: 'c.industry', client: 'c.id' }, P)} GROUP BY 1`, P.values);
    return { rows: rows.map(r => ({ key: fmtKey(r.key), value: r.value, prev: r.prev, clients: r.clients })), tables: ['clients'], source: 'stub:client-feedback' };
  },
  origination_credit: async (c, p, g) => { const r = await emAgg({ ...c, partner: c.partner }, p, g || 'partner'); return { rows: r.map(x => ({ key: x.key, value: x.billed })), tables: ['engagement_months', 'engagements'], sensitive: 'partner_comp' }; },
  delivery_credit: async (c, p, g) => IMPL.origination_credit(c, p, g),
  personal_pipeline_coverage: async (c, p, g) => oppAgg(c, g || 'partner', "o.outcome IS NULL", r => ({ key: r.key, value: div(r.weighted, 6e6), weighted: r.weighted, target: 6e6 })),
  relationship_breadth: async (c, p, g) => { const P = new Params(); const rows = await db.query(`SELECT ${g === 'client' ? 'ct.client_id' : g === 'partner' ? 'ct.kearney_person_id' : "'all'"} AS key, COUNT(*)::int AS value, SUM(CASE WHEN ct.last_contact < ${P.add(TODAY)}::date - 90 OR ct.last_contact IS NULL THEN 1 ELSE 0 END)::int AS decayed FROM contacts ct WHERE 1=1 ${cutWhere(c, { client: 'ct.client_id', partner: 'ct.kearney_person_id' }, P)} GROUP BY 1`, P.values); return { rows: rows.map(r => ({ key: fmtKey(r.key), value: r.value, decayed: r.decayed })), tables: ['contacts'] }; },
  team_leverage_realisation: async (c, p, g) => IMPL.realisation(c, p, g || 'partner'),
  counselling_load: async (c, p, g) => { const P = new Params(); const rows = await db.query(`SELECT ${g === 'unit' ? 'p.unit' : g === 'office' ? 'p.office' : "'all'"} AS key, COUNT(*)::numeric / NULLIF(COUNT(DISTINCT p.counsellor_id),0) AS value, COUNT(DISTINCT p.counsellor_id)::int AS counsellors, MAX(x.n) AS max_load FROM people p JOIN (SELECT counsellor_id, COUNT(*) n FROM people WHERE status='active' AND counsellor_id IS NOT NULL GROUP BY 1) x ON x.counsellor_id=p.counsellor_id WHERE p.status='active' AND p.counsellor_id IS NOT NULL ${cutWhere(c, PPL_DIMS, P)} GROUP BY 1`, P.values); return { rows: rows.map(r => ({ key: fmtKey(r.key), value: r.value, counsellors: r.counsellors, max_load: r.max_load })), tables: ['people'] }; },
  ip_reuse_rate: async (c, p, g) => { const P = new Params(); const rows = await db.query(`SELECT ${groupExpr(g, 'e') && !timeDim(g) ? groupExpr(g, 'e') : "'all'"} AS key, COUNT(*)::int AS n, SUM(CASE WHEN reuses_asset THEN 1 ELSE 0 END)::int AS reuse FROM engagements e WHERE e.start_date BETWEEN ${P.add(p.from)} AND ${P.add(addMonths(p.to, 1))} ${cutWhere(c, ENG_DIMS, P)} GROUP BY 1`, P.values); return { rows: rows.map(r => ({ key: fmtKey(r.key), value: div(r.reuse, r.n), engagements: r.n })), tables: ['engagements'], source: 'stub:beehive' }; },
  expert_network_use: async (c, p, g) => { const P = new Params(); const rows = await db.query(`SELECT ${groupExpr(g, 'e') && !timeDim(g) ? groupExpr(g, 'e') : "'all'"} AS key, AVG(expert_calls) AS value, SUM(expert_calls)::int AS calls, SUM(expert_calls)*1200 AS cost FROM engagements e WHERE e.start_date BETWEEN ${P.add(p.from)} AND ${P.add(addMonths(p.to, 1))} ${cutWhere(c, ENG_DIMS, P)} GROUP BY 1`, P.values); return { rows: rows.map(r => ({ key: fmtKey(r.key), value: r.value, calls: r.calls, cost: r.cost })), tables: ['engagements'], source: 'stub:expert-tracker' }; },
  research_reach: async () => { const rows = await db.query(`SELECT title AS key, downloads AS value, citations, attributed_leads, attributed_pipeline FROM knowledge_assets WHERE is_public ORDER BY downloads DESC`); return { rows, tables: ['knowledge_assets'], source: 'public titles; usage stub:web-analytics' }; },
  knowledge_search_success: async () => { const rows = await db.query(`SELECT topic AS key, opened::numeric/searches AS value, searches, opened FROM knowledge_search_topics ORDER BY 2`); const t = rows.reduce((a, r) => a + r.searches, 0), o = rows.reduce((a, r) => a + r.opened, 0); return { rows, total: { value: o / t, searches: t, opened: o }, tables: ['knowledge_search_topics'], source: 'stub:glean' }; }
};
function timeDim(g) { return g === 'month' || g === 'quarter' || g === 'year'; }
function shiftKey(key, g, months) { if (!timeDim(g)) return key; return addMonths(key, months); }
async function oppAgg(c, g, where, map) {
  const P = new Params();
  const rows = await db.query(`SELECT ${(g && groupExpr(g, 'opp')) || "'all'"} AS key, COUNT(*)::int AS n, COALESCE(SUM(o.value),0) AS value, COALESCE(SUM(o.value*o.win_prob),0) AS weighted,
    SUM(CASE WHEN o.outcome='won' THEN 1 ELSE 0 END)::int AS won, COALESCE(SUM(CASE WHEN o.outcome='won' THEN o.value END),0) AS won_value, AVG(o.decided_date - o.created_date) AS cycle
    FROM opportunities o WHERE ${where} ${cutWhere(c, { region: 'o.region', unit: 'o.unit', practice: 'o.practice', industry: 'o.industry', client: 'o.client_id', partner: 'o.partner_id', stage: 'o.stage' }, P)} GROUP BY 1 ORDER BY 1`, P.values);
  return { rows: rows.map(r => map({ ...r, key: fmtKey(r.key) })), tables: ['opportunities'] };
}
async function engagementList(cut, status) {
  const P = new Params();
  const rows = await db.query(`SELECT e.*, c.name AS client_name, c.is_public, x.hours_to_date, x.billed_to_date, x.std_to_date, x.cost_to_date,
      GREATEST(0.02, LEAST(1, (${P.add(TODAY)}::date - e.start_date)::numeric / NULLIF(e.end_date - e.start_date,0))) AS elapsed
    FROM engagements e JOIN clients c ON c.id=e.client_id
    LEFT JOIN (SELECT engagement_id, SUM(hours) hours_to_date, SUM(billed) billed_to_date, SUM(standard_value) std_to_date, SUM(staff_cost) cost_to_date FROM engagement_months GROUP BY 1) x ON x.engagement_id=e.id
    WHERE 1=1 ${status ? `AND e.status='${status}'` : ''} ${cutWhere(cut, ENG_DIMS, P)} ORDER BY e.overrun_prob DESC NULLS LAST, e.budget_fees DESC`, P.values);
  return rows;
}

// ---------- public API ----------
async function compute(metricId, { cut = {}, period, groupBy = null } = {}) {
  const m = catalogue.byId[metricId]; if (!m) throw new Error('Unknown metric ' + metricId);
  const impl = IMPL[m.impl]; if (!impl) return { metric: m, rows: [], lineage: lineage(m, cut, period, [], 0, 'catalogue only') };
  const p = typeof period === 'string' || !period ? periodFor(period || 'ltm') : period;
  const t0 = Date.now();
  const res = await impl(cut, p, groupBy);
  const rows = (res.rows || []).map(r => ({ ...r, label: r.label || ref.labelOf(groupBy || 'all', r.key) }));
  const total = res.total || totalOf(m, rows);
  return { metric: m, period: p, cut, groupBy, rows, total, note: res.note || null, extra: res.top_clients ? { top_clients: res.top_clients } : null, bands: res.bands || false, lineage: lineage(m, cut, p, res.tables || [], rows.length, res.source, Date.now() - t0, res.note) };
}
function totalOf(m, rows) {
  if (!rows.length) return { value: null };
  if (rows.length === 1) return { value: rows[0].value };
  if (m.format === 'money' && m.id !== 'revenue_per_partner' && m.id !== 'revenue_per_professional' && m.id !== 'profit_per_partner' && m.id !== 'effective_rate' && m.id !== 'eac') return { value: rows.reduce((a, r) => a + (r.value || 0), 0) };
  if (m.id === 'wip_ageing' || m.id === 'pipeline_value' || m.id === 'weighted_pipeline' || m.id === 'new_clients') return { value: rows.reduce((a, r) => a + (r.value || 0), 0) };
  const vals = rows.filter(r => r.value !== null && r.value !== undefined);
  return { value: vals.length ? vals.reduce((a, r) => a + r.value, 0) / vals.length : null, note: 'simple average of members' };
}
function lineage(m, cut, p, tables, rowCount, sourceOverride, ms, note) {
  return {
    metric: m.id, name: m.name, formula: m.formula, owner: m.owner, source_system: m.source, stub: sourceOverride || [...new Set(tables.map(t => STUB[t] || 'stub'))].join(', '),
    tables, filters: cut, period: p ? { from: p.from, to: p.to, label: p.label } : null, row_count: rowCount, refreshed_at: config.demoToday + 'T05:30:00Z',
    query_ms: ms || 0, seeded: config.demoMode, note: note || null, path: ['Source system', 'Connector stub (demo) / ADF to OneLake (live)', 'Lakehouse table', 'Semantic model: ' + m.name, 'Query Agent', 'Visual']
  };
}
module.exports = { compute, periodFor, priorYear, priorPeriod, addMonths, monthLabel, quarterLabel, quarterStart, monthsBetween, emAgg, pmAgg, pplAgg, engagementList, oppAgg, Params, cutWhere, ENG_DIMS, PPL_DIMS, LAST_CLOSED, TODAY, monthOf };
