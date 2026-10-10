'use strict';
// Role workspaces (screens 4 to 13) and governance screens (14 to 16): each endpoint composes metric engine calls and agent outputs.
const express = require('express');
const db = require('../db');
const engine = require('../metrics/engine');
const ref = require('../metrics/refcache');
const forecast = require('../agents/forecast');
const variance = require('../agents/variance');
const pipeline = require('../agents/pipeline');
const engagement = require('../agents/engagement');
const talent = require('../agents/talent');
const staffing = require('../agents/staffing');
const client360 = require('../agents/client360');
const scenario = require('../agents/scenario');
const cash = require('../agents/cash');
const observatory = require('../agents/observatory');
const action = require('../agents/action');

const router = express.Router();
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });
const cutFrom = q => { const cut = {}; for (const d of ['region', 'unit', 'office', 'practice', 'industry', 'level', 'client', 'engagement']) if (q[d]) cut[d] = q[d]; return cut; };

router.get('/firm', wrap(async (req, res) => {
  const r = ref.get();
  const [rev, pa, ly] = await Promise.all([engine.compute('net_fee_revenue', { period: 'ytd', groupBy: 'unit' }), engine.compute('plan_attainment', { period: 'ytd', groupBy: 'unit' }), engine.compute('net_fee_revenue', { period: engine.priorYear(engine.periodFor('ytd')), groupBy: 'unit' })]);
  const paMap = Object.fromEntries(pa.rows.map(x => [x.key, x])); const lyMap = Object.fromEntries(ly.rows.map(x => [x.key, x.value]));
  const points = rev.rows.map(x => { const offices = r.offices.filter(o => o.unit === x.key).sort((a, b) => b.users - a.users); const o = offices[0]; const users = offices.reduce((a, b) => a + b.users, 0); return { unit: x.key, label: x.label, region: r.unitById[x.key].region, lat: o ? o.lat : 0, lon: o ? o.lon : 0, revenue: x.value, plan: paMap[x.key] ? paMap[x.key].plan : null, attainment: paMap[x.key] ? paMap[x.key].value : null, growth: lyMap[x.key] ? x.value / lyMap[x.key] - 1 : null, users, offices: offices.length }; });
  const [fc, risk] = await Promise.all([forecast.revenue({ cut: {}, horizon: { toYearEnd: true } }), forecast.unitsAtRisk({ cut: {} })]);
  const ltm = engine.periodFor('ltm'); const prior = engine.priorPeriod(ltm);
  const tree = await variance.explain({ metricId: 'profit_per_partner', cut: {}, period: ltm, comparePeriod: prior });
  const byRegion = await engine.compute('plan_attainment', { period: 'ytd', groupBy: 'region' });
  res.json({ points, forecast: { visual: fc.visual, fullYear: fc.fullYear, narrative: fc.narrative, model: fc.model }, tree, gaps: risk.units.slice(0, 10), gapsVisual: risk.visual, regions: byRegion.rows, seeded: true });
}));

router.get('/region/:region', wrap(async (req, res) => {
  const region = req.params.region; const cut = { region };
  const q = engine.periodFor('qtd'); const lq = engine.periodFor('last_quarter');
  const [rev, pa, growth, util, real, pipe, score, bench] = await Promise.all([
    engine.compute('net_fee_revenue', { cut, period: q, groupBy: 'unit' }), engine.compute('plan_attainment', { cut, period: q, groupBy: 'unit' }), engine.compute('revenue_growth', { cut, period: q, groupBy: 'unit' }),
    engine.compute('utilisation', { cut, period: lq, groupBy: 'unit' }), engine.compute('billing_realisation', { cut, period: lq, groupBy: 'unit' }), engine.compute('weighted_pipeline', { cut, groupBy: 'unit' }), engine.compute('engagement_score', { cut, groupBy: 'unit' }), engine.compute('bench_rate', { cut, period: 'last_month', groupBy: 'unit' })
  ]);
  const m = (r, k) => { const x = r.rows.find(y => y.key === k); return x ? x.value : null; };
  const league = rev.rows.map(x => ({ unit: x.key, label: x.label, revenue: x.value, attainment: m(pa, x.key), growth: m(growth, x.key), utilisation: m(util, x.key), realisation: m(real, x.key), pipeline: m(pipe, x.key), engagement_score: m(score, x.key), bench: m(bench, x.key) })).sort((a, b) => (a.attainment || 0) - (b.attainment || 0));
  // utilisation heatmap unit × level
  const P = new engine.Params();
  const hm = await db.query(`SELECT p.unit, p.level, SUM(pm.chargeable_hours)/NULLIF(SUM(pm.available_hours),0) AS util, COUNT(DISTINCT p.id)::int AS people FROM person_months pm JOIN people p ON p.id=pm.person_id WHERE pm.month BETWEEN ${P.add(lq.from)} AND ${P.add(lq.to)} AND p.region=${P.add(region)} AND p.client_service AND p.type='employee' GROUP BY 1,2`, P.values);
  const levels = ['PARTNER', 'AP', 'PRINCIPAL', 'MANAGER', 'ASSOCIATE', 'BA']; const units = league.map(l => l.unit);
  const heat = { x: units.map(u => ref.labelOf('unit', u)), y: levels.map(l => ref.labelOf('level', l)), cells: hm.map(h => ({ x: units.indexOf(h.unit), y: levels.indexOf(h.level), value: h.util, n: h.people })).filter(c => c.x >= 0), unitKeys: units, levelKeys: levels, targets: Object.fromEntries(r().levels.map(l => [l.id, l.util_target])) };
  // cross-border flows: delivering office unit → engagement unit, within or into the region
  const P2 = new engine.Params();
  const flows = await db.query(`SELECT o.unit AS from_unit, e.unit AS to_unit, SUM(em.hours) AS hours FROM engagement_months em JOIN engagements e ON e.id=em.engagement_id JOIN offices o ON o.id=e.office WHERE em.month BETWEEN ${P2.add(q.from)} AND ${P2.add(q.to)} AND e.region=${P2.add(region)} AND o.unit<>e.unit GROUP BY 1,2 HAVING SUM(em.hours) > 200 ORDER BY 3 DESC LIMIT 25`, P2.values);
  const trendRows = await engine.compute('utilisation', { cut, period: 'last_6m', groupBy: 'month' });
  res.json({ region, label: ref.labelOf('region', region), period: q, league, heat, flows: flows.map(f => ({ ...f, from: ref.labelOf('unit', f.from_unit), to: ref.labelOf('unit', f.to_unit) })), utilTrend: trendRows.rows, seeded: true });
  function r() { return ref.get(); }
}));

router.get('/practice/:practice', wrap(async (req, res) => {
  const practice = req.params.practice; const cut = { practice };
  const [trend, byInd, win, ipr, rev, growth, winByPractice] = await Promise.all([
    engine.compute('net_fee_revenue', { cut, period: 'last_3y', groupBy: 'quarter' }), engine.compute('revenue_growth', { cut, period: 'ytd', groupBy: 'industry' }), engine.compute('win_rate', { cut, groupBy: 'industry' }), engine.compute('ip_reuse_rate', { cut, period: 'ltm' }),
    engine.compute('net_fee_revenue', { cut, period: 'ytd' }), engine.compute('revenue_growth', { cut, period: 'ytd' }), engine.compute('win_rate', { groupBy: 'practice' })
  ]);
  const mk = await staffing.marketplace({});
  // white-space matrix: top 12 clients in the practice's industries × practices (revenue last 2 years)
  const matrixRows = await db.query(`SELECT c.id, c.name, c.fortune_g500, c.relationship_partner, e.practice, SUM(x.billed) AS revenue FROM clients c JOIN engagements e ON e.client_id=c.id JOIN (SELECT engagement_id, SUM(billed) billed FROM engagement_months WHERE month >= '2024-10-01' GROUP BY 1) x ON x.engagement_id=e.id WHERE c.id IN (SELECT e2.client_id FROM engagements e2 JOIN engagement_months m2 ON m2.engagement_id=e2.id WHERE m2.month >= '2024-10-01' GROUP BY 1 ORDER BY SUM(m2.billed) DESC LIMIT 14) GROUP BY 1,2,3,4,5`);
  const clients = [...new Set(matrixRows.map(r => r.id))].map(id => { const rows = matrixRows.filter(r => r.id === id); return { id, name: rows[0].name, fortune_g500: rows[0].fortune_g500, partner: rows[0].relationship_partner, total: rows.reduce((a, r) => a + r.revenue, 0), cells: Object.fromEntries(rows.map(r => [r.practice, r.revenue])) }; }).sort((a, b) => b.total - a.total);
  const fg500 = await db.query(`SELECT COUNT(*) FILTER (WHERE fortune_g500)::int AS fg500_clients, COUNT(*)::int AS clients FROM clients WHERE is_public OR name LIKE 'Client%'`);
  res.json({ practice, label: ref.labelOf('practice', practice), revenue: rev.total.value, growth: growth.total.value, trend: trend.rows, byIndustry: byInd.rows, winByIndustry: win.rows, winByPractice: winByPractice.rows, ipReuse: ipr.total.value, skills: mk.skills, matrix: { clients, practices: ref.get().practices }, fg500: fg500[0], seeded: true });
}));

router.get('/account/:client', wrap(async (req, res) => { const a = await client360.account(req.params.client); if (!a) return res.status(404).json({ error: 'unknown client' }); res.json(a); }));
router.get('/engagements', wrap(async (req, res) => { const cut = cutFrom(req.query); if (req.query.ids) cut.engagement = req.query.ids.split(','); const b = await engagement.board({ cut, limit: parseInt(req.query.limit || '20', 10) }); const first = req.query.focus || (b.engagements[0] && b.engagements[0].id); const bd = first ? await engagement.burndown(first) : null; res.json({ board: b, burndown: bd }); }));
router.get('/burndown/:id', wrap(async (req, res) => res.json(await engagement.burndown(req.params.id))));
router.get('/talent', wrap(async (req, res) => {
  const cut = cutFrom(req.query);
  const [pyr, heat, attr] = await Promise.all([talent.pyramid({ cut }), talent.heatmap({ cut, level: req.query.level || null }), engine.compute('regretted_attrition', { cut, groupBy: 'unit' })]);
  const P = new engine.Params();
  const leavers = await db.query(`SELECT date_trunc('month', left_date)::date AS month, COUNT(*)::int AS leavers, SUM(CASE WHEN regretted THEN 1 ELSE 0 END)::int AS regretted FROM people p WHERE status='left' AND left_date >= '2025-01-01' ${engine.cutWhere(cut, engine.PPL_DIMS, P)} GROUP BY 1 ORDER BY 1`, P.values);
  const P2 = new engine.Params();
  const promo = await db.query(`SELECT p.level, COUNT(*)::int AS n, SUM(CASE WHEN p.months_in_level >= l.typical_months_in_level THEN 1 ELSE 0 END)::int AS ready FROM people p JOIN levels l ON l.id=p.level WHERE p.status='active' AND p.client_service AND p.type='employee' AND p.level<>'PARTNER' ${engine.cutWhere(cut, engine.PPL_DIMS, P2)} GROUP BY 1`, P2.values);
  const P3 = new engine.Params();
  const sustained = await db.query(`SELECT p.unit, COUNT(*)::int AS n FROM people p WHERE p.status='active' AND p.sustained_weeks >= 4 ${engine.cutWhere(cut, engine.PPL_DIMS, P3)} GROUP BY 1 ORDER BY 2 DESC`, P3.values);
  const score = await engine.compute('engagement_score', { cut, groupBy: 'unit' });
  res.json({ pyramid: pyr, heatmap: heat, attrition: attr.rows, leavers: leavers.map(l => ({ ...l, month: typeof l.month === 'string' ? l.month : l.month.toISOString().slice(0, 10) })), promotion: promo.map(p => ({ ...p, label: ref.labelOf('level', p.level) })), sustained: sustained.map(s => ({ ...s, label: ref.labelOf('unit', s.unit) })), engagementScore: score.rows, seeded: true });
}));
router.get('/staffing', wrap(async (req, res) => { const cut = cutFrom(req.query); const mk = await staffing.marketplace({ cut }); const roll = await staffing.rollingOff({ cut, weeks: 8 }); res.json({ marketplace: mk, rollingOff: roll.people, seeded: true }); }));
router.get('/pipeline', wrap(async (req, res) => { const cut = cutFrom(req.query); const room = await pipeline.room({ cut }); const winTrend = await engine.compute('win_rate', { cut, groupBy: 'practice' }); res.json({ room, winByPractice: winTrend.rows, seeded: true }); }));
router.get('/forecast', wrap(async (req, res) => { const cut = cutFrom(req.query); const [fc, risk, base] = await Promise.all([forecast.revenue({ cut, horizon: { toYearEnd: true } }), forecast.unitsAtRisk({ cut }), scenario.baseline(cut)]); res.json({ forecast: fc, units: risk, baseline: base, seeded: true }); }));
router.post('/scenario', wrap(async (req, res) => { const { cut, scenarios } = req.body; if (scenarios && scenarios.length > 1) return res.json(await scenario.compare({ cut: cut || {}, scenarios })); res.json(await scenario.run({ cut: cut || {}, scenario: scenarios ? scenarios[0].scenario : req.body.scenario, label: scenarios ? scenarios[0].label : req.body.label })); }));
router.get('/cash', wrap(async (req, res) => {
  const cut = cutFrom(req.query);
  const [lock, wip, late, held] = await Promise.all([engine.compute('lockup_days', { cut, groupBy: 'unit' }), engine.compute('wip_ageing', { cut, groupBy: 'unit' }), cash.lateInvoices({ cut, limit: 15 }), cash.wipHeldByTimesheets({ cut })]);
  const dsoTrend = await engine.compute('collection_realisation', { cut, period: 'ltm', groupBy: 'month' });
  res.json({ lockup: lock.rows, wip: wip.rows, late, held, collectionTrend: dsoTrend.rows, seeded: true });
}));
router.get('/observatory', wrap(async (req, res) => { const [s, t, a] = await Promise.all([observatory.summary(), observatory.tickets(), observatory.adoption()]); res.json({ summary: s, tickets: t, adoption: a }); }));
router.get('/actions', wrap(async (req, res) => res.json(await action.list())));
module.exports = router;
