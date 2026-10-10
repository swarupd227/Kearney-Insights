'use strict';
/**
 * Deterministic seed generator for Astra Insights for Kearney.
 * Reads offices.json (real, Schedule M-shaped reference data) and manifest.json (constraints and planted patterns)
 * and produces every seeded table. Fixed random seed: every rehearsal shows the same values.
 *
 * Usage: node server/seed/generate.js --summary
 */
const ref = require('./offices.json');
const manifest = require('./manifest.json');
const fs = require('fs');
const path = require('path');

// ---------- deterministic randomness ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(manifest.random_seed);
const R = {
  f: () => rand(),
  int: (a, b) => a + Math.floor(rand() * (b - a + 1)),
  pick: arr => arr[Math.floor(rand() * arr.length)],
  chance: p => rand() < p,
  norm: (mu = 0, sd = 1) => { let u = 0, v = 0; while (u === 0) u = rand(); while (v === 0) v = rand(); return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); },
  lognorm: (median, sigma) => median * Math.exp(R.norm(0, sigma)),
  weighted: (items, weights) => { const t = weights.reduce((a, b) => a + b, 0); let x = rand() * t; for (let i = 0; i < items.length; i++) { x -= weights[i]; if (x <= 0) return items[i]; } return items[items.length - 1]; }
};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sigmoid = x => 1 / (1 + Math.exp(-x));
const r2 = x => Math.round(x * 100) / 100;
const r0 = x => Math.round(x);

// ---------- calendar ----------
const TODAY = new Date(manifest.clock.today + 'T00:00:00Z');
function ymd(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function addMonths(d, n) { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; }
function monthStart(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }
function monthsBetween(a, b) { return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()); }
const FIRST = new Date(manifest.clock.first_month + 'T00:00:00Z');
const LAST_CLOSED = new Date(manifest.clock.last_closed_month + 'T00:00:00Z');
const MONTHS = []; for (let d = new Date(FIRST); d <= LAST_CLOSED; d = addMonths(d, 1)) MONTHS.push(monthStart(d));
const PLAN_MONTHS = []; for (let d = new Date(FIRST); d <= new Date('2027-12-01T00:00:00Z'); d = addMonths(d, 1)) PLAN_MONTHS.push(monthStart(d));
const season = m => manifest.scale.seasonality[String(m.getUTCMonth() + 1)];

// ---------- reference ----------
const unitById = Object.fromEntries(ref.units.map(u => [u.id, u]));
const regionOfUnit = u => unitById[u].region;
const officesByUnit = {}; ref.offices.forEach(o => { (officesByUnit[o.unit] = officesByUnit[o.unit] || []).push(o); });
const rateFactor = manifest.scale.unit_rate_factor;

const LEVELS = [
  { id: 'PARTNER', name: 'Partner', rank: 6, client_service: true, util_target: 0.45, standard_rate: 950, cost_rate: 400, typical_months_in_level: 0 },
  { id: 'AP', name: 'Associate Partner', rank: 5, client_service: true, util_target: 0.55, standard_rate: 800, cost_rate: 290, typical_months_in_level: 36 },
  { id: 'PRINCIPAL', name: 'Principal', rank: 4, client_service: true, util_target: 0.65, standard_rate: 650, cost_rate: 185, typical_months_in_level: 36 },
  { id: 'MANAGER', name: 'Manager', rank: 3, client_service: true, util_target: 0.72, standard_rate: 480, cost_rate: 120, typical_months_in_level: 30 },
  { id: 'ASSOCIATE', name: 'Associate', rank: 2, client_service: true, util_target: 0.75, standard_rate: 350, cost_rate: 80, typical_months_in_level: 30 },
  { id: 'BA', name: 'Business Analyst', rank: 1, client_service: true, util_target: 0.75, standard_rate: 250, cost_rate: 55, typical_months_in_level: 24 },
  { id: 'BS', name: 'Business Services', rank: 0, client_service: false, util_target: 0, standard_rate: 0, cost_rate: 60, typical_months_in_level: 0 },
  { id: 'CONTRACTOR', name: 'Contractor', rank: 0, client_service: false, util_target: 0.7, standard_rate: 300, cost_rate: 110, typical_months_in_level: 0 }
];
const levelById = Object.fromEntries(LEVELS.map(l => [l.id, l]));
const CS_LEVELS = ['PARTNER', 'AP', 'PRINCIPAL', 'MANAGER', 'ASSOCIATE', 'BA'];

const SKILLS = ['SAP', 'Procurement', 'Supply chain', 'Pricing', 'Digital', 'Analytics', 'AI', 'Agentic AI', 'M&A', 'Post-merger integration', 'Organization design', 'Sustainability', 'Strategy', 'Operations', 'Retail', 'Financial services', 'Public sector', 'Energy', 'Automotive', 'Aerospace', 'Cost transformation', 'Product development', 'Customer experience', 'Cloud', 'Data engineering'];
const PRACTICE_SKILLS = {
  DA: ['Digital', 'Analytics', 'AI', 'Agentic AI', 'Data engineering', 'Cloud'], MA: ['M&A', 'Post-merger integration', 'Strategy'],
  OPS: ['Operations', 'Supply chain', 'Cost transformation', 'SAP'], ORG: ['Organization design', 'Customer experience'],
  PROC: ['Procurement', 'Supply chain', 'SAP'], PER: ['Product development', 'Operations'], SUS: ['Sustainability', 'Energy'],
  SG: ['Strategy', 'Pricing', 'Customer experience'], TRF: ['Cost transformation', 'Organization design', 'Digital'], GBPC: ['Public sector', 'Strategy']
};
const INDUSTRY_SKILL = { AD: 'Aerospace', AUTO: 'Automotive', CR: 'Retail', ER: 'Energy', FS: 'Financial services', PUB: 'Public sector' };
const PRACTICE_WEIGHTS = { DA: 16, MA: 8, OPS: 18, ORG: 8, PROC: 14, PER: 4, SUS: 5, SG: 14, TRF: 11, GBPC: 2 };
const INDUSTRY_WEIGHTS = { AD: 5, AUTO: 9, CR: 13, COM: 6, ER: 11, FS: 12, HLS: 9, IGS: 10, INF: 4, MED: 3, PE: 7, PUB: 7, TECH: 7, TT: 5 };
const LANG_BY_OFFICE_LANG = { en: ['English'], de: ['German', 'English'], fr: ['French', 'English'], es: ['Spanish', 'English'], pt: ['Portuguese', 'English'], ja: ['Japanese', 'English'], ar: ['Arabic', 'English'] };

// ---------- output ----------
const T = {
  regions: ref.regions.map(r => ({ id: r.id, name: r.name, users: r.users })),
  units: ref.units.map(u => ({ id: u.id, name: u.name, region: u.region })),
  offices: ref.offices.map(o => ({ id: o.id, city: o.city, country: o.country, unit: o.unit, region: regionOfUnit(o.unit), users: o.users, contractors: o.contractors, employees: o.users - o.contractors, lat: o.lat, lon: o.lon, lang: o.lang })),
  kearney_companies: ref.kearney_companies.map(k => ({ id: k.id, name: k.name, focus: k.focus, office: k.office, acquired: k.acquired || null })),
  practices: ref.practices, industries: ref.industries, levels: LEVELS,
  people: [], clients: [], engagements: [], engagement_months: [], person_months: [], invoices: [], opportunities: [],
  plan: [], fx_rates: [], contacts: [], knowledge_assets: [], knowledge_search_topics: [], app_adoption: [],
  staffing_roles: [], calendar_events: [], agent_runs: [], model_registry: [], seed_meta: []
};

// =====================================================================
// 1. PEOPLE (one per Schedule M user ID)
// =====================================================================
let pid = 0;
const nextPid = () => 'P-' + String(++pid).padStart(5, '0');
const pyramid = manifest.scale.pyramid;
const csShare = manifest.scale.client_service_share_of_employees;
const hubs = manifest.scale.shared_services_hubs;
const BS_FUNCTIONS = ['Finance', 'People', 'KNet (IT)', 'Marketing and Research', 'Knowledge Management', 'Legal and Risk', 'Office Services', 'Staffing'];

function tenureMonthsForLevel(level) {
  const base = { BA: [1, 30], ASSOCIATE: [12, 60], MANAGER: [36, 96], PRINCIPAL: [60, 150], AP: [84, 200], PARTNER: [100, 320], BS: [1, 240], CONTRACTOR: [1, 60] }[level];
  return R.int(base[0], base[1]);
}
function makePerson(office, type, level, clientService) {
  const lvl = levelById[level];
  const tenure = tenureMonthsForLevel(level);
  const hire = addMonths(TODAY, -tenure);
  const typical = lvl.typical_months_in_level || 36;
  const monthsInLevel = level === 'PARTNER' ? Math.min(tenure, R.int(6, 200)) : Math.min(tenure, clamp(Math.round(R.lognorm(typical * 0.75, 0.5)), 1, 90));
  const practice = clientService ? R.weighted(Object.keys(PRACTICE_WEIGHTS), Object.values(PRACTICE_WEIGHTS)) : null;
  const industry = clientService ? R.weighted(Object.keys(INDUSTRY_WEIGHTS), Object.values(INDUSTRY_WEIGHTS)) : null;
  const skills = new Set();
  if (practice) { PRACTICE_SKILLS[practice].forEach(s => { if (R.chance(0.6)) skills.add(s); }); }
  if (industry && INDUSTRY_SKILL[industry] && R.chance(0.7)) skills.add(INDUSTRY_SKILL[industry]);
  if (R.chance(0.35)) skills.add(R.pick(SKILLS));
  if (skills.size === 0 && clientService) skills.add(R.pick(SKILLS));
  const languages = [...LANG_BY_OFFICE_LANG[office.lang]]; if (R.chance(0.25)) languages.push(R.pick(['French', 'German', 'Spanish', 'Mandarin', 'Hindi', 'Arabic', 'Japanese', 'Portuguese']));
  const sustained = clientService && lvl.rank >= 1 && lvl.rank <= 4 ? (R.chance(0.12) ? R.int(4, 9) : R.int(0, 3)) : 0;
  return {
    id: nextPid(), office: office.id, unit: office.unit, region: regionOfUnit(office.unit), level, type, client_service: clientService,
    practice, industry, hire_date: ymd(hire), months_in_level: monthsInLevel, last_promotion: ymd(addMonths(TODAY, -monthsInLevel)),
    counsellor_id: null, counsellor_changed: R.chance(0.1), skills: [...skills], languages: [...new Set(languages)],
    travel_weeks: clientService ? R.int(0, 30) : R.int(0, 4), sustained_weeks: sustained, weekend_days: sustained >= 4 ? R.int(4, 12) : R.int(0, 3),
    flight_risk: null, flight_drivers: null, burnout_flag: false,
    engagement_score: r2(clamp(R.norm(74, 8), 40, 95)), learning_hours: r2(clamp(R.norm(clientService ? 11 : 7, 4), 0, 40)),
    roll_off_date: null, status: 'active', left_date: null, regretted: false,
    kearney_company: null, bs_function: clientService ? null : (type === 'contractor' ? R.pick(['KNet (IT)', 'Office Services', 'Staffing', 'Finance']) : R.pick(BS_FUNCTIONS)),
    source: 'stub:peoplesoft'
  };
}
for (const office of ref.offices) {
  const employees = office.users - office.contractors;
  const cs = Math.round(employees * (hubs[office.id] || csShare));
  // level allocation by pyramid, largest remainder
  const counts = {}; let assigned = 0;
  CS_LEVELS.forEach(l => { counts[l] = Math.floor(cs * pyramid[l]); assigned += counts[l]; });
  let rem = cs - assigned; const order = ['ASSOCIATE', 'BA', 'MANAGER', 'PRINCIPAL', 'AP', 'PARTNER'];
  for (let i = 0; rem > 0; i++, rem--) counts[order[i % order.length]]++;
  if (cs > 0 && counts.PARTNER === 0) { counts.PARTNER = 1; counts.ASSOCIATE = Math.max(0, counts.ASSOCIATE - 1); }
  CS_LEVELS.forEach(l => { for (let i = 0; i < counts[l]; i++) T.people.push(makePerson(office, 'employee', l, true)); });
  for (let i = 0; i < employees - cs; i++) T.people.push(makePerson(office, 'employee', 'BS', false));
  for (let i = 0; i < office.contractors; i++) {
    const csContractor = office.id === 'SEL' ? R.chance(0.8) : R.chance(0.3);
    T.people.push(makePerson(office, 'contractor', 'CONTRACTOR', csContractor));
  }
}
// Kearney companies: tag a share of people in the company's home office
for (const k of ref.kearney_companies) {
  const office = ref.offices.find(o => o.city === k.office);
  if (!office) continue;
  const pool = T.people.filter(p => p.office === office.id && p.client_service && p.type === 'employee' && !p.kearney_company);
  const n = Math.min(pool.length, R.int(8, 30));
  for (let i = 0; i < n; i++) pool[i].kearney_company = k.id;
}
// counsellors: partners or APs in the same office, else unit
const seniorByOffice = {}; const seniorByUnit = {};
T.people.forEach(p => { if (p.level === 'PARTNER' || p.level === 'AP') { (seniorByOffice[p.office] = seniorByOffice[p.office] || []).push(p.id); (seniorByUnit[p.unit] = seniorByUnit[p.unit] || []).push(p.id); } });
T.people.forEach(p => { if (p.client_service && p.level !== 'PARTNER') { const pool = seniorByOffice[p.office] || seniorByUnit[p.unit] || []; if (pool.length) p.counsellor_id = R.pick(pool); } });

// Planted storyline D: Principals in the Middle East unit
const sd = manifest.planted_patterns.storyline_D_talent_cluster;
T.people.filter(p => p.unit === sd.unit && p.level === sd.level).forEach(p => {
  if (R.chance(sd.share_affected)) {
    p.months_in_level = Math.max(p.months_in_level, R.int(sd.months_in_level_min, sd.months_in_level_min + 20));
    p.last_promotion = ymd(addMonths(TODAY, -p.months_in_level));
    p.sustained_weeks = Math.max(p.sustained_weeks, R.int(sd.sustained_weeks_min, sd.sustained_weeks_min + 6));
    p.weekend_days = R.int(6, 14); p.travel_weeks = R.int(18, 34);
  }
});
// Leavers (last 21 months) as additional records, so active headcount still equals Schedule M
const activeCs = T.people.filter(p => p.client_service && p.type === 'employee');
const leaverCount = Math.round(activeCs.length * 0.14);
for (let i = 0; i < leaverCount; i++) {
  const tmpl = R.pick(activeCs); const office = ref.offices.find(o => o.id === tmpl.office);
  const lv = R.weighted(['BA', 'ASSOCIATE', 'MANAGER', 'PRINCIPAL', 'AP', 'PARTNER'], [22, 34, 22, 14, 5, 3]);
  const p = makePerson(office, 'employee', lv, true);
  p.status = 'left'; p.left_date = ymd(addDays(TODAY, -R.int(5, 640))); p.regretted = R.chance(0.58);
  if (p.unit === sd.unit && lv === 'PRINCIPAL') p.regretted = R.chance(0.8);
  T.people.push(p);
}
// Flight risk and burnout (model 7 and 8), computed on seeded attributes; no protected attributes used
const LEVEL_BASE = { PARTNER: -4.4, AP: -3.8, PRINCIPAL: -3.3, MANAGER: -3.0, ASSOCIATE: -2.8, BA: -2.9 };
const UNIT_OFFSET = { ME: 0.25, IND: 0.2, UKI: 0.05, NA: 0.0, DACH: -0.05, JPN: -0.3, NORD: -0.15 };
for (const p of T.people) {
  if (!p.client_service || p.type !== 'employee' || p.status !== 'active') continue;
  const lvl = levelById[p.level]; const typical = lvl.typical_months_in_level || 36;
  const terms = [];
  const overdue = p.level === 'PARTNER' ? 0 : Math.max(0, (p.months_in_level - typical) / 12);
  terms.push(['Time since promotion', 0.9 * overdue, `${p.months_in_level} months in level against a typical ${typical}`]);
  terms.push(['Sustained hours', 0.22 * p.sustained_weeks, `${p.sustained_weeks} weeks above 60 recorded hours`]);
  terms.push(['Counsellor change', p.counsellor_changed ? 0.45 : 0, 'Counsellor changed in the last year']);
  terms.push(['Travel load', 0.03 * p.travel_weeks, `${p.travel_weeks} travel weeks in the year`]);
  terms.push(['Recent promotion', p.months_in_level < 9 && p.level !== 'PARTNER' ? -0.7 : 0, 'Promoted in the last nine months']);
  terms.push(['Engagement score', -0.025 * (p.engagement_score - 74), `Glint score ${p.engagement_score}`]);
  terms.push(['Staffing churn', 0.1 * (R.int(0, 4)), 'Short assignments in the last year']);
  const logit = LEVEL_BASE[p.level] + (UNIT_OFFSET[p.unit] || 0) + terms.reduce((a, t) => a + t[1], 0) + R.norm(0, 0.25);
  p.flight_risk = r2(clamp(sigmoid(logit), 0.01, 0.95));
  p.flight_drivers = terms.filter(t => t[1] !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3).map(t => ({ driver: t[0], effect: r2(t[1]), detail: t[2] }));
  p.burnout_flag = p.sustained_weeks >= 4 && (p.weekend_days >= 4 || p.travel_weeks > 20);
  if (R.chance(0.22)) p.roll_off_date = ymd(addDays(TODAY, R.int(3, 70)));
}

// =====================================================================
// 2. CLIENTS
// =====================================================================
const partnersByUnit = {}; T.people.forEach(p => { if (p.level === 'PARTNER' && p.status === 'active') (partnersByUnit[p.unit] = partnersByUnit[p.unit] || []).push(p.id); });
const anyPartner = unit => R.pick(partnersByUnit[unit] || partnersByUnit.NA);
const unitsOfRegion = r => ref.units.filter(u => u.region === r).map(u => u.id);
const CLIENT_SIZE = []; // weight for engagement selection
for (const pc of ref.public_clients) {
  T.clients.push({ id: pc.id, name: pc.name, is_public: true, industry: pc.industry, region: pc.region, unit: pc.unit, fortune_g500: ['DSM', 'TEF', 'LIC'].includes(pc.id),
    public_work: pc.work, public_year: pc.year, public_source: pc.source, relationship_partner: anyPartner(pc.unit), first_engaged: ymd(addMonths(TODAY, -R.int(24, 80))),
    satisfaction: r2(clamp(R.norm(8.1, 0.6), 5, 10)), satisfaction_prev: null, sentiment_themes: null, payment_behaviour: r2(R.norm(0, 0.6)), source: 'public+stub:sap' });
  CLIENT_SIZE.push(pc.id === 'LIC' ? 3.5 : pc.id === 'DSM' ? 3 : 2);
}
const N_CLIENTS = 440;
for (let i = 1; i <= N_CLIENTS; i++) {
  const industry = R.weighted(Object.keys(INDUSTRY_WEIGHTS), Object.values(INDUSTRY_WEIGHTS));
  const region = R.weighted(['AMER', 'EUR', 'APAC', 'MEA'], [34, 31, 22, 13]);
  const unit = R.pick(unitsOfRegion(region));
  const size = R.lognorm(1, 0.9);
  T.clients.push({ id: 'C-' + String(i).padStart(4, '0'), name: 'Client C-' + String(i).padStart(4, '0'), is_public: false, industry, region, unit,
    fortune_g500: R.chance(size > 1.5 ? 0.6 : 0.2), public_work: null, public_year: null, public_source: null, relationship_partner: anyPartner(unit),
    first_engaged: ymd(addMonths(TODAY, -R.int(3, 120))), satisfaction: r2(clamp(R.norm(7.9, 0.8), 4, 10)), satisfaction_prev: null, sentiment_themes: null,
    payment_behaviour: r2(R.norm(0, 0.8)), source: 'stub:sap' });
  CLIENT_SIZE.push(size);
}
T.clients.forEach(c => { c.satisfaction_prev = r2(clamp(c.satisfaction + R.norm(0, 0.5), 4, 10)); c.sentiment_themes = R.pick([['Responsiveness', 'Depth of expertise'], ['Value for fees', 'Team continuity'], ['Implementation support', 'Senior attention'], ['Clarity of recommendations', 'Speed']]); });
const clientById = Object.fromEntries(T.clients.map(c => [c.id, c]));
const clientsByUnit = {}; T.clients.forEach((c, i) => { (clientsByUnit[c.unit] = clientsByUnit[c.unit] || []).push([c, CLIENT_SIZE[i]]); });
const clientsByRegion = {}; T.clients.forEach((c, i) => { (clientsByRegion[c.region] = clientsByRegion[c.region] || []).push([c, CLIENT_SIZE[i]]); });
function pickClientFor(unit) {
  const local = clientsByUnit[unit] || []; const regional = clientsByRegion[regionOfUnit(unit)] || [];
  const pool = R.chance(0.7) && local.length ? local : regional;
  return R.weighted(pool.map(x => x[0]), pool.map(x => x[1]));
}

// =====================================================================
// 3. ENGAGEMENTS and monthly economics
// =====================================================================
// capacity-weighted revenue scale per unit
const unitCapacity = {}; ref.units.forEach(u => unitCapacity[u.id] = 0);
for (const p of T.people) {
  if (!p.client_service || p.status !== 'active') continue;
  const lvl = levelById[p.level]; unitCapacity[p.unit] += 1800 * lvl.util_target * lvl.standard_rate * (rateFactor[p.unit] || 1) * (p.type === 'contractor' ? 0.5 : 1);
}
const totalCap = Object.values(unitCapacity).reduce((a, b) => a + b, 0);
const REV25 = manifest.scale.revenue_2025_usd;
const REAL_BASE = 0.88; // base billing realisation
const unitRev25 = {}; ref.units.forEach(u => unitRev25[u.id] = REV25 * unitCapacity[u.id] / totalCap);
const sa = manifest.planted_patterns.storyline_A_europe_gap;
function unitStdTarget(unit, m) {
  const y = m.getUTCFullYear(); const region = regionOfUnit(unit);
  let g = 1; if (y === 2024) g = 1 / manifest.scale.growth_2024_to_2025; if (y === 2023) g = 1 / (manifest.scale.growth_2024_to_2025 * 1.1);
  if (y === 2026) g = manifest.scale.actual_growth_2026_by_region[region] * (sa.unit_actual_factor_2026[unit] || 1);
  if (y === 2027) g = manifest.scale.actual_growth_2026_by_region[region] * 1.08;
  return unitRev25[unit] / 12 * season(m) * g / REAL_BASE;
}
const FEE_MODELS = ['tm', 'fixed', 'value'];
const WS_NAMES = ['Diagnostic', 'Design', 'Implementation', 'Change management', 'PMO', 'Analytics', 'Sourcing', 'Pilot'];
let engSeq = 0; const planted = manifest.planted_patterns.storyline_B_dach_realisation;
const plantedIds = new Set(planted.engagements.map(e => e.id));
const engagementsRaw = [];
function crossBorderOffice(unit) {
  // 70% from another unit in the same region, 30% from the delivery hubs (India, Central and Eastern Europe)
  const region = regionOfUnit(unit);
  const sameRegion = ref.offices.filter(o => o.unit !== unit && regionOfUnit(o.unit) === region);
  const hubs = ref.offices.filter(o => ['IND', 'CEE'].includes(o.unit) && o.unit !== unit);
  const pool = R.chance(0.7) && sameRegion.length ? sameRegion : hubs;
  return R.weighted(pool, pool.map(o => o.users));
}
function newEngagement(unit, startMonth, opts = {}) {
  const office = R.chance(0.14) ? crossBorderOffice(unit) : R.pick(officesByUnit[unit]);
  const client = opts.client || pickClientFor(unit);
  const practice = opts.practice || R.weighted(Object.keys(PRACTICE_WEIGHTS), Object.values(PRACTICE_WEIGHTS));
  const duration = opts.duration || R.weighted([2, 3, 4, 5, 6, 7, 8, 10, 12], [6, 10, 14, 14, 13, 10, 8, 5, 3]);
  const avgMonthly = unitRev25[unit] / 12 / Math.max(5, unitCapacity[unit] / 4.6e6) / REAL_BASE; // typical monthly standard value per engagement
  const monthlyStd = R.lognorm(avgMonthly, 0.55);
  const budgetFees = monthlyStd * duration * REAL_BASE;
  const blendedRate = 420 * (rateFactor[unit] || 1);
  const budgetHours = budgetFees / (blendedRate * REAL_BASE);
  const feeModel = opts.fee_model || R.weighted(FEE_MODELS, [45, 40, 15]);
  const start = new Date(startMonth); start.setUTCDate(R.int(1, 25));
  const end = addDays(addMonths(start, duration), -R.int(0, 10));
  const nws = R.int(2, 4); const shares = Array.from({ length: nws }, () => R.f() + 0.3); const st = shares.reduce((a, b) => a + b, 0);
  const workstreams = Array.from({ length: nws }, (_, i) => ({ name: WS_NAMES[(i * 3 + R.int(0, 2)) % WS_NAMES.length] + (i ? '' : ''), share: r2(shares[i] / st) }));
  return {
    id: null, client_id: client.id, practice, industry: client.industry, unit, office: office.id, region: regionOfUnit(unit),
    partner_id: client.relationship_partner && R.chance(0.6) ? client.relationship_partner : anyPartner(unit), principal_id: null,
    fee_model: feeModel, budget_fees: r0(budgetFees), budget_hours: r0(budgetHours), standard_rate: r0(blendedRate),
    start_date: ymd(start), end_date: ymd(end), status: null, health_score: null, overrun_prob: null, predicted_overrun_date: null, eac: null,
    margin_at_completion: null, write_off_risk: null, realisation_forecast: null, kearney_company: R.chance(0.07) ? R.pick(ref.kearney_companies).id : null,
    scope_changes: R.chance(0.25) ? R.int(1, 3) : 0, reuses_asset: R.chance(0.42), expert_calls: R.chance(0.5) ? R.int(1, 12) : 0,
    workstreams, team_size: clamp(Math.round(monthlyStd / (blendedRate * 130)), 2, 18), planted: opts.planted || null, source: 'stub:sap',
    _start: start, _end: end, _duration: duration, _monthlyStd: monthlyStd, _disc: clamp(R.norm(0.05, 0.02), 0, 0.15), _wo: clamp(R.norm(0.02, 0.012), 0, 0.08),
    _over: feeModel === 'fixed' ? clamp(R.norm(0.02, 0.03), 0, 0.2) : 0, _delay: clamp(R.norm(0.08, 0.03), 0.02, 0.2), _profile: null
  };
}
function profileFor(e) {
  const n = e._duration; const w = [];
  for (let i = 0; i < n; i++) { let s = 1; if (i === 0) s = 0.55; else if (i === n - 1) s = 0.7; else if (i === 1) s = 0.9; w.push(s * clamp(R.norm(1, 0.08), 0.8, 1.2)); }
  return w;
}
// Simulate month by month per unit: start engagements until active standard value meets target
const SIM_START = new Date('2023-06-01T00:00:00Z');
const SIM_END = new Date('2026-12-01T00:00:00Z');
for (const u of ref.units) {
  let active = [];
  for (let m = new Date(SIM_START); m <= SIM_END; m = addMonths(m, 1)) {
    active = active.filter(e => monthsBetween(monthStart(e._start), m) < e._duration);
    const target = unitStdTarget(u.id, m);
    let sum = active.reduce((a, e) => a + e._monthlyStd * e._profile[monthsBetween(monthStart(e._start), m)], 0);
    let guard = 0;
    while (sum < target * 0.98 && guard++ < 400) {
      const e = newEngagement(u.id, m); e._profile = profileFor(e);
      active.push(e); engagementsRaw.push(e); sum += e._monthlyStd * e._profile[0];
    }
  }
}
// planted DACH engagements: pick five DACH engagements live through Q3 2026, started Mar–Jun 2026, duration >= 6
const dachCandidates = engagementsRaw.filter(e => e.unit === 'DACH' && e._start >= new Date('2026-02-15T00:00:00Z') && e._start <= new Date('2026-06-20T00:00:00Z') && e._duration >= 6).sort((a, b) => b._monthlyStd - a._monthlyStd);
planted.engagements.forEach((pe, i) => {
  const e = dachCandidates[i]; if (!e) return;
  e.id = pe.id; e.planted = 'storyline_B'; e.fee_model = pe.fee_model; e._plantedQ3 = pe;
  e._monthlyStd *= 2.2; e.budget_fees = r0(e.budget_fees * 2.2); e.budget_hours = r0(e.budget_hours * 2.2); // make them material
  if (pe.trend_overrun) { e.scope_changes = Math.max(e.scope_changes, 2); }
});
// keep the DACH unit's 2026 standard value on its target: take the std added to the planted engagements away from the other DACH engagements that start in 2026
{
  const added = dachCandidates.slice(0, planted.engagements.length).reduce((a, e) => a + (e._plantedQ3 ? e._monthlyStd * (1 - 1 / 2.2) : 0), 0);
  const others = engagementsRaw.filter(e => e.unit === 'DACH' && !e._plantedQ3 && e._start >= new Date('2026-01-01T00:00:00Z'));
  const pool = others.reduce((a, e) => a + e._monthlyStd, 0);
  if (pool > 0) others.forEach(e => { e._monthlyStd *= Math.max(0.5, 1 - added / pool); });
}
// LIC purchase history (storyline C) and peer pattern
const sc = manifest.planted_patterns.storyline_C_lic_white_space;
engagementsRaw.filter(e => e.client_id === 'LIC').forEach((e, i) => { e.practice = i === 0 ? 'ORG' : 'TRF'; });
if (!engagementsRaw.some(e => e.client_id === 'LIC')) {
  const e = newEngagement('IND', new Date('2026-03-01T00:00:00Z'), { client: clientById.LIC, practice: 'TRF', duration: 9 }); e._profile = profileFor(e); engagementsRaw.push(e);
}
{ // ensure at least three LIC engagements in TRF across 2024-2026 for a visible history
  const have = engagementsRaw.filter(e => e.client_id === 'LIC').length;
  for (let i = have; i < 4; i++) { const e = newEngagement('IND', new Date(`202${4 + i % 3}-0${2 + i}-01T00:00:00Z`), { client: clientById.LIC, practice: 'TRF', duration: R.int(5, 9) }); e._profile = profileFor(e); engagementsRaw.push(e); }
}
// FS peers: those with TRF engagements also get a DA engagement (co-purchase pattern)
{
  const fsTrf = new Set(engagementsRaw.filter(e => e.practice === 'TRF' && clientById[e.client_id].industry === 'FS' && e.client_id !== 'LIC').map(e => e.client_id));
  for (const cid of fsTrf) {
    if (R.chance(sc.peer_pattern.strength) && !engagementsRaw.some(e => e.client_id === cid && e.practice === 'DA')) {
      const c = clientById[cid]; const e = newEngagement(c.unit, addMonths(TODAY, -R.int(3, 26)), { client: c, practice: 'DA', duration: R.int(3, 7) }); e._profile = profileFor(e); engagementsRaw.push(e);
    }
  }
}
// assign ids in start order, reserving planted ids
engagementsRaw.sort((a, b) => a._start - b._start);
engSeq = 1000;
for (const e of engagementsRaw) { if (e.id) continue; do { engSeq++; } while (plantedIds.has('E-' + engSeq)); e.id = 'E-' + engSeq; }
// principals: pick a principal in the unit
const principalsByUnit = {}; T.people.forEach(p => { if (p.level === 'PRINCIPAL' && p.status === 'active') (principalsByUnit[p.unit] = principalsByUnit[p.unit] || []).push(p.id); });
// monthly economics
const sb = manifest.planted_patterns.storyline_B_dach_realisation;
let invSeq = 0;
for (const e of engagementsRaw) {
  e.principal_id = R.pick(principalsByUnit[e.unit] || principalsByUnit.NA);
  const startM = monthStart(e._start);
  e.status = e._start > TODAY ? 'planned' : (e._end < TODAY ? 'closed' : 'live');
  let carry = 0, cumStd = 0, cumBilled = 0, cumHours = 0, cumCost = 0;
  const budgetStd = e.budget_fees / REAL_BASE;
  for (let i = 0; i < e._duration; i++) {
    const m = addMonths(startM, i); if (m > LAST_CLOSED) break;
    let std = e._monthlyStd * e._profile[i];
    const monthKey = m.getUTCMonth() + 1; const y = m.getUTCFullYear();
    if (y === 2026 && sa.unit_actual_factor_2026[e.unit] && sa.unit_actual_factor_2026[e.unit] < 1) { const slip = e.unit === 'UKI' ? (ymd(m) >= sa.uki_start_slip_from ? 0.9 : 1) : sa.unit_actual_factor_2026[e.unit]; std *= slip; }
    let disc = e._disc, wo = e._wo, over = 0, delayRate = e._delay;
    if (e.fee_model === 'fixed' && cumStd + std > budgetStd) over = Math.min(std, cumStd + std - budgetStd) / std * 0.9; // unbillable overrun share
    else over = e._over * (i / e._duration);
    if (e._plantedQ3 && y === 2026 && monthKey >= 7 && monthKey <= 9) { disc = e._plantedQ3.discount; wo = e._plantedQ3.write_off; over = Math.max(over, e._plantedQ3.overrun); std *= 1.1; }
    else if (e._plantedQ3 && y === 2026 && monthKey >= 4 && monthKey <= 6) { disc = 0.03; wo = 0.01; over = 0.01; }
    const hours = std / e.standard_rate;
    const discount = std * disc, writeOff = std * wo, overrun = std * over;
    const net = std - discount - writeOff - overrun;
    const delayed = net * delayRate;
    const billed = net - delayed + carry; carry = delayed;
    const staffCost = hours * e.standard_rate * clamp(R.norm(0.42, 0.04), 0.3, 0.6);
    const expenses = std * clamp(R.norm(0.08, 0.02), 0.02, 0.15); const unrec = expenses * clamp(R.norm(0.15, 0.06), 0, 0.5);
    cumStd += std; cumBilled += billed; cumHours += hours; cumCost += staffCost;
    const ageMonths = monthsBetween(m, LAST_CLOSED);
    const unbilled = ageMonths === 0 ? delayed : (e._plantedQ3 || R.chance(0.08) ? delayed * clamp(1 - ageMonths * 0.25, 0, 1) : 0);
    T.engagement_months.push({ engagement_id: e.id, month: ymd(m), hours: r0(hours), standard_value: r0(std), discount: r0(discount), write_off: r0(writeOff), overrun_unbilled: r0(overrun), delayed: r0(delayed), billed: r0(billed), staff_cost: r0(staffCost), expenses: r0(expenses), unrecovered_expense: r0(unrec), collected: 0, unbilled_wip: r0(unbilled) });
    // invoice for the billed amount
    if (billed > 1000) {
      const client = clientById[e.client_id];
      const issue = addDays(addMonths(m, 1), R.int(3, 12)); const due = addDays(issue, 30);
      const payDelay = Math.round(R.norm(18 + client.payment_behaviour * 22, 18)); const paid = addDays(due, Math.max(-10, payDelay));
      const disputed = R.chance(0.03 + (e._plantedQ3 ? 0.15 : 0));
      const status = paid <= TODAY && !disputed ? 'paid' : (due < TODAY ? 'overdue' : 'open');
      const logit = -2.2 + client.payment_behaviour * 1.2 + (billed / 1e6) * 0.3 + ({ MEA: 0.6, APAC: 0.3, EUR: 0, AMER: -0.2 })[e.region] + (disputed ? 2 : 0) + (status === 'overdue' ? 1.2 : 0);
      const lateProb = r2(clamp(sigmoid(logit), 0.01, 0.97));
      const drivers = [];
      if (client.payment_behaviour > 0.5) drivers.push('Client pays late on average'); if (disputed) drivers.push('Invoice disputed'); if (billed > 800000) drivers.push('Large invoice value'); if (e.region === 'MEA') drivers.push('Regional payment cycle'); if (!drivers.length) drivers.push('No adverse signals');
      T.invoices.push({ id: 'INV-' + String(++invSeq).padStart(6, '0'), engagement_id: e.id, client_id: e.client_id, unit: e.unit, region: e.region, issue_date: ymd(issue), due_date: ymd(due), amount: r0(billed), paid_date: status === 'paid' ? ymd(paid) : null, status, late_prob: lateProb, late_drivers: drivers, disputed, source: 'stub:sap' });
      const em = T.engagement_months[T.engagement_months.length - 1]; if (status === 'paid') em.collected = r0(billed);
    }
  }
  // engagement health predictions (model 4, 5) for live engagements
  if (e.status === 'live') {
    const elapsed = clamp((TODAY - e._start) / (e._end - e._start), 0.02, 1);
    const burn = cumHours / e.budget_hours;
    const pressure = burn - elapsed;
    const plantedBoost = e._plantedQ3 && e._plantedQ3.trend_overrun ? 1.6 : 0;
    const logit = -1.2 + 7 * pressure + 0.35 * e.scope_changes + (e.fee_model === 'fixed' ? 0.5 : 0) + plantedBoost;
    e.overrun_prob = r2(clamp(sigmoid(logit), 0.02, 0.98));
    const burnRate = cumHours / Math.max(1, monthsBetween(startM, LAST_CLOSED) + 1);
    const remainingHours = Math.max(0, e.budget_hours - cumHours);
    const monthsLeft = Math.max(0.2, monthsBetween(LAST_CLOSED, monthStart(e._end)) + 0.5);
    const needRate = remainingHours / monthsLeft;
    if (burnRate > needRate * 1.05 || e.overrun_prob > 0.5) { const monthsToExhaust = remainingHours / Math.max(burnRate, 1); e.predicted_overrun_date = ymd(addDays(LAST_CLOSED, Math.round(monthsToExhaust * 30 + 30))); }
    const eacHours = cumHours + burnRate * monthsLeft * (e.overrun_prob > 0.5 ? 1.05 : 0.95);
    e.eac = r0(eacHours * e.standard_rate * 0.42);
    const fees = e.fee_model === 'fixed' ? e.budget_fees : Math.min(e.budget_fees * 1.15, eacHours * e.standard_rate * REAL_BASE);
    e.margin_at_completion = r2(clamp((fees - e.eac - fees * 0.02) / fees, -0.3, 0.7));
    e.write_off_risk = r2(clamp(sigmoid(-2.5 + 4 * Math.max(0, pressure) + (e._plantedQ3 ? 1.5 : 0) + clientById[e.client_id].payment_behaviour * 0.3), 0.01, 0.9));
    e.realisation_forecast = r2(clamp(REAL_BASE - 0.3 * Math.max(0, pressure) - (e._plantedQ3 ? 0.12 : 0) + R.norm(0, 0.02), 0.4, 1));
    e.health_score = r0(clamp(100 - 55 * e.overrun_prob - 25 * e.write_off_risk - 10 * (1 - e.realisation_forecast / REAL_BASE) * 5, 5, 99));
  }
  T.engagements.push(Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('_'))));
}
const engById = Object.fromEntries(T.engagements.map(e => [e.id, e]));

// =====================================================================
// 4. PERSON MONTHS (utilisation consistent with engagement hours)
// =====================================================================
const unitHoursByMonth = {};
for (const em of T.engagement_months) { const k = engById[em.engagement_id].unit + '|' + em.month; unitHoursByMonth[k] = (unitHoursByMonth[k] || 0) + em.hours; }
const csPeople = T.people.filter(p => p.client_service && (p.status === 'active' || p.left_date));
const peopleByUnit = {}; csPeople.forEach(p => (peopleByUnit[p.unit] = peopleByUnit[p.unit] || []).push(p));
for (const u of ref.units) {
  const ppl = peopleByUnit[u.id] || [];
  for (const m of MONTHS) {
    const mk = ymd(m);
    const present = ppl.filter(p => p.hire_date <= mk && (!p.left_date || p.left_date >= mk));
    // relative weights by level target
    let wsum = 0; const w = present.map(p => { const x = levelById[p.level].util_target * clamp(R.norm(1, 0.18), 0.4, 1.6) * (p.type === 'contractor' ? 0.6 : 1); wsum += x; return x; });
    const need = (unitHoursByMonth[u.id + '|' + mk] || 0) * 0.86;
    let scale = wsum > 0 ? need / (wsum * 150) : 0;
    if (u.id === 'NORD' && m.getUTCFullYear() === 2026) scale *= 1 + sa.nord_utilisation_gap_points / 100 * 1.3;
    present.forEach((p, i) => {
      const available = 150 + R.int(-20, 14);
      let chargeable = clamp(w[i] * 150 * scale, 0, available * 0.98);
      if (p.level === 'PARTNER') chargeable = Math.min(chargeable, available * 0.6);
      const overtime = p.sustained_weeks >= 4 && monthsBetween(m, LAST_CLOSED) < Math.ceil(p.sustained_weeks / 4.3) ? R.int(90, 130) : R.int(0, 25);
      const due = 4, late = R.chance(0.1 + (p.level === 'PARTNER' ? 0.15 : 0)) ? R.int(1, 2) : 0;
      T.person_months.push({ person_id: p.id, month: mk, chargeable_hours: r0(chargeable), available_hours: available, recorded_hours: r0(available + overtime), timesheets_due: due, timesheets_late: late });
    });
  }
}

// =====================================================================
// 5. PLAN (Anaplan stub) and FX
// =====================================================================
const unitActualRev = {}; for (const em of T.engagement_months) { const e = engById[em.engagement_id]; const k = e.unit + '|' + em.month; unitActualRev[k] = (unitActualRev[k] || 0) + em.billed; }
const unitHeadcount = {}; T.people.forEach(p => { if (p.status === 'active' && p.type === 'employee') unitHeadcount[p.unit] = (unitHeadcount[p.unit] || 0) + 1; });
for (const u of ref.units) {
  for (const m of PLAN_MONTHS) {
    const y = m.getUTCFullYear(); let plan;
    if (y <= 2025) { const actual = unitActualRev[u.id + '|' + ymd(m)] || unitRev25[u.id] / 12 * season(m); plan = actual * clamp(R.norm(1.0, 0.03), 0.92, 1.08); }
    else { const base25 = unitActualRev[u.id + '|' + ymd(new Date(Date.UTC(2025, m.getUTCMonth(), 1)))] || unitRev25[u.id] / 12 * season(m); plan = base25 * manifest.scale.plan_growth_2026 * (y === 2027 ? 1.09 : 1); }
    T.plan.push({ unit: u.id, month: ymd(m), revenue_plan: r0(plan), margin_plan: r2(clamp(R.norm(0.36, 0.02), 0.28, 0.45)), util_target: 0.68, headcount_plan: r0((unitHeadcount[u.id] || 0) * (y === 2026 ? 1.06 : y === 2027 ? 1.12 : 0.95)), collections_plan: r0(plan * 0.97) });
  }
}
const CURRENCIES = [['EUR', 1.08, 0.28], ['GBP', 1.27, 0.06], ['JPY', 0.0067, 0.04], ['INR', 0.012, 0.03], ['SAR', 0.2667, 0.07], ['AED', 0.2723, 0.06], ['AUD', 0.66, 0.03], ['CHF', 1.13, 0.02]];
for (const m of MONTHS) { for (const [cur, planRate, share] of CURRENCIES) { const drift = cur === 'JPY' ? -0.06 : cur === 'EUR' ? 0.03 : cur === 'GBP' ? 0.02 : cur === 'INR' ? -0.03 : 0; const t = monthsBetween(FIRST, m) / 33; T.fx_rates.push({ month: ymd(m), currency: cur, plan_rate: planRate, actual_rate: r2(planRate * (1 + drift * t + R.norm(0, 0.012)) * 10000) / 10000, revenue_share: share, source: 'market' }); } }

// =====================================================================
// 6. OPPORTUNITIES (Salesforce stub) with win probability (model 3)
// =====================================================================
const STAGES = ['Qualify', 'Propose', 'Negotiate', 'Verbal'];
const STAGE_LOGIT = { Qualify: -1.3, Propose: -0.6, Negotiate: 0.3, Verbal: 1.4 };
const partnerWinRate = {}; T.people.forEach(p => { if (p.level === 'PARTNER') partnerWinRate[p.id] = clamp(R.norm(0.36, 0.08), 0.15, 0.6); });
let oppSeq = 0;
for (const u of ref.units) {
  const n = Math.round(unitRev25[u.id] / 1.3e6);
  for (let i = 0; i < n; i++) {
    const created = addDays(new Date('2025-01-01T00:00:00Z'), R.int(0, 650));
    const isNew = R.chance(0.2);
    const client = isNew ? null : pickClientFor(u.id);
    const practice = R.weighted(Object.keys(PRACTICE_WEIGHTS), Object.values(PRACTICE_WEIGHTS));
    const value = R.lognorm(unitRev25[u.id] / 12 / Math.max(5, unitCapacity[u.id] / 4.6e6) * 5, 0.7);
    const age = Math.round((TODAY - created) / 86400000);
    const cycle = R.int(35, 160);
    const decided = age > cycle;
    const partner = anyPartner(u.id);
    const relationship = client ? clamp(R.norm(0.6, 0.25), 0, 1) : clamp(R.norm(0.25, 0.15), 0, 1);
    const priorWork = client ? engagementsRaw.filter(e => e.client_id === client.id).length : 0;
    const stage = decided ? 'Verbal' : R.weighted(STAGES, [30, 35, 22, 13]);
    const typical = unitRev25[u.id] / 12 / Math.max(5, unitCapacity[u.id] / 4.6e6) * 5;
    const terms = [
      ['Stage', STAGE_LOGIT[stage]], ['Relationship strength', 1.6 * (relationship - 0.5)], ['Prior work with the client', Math.min(0.8, 0.25 * priorWork)],
      ['Fee against typical', -0.5 * Math.log(Math.max(0.2, value / typical))], ['Opportunity age', -0.012 * Math.max(0, age - 60)], ['Partner record', 2.5 * (partnerWinRate[partner] - 0.36)]
    ];
    const logit = -0.4 + terms.reduce((a, t) => a + t[1], 0) + R.norm(0, 0.3);
    const prob = clamp(sigmoid(logit), 0.03, 0.97);
    const lastActivity = addDays(TODAY, -(decided ? R.int(30, 300) : (R.chance(0.22) ? R.int(31, 75) : R.int(0, 20))));
    const outcome = decided ? (R.chance(prob) ? 'won' : 'lost') : null;
    const newClientId = isNew ? 'C-' + String(N_CLIENTS + 1 + (++oppSeq % 60)).padStart(4, '0') : null;
    if (isNew && !clientById[newClientId]) { const c = { id: newClientId, name: 'Prospect ' + newClientId, is_public: false, industry: R.pick(ref.industries).id, region: regionOfUnit(u.id), unit: u.id, fortune_g500: R.chance(0.3), public_work: null, public_year: null, public_source: null, relationship_partner: partner, first_engaged: null, satisfaction: null, satisfaction_prev: null, sentiment_themes: null, payment_behaviour: 0, source: 'stub:salesforce' }; T.clients.push(c); clientById[c.id] = c; }
    T.opportunities.push({
      id: 'OPP-' + String(T.opportunities.length + 1).padStart(5, '0'), client_id: client ? client.id : newClientId, practice, industry: client ? client.industry : clientById[newClientId].industry, unit: u.id, region: regionOfUnit(u.id),
      partner_id: partner, stage: decided ? (outcome === 'won' ? 'Won' : 'Lost') : stage, value: r0(value), created_date: ymd(created), expected_close: ymd(addDays(created, cycle)),
      decided_date: decided ? ymd(addDays(created, cycle)) : null, outcome, win_prob: r2(prob),
      win_drivers: terms.map(t => ({ driver: t[0], effect: r2(t[1]) })).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)).slice(0, 4),
      last_activity: ymd(lastActivity), fee_model: R.weighted(FEE_MODELS, [45, 40, 15]), is_new_client: isNew, expected_start: ymd(addDays(created, cycle + R.int(14, 60))), source: 'stub:salesforce'
    });
  }
}
// LIC open pipeline: one DA opportunity proposed (white space to be confirmed) and one TRF extension
T.opportunities.push({ id: 'OPP-LIC01', client_id: 'LIC', practice: 'TRF', industry: 'FS', unit: 'IND', region: 'APAC', partner_id: clientById.LIC.relationship_partner, stage: 'Negotiate', value: 2600000, created_date: '2026-08-14', expected_close: '2026-11-10', decided_date: null, outcome: null, win_prob: 0.68, win_drivers: [{ driver: 'Prior work with the client', effect: 0.8 }, { driver: 'Stage', effect: 0.3 }, { driver: 'Relationship strength', effect: 0.5 }, { driver: 'Fee against typical', effect: -0.2 }], last_activity: '2026-10-06', fee_model: 'fixed', is_new_client: false, expected_start: '2026-12-01', source: 'stub:salesforce' });

// =====================================================================
// 7. CONTACTS (relationship maps)
// =====================================================================
const EXEC_TITLES = ['Chief Executive Officer', 'Chief Financial Officer', 'Chief Operating Officer', 'Chief Information Officer', 'Chief Strategy Officer', 'Chief Human Resources Officer', 'Head of Procurement', 'Chief Digital Officer', 'Managing Director, Transformation'];
let ctSeq = 0;
for (const c of T.clients) {
  if (c.name.startsWith('Prospect')) continue;
  const n = c.is_public ? R.int(5, 8) : (CLIENT_SIZE[T.clients.indexOf(c)] > 1.3 ? R.int(3, 6) : R.int(1, 3));
  const partners = new Set([c.relationship_partner]); engagementsRaw.filter(e => e.client_id === c.id).forEach(e => partners.add(e.partner_id));
  const pArr = [...partners];
  for (let i = 0; i < n; i++) {
    const title = c.id === 'LIC' && i === 0 ? 'Chief Executive Officer' : c.id === 'LIC' && i === 1 ? 'Chief Agency Officer' : c.id === 'LIC' && i === 2 ? 'Chief Financial Officer (new, since August 2026)' : EXEC_TITLES[i % EXEC_TITLES.length];
    const isNewCfo = title.startsWith('Chief Financial Officer (new');
    T.contacts.push({ id: 'CT-' + String(++ctSeq).padStart(5, '0'), client_id: c.id, title, kearney_person_id: isNewCfo ? null : R.pick(pArr), last_contact: isNewCfo ? null : ymd(addDays(TODAY, -R.int(2, 160))), strength: isNewCfo ? 0 : R.int(1, 5), source: 'stub:salesforce' });
  }
}
// someone in the firm knows the new LIC CFO from a prior client
{ const knower = R.pick(T.people.filter(p => p.level === 'AP' && p.unit === 'IND')); T.contacts.push({ id: 'CT-LICCFO', client_id: 'LIC', title: 'Chief Financial Officer (new, since August 2026): known from prior role at Client C-0117', kearney_person_id: knower ? knower.id : null, last_contact: '2026-05-20', strength: 3, source: 'stub:salesforce' }); }

// =====================================================================
// 8. KNOWLEDGE (Glean / Beehive stubs), adoption, staffing, calendar
// =====================================================================
ref.research_publications.forEach((t, i) => T.knowledge_assets.push({ id: 'PUB-' + (i + 1), title: t, type: 'Public research publication', practice: i === 0 || i === 4 ? 'GBPC' : i === 3 ? 'SG' : 'OPS', is_public: true, downloads: R.int(6000, 42000), citations: R.int(40, 600), reuse_count: R.int(10, 60), attributed_leads: R.int(6, 40), attributed_pipeline: r0(R.lognorm(9e6, 0.6)), source: 'public titles; usage stub:glean' }));
const ASSET_TOPICS = ['Retail pricing playbook', 'Procurement category strategy toolkit', 'Agentic AI operating model', 'Post-merger integration 100-day plan', 'Supply chain resilience diagnostic', 'Zero-based budgeting approach', 'Energy transition scenario model', 'Customer experience benchmark', 'SAP S/4 programme assurance', 'Working capital release toolkit', 'Automotive software cost model', 'Public sector FDI attraction framework', 'Insurance agency transformation playbook', 'Aerospace supplier risk model', 'Sustainability reporting readiness'];
ASSET_TOPICS.forEach((t, i) => T.knowledge_assets.push({ id: 'K-' + String(i + 1).padStart(3, '0'), title: 'Asset K-' + String(i + 1).padStart(3, '0') + ': ' + t, type: 'Internal asset', practice: R.pick(ref.practices).id, is_public: false, downloads: R.int(100, 2500), citations: 0, reuse_count: R.int(2, 45), attributed_leads: 0, attributed_pipeline: 0, source: 'stub:beehive' }));
[['Retail pricing in the Middle East', 310, 0.21], ['Agentic AI case studies', 540, 0.35], ['Generative AI pricing models', 220, 0.18], ['Procurement savings benchmarks', 460, 0.74], ['Supply chain resilience', 390, 0.69], ['SAP S/4 migration lessons', 280, 0.61], ['Insurance distribution benchmarks', 150, 0.3], ['Sustainability reporting CSRD', 260, 0.52], ['Post-merger integration templates', 420, 0.8], ['Hydrogen economics', 120, 0.25]].forEach(([topic, s, rate]) => T.knowledge_search_topics.push({ topic, searches: s, opened: Math.round(s * rate), source: 'stub:glean' }));
[['SAP S/4HANA (FOCUS)', 1900, 1620], ['Salesforce', 2400, 1310], ['PeopleSoft', 6637, 4980], ['IEM time entry', 5200, 4890], ['Concur', 6637, 5010], ['Anaplan', 320, 180], ['Power BI', 3100, 1240], ['Glean', 6637, 3980], ['Beehive', 6637, 2100], ['Expert Tracker', 1500, 260], ['Degreed', 6637, 1190], ['ServiceNow portal', 6637, 2860], ['FP&A Dashboard', 410, 70], ['WIPS 3.0', 900, 150]].forEach(([a, l, act]) => T.app_adoption.push({ application: a, licensed: l, active_30d: act, source: 'stub:servicenow-cmdb' }));
// staffing roles for the next eight weeks
const liveEng = T.engagements.filter(e => e.status === 'live');
for (let i = 0; i < 70; i++) {
  const e = R.pick(liveEng); const office = ref.offices.find(o => o.id === e.office);
  const level = R.weighted(['BA', 'ASSOCIATE', 'MANAGER', 'PRINCIPAL'], [25, 40, 25, 10]);
  const skills = [R.pick(PRACTICE_SKILLS[e.practice])]; if (R.chance(0.5)) skills.push(R.pick(SKILLS));
  const requested = addDays(TODAY, -R.int(1, 30)); const start = addDays(TODAY, R.int(-3, 56));
  const filled = R.chance(0.45);
  T.staffing_roles.push({ id: 'ROLE-' + String(i + 1).padStart(4, '0'), engagement_id: e.id, client_id: e.client_id, level, skills, location: office.city, unit: e.unit, start_date: ymd(start), weeks: R.int(3, 16), requested_date: ymd(requested), filled_date: filled ? ymd(addDays(requested, R.int(2, 14))) : null, status: filled ? 'filled' : 'open', language: LANG_BY_OFFICE_LANG[office.lang][0], source: 'stub:staffing' });
}
T.staffing_roles.push({ id: 'ROLE-RUH1', engagement_id: liveEng.find(e => e.unit === 'ME') ? liveEng.find(e => e.unit === 'ME').id : null, client_id: 'GACA', level: 'MANAGER', skills: ['Procurement', 'Supply chain'], location: 'Riyadh', unit: 'ME', start_date: ymd(addDays(TODAY, 6)), weeks: 10, requested_date: ymd(addDays(TODAY, -4)), filled_date: null, status: 'open', language: 'Arabic', source: 'stub:staffing' });
T.staffing_roles.push({ id: 'ROLE-RUH2', engagement_id: null, client_id: 'GACA', level: 'ASSOCIATE', skills: ['Procurement'], location: 'Riyadh', unit: 'ME', start_date: ymd(addDays(TODAY, 6)), weeks: 10, requested_date: ymd(addDays(TODAY, -4)), filled_date: null, status: 'open', language: 'English', source: 'stub:staffing' });
// calendars for personas
const tomorrow = addDays(TODAY, 1);
const ts = (d, h) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h)).toISOString();
T.calendar_events.push({ persona: 'gal', start_ts: ts(tomorrow, 9), end_ts: ts(tomorrow, 10), title: 'Meeting with Life Insurance Corporation of India leadership', client_id: 'LIC', is_client_meeting: true, attachments: [], source: 'stub:graph' });
T.calendar_events.push({ persona: 'gal', start_ts: ts(TODAY, 14), end_ts: ts(TODAY, 15), title: 'Account planning: Financial Services India', client_id: null, is_client_meeting: false, attachments: [], source: 'stub:graph' });
T.calendar_events.push({ persona: 'mp', start_ts: ts(TODAY, 11), end_ts: ts(TODAY, 12), title: 'Board preparation', client_id: null, is_client_meeting: false, attachments: [], source: 'stub:graph' });
T.calendar_events.push({ persona: 'cfo', start_ts: ts(TODAY, 15), end_ts: ts(TODAY, 16), title: 'Q4 forecast review with regional CFOs', client_id: null, is_client_meeting: false, attachments: [], source: 'stub:graph' });
T.calendar_events.push({ persona: 'rmd_eur', start_ts: ts(addDays(TODAY, 2), 8), end_ts: ts(addDays(TODAY, 2), 9), title: 'DACH leadership call', client_id: null, is_client_meeting: false, attachments: [], source: 'stub:graph' });
T.calendar_events.push({ persona: 'cpo', start_ts: ts(TODAY, 10), end_ts: ts(TODAY, 11), title: 'Principal promotion committee preparation', client_id: null, is_client_meeting: false, attachments: [], source: 'stub:graph' });

// =====================================================================
// 9. AGENT RUNS (last seven days) and MODEL REGISTRY
// =====================================================================
const PERSONAS = ['mp', 'cfo', 'rmd_eur', 'gpc_da', 'gal', 'principal', 'cpo', 'staffing'];
const SAMPLE_Q = ['Are we on track for the year?', 'Why did realisation drop in DACH last quarter?', 'Show me utilisation by unit in Europe against plan', 'Which of my engagements will overrun?', 'Prepare me for my meeting with LIC', 'Where will we lose the most Principals?', 'Who can start on a procurement engagement in Riyadh on Monday?', 'Which units will miss plan this quarter?', 'Compare revenue per partner across regions', 'What is our pipeline coverage for Q1 in Europe?', 'Show me the flight risk of my colleagues', 'Which invoices are most likely to go past 90 days?'];
const INTENT_OF = q => /why/i.test(q) ? 'explain' : /forecast|on track|overrun|will/i.test(q) ? 'predict' : /prepare|brief/i.test(q) ? 'brief' : /who can/i.test(q) ? 'match' : 'lookup';
const AGENTS_OF = { lookup: ['Conductor', 'Metric Agent', 'Query Agent', 'Dashboard Composer Agent', 'Briefing Agent', 'Guardian'], explain: ['Conductor', 'Metric Agent', 'Query Agent', 'Variance Agent', 'Dashboard Composer Agent', 'Briefing Agent', 'Guardian'], predict: ['Conductor', 'Metric Agent', 'Query Agent', 'Forecast Agent', 'Engagement Health Agent', 'Dashboard Composer Agent', 'Briefing Agent', 'Guardian'], brief: ['Conductor', 'Client 360 Agent', 'Pipeline and Win Agent', 'Briefing Agent', 'Guardian'], match: ['Conductor', 'Staffing Match Agent', 'Briefing Agent', 'Guardian'] };
// Agent runs are not seeded: the observatory shows only real runs made by this product.
const MODELS = [
  [1, 'Revenue forecast', 'Net fee revenue', 'Firm to practice; monthly, 1–4 quarters', 'Bottom-up engagement forecast reconciled with top-down time series', { metric: 'Backtest MAPE by quarter', value: 3.4, band_coverage: 0.86 }],
  [2, 'Utilisation forecast', 'Chargeable utilisation', 'Person, unit, level; weekly, 1–8 weeks', 'Gradient-boosted regression', { metric: 'Mean absolute error (points)', value: 2.7 }],
  [3, 'Win probability', 'Chance an opportunity is won', 'Opportunity; daily', 'Calibrated gradient-boosted classifier', { metric: 'AUC', value: 0.79, calibration_error: 0.04 }],
  [4, 'Engagement overrun', 'Cost and hours at completion; overrun date', 'Engagement; weekly', 'Quantile regression', { metric: 'Error at completion (closed engagements)', value: 6.1 }],
  [5, 'Write-off risk', 'Value likely to be written off', 'Engagement; monthly', 'Gradient-boosted regression', { metric: 'Error over last four quarters', value: 8.2 }],
  [6, 'Late payment', 'Chance an invoice passes 90 days', 'Invoice', 'Gradient-boosted classifier', { metric: 'Precision / recall', precision: 0.71, recall: 0.64 }],
  [7, 'Flight risk', 'Chance of a voluntary regretted exit', 'Person; monthly, six months ahead', 'Survival model with per-person explanations', { metric: 'Concordance index', value: 0.74, fairness: 'Pass (aggregated groups)' }],
  [8, 'Burnout alert', 'Sustained overload', 'Person; weekly', 'Rules with anomaly detection', { metric: 'Alert precision (People team feedback)', value: 0.68 }],
  [9, 'Skill demand forecast', 'Roles needed by skill, level and office', 'Weekly and quarterly', 'Monte Carlo simulation', { metric: 'Forecast against roles staffed', value: 0.81 }],
  [10, 'Hiring need forecast', 'Hires needed by office and level', 'Quarterly, 1–4 quarters', 'Driver model', { metric: 'Variance against plan', value: 7.5 }],
  [11, 'Metric anomaly detection', 'Unusual movement in any metric', 'Every metric and cut; daily', 'Seasonal decomposition with robust thresholds', { metric: 'Alert acceptance rate', value: 0.77 }],
  [12, 'Next-best practice', 'Practice most likely to sell into an account next', 'Account; monthly', 'Collaborative filtering', { metric: 'Hit rate on past cross-sells', value: 0.43 }],
  [13, 'Client sentiment', 'Themes and sentiment in client feedback', 'Engagement and account', 'Language model with prompts and a fixed theme list', { metric: 'Agreement with human-labelled sample', value: 0.84 }],
  [14, 'Narrative generation', 'Spoken and written explanations', 'Every answer', 'Language model with prompts; every number inserted from the Query Agent', { metric: 'Citation check pass rate', value: 0.995 }]
];
MODELS.forEach(([id, name, predicts, grain, method, accuracy]) => T.model_registry.push({ id, name, predicts, grain, method, version: '1.0-seed', accuracy, trained_at: id >= 13 ? null : (id === 7 || id === 8 ? '2026-10-01' : '2026-10-05'), status: 'active', retrain: id === 7 || id === 8 ? 'quarterly' : (id >= 13 ? 'n/a (prompts only)' : 'monthly'), uses_llm: id >= 13 }));

T.seed_meta.push({ key: 'seed_version', value: manifest.version }, { key: 'random_seed', value: String(manifest.random_seed) }, { key: 'generated_at', value: new Date().toISOString() }, { key: 'today', value: manifest.clock.today });

// ---------- summary ----------
function summary() {
  const rev = y => T.engagement_months.filter(m => m.month.startsWith(String(y))).reduce((a, m) => a + m.billed, 0);
  const partners = T.people.filter(p => p.level === 'PARTNER' && p.status === 'active').length;
  const q = (eid, from, to) => { const ms = T.engagement_months.filter(m => m.engagement_id === eid && m.month >= from && m.month <= to); const s = ms.reduce((a, m) => a + m.standard_value, 0); const b = ms.reduce((a, m) => a + m.billed, 0); return s ? r2(b / s) : null; };
  const dachReal = (from, to) => { const ids = new Set(T.engagements.filter(e => e.unit === 'DACH').map(e => e.id)); const ms = T.engagement_months.filter(m => ids.has(m.engagement_id) && m.month >= from && m.month <= to); return r2(ms.reduce((a, m) => a + m.billed, 0) / ms.reduce((a, m) => a + m.standard_value, 0)); };
  return {
    people: T.people.length, active: T.people.filter(p => p.status === 'active').length, partners, clients: T.clients.length, engagements: T.engagements.length, live: T.engagements.filter(e => e.status === 'live').length,
    engagement_months: T.engagement_months.length, person_months: T.person_months.length, invoices: T.invoices.length, opportunities: T.opportunities.length,
    revenue_2024: r0(rev(2024) / 1e6) + 'M', revenue_2025: r0(rev(2025) / 1e6) + 'M', revenue_2026_ytd: r0(rev(2026) / 1e6) + 'M',
    dach_realisation_q2: dachReal('2026-04-01', '2026-06-01'), dach_realisation_q3: dachReal('2026-07-01', '2026-09-01'),
    planted: planted.engagements.map(p => ({ id: p.id, exists: !!engById[p.id], q3: q(p.id, '2026-07-01', '2026-09-01'), overrun: engById[p.id] && engById[p.id].overrun_prob })),
    me_principal_risk: r2(T.people.filter(p => p.unit === 'ME' && p.level === 'PRINCIPAL' && p.status === 'active').reduce((a, p) => a + p.flight_risk, 0) / T.people.filter(p => p.unit === 'ME' && p.level === 'PRINCIPAL' && p.status === 'active').length),
    firm_principal_risk: r2(T.people.filter(p => p.level === 'PRINCIPAL' && p.status === 'active').reduce((a, p) => a + p.flight_risk, 0) / T.people.filter(p => p.level === 'PRINCIPAL' && p.status === 'active').length)
  };
}
module.exports = { tables: T, summary, manifest, TODAY };
if (require.main === module) {
  console.log(JSON.stringify(summary(), null, 2));
  if (process.argv.includes('--write')) { fs.writeFileSync(path.join(__dirname, 'seed-output.json'), JSON.stringify(T)); console.log('written seed-output.json'); }
}
