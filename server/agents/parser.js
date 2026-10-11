'use strict';
/**
 * Natural-language understanding for the Conductor: intent, metrics, dimension members, period, grouping and comparison.
 * Deterministic and dictionary-based so the orals storylines never depend on a network call. Azure OpenAI, when configured,
 * is used only as a fallback for questions the dictionaries cannot resolve (see llm.js).
 */
const catalogue = require('../metrics/catalogue');
const ref = require('../metrics/refcache');

const REGION_SYN = { EUR: ['europe', 'european', 'emea'], APAC: ['asia pacific', 'asia-pacific', 'apac', 'asia'], AMER: ['americas', 'america'], MEA: ['middle east and africa', 'mea', 'middle east & africa'] };
const UNIT_SYN = { NA: ['north america', 'united states', 'usa', 'us and canada', 'canada'], LATAM: ['latin america', 'latam', 'brazil', 'mexico'], DACH: ['dach', 'germany', 'german', 'austria', 'switzerland'], UKI: ['uk and ireland', 'uk & ireland', 'uk', 'united kingdom', 'britain', 'ireland'], FRBNL: ['france and benelux', 'france', 'benelux', 'netherlands', 'belgium'], NORD: ['nordics', 'nordic', 'scandinavia', 'sweden', 'denmark', 'norway', 'finland'], SEUR: ['southern europe', 'spain', 'italy', 'portugal', 'iberia'], CEE: ['central and eastern europe', 'cee', 'eastern europe', 'poland', 'romania', 'czech'], IND: ['india', 'indian'], JPN: ['japan', 'japanese'], KOR: ['korea', 'korean'], GCN: ['greater china', 'china', 'hong kong'], SEA: ['southeast asia', 'south east asia', 'asean', 'thailand', 'indonesia', 'malaysia'], ANZ: ['australia and new zealand', 'anz', 'australia', 'new zealand'], ME: ['middle east', 'gulf', 'gcc', 'saudi arabia', 'uae', 'qatar'], AFR: ['africa', 'south africa'], TUR: ['türkiye', 'turkiye', 'turkey'] };
const PRACTICE_SYN = { DA: ['digital and analytics', 'digital & analytics', 'd&a', 'digital', 'analytics practice', 'data and analytics'], MA: ['mergers and acquisitions', 'm&a', 'mergers', 'acquisitions practice'], OPS: ['operations and performance', 'operations', 'ops'], ORG: ['organization', 'organisation', 'org practice'], PROC: ['procurement'], PER: ['perlab'], SUS: ['sustainability'], SG: ['strategy and growth', 'strategy'], TRF: ['transformation'], GBPC: ['global business policy council', 'policy council', 'gbpc'] };
const INDUSTRY_SYN = { FS: ['financial services', 'banks', 'banking', 'insurance', 'insurers'], PUB: ['public sector', 'government', 'governments'], CR: ['consumer and retail', 'retail', 'consumer'], AUTO: ['automotive', 'auto'], ER: ['energy and resources', 'energy', 'oil and gas', 'mining'], HLS: ['healthcare and life sciences', 'healthcare', 'life sciences', 'pharma'], TECH: ['technology', 'tech'], PE: ['private equity'], AD: ['aerospace and defense', 'aerospace', 'defense', 'defence'], MED: ['media'], COM: ['communications', 'telecom', 'telco'], IGS: ['industrial goods and services', 'industrial', 'industrials'], INF: ['infrastructure'], TT: ['transportation and travel', 'transportation', 'travel', 'aviation', 'airlines'] };
const LEVEL_SYN = { AP: ['associate partners', 'associate partner'], PARTNER: ['partners', 'partner level'], PRINCIPAL: ['principals', 'principal'], MANAGER: ['managers', 'manager', 'senior managers'], ASSOCIATE: ['associates', 'associate level', 'associate'], BA: ['business analysts', 'business analyst', 'analysts', 'senior business analysts'] };
const CLIENT_SYN = { LIC: ['lic', 'life insurance corporation', 'life insurance corporation of india'], DSM: ['dsm', 'dsm-firmenich', 'dsm firmenich', 'firmenich'], GACA: ['gaca', 'general authority of civil aviation', 'saudi general authority', 'saudi civil aviation'], GOP: ['government of pakistan', 'pakistan'], JL: ['j.league', 'j league', 'jleague'], TEF: ['telefónica', 'telefonica'] };
const STAGE_SYN = ['qualify', 'propose', 'negotiate', 'verbal'];

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function findDim(q, dict) {
  // longest synonym wins; returns [id, matchedText]
  let best = null;
  for (const [id, syns] of Object.entries(dict)) for (const s of syns) { const re = new RegExp('(^|[^a-z0-9&-])' + esc(s) + '(?=$|[^a-z0-9-])', 'i'); const m = q.match(re); if (m && (!best || s.length > best[1].length)) best = [id, s, m.index]; }
  return best;
}
function findAllDims(q, dict) {
  const out = []; for (const [id, syns] of Object.entries(dict)) for (const s of syns) { const re = new RegExp('(^|[^a-z0-9&-])' + esc(s) + '(?=$|[^a-z0-9-])', 'i'); if (re.test(q)) { out.push(id); break; } } return [...new Set(out)];
}

function parsePeriod(q) {
  const t = q.toLowerCase();
  const m = { horizon: null };
  if (/last quarter|previous quarter|past quarter/.test(t)) m.period = 'last_quarter';
  else if (/this quarter|quarter to date|qtd|current quarter/.test(t)) m.period = 'qtd';
  else if (/last (six|6) months|past (six|6) months/.test(t)) m.period = 'last_6m';
  else if (/last (three|3) years|three years ago|3 years ago/.test(t)) m.period = 'last_3y';
  else if (/last (twelve|12) months|last year|past year|trailing/.test(t)) m.period = 'ltm';
  else if (/this year|for the year|year to date|ytd|on track for the year|full year/.test(t)) m.period = 'ytd';
  else if (/last month|previous month/.test(t)) m.period = 'last_month';
  else if (/since (january )?2024|all time|history/.test(t)) m.period = 'all';
  const mo = t.match(/\b(in|for) (january|february|march|april|may|june|july|august|september|october|november|december)\b/);
  if (mo) { const idx = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].indexOf(mo[2]); const y = idx <= 8 ? 2026 : 2025; const ms = `${y}-${String(idx + 1).padStart(2, '0')}-01`; m.period = { from: ms, to: ms, label: mo[2][0].toUpperCase() + mo[2].slice(1) + ' ' + y }; }
  const qm = t.match(/\bq([1-4])\b(?: (\d{4}))?/);
  if (qm) { const qn = parseInt(qm[1], 10); const y = qm[2] ? parseInt(qm[2], 10) : (qn === 1 ? 2027 : 2026); m.quarterRef = { q: qn, year: y }; if (y <= 2026 && !(y === 2026 && qn === 4)) { const from = `${y}-${String((qn - 1) * 3 + 1).padStart(2, '0')}-01`; m.period = { from, to: `${y}-${String((qn - 1) * 3 + 3).padStart(2, '0')}-01`, label: `Q${qn} ${y}` }; } else m.horizon = { quarter: qn, year: y }; }
  if (/next (six|6) months/.test(t)) m.horizon = { months: 6 };
  else if (/next (three|3) months|next quarter/.test(t)) m.horizon = { months: 3 };
  else if (/next (eight|8) weeks/.test(t)) m.horizon = { weeks: 8 };
  else if (/next (three|3) weeks/.test(t)) m.horizon = { weeks: 3 };
  else if (/next month/.test(t)) m.horizon = { months: 1 };
  else if (/year.?end|to year end|end of (the )?year|full.year|for the year|rest of the year/.test(t)) m.horizon = { toYearEnd: true };
  else if (/next year|2027/.test(t)) m.horizon = { year: 2027 };
  else if (/two quarters ahead|next two quarters/.test(t)) m.horizon = { months: 6 };
  return m;
}

function parseGroupBy(q) {
  const t = q.toLowerCase();
  const map = [[/\bby (business )?unit\b|\bper unit\b|\bacross units\b|league table|which units|units (are|with|below|above|that)/, 'unit'], [/\bby region\b|\bacross regions\b|\bper region\b|\bby geography\b/, 'region'], [/\b(by|per|as per|across|into) practi[cs]es?\b|which practices|by offer|by service line/, 'practice'], [/\bby level\b|\bacross levels\b|\bper level\b|\bpyramid\b/, 'level'], [/\bby office\b|\bacross offices\b|\bper office\b/, 'office'], [/\bby client\b|\bby account\b|\bper client\b|\bper account\b|top clients|which clients|which of our/, 'client'], [/\bby industry\b|\bby sector\b|\bacross industries\b/, 'industry'], [/\bby month\b|\bmonthly\b|\btrend\b|over time|for the last|last (six|6|twelve|12) months|history/, 'month'], [/\bby quarter\b|\bquarterly\b/, 'quarter'], [/\bby year\b|\byearly\b|\bannual\b|last (three|3) years|three years ago/, 'year'], [/\bby engagement\b|which engagements|my engagements|which of my engagements/, 'engagement'], [/\bby fee model\b|fee mix|fee model mix/, 'fee_model'], [/\bby partner\b|which partners|partners whose/, 'partner'], [/\bby application\b|\bper application\b/, 'application'], [/\bby stage\b/, 'stage']];
  for (const [re, g] of map) if (re.test(t)) return g;
  return null;
}

function parseMetrics(q) {
  const t = ' ' + q.toLowerCase() + ' ';
  const found = [];
  for (const m of catalogue.metrics) {
    const names = [m.name.toLowerCase(), ...m.synonyms];
    for (const s of names) { const re = new RegExp('(^|[^a-z0-9-])' + esc(s) + '(?=$|[^a-z0-9-])', 'i'); const mm = t.match(re); if (mm) { found.push({ id: m.id, len: s.length, idx: mm.index }); break; } }
  }
  // de-duplicate overlapping families: keep the longest synonym match first, then by position
  found.sort((a, b) => b.len - a.len || a.idx - b.idx);
  const ids = []; for (const f of found) if (!ids.includes(f.id)) ids.push(f.id);
  return ids;
}

function parseIntent(q, parsed) {
  const t = q.toLowerCase();
  if (/what (should|can|do) i do|what should we do|draft|propose actions?|recommend(ed)? actions?|fix (it|this)/.test(t)) return 'act';
  if (/approve|reject/.test(t) && /action/.test(t)) return 'action_centre';
  if (/what if|what would|scenario|freeze|if we (raise|increase|cut|reduce|lower)|raise rates|rate increase|compare a .*with|happens to (profit|margin|revenue|leverage|utilisation|utilization)|if i (add|roll off|remove)|add one|roll off one|drops? \d+ points|improvement in realisation/.test(t)) return 'simulate';
  if (/what (did|have) the agents (do|done)|agent observatory|observatory|what can the action agent|agent polic|which agents|what the agents/.test(t)) return 'observatory';
  if (/service desk|ticket volumes|tickets by|incidents|help ?desk|applications do fewer|licensed users|adoption/.test(t)) return 'it_service';
  if (/how (was|is) this calculated|lineage|show (me )?the (calculation|lineage|source)|where does this number come from|trace/.test(t)) return 'lineage';
  if (/pin this|pin to my board|make this weekly|share this|turn this into a slide|export (this|to) (a )?slide|slide export/.test(t)) return 'board';
  if (/find me|material on|kearney material|documents? on|search for|knowledge on|who knows about|experts? on|look for/.test(t)) return 'knowledge';
  if (/prepare me|prepare for|brief me|meeting (with|tomorrow)|account (360|plan|brief)|audio brief|for the car|what have we done for|who in the firm (has worked|knows)|relationship map|white space|whitespace|where is the white/.test(t)) return 'client360';
  if (/who can start|who is available|who could start|available (on|from)|rolling off|roll.?off|bench list|open roles|staffing gap|who can i put|candidates for/.test(t)) return 'match';
  if (/lose the most|flight.?risk|highest.?risk|burnout|how many hires|hiring need|hires does|will leave|likely to leave/.test(t)) return 'predict';
  if (/^why\b|\bwhy\b|what (is|was) (driving|behind)|driver|drivers of|cause|caused|bridge|variance|explain (the|this|why)|what changed|contributors|what happened/.test(t)) return 'explain';
  if (/read the brief|morning brief|tell me more about the first|what has changed since|shorter/.test(t)) return 'brief';
  if (/\bforecast\b|\bpredict|\bprojection|\bon track\b|\bwill (we|it|they|this)\b|\blikely\b|probab|\bexpected to\b|next (six|6|three|3) months|year.?end|get worse|overrun|miss plan|at risk|flight.?risk|lose the most|how many hires|hiring need|need next year|go past 90|pay late|close this quarter|most likely to/.test(t)) return 'predict';
  if (/compare|versus|\bvs\b|across (regions|units|practices|levels|offices)|league table|which (units|practices|offices|regions|clients|levels)|rank|top \d+|lowest|highest|fastest|below \d+%|above \d+%|more than \d+ hours|buy (from )?only one/.test(t)) return 'compare';
  if (/show me|what is|what are|how much|how many|give me|list|tell me|open the|go to|take me to/.test(t)) return 'lookup';
  return 'lookup';
}

function parseScenario(q) {
  const t = q.toLowerCase(); const s = {};
  let m = t.match(/(raise|increase|rais(e|ing)) (billing )?rates? (by )?(\d+(?:\.\d+)?)\s?%/) || t.match(/(\d+(?:\.\d+)?)\s?% rate (increase|rise)/);
  if (m) s.rate_pct = parseFloat(m[5] || m[1]);
  m = t.match(/(cut|reduce|lower|decrease) (billing )?rates? (by )?(\d+(?:\.\d+)?)\s?%/); if (m) s.rate_pct = -parseFloat(m[4]);
  m = t.match(/utili[sz]ation (drops?|falls?|declines?) (by )?(\d+(?:\.\d+)?)\s?(points?|pts|%)/); if (m) s.util_points = -parseFloat(m[3]);
  m = t.match(/utili[sz]ation (rises?|improves?|increases?|goes up) (by )?(\d+(?:\.\d+)?)\s?(points?|pts|%)/); if (m) s.util_points = parseFloat(m[3]);
  m = t.match(/(\d+)[- ]?point improvement in realisation|realisation (improves?|rises?) (by )?(\d+)/); if (m) s.realisation_points = parseFloat(m[1] || m[4]);
  if (/freeze/.test(t)) { s.hiring_freeze = { level: findDim(t, LEVEL_SYN) ? findDim(t, LEVEL_SYN)[0] : 'ASSOCIATE', quarters: (t.match(/(\d|one|two|three|four) quarters?/) ? ({ one: 1, two: 2, three: 3, four: 4 }[t.match(/(\d|one|two|three|four) quarters?/)[1]] || parseInt(t.match(/(\d|one|two|three|four) quarters?/)[1], 10)) : 2) }; }
  m = t.match(/add (one|two|three|\d) (associate|manager|principal|business analyst)s? for (\d+|four|six|eight) weeks/); if (m) s.add_staff = { count: ({ one: 1, two: 2, three: 3 }[m[1]] || parseInt(m[1], 10)), level: m[2].toUpperCase().replace('BUSINESS ANALYST', 'BA'), weeks: ({ four: 4, six: 6, eight: 8 }[m[3]] || parseInt(m[3], 10)) };
  m = t.match(/roll off (one|two|\d) (associate|manager|principal|business analyst)s? (two|three|four|\d) weeks? early/); if (m) s.remove_staff = { count: ({ one: 1, two: 2 }[m[1]] || parseInt(m[1], 10)), level: m[2].toUpperCase(), weeks: ({ two: 2, three: 3, four: 4 }[m[3]] || parseInt(m[3], 10)) };
  m = t.match(/fee mix|shift (\d+)\s?% (to|into) fixed/); if (m && m[1]) s.fixed_fee_shift_pct = parseFloat(m[1]);
  if (/from january|from q1|next year|in january/.test(t)) s.start = '2027-01-01';
  if (/fx|currency|dollar strengthens|euro weakens/.test(t)) s.fx_pct = -3;
  return Object.keys(s).length ? s : null;
}

function parse(question, ctx = {}) {
  const q = question.trim();
  const t = q.toLowerCase();
  const r = ref.get();
  const cut = {};
  const region = findDim(t, REGION_SYN); const unit = findDim(t, UNIT_SYN);
  // "Middle East" alone is a unit; "Middle East and Africa" is the region. Unit match wins only if its text is longer.
  if (region && unit) { if (unit[1].length > region[1].length) cut.unit = unit[0]; else if (region[1] !== unit[1] && !region[1].includes(unit[1])) { cut.region = region[0]; cut.unit = unit[0]; } else cut.region = region[0]; }
  else if (region) cut.region = region[0]; else if (unit) cut.unit = unit[0];
  if (r) { const office = r.offices.find(o => new RegExp('\\b' + esc(o.city.toLowerCase()) + '\\b').test(t)); if (office) { cut.office = office.id; if (!cut.unit) cut.unit = undefined; } }
  const practices = findAllDims(t, PRACTICE_SYN); if (practices.length === 1 && !/by practice|which practices|across practices/.test(t)) cut.practice = practices[0]; else if (practices.length > 1) cut.practices = practices;
  const industry = findDim(t, INDUSTRY_SYN); if (industry) cut.industry = industry[0];
  const level = findDim(t, LEVEL_SYN); if (level) cut.level = level[0];
  const client = findDim(t, CLIENT_SYN); if (client) cut.client = client[0];
  const cm = q.match(/\bC-\d{4}\b/); if (cm) cut.client = cm[0];
  const em = q.match(/\bE-\d{4}\b/g); if (em) cut.engagement = em.length === 1 ? em[0] : em;
  const pm = q.match(/\bP-\d{5}\b/); if (pm) cut.person = pm[0];
  const fee = /fixed.fee/.test(t) ? 'fixed' : /time and materials|t&m/.test(t) ? 'tm' : null; if (fee) cut.fee_model = fee;
  const stage = STAGE_SYN.find(s => new RegExp('\\b' + s + '\\b').test(t)); if (stage) cut.stage = stage[0].toUpperCase() + stage.slice(1);
  const skills = []; for (const s of ['sap', 'procurement', 'supply chain', 'agentic ai', 'pricing', 'analytics', 'm&a', 'sustainability', 'digital', 'strategy', 'operations', 'cloud', 'data engineering', 'retail', 'financial services', 'public sector', 'energy', 'automotive', 'aerospace', 'ai']) if (new RegExp('(^|[^a-z])' + esc(s) + '(?=$|[^a-z])').test(t)) skills.push(s);
  // persona-relative scope
  const persona = ctx.persona;
  if (/\bmy (engagements?|projects?|team|colleagues|clients?|accounts?|opportunities|pipeline|unit|region|margin|counselees)\b/.test(t) && persona) {
    if (persona.scope.engagements && /engagement|project|team|margin|colleagues/.test(t)) { cut.engagement = cut.engagement || persona.scope.engagements; cut.unit = cut.unit || persona.scope.unit; }
    if (persona.scope.accounts && /client|account/.test(t)) cut.client = cut.client || persona.scope.accounts[0];
    if (persona.scope.region && /region|unit/.test(t)) cut.region = cut.region || persona.scope.region;
    if (persona.scope.practice) cut.practice = cut.practice || persona.scope.practice;
  }
  if (/this client|the client|their|them\b|they\b/.test(t) && !cut.client && ctx.memory && ctx.memory.client) cut.client = ctx.memory.client;
  if (/this client|the client/.test(t) && !cut.client && persona && persona.scope.accounts) cut.client = persona.scope.accounts[0];
  const period = parsePeriod(q);
  let groupBy = parseGroupBy(q);
  let metrics = parseMetrics(q);
  const intent = parseIntent(q, { metrics, cut });
  const compare = /against plan|vs\.? plan|versus plan|to plan|plan attainment|behind plan|miss plan|on track/.test(t) ? 'plan' : /year on year|compared with last year|vs\.? last year|than last year|versus last year/.test(t) ? 'ly' : /three years ago|compared with 3 years/.test(t) ? 'ly3' : null;
  // "same for X" / "only Principals": inherit from memory
  const followUp = /^(now |and )?(show|do) (me )?the same (for|in)|^only |^just |^and (for|in) |^what about|^now for|^same for|^(yeah,? |yes,? |ok,? |please )*(break|split|cut|slice) (it|this|that|the gap|that gap|this gap) (down |up )?(by|as per|per|across)/.test(t) || /^(will|does|is|can) (it|this|that)\b/.test(t) || /^what should i do about (it|this|that)/.test(t) || /^(tell me more|explain (that|this|it)|why\?*$|drill into this|why this dip)/.test(t);
  const flags = {
    individual_people: /highest.?risk|list (the|them)|show me the (people|individuals|names)|flight risk of my colleagues|who on my team|which (people|individuals)|by person|each person|per person|named people|show me who/.test(t),
    partner_comp: /credit fell|partners whose|origination credit|partner compensation|distribution/.test(t),
    wantsBoard: /pin|board/.test(t), wantsSlide: /slide/.test(t), wantsAudio: /audio|for the car|listen/.test(t), shorter: /shorter|briefly|in one line/.test(t)
  };
  if (intent === 'explain' && metrics.length === 0 && ctx.memory && ctx.memory.metrics) metrics = ctx.memory.metrics;
  return { question: q, intent, metrics, cut, groupBy, period: period.period || null, horizon: period.horizon, quarterRef: period.quarterRef || null, compare, scenario: parseScenario(q), skills, flags, followUp };
}
module.exports = { parse, REGION_SYN, UNIT_SYN, PRACTICE_SYN, INDUSTRY_SYN, LEVEL_SYN, CLIENT_SYN };
