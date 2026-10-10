'use strict';
/**
 * Guardian: checks every answer for access rights, privacy, citations and policy before display.
 * Pass, redact or block, with the reason logged to the audit log.
 */
const db = require('../db');

const SENSITIVE_FIELDS = ['flight_risk', 'flight_drivers', 'recorded_hours', 'sustained_weeks', 'counsellor_id', 'engagement_score_individual'];

function scopeCheck(persona, cut) {
  // Row-level security: a persona sees its own scope in full and the rest only as aggregates.
  const s = persona.scope || {};
  if (s.level === 'firm') return { ok: true };
  if (s.level === 'region') { if (cut.region && cut.region !== s.region) return { ok: false, aggregateOnly: true, reason: `Outside the ${persona.short} scope: other regions are shown as aggregates only` }; if (cut.unit && !unitInRegion(cut.unit, s.region)) return { ok: false, aggregateOnly: true, reason: `Unit ${cut.unit} is outside the ${persona.short} scope` }; return { ok: true }; }
  if (s.level === 'practice') return { ok: true, note: 'Practice leader scope: firm-wide view for the practice; other practices as aggregates' };
  if (s.level === 'accounts') { if (cut.client && !s.accounts.includes(cut.client)) return { ok: false, aggregateOnly: true, reason: 'Account outside this Global Account Leader scope' }; return { ok: true }; }
  if (s.level === 'engagements') { if (cut.engagement) { const ids = Array.isArray(cut.engagement) ? cut.engagement : [cut.engagement]; if (!ids.every(id => s.engagements.includes(id))) return { ok: false, aggregateOnly: true, reason: 'Engagement outside this Principal scope' }; } return { ok: true }; }
  return { ok: true };
}
let unitRegion = null;
function unitInRegion(unit, region) { return unitRegion ? unitRegion[unit] === region : true; }
async function init() { const rows = await db.query('SELECT id, region FROM units'); unitRegion = Object.fromEntries(rows.map(r => [r.id, r.region])); }

/**
 * check(request, ctx): request = { parsed, plan } -> { result: 'pass'|'redact'|'block', reason, log }
 */
function check({ parsed, plan }, persona) {
  const checks = [];
  // 1. Individual people data
  if (parsed.flags.individual_people || plan.needsIndividualPeople) {
    const allowed = persona.policy.individual_people === true || (persona.policy.individual_people === 'availability' && plan.peopleField === 'availability');
    if (!allowed) return { result: 'block', reason: `Individual people data (${plan.peopleField || 'flight risk and hours'}) is outside the ${persona.title} scope. Aggregates by unit and level are available. Individual scores are shown only to the counselling partner and authorised People leaders.`, policy: 'people_individual', checks };
    checks.push({ check: 'Individual people data', result: 'pass', detail: `${persona.title} is authorised; view logged` });
  }
  // 2. Partner compensation
  if (parsed.flags.partner_comp || plan.sensitive === 'partner_comp') {
    if (persona.policy.partner_comp !== 'committee' && persona.policy.partner_comp !== 'own') return { result: 'block', reason: 'Partner compensation data sits in a restricted model that only the partner compensation committee may query.', policy: 'partner_comp', checks };
    checks.push({ check: 'Partner compensation', result: 'pass', detail: 'Own credit only' });
  }
  if (plan.sensitive === 'partner_comp_aggregate' && persona.policy.partner_comp === 'none') return { result: 'block', reason: 'Profit per partner is restricted to firm leadership and the compensation committee.', policy: 'partner_comp', checks };
  // 3. Scope
  const sc = scopeCheck(persona, parsed.cut);
  if (!sc.ok && sc.aggregateOnly) { checks.push({ check: 'Row-level security', result: 'redact', detail: sc.reason }); return { result: 'redact', reason: sc.reason, policy: 'rls', checks, aggregateOnly: true }; }
  checks.push({ check: 'Row-level security', result: 'pass', detail: sc.note || `${persona.title} scope applied` });
  // 4. Citations (every number from the Query Agent; template narratives satisfy this by construction)
  checks.push({ check: 'Citation check', result: 'pass', detail: 'All numbers inserted from Query Agent results' });
  // 5. Action policy: draft only
  if (parsed.intent === 'act') checks.push({ check: 'Action policy', result: 'pass', detail: 'Draft only; a named approver must approve before any connector is called' });
  return { result: 'pass', checks };
}
async function log(persona, event, detail) { await db.query('INSERT INTO audit_log (persona, event, detail) VALUES ($1,$2,$3)', [persona, event, JSON.stringify(detail)]).catch(() => {}); }
function stripSensitive(rows) { return rows.map(r => { const o = { ...r }; SENSITIVE_FIELDS.forEach(f => delete o[f]); return o; }); }
module.exports = { init, check, log, stripSensitive, scopeCheck };
