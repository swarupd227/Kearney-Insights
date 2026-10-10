'use strict';
/**
 * Staffing Match Agent: matches open roles to available people by skill, level, location, language and development need.
 * Proposes; the staffing manager confirms. Supply and demand by skill for the next eight weeks (model 9 output shape).
 */
const db = require('../db');
const engine = require('../metrics/engine');
const ref = require('../metrics/refcache');
const composer = require('./composer');
const { listWords, dateLabel } = require('./util');

function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function nextMonday(s) { const d = new Date(s + 'T00:00:00Z'); const day = d.getUTCDay(); const add = (8 - day) % 7 || 7; d.setUTCDate(d.getUTCDate() + add); return d.toISOString().slice(0, 10); }

async function candidates({ skills = [], level = null, location = null, unit = null, startBy = null, language = null, limit = 8, practice = null }) {
  const start = startBy || nextMonday(engine.TODAY);
  const office = location ? (ref.get().offices.find(o => o.city.toLowerCase() === location.toLowerCase()) || null) : null;
  const unitId = unit || (office ? office.unit : null);
  const regionId = unitId ? ref.get().unitById[unitId].region : null;
  // supply: rolling off by the start date, or on the bench last month
  const P = new engine.Params();
  const rows = await db.query(`SELECT p.id, p.office, p.unit, p.region, p.level, p.skills, p.languages, p.practice, p.roll_off_date, p.travel_weeks, p.learning_hours, pm.chargeable_hours, pm.available_hours
    FROM people p LEFT JOIN person_months pm ON pm.person_id=p.id AND pm.month=${P.add(engine.LAST_CLOSED)}
    WHERE p.status='active' AND p.client_service AND p.type='employee' AND p.level NOT IN ('PARTNER','AP') AND (p.roll_off_date <= ${P.add(start)} OR pm.chargeable_hours < 0.2*pm.available_hours)`, P.values);
  const want = skills.map(s => s.toLowerCase());
  const scored = rows.map(p => {
    const have = (p.skills || []).map(s => s.toLowerCase());
    const skillHits = want.filter(w => have.some(h => h.includes(w) || w.includes(h)));
    const reasons = []; let score = 0;
    if (want.length) { score += 40 * skillHits.length / want.length; if (skillHits.length) reasons.push(`has ${listWords(skillHits)}`); }
    if (level) { if (p.level === level) { score += 20; reasons.push(`${ref.labelOf('level', level)} level`); } else if (Math.abs(levelRank(p.level) - levelRank(level)) === 1) { score += 8; reasons.push(`adjacent level (${ref.labelOf('level', p.level)})`); } }
    if (office && p.office === office.id) { score += 20; reasons.push(`based in ${office.city}`); } else if (unitId && p.unit === unitId) { score += 14; reasons.push(`same unit (${ref.labelOf('unit', p.unit)})`); } else if (regionId && p.region === regionId) { score += 7; reasons.push('same region'); } else if (unitId) { score -= 5; reasons.push('cross-region move'); }
    const available = p.roll_off_date && p.roll_off_date <= start ? `rolls off ${dateLabel(p.roll_off_date)}` : 'on the bench';
    score += p.roll_off_date && p.roll_off_date <= start ? 10 : 12; reasons.push(available);
    if (language && (p.languages || []).map(l => l.toLowerCase()).includes(language.toLowerCase())) { score += 8; reasons.push(`speaks ${language}`); }
    if (practice && p.practice === practice) { score += 6; reasons.push(`${ref.labelOf('practice', practice)} practice`); }
    if (p.travel_weeks > 24 && unitId && p.unit !== unitId) { score -= 6; reasons.push('heavy travel already this year'); }
    if (want.length && skillHits.length < want.length && p.learning_hours > 15) { score += 3; reasons.push('development fit: high learning hours'); }
    return { id: p.id, level: p.level, level_name: ref.labelOf('level', p.level), office_name: ref.labelOf('office', p.office), unit_name: ref.labelOf('unit', p.unit), skills: p.skills, languages: p.languages, availability: available, roll_off_date: p.roll_off_date, score: Math.round(score), reasons };
  }).filter(c => !want.length || c.reasons.some(r => r.startsWith('has')) || c.score >= 30).sort((a, b) => b.score - a.score).slice(0, limit);
  const what = [skills.length ? skills.join(' and ') : null, level ? ref.labelOf('level', level) : null].filter(Boolean).join(' ');
  const narrative = `${scored.length} people can start${office ? ' in ' + office.city : unitId ? ' in ' + ref.labelOf('unit', unitId) : ''} by ${dateLabel(start)}${what ? ' for ' + what : ''}. ` + (scored[0] ? `${scored[0].id} (${scored[0].level_name}, ${scored[0].office_name}) is the best match: ${listWords(scored[0].reasons.slice(0, 4))}. ` : '') + (scored[1] ? `Then ${scored[1].id} (${scored[1].level_name}, ${scored[1].office_name}): ${listWords(scored[1].reasons.slice(0, 3))}.` : '') + ' Each match is a proposal; the staffing manager confirms it.';
  return { agent: 'Staffing Match Agent', candidates: scored, start, narrative, spoken: scored[0] ? `${scored[0].id}, a ${scored[0].level_name} in ${scored[0].office_name}, is the best match: ${listWords(scored[0].reasons.slice(0, 3))}. I can draft the assignment for your confirmation.` : 'No one matches by that date.', needsIndividualPeople: true, peopleField: 'availability',
    table: composer.table('Ranked candidates', `Start by ${dateLabel(start)}`, [['id', 'Person'], ['level_name', 'Level'], ['office_name', 'Office'], ['availability', 'Availability'], ['skills', 'Skills'], ['languages', 'Languages'], ['score', 'Match score'], ['reasons', 'Why']], scored, lineage()), visual: null,
    followUps: ['Confirm the first match', 'Show supply and demand by skill for the next eight weeks', 'Who is rolling off in the next three weeks?'] };
}
function levelRank(l) { return { BA: 1, ASSOCIATE: 2, MANAGER: 3, PRINCIPAL: 4, AP: 5, PARTNER: 6 }[l] || 0; }
async function rollingOff({ cut = {}, weeks = 3, skills = [], level = null }) {
  const P = new engine.Params();
  const rows = await db.query(`SELECT p.id, p.level, p.office, p.unit, p.skills, p.roll_off_date, p.practice FROM people p WHERE p.status='active' AND p.client_service AND p.roll_off_date BETWEEN ${P.add(engine.TODAY)} AND ${P.add(addDays(engine.TODAY, weeks * 7))} ${level ? `AND p.level='${level}'` : ''} ${engine.cutWhere(cut, engine.PPL_DIMS, P)} ORDER BY p.roll_off_date`, P.values);
  const want = skills.map(s => s.toLowerCase());
  const list = rows.filter(p => !want.length || (p.skills || []).some(s => want.some(w => s.toLowerCase().includes(w)))).map(p => ({ ...p, level_name: ref.labelOf('level', p.level), office_name: ref.labelOf('office', p.office), unit_name: ref.labelOf('unit', p.unit) }));
  const byWeek = {}; list.forEach(p => { const w = Math.ceil((new Date(p.roll_off_date) - new Date(engine.TODAY)) / (7 * 86400000)) || 1; byWeek[w] = (byWeek[w] || 0) + 1; });
  return { agent: 'Staffing Match Agent', people: list, needsIndividualPeople: true, peopleField: 'availability', narrative: `${list.length} ${level ? ref.labelOf('level', level) + 's' : 'people'}${skills.length ? ' with ' + skills.join(', ') : ''} roll off in the next ${weeks} weeks${composer.scopeLabel(cut)}: ${Object.entries(byWeek).map(([w, n]) => `${n} in week ${w}`).join(', ')}.`, spoken: `${list.length} people roll off in the next ${weeks} weeks.`, table: composer.table('Rolling off', `Next ${weeks} weeks`, [['id', 'Person'], ['level_name', 'Level'], ['office_name', 'Office'], ['unit_name', 'Unit'], ['roll_off_date', 'Roll-off'], ['skills', 'Skills']], list, lineage()), visual: null, followUps: ['Show open roles for the next eight weeks', 'Who can start on a procurement engagement in Riyadh on Monday?', 'Show the bench by office'] };
}
async function marketplace({ cut = {}, weeks = 8 }) {
  const P = new engine.Params();
  const roles = await db.query(`SELECT s.*, c.name AS client_name FROM staffing_roles s LEFT JOIN clients c ON c.id=s.client_id WHERE s.start_date <= ${P.add(addDays(engine.TODAY, weeks * 7))} ${engine.cutWhere(cut, { unit: 's.unit', level: 's.level' }, P)} ORDER BY s.status, s.start_date`, P.values);
  const P2 = new engine.Params();
  const supply = await db.query(`SELECT p.id, p.level, p.skills, p.roll_off_date, p.office, p.unit FROM people p WHERE p.status='active' AND p.client_service AND p.type='employee' AND p.roll_off_date BETWEEN ${P2.add(engine.TODAY)} AND ${P2.add(addDays(engine.TODAY, weeks * 7))} ${engine.cutWhere(cut, engine.PPL_DIMS, P2)}`, P2.values);
  const skillsAll = [...new Set(roles.flatMap(r => r.skills || []))];
  const demandBySkill = {}; roles.filter(r => r.status === 'open').forEach(r => (r.skills || []).forEach(s => demandBySkill[s] = (demandBySkill[s] || 0) + 1));
  const supplyBySkill = {}; supply.forEach(p => (p.skills || []).forEach(s => { if (skillsAll.includes(s)) supplyBySkill[s] = (supplyBySkill[s] || 0) + 1; }));
  const skills = skillsAll.map(s => ({ skill: s, demand: demandBySkill[s] || 0, supply: supplyBySkill[s] || 0, gap: (supplyBySkill[s] || 0) - (demandBySkill[s] || 0) })).sort((a, b) => a.gap - b.gap);
  const open = roles.filter(r => r.status === 'open');
  // weekly demand and supply
  const weeksArr = Array.from({ length: weeks }, (_, i) => i + 1);
  const weekly = weeksArr.map(w => ({ week: `W${w}`, demand: open.filter(r => Math.ceil((new Date(r.start_date) - new Date(engine.TODAY)) / (7 * 86400000)) <= w).length, supply: supply.filter(p => Math.ceil((new Date(p.roll_off_date) - new Date(engine.TODAY)) / (7 * 86400000)) <= w).length }));
  const narrative = `${open.length} roles are open for the next ${weeks} weeks${composer.scopeLabel(cut)} and ${supply.length} people roll off in the same window. ${skills[0] && skills[0].gap < 0 ? `The tightest skills are ${listWords(skills.filter(s => s.gap < 0).slice(0, 3).map(s => `${s.skill} (${-s.gap} short)`))}.` : 'Supply covers every skill in demand.'} Fill rate for roles already started: ${require('./util').pct(roles.filter(r => r.start_date <= engine.TODAY).length ? roles.filter(r => r.start_date <= engine.TODAY && r.status === 'filled').length / roles.filter(r => r.start_date <= engine.TODAY).length : 0, 0)}.`;
  return { agent: 'Staffing Match Agent', model: { id: 9, name: 'Skill demand forecast' }, roles: roles.map(r => ({ ...r, level_name: ref.labelOf('level', r.level), label: r.client_name || r.client_id || 'Internal' })), supply: supply.length, skills, weekly, narrative, spoken: narrative,
    visual: { type: 'line', title: `Supply and demand, next ${weeks} weeks`, subtitle: 'Cumulative open roles against people rolling off', x: weekly.map(w => w.week), series: [{ name: 'Demand (open roles)', data: weekly.map(w => w.demand) }, { name: 'Supply (roll-offs)', data: weekly.map(w => w.supply), kind: 'compare' }], format: 'number', seeded: true, lineage: lineage() },
    visual2: { type: 'bar', title: 'Gap by skill', subtitle: 'Supply minus demand', x: skills.map(s => s.skill), series: [{ name: 'Gap', data: skills.map(s => s.gap) }], format: 'number', horizontal: true, seeded: true, lineage: lineage() },
    table: composer.table('Open roles', `Start within ${weeks} weeks`, [['id', 'Role'], ['label', 'Client'], ['engagement_id', 'Engagement'], ['level_name', 'Level'], ['skills', 'Skills'], ['location', 'Location'], ['start_date', 'Start'], ['weeks', 'Weeks'], ['status', 'Status']], roles.filter(r => r.status === 'open').map(r => ({ ...r, level_name: ref.labelOf('level', r.level), label: r.client_name || r.client_id || 'Internal' })), lineage()),
    followUps: ['Who can start on a procurement engagement in Riyadh on Monday?', 'Show me Associates with SAP experience rolling off in the next three weeks', 'Which units are below 70% utilisation at Associate level?'] };
}
function lineage() { return { metric: 'staffing_match', name: 'Staffing match', formula: 'Score = skills (40) + level (20) + location (20) + availability (12) + language (8) + practice (6), minus travel load', owner: 'Staffing manager', source_system: 'Staffing system (to be confirmed), PeopleSoft/Workday, IEM', stub: 'stub:staffing + stub:peoplesoft', tables: ['people', 'person_months', 'staffing_roles'], model: 'Skill demand forecast v1.0-seed (Monte Carlo)', seeded: true, refreshed_at: engine.TODAY + 'T05:30:00Z' }; }
module.exports = { candidates, rollingOff, marketplace };
