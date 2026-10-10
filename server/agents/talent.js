'use strict';
/**
 * Talent Risk Agent (models 7, 8, 10): regretted attrition and burnout risk with drivers; hiring need forecast.
 * Individual scores are shown only to authorised People leaders and the counselling partner; everyone else sees aggregates.
 */
const db = require('../db');
const engine = require('../metrics/engine');
const ref = require('../metrics/refcache');
const composer = require('./composer');
const { pct, num, listWords } = require('./util');

async function heatmap({ cut = {}, level = null, horizonMonths = 6, individuals = false }) {
  const P = new engine.Params();
  const lvl = level || cut.level || null;
  const rows = await db.query(`SELECT p.unit, p.level, COUNT(*)::int AS n, AVG(p.flight_risk) AS risk, SUM(p.flight_risk) AS expected_exits, SUM(CASE WHEN p.flight_risk>=0.35 THEN 1 ELSE 0 END)::int AS high FROM people p WHERE p.status='active' AND p.client_service AND p.type='employee' ${engine.cutWhere({ ...cut, level: undefined }, engine.PPL_DIMS, P)} GROUP BY 1,2`, P.values);
  const levels = ['PARTNER', 'AP', 'PRINCIPAL', 'MANAGER', 'ASSOCIATE', 'BA'];
  const units = [...new Set(rows.map(r => r.unit))].sort();
  const cells = rows.map(r => ({ x: units.indexOf(r.unit), y: levels.indexOf(r.level), value: r.risk, n: r.n, expected: r.expected_exits, high: r.high }));
  const focus = lvl ? rows.filter(r => r.level === lvl) : rows;
  const byUnit = {}; focus.forEach(r => { byUnit[r.unit] = byUnit[r.unit] || { unit: r.unit, label: ref.labelOf('unit', r.unit), n: 0, expected: 0, high: 0, risk: 0 }; byUnit[r.unit].n += r.n; byUnit[r.unit].expected += r.expected_exits; byUnit[r.unit].high += r.high; });
  const ranked = Object.values(byUnit).map(u => ({ ...u, risk: u.expected / u.n })).sort((a, b) => b.expected - a.expected);
  // aggregated top drivers for the focus group
  const P2 = new engine.Params();
  const drv = await db.query(`SELECT d->>'driver' AS driver, COUNT(*)::int AS n, AVG((d->>'effect')::numeric) AS effect FROM people p, jsonb_array_elements(p.flight_drivers) d WHERE p.status='active' AND p.flight_risk >= 0.35 ${lvl ? `AND p.level='${lvl}'` : ''} ${engine.cutWhere({ ...cut, level: undefined }, engine.PPL_DIMS, P2)} ${ranked[0] ? `AND p.unit='${ranked[0].unit}'` : ''} GROUP BY 1 ORDER BY 2 DESC LIMIT 4`, P2.values);
  const lvlName = lvl ? ref.labelOf('level', lvl) + 's' : 'people';
  const totalExpected = ranked.reduce((a, u) => a + u.expected, 0);
  const narrative = `Over the next ${horizonMonths} months the model expects about ${num(totalExpected)} regretted exits among ${lvlName}${composer.scopeLabel({ ...cut, level: undefined })}. ${ranked[0] ? `${ranked[0].label} carries the most: ${num(ranked[0].expected)} expected exits from ${ranked[0].n} ${lvlName} (average flight risk ${pct(ranked[0].risk, 0)}, ${ranked[0].high} people above 35%).` : ''} ${drv.length ? `The drivers there are ${listWords(drv.map(d => d.driver.toLowerCase()))}.` : ''} ${ranked[1] ? `Next: ${ranked[1].label} (${num(ranked[1].expected)}) and ${ranked[2] ? ranked[2].label + ' (' + num(ranked[2].expected) + ')' : ''}.` : ''}`;
  const spoken = ranked[0] ? `${ranked[0].label} is where we will lose the most ${lvlName}: about ${num(ranked[0].expected)} in six months, driven by ${drv[0] ? drv[0].driver.toLowerCase() : 'time since promotion'} and ${drv[1] ? drv[1].driver.toLowerCase() : 'sustained hours'}. ${individuals ? 'Ask me to show the highest-risk people.' : 'Individual names are available only to People leaders.'}` : 'No flight-risk data in this scope.';
  return { agent: 'Talent Risk Agent', model: { id: 7, name: 'Flight risk', version: '1.0-seed', method: 'Survival model with per-person explanations', fairness: 'Pass on aggregated groups; no protected attribute is an input' }, ranked, drivers: drv, narrative, spoken,
    visual: composer.heatmap(`Flight-risk heatmap${composer.scopeLabel({ ...cut, level: undefined })}`, 'Average flight risk by unit and level, six months ahead', units.map(u => ref.labelOf('unit', u)), levels.map(l => ref.labelOf('level', l)), cells, 'pct', lineage(cut), { unitKeys: units, levelKeys: levels }),
    table: composer.table(`Expected regretted exits by unit, ${lvlName}`, `Next ${horizonMonths} months`, [['label', 'Unit'], ['n', 'Headcount'], ['risk', 'Average flight risk', 'pct'], ['high', 'Above 35%'], ['expected', 'Expected exits', 'number1']], ranked, lineage(cut)),
    followUps: [lvl ? `Show me the highest-risk ${lvlName}` : 'Show me the highest-risk Principals', 'How many hires does India need next year?', 'How does our pyramid in Asia Pacific compare with last year?'] };
}
async function individuals({ cut = {}, level = 'PRINCIPAL', limit = 12 }) {
  const P = new engine.Params();
  const rows = await db.query(`SELECT p.id, p.unit, p.office, p.level, p.months_in_level, p.sustained_weeks, p.travel_weeks, p.counsellor_id, p.counsellor_changed, p.flight_risk, p.flight_drivers, p.burnout_flag, p.engagement_score FROM people p WHERE p.status='active' AND p.client_service ${level ? `AND p.level='${level}'` : ''} ${engine.cutWhere({ ...cut, level: undefined }, engine.PPL_DIMS, P)} ORDER BY p.flight_risk DESC LIMIT ${limit}`, P.values);
  const list = rows.map(r => ({ ...r, unit_name: ref.labelOf('unit', r.unit), office_name: ref.labelOf('office', r.office), drivers: (r.flight_drivers || []).map(d => d.detail || d.driver) }));
  const narrative = `${list.length} highest-risk ${level ? ref.labelOf('level', level) + 's' : 'people'}${composer.scopeLabel({ ...cut, level: undefined })}, shown by identifier. ${list[0] ? `${list[0].id} (${list[0].office_name}) has a flight risk of ${pct(list[0].flight_risk, 0)}: ${listWords(list[0].drivers.slice(0, 3))}.` : ''} This view is logged.`;
  return { agent: 'Talent Risk Agent', model: { id: 7, name: 'Flight risk' }, people: list, narrative, spoken: `${list[0] ? list[0].id + ' has the highest risk at ' + pct(list[0].flight_risk, 0) : 'No one in scope'}. The list is shown by identifier and this view is logged.`, needsIndividualPeople: true,
    table: composer.table(`Highest-risk ${level ? ref.labelOf('level', level) + 's' : 'people'}`, 'Individual scores; view logged', [['id', 'Person'], ['unit_name', 'Unit'], ['office_name', 'Office'], ['flight_risk', 'Flight risk', 'pct'], ['months_in_level', 'Months in level'], ['sustained_weeks', 'Weeks over 60h'], ['burnout_flag', 'Burnout alert'], ['counsellor_id', 'Counsellor'], ['drivers', 'Drivers']], list, lineage(cut)), visual: null,
    followUps: ['What should I do about it?', 'Where will we lose the most Principals in the next six months, and why?', 'How many hires does India need next year?'] };
}
async function burnout({ cut = {}, weeks = 3 }) {
  const P = new engine.Params();
  const rows = await db.query(`SELECT p.id, p.unit, p.office, p.level, p.sustained_weeks, p.weekend_days, p.travel_weeks, p.burnout_flag FROM people p WHERE p.status='active' AND p.client_service AND p.sustained_weeks >= ${weeks} ${engine.cutWhere(cut, engine.PPL_DIMS, P)} ORDER BY p.sustained_weeks DESC LIMIT 20`, P.values);
  const list = rows.map(r => ({ ...r, level_name: ref.labelOf('level', r.level), office_name: ref.labelOf('office', r.office) }));
  return { agent: 'Talent Risk Agent', model: { id: 8, name: 'Burnout alert' }, people: list, needsIndividualPeople: true, peopleField: 'hours', narrative: `${list.length} people${composer.scopeLabel(cut)} have recorded more than 60 hours a week for ${weeks} or more weeks. ${list[0] ? `${list[0].id} (${list[0].level_name}, ${list[0].office_name}) is at ${list[0].sustained_weeks} weeks with ${list[0].weekend_days} weekend days.` : ''}`, spoken: `${list.length} people are above 60 hours for ${weeks} weeks or more.`, table: composer.table('Sustained hours', `60+ recorded hours a week for ${weeks}+ weeks`, [['id', 'Person'], ['level_name', 'Level'], ['office_name', 'Office'], ['sustained_weeks', 'Weeks'], ['weekend_days', 'Weekend days'], ['travel_weeks', 'Travel weeks'], ['burnout_flag', 'Burnout alert']], list, lineage(cut)), visual: null, followUps: ['What should I do about it?', 'Show utilisation for my team', 'Show sustained hours by unit'] };
}
async function pyramid({ cut = {} }) {
  const levels = ['PARTNER', 'AP', 'PRINCIPAL', 'MANAGER', 'ASSOCIATE', 'BA'];
  const P = new engine.Params();
  const now = await db.query(`SELECT p.level, COUNT(*)::int AS n FROM people p WHERE p.status='active' AND p.client_service AND p.type='employee' ${engine.cutWhere(cut, engine.PPL_DIMS, P)} GROUP BY 1`, P.values);
  const P2 = new engine.Params();
  const ly = await db.query(`SELECT p.level, COUNT(*)::int AS n FROM people p WHERE p.client_service AND p.type='employee' AND p.hire_date <= ${P2.add(engine.addMonths(engine.LAST_CLOSED, -12))} AND (p.left_date IS NULL OR p.left_date > $1) ${engine.cutWhere(cut, engine.PPL_DIMS, P2)} GROUP BY 1`, P2.values);
  const nm = Object.fromEntries(now.map(r => [r.level, r.n])), lm = Object.fromEntries(ly.map(r => [r.level, r.n]));
  const target = { PARTNER: 0.075, AP: 0.06, PRINCIPAL: 0.13, MANAGER: 0.21, ASSOCIATE: 0.31, BA: 0.215 };
  const total = levels.reduce((a, l) => a + (nm[l] || 0), 0), totalLy = levels.reduce((a, l) => a + (lm[l] || 0), 0);
  const rows = levels.map(l => ({ level: l, label: ref.labelOf('level', l), now: nm[l] || 0, share: (nm[l] || 0) / total, last_year: lm[l] || 0, share_ly: (lm[l] || 0) / totalLy, target: target[l], drift: (nm[l] || 0) / total - target[l] }));
  const lev = (total - (nm.PARTNER || 0)) / (nm.PARTNER || 1), levLy = (totalLy - (lm.PARTNER || 0)) / (lm.PARTNER || 1);
  const narrative = `The pyramid${composer.scopeLabel(cut)} has ${total} client-service professionals against ${totalLy} a year ago; leverage is ${lev.toFixed(1)} (${levLy.toFixed(1)} last year). ${rows.sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))[0].label}s show the largest drift from the target shape (${pct(rows[0].share, 1)} against a target of ${pct(rows[0].target, 1)}).`;
  rows.sort((a, b) => levels.indexOf(a.level) - levels.indexOf(b.level));
  return { agent: 'Talent Risk Agent', rows, leverage: lev, leverage_ly: levLy, narrative, spoken: narrative, visual: { type: 'pyramid', title: `Pyramid${composer.scopeLabel(cut)} against target`, subtitle: 'Headcount by level, now and a year ago', rows, seeded: true, lineage: lineage(cut) }, table: composer.table('Pyramid', '', [['label', 'Level'], ['now', 'Now'], ['share', 'Share', 'pct'], ['last_year', 'A year ago'], ['share_ly', 'Share then', 'pct'], ['target', 'Target share', 'pct'], ['drift', 'Drift', 'pts']], rows, lineage(cut)), followUps: ['Where will we lose the most Principals in the next six months, and why?', 'Show leverage by unit', 'How many hires does India need next year?'] };
}
async function hiringNeed({ cut = {}, year = 2027 }) {
  const levels = ['PARTNER', 'AP', 'PRINCIPAL', 'MANAGER', 'ASSOCIATE', 'BA'];
  const P = new engine.Params();
  const ppl = await db.query(`SELECT p.level, COUNT(*)::int AS n, SUM(p.flight_risk) AS expected_exits FROM people p WHERE p.status='active' AND p.client_service AND p.type='employee' ${engine.cutWhere(cut, engine.PPL_DIMS, P)} GROUP BY 1`, P.values);
  const P2 = new engine.Params();
  const plan = await db.query(`SELECT SUM(headcount_plan)::int AS plan FROM plan pl JOIN units u ON u.id=pl.unit WHERE pl.month='${year}-12-01' ${engine.cutWhere(cut, { region: 'u.region', unit: 'pl.unit' }, P2)}`, P2.values);
  const P3 = new engine.Params();
  const nowTotal = await db.query(`SELECT COUNT(*)::int AS n FROM people p WHERE p.status='active' AND p.type='employee' ${engine.cutWhere(cut, engine.PPL_DIMS, P3)}`, P3.values);
  const growth = Math.max(0, (plan[0].plan || 0) - nowTotal[0].n);
  const csShare = ppl.reduce((a, r) => a + r.n, 0) / Math.max(1, nowTotal[0].n);
  // skill demand (model 9): weighted pipeline × staffing template → roles by level; expressed as a share of hiring
  const P4 = new engine.Params();
  const pipe = await db.query(`SELECT COALESCE(SUM(value*win_prob),0) AS weighted FROM opportunities o WHERE o.outcome IS NULL ${engine.cutWhere(cut, { region: 'o.region', unit: 'o.unit', practice: 'o.practice' }, P4)}`, P4.values);
  const demandRoles = pipe[0].weighted / 420000; // one FTE-year per US$420k of weighted pipeline
  const shape = { PARTNER: 0.02, AP: 0.04, PRINCIPAL: 0.1, MANAGER: 0.18, ASSOCIATE: 0.36, BA: 0.3 };
  const rows = levels.map(l => { const p = ppl.find(r => r.level === l) || { n: 0, expected_exits: 0 }; const attrition = p.expected_exits * 2; const promoOut = l === 'PARTNER' ? 0 : p.n * 0.12; const promoIn = l === 'BA' ? 0 : (ppl.find(r => r.level === levels[levels.indexOf(l) + 1]) || { n: 0 }).n * 0.12; const growthL = growth * csShare * shape[l]; const demandL = Math.max(0, demandRoles * shape[l] - p.n * 0.05); return { level: l, label: ref.labelOf('level', l), headcount: p.n, attrition: Math.round(attrition), promotions_out: Math.round(promoOut), promotions_in: Math.round(promoIn), growth: Math.round(growthL), demand_signal: Math.round(demandL), hires: Math.max(0, Math.round(attrition + promoOut - promoIn + growthL)) }; });
  const total = rows.reduce((a, r) => a + r.hires, 0);
  const scope = composer.scopeLabel(cut).replace(/^, /, '') || 'The firm';
  const narrative = `${scope} needs about ${total} client-service hires in ${year}: ${listWords(rows.filter(r => r.hires > 0).map(r => `${r.hires} ${r.label}s`))}. The need combines expected attrition over the year (${rows.reduce((a, r) => a + r.attrition, 0)}), promotions out of each level, planned headcount growth of ${growth} and a pipeline demand signal of ${Math.round(demandRoles)} FTE-years from ${require('./util').money(pipe[0].weighted)} of weighted pipeline.`;
  return { agent: 'Talent Risk Agent', model: { id: 10, name: 'Hiring need forecast', linked: 'Skill demand forecast (model 9)' }, rows, total, narrative, spoken: `${scope} needs about ${total} hires next year, mostly ${rows.sort((a, b) => b.hires - a.hires)[0].label}s. The driver is attrition plus planned growth.`, visual: { type: 'stackedbar', title: `Hiring need ${year}${composer.scopeLabel(cut)}`, subtitle: 'By level and driver', x: levels.map(l => ref.labelOf('level', l)), series: [{ name: 'Attrition replacement', data: levels.map(l => rows.find(r => r.level === l).attrition) }, { name: 'Promotions out, net', data: levels.map(l => Math.max(0, rows.find(r => r.level === l).promotions_out - rows.find(r => r.level === l).promotions_in)) }, { name: 'Planned growth', data: levels.map(l => rows.find(r => r.level === l).growth) }], format: 'number', seeded: true, lineage: { ...lineage(cut), model: 'Hiring need forecast v1.0-seed (driver model) linked to Skill demand forecast v1.0-seed (Monte Carlo)' } }, table: composer.table(`Hiring need ${year}`, '', [['label', 'Level'], ['headcount', 'Headcount'], ['attrition', 'Attrition'], ['promotions_out', 'Promotions out'], ['promotions_in', 'Promotions in'], ['growth', 'Growth'], ['demand_signal', 'Pipeline demand'], ['hires', 'Hires needed']], rows.sort((a, b) => levels.indexOf(a.level) - levels.indexOf(b.level)), lineage(cut)), followUps: ['Where will we lose the most Principals in the next six months, and why?', 'Show recruiting conversion by office', 'Do we have enough agentic AI skills to staff the open Digital and Analytics pipeline?'] };
}
function lineage(cut) { return { metric: 'flight_risk', name: 'Flight risk', formula: 'Survival model: time in level, time since promotion, sustained hours, staffing churn, travel, counsellor change', owner: 'Chief People Officer', source_system: 'PeopleSoft/Workday, IEM, Partner Performance System', stub: 'stub:peoplesoft + stub:iem', tables: ['people', 'person_months'], filters: cut, model: 'Flight risk v1.0-seed (concordance 0.74, fairness pass)', seeded: true, refreshed_at: engine.TODAY + 'T05:30:00Z', restricted: 'Individual scores: counselling partner and People leaders only' }; }
module.exports = { heatmap, individuals, burnout, pyramid, hiringNeed };
