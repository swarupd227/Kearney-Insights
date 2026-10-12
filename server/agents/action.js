'use strict';
/**
 * Action Agent: turns insights and predictions into drafted actions, each with an owner, a due date and an expected effect
 * computed from the data (every figure states the assumption behind it). Draft only: a named person approves every action.
 * Approved actions go to a stub that records them and sends nothing (demo mode).
 *
 * Two ways in: draftFromContext() answers "What should I do about it?" from the last insight; refreshQueue() lets the
 * predictions draft their own actions (overruns, flight risk, late invoices, stalled deals) so the action centre fills
 * itself each morning, ranked by expected effect.
 */
const db = require('../db');
const engine = require('../metrics/engine');
const ref = require('../metrics/refcache');
const { money, pct, dateLabel, num, countWord } = require('./util');

function due(days) { const d = new Date(engine.TODAY + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
const n = v => (v === null || v === undefined || isNaN(Number(v))) ? 0 : Number(v);
const REPLACEMENT_COST = { PARTNER: 1.5e6, AP: 1.1e6, PRINCIPAL: 8e5, MANAGER: 4e5, ASSOCIATE: 2.5e5, BA: 1.5e5 };
const COST_FACTOR = { NA: 1.25, DACH: 1.15, UKI: 1.15, ME: 1.3, IND: 0.38 }; // loaded-cost factors, the same as the scenario agent
const TARGET_MARGIN = 0.5;

// ---- Expected effect of an action, from the data. Returns { impact, text }; impact in US$.
async function pricingEffect(ids) {
  if (!ids.length) return null;
  const P = new engine.Params(); const from = engine.addMonths(engine.LAST_CLOSED, -5);
  const r = await db.one(`SELECT COALESCE(SUM(write_off),0) AS wo, COALESCE(SUM(discount),0) AS disc, COALESCE(SUM(standard_value),0) AS std FROM engagement_months WHERE engagement_id = ANY(${P.add(ids)}) AND month >= ${P.add(from)}`, P.values);
  const excess = Math.max(0, n(r.disc) - 0.10 * n(r.std)); const leak = n(r.wo) + excess; const impact = 0.5 * leak;
  return { impact, text: `Realisation recovered over the next six months if half of the last six months' write-offs (${money(n(r.wo))}) and discounts above 10% (${money(excess)}) are stopped` };
}
async function staffingEffect(engId) {
  if (!engId) return null;
  const e = (await engine.engagementList({ engagement: engId }, null))[0]; if (!e) return null;
  const weeks = Math.max(2, Math.min(12, Math.round((new Date(e.end_date) - new Date(engine.TODAY)) / (7 * 86400000))));
  const lvl = ref.get().levels.find(l => l.id === 'ASSOCIATE'); const local = COST_FACTOR[e.unit] || 1; const hours = 2 * weeks * 45;
  const impact = Math.max(0, hours * lvl.cost_rate * (local - COST_FACTOR.IND));
  return { impact, text: `Lower loaded cost over ${weeks} weeks: two Associate roles (${num(hours)} hours) delivered from India at ${money(lvl.cost_rate * COST_FACTOR.IND)} an hour instead of ${money(lvl.cost_rate * local)}` };
}
function retentionEffect(expected, level, label) {
  const cost = REPLACEMENT_COST[level] || 2.5e5; const impact = n(expected) * 0.3 * cost;
  return { impact, text: `Replacement cost avoided if one in three conversations changes the outcome: ${num(expected)} expected exits in ${label}, ${money(cost)} to replace each ${ref.labelOf('level', level)}` };
}
function pipelineEffect(opps) {
  const weighted = opps.reduce((a, o) => a + n(o.value) * n(o.win_prob), 0); const gross = opps.reduce((a, o) => a + n(o.value), 0);
  return { impact: weighted, text: `Weighted value back in motion: ${money(gross)} gross across ${opps.length} opportunities, weighted by win probability` };
}
function cashEffect(invoices) {
  const expected = invoices.reduce((a, i) => a + n(i.amount) * n(i.late_prob), 0); const gross = invoices.reduce((a, i) => a + n(i.amount), 0);
  return { impact: expected, text: `Collected within 30 days of the reminder, from ${money(gross)} outstanding (each invoice weighted by its late-payment probability)` };
}
function recoveryEffect(e) {
  const fees = n(e.budget_fees); const m = n(e.margin_at_completion); const impact = Math.max(0, (TARGET_MARGIN - m) * fees);
  return { impact, text: `Margin at risk: ${pct(m, 0)} margin at completion against a ${pct(TARGET_MARGIN, 0)} target on ${money(fees)} of fees` };
}
async function introductionEffect(practiceId, prob) {
  if (!practiceId) return null;
  const P = new engine.Params();
  const r = await db.one(`SELECT AVG(budget_fees) AS fee FROM engagements WHERE practice = ${P.add(practiceId)} AND budget_fees > 0`, P.values);
  const fee = n(r && r.fee); const share = n(prob) || 0.3; const impact = fee * share * 0.3;
  return { impact, text: `Expected from a typical ${ref.labelOf('practice', practiceId)} engagement of ${money(fee)}: ${pct(share, 0)} of similar clients bought it, one in three introductions assumed to convert` };
}
async function feesOf(ids) { if (!ids.length) return 0; const P = new engine.Params(); const r = await db.one(`SELECT COALESCE(SUM(budget_fees),0) AS fees FROM engagements WHERE id = ANY(${P.add(ids)})`, P.values); return n(r.fees); }

async function insert(persona, trigger, d, extra = {}) {
  // A draft with a key that is already waiting is not raised twice; the existing draft is returned instead.
  if (d.key) { const dup = await db.one(`SELECT * FROM actions WHERE status='pending' AND payload->>'key' = $1 LIMIT 1`, [d.key]); if (dup) return dup; }
  const payload = { ...extra, key: d.key || null, impact: d.effect ? Math.round(d.effect.impact) : null, impact_text: d.effect ? d.effect.text : (d.note || null), evidence: d.evidence || null, ask: d.ask || null, model: d.model || null };
  return db.one('INSERT INTO actions (persona, trigger_insight, action_type, title, body, owner, due_date, status, connector, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [persona, trigger, d.action_type, d.title, d.body, d.owner, d.due_date, 'pending', d.connector, JSON.stringify(payload)]);
}

// ---- "What should I do about it?": drafts from the last insight in the conversation
async function draftFromContext(persona, memory) {
  const drafts = [];
  const last = memory && memory.last;
  if (!last) return { drafts: [], narrative: 'Ask me about a metric, an engagement, a client or a team first, and I will draft actions from that insight.' };
  if (last.kind === 'variance_realisation' || last.kind === 'engagement_health') {
    const contributors = (last.contributors || last.engagements || []).slice(0, 3);
    const unit = last.cut && last.cut.unit ? ref.labelOf('unit', last.cut.unit) : 'the unit';
    const ids = contributors.map(c => c.engagement || c.id);
    drafts.push({ action_type: 'pricing_review', connector: 'Salesforce (opportunity and contract notes)', title: `Pricing review for ${ids.join(', ')}`, owner: 'Office or unit leader, ' + unit, due_date: due(10), effect: await pricingEffect(ids), ask: last.question, body: `Review rate discounts and fixed-fee scope on ${ids.join(', ')}: realisation ${contributors.map(c => `${c.engagement || c.id} ${pct(c.realisation ?? c.realisation_forecast, 0)}`).join(', ')}. Confirm change orders for scope added since signature and reset discount authority above 10%.` });
    drafts.push({ action_type: 'staffing_change', connector: 'Staffing system (generic interface)', title: `Staffing change: add cross-border capacity to ${ids[0] || 'the engagement'}`, owner: 'Staffing manager', due_date: due(5), effect: await staffingEffect(ids[0]), ask: `Show me Associates with SAP experience rolling off in the next three weeks`, body: `Replace two Associate roles on ${ids[0] || 'the engagement'} with Associates rolling off in another unit within two weeks, to reduce overrun hours at a lower loaded cost. Candidates are proposed on request.` });
    drafts.push({ action_type: 'note', connector: 'Outlook (draft to engagement partners)', title: `Note to the engagement partners on ${ids.join(', ')}`, owner: persona.title, due_date: due(2), note: `Confirms the recovery plan on ${money(await feesOf(ids))} of fees`, ask: last.question, body: `Draft for your edit: "The SAP data shows realisation on ${ids.join(', ')} below the unit average, driven by write-offs and fixed-fee overrun. Please confirm the recovery plan, the change-order position and the expected margin at completion by ${dateLabel(due(7))}."` });
  } else if (last.kind === 'talent') {
    const top = last.ranked && last.ranked[0]; const unit = top ? top.label : 'the unit';
    const people = last.people ? last.people.slice(0, 3).map(p => p.id) : [];
    drafts.push({ key: top && !people.length ? `retention:${top.unit}:PRINCIPAL` : null, action_type: 'retention_brief', connector: 'Workday (counsellor task) and Teams', title: `Retention conversation briefs for ${people.length ? people.join(', ') : 'the highest-risk Principals in ' + unit}`, owner: 'Counselling partners', due_date: due(14), effect: top ? retentionEffect(top.expected, 'PRINCIPAL', unit) : null, ask: last.question, body: `Prepare a retention conversation for each person: drivers (time since promotion, sustained hours), the next promotion window, and a staffing change to reduce hours. Briefs are generated per person for the counselling partner only.` });
    drafts.push({ action_type: 'promotion_review', connector: 'Workday (Career Roadmap System)', title: `Early promotion review for Principals in ${unit}`, owner: 'Chief People Officer', due_date: due(21), note: 'Brings the promotion decisions forward by one committee cycle', ask: 'How does our pyramid compare with last year?', body: `Bring forward the promotion committee review for Principals in ${unit} with more than 40 months in level and sustained hours above six weeks.` });
    drafts.push({ action_type: 'staffing_change', connector: 'Staffing system', title: `Rebalance hours in ${unit}`, owner: 'Staffing manager', due_date: due(7), note: 'Removes the sustained-hours driver for the people above 60 hours a week', ask: 'Show sustained hours by unit', body: `Cap new assignments for people with four or more weeks above 60 recorded hours and add capacity from the bench.` });
  } else if (last.kind === 'plan_gap' || last.kind === 'forecast') {
    const behind = (last.units || []).filter(u => u.gap < 0).slice(0, 2); const units = behind.map(u => u.label); const keys = behind.map(u => u.key).filter(Boolean);
    const P = new engine.Params();
    const stalled = keys.length ? await db.query(`SELECT o.*, c.name AS client_name FROM opportunities o LEFT JOIN clients c ON c.id=o.client_id WHERE o.outcome IS NULL AND o.value >= 1000000 AND o.unit = ANY(${P.add(keys)}) AND o.last_activity < ${P.add(engine.TODAY)}::date - 30 ORDER BY o.value DESC LIMIT 8`, P.values) : [];
    drafts.push({ action_type: 'pipeline_push', connector: 'Salesforce (tasks to partners)', title: `Pipeline acceleration in ${units.join(' and ') || 'the units behind plan'}`, owner: 'Regional Managing Director', due_date: due(14), effect: stalled.length ? pipelineEffect(stalled) : null, note: stalled.length ? null : 'No stalled opportunities above US$1 million in these units', ask: 'Which large deals have not moved for 30 days?', body: `Ask the partners who own stalled opportunities above US$1 million in ${units.join(' and ') || 'these units'} to confirm next steps within two weeks${stalled.length ? ': ' + stalled.map(o => o.id).join(', ') : ''}.` });
    drafts.push({ action_type: 'pricing_review', connector: 'Salesforce', title: `Realisation review in ${units[0] || 'the unit with the largest realisation effect'}`, owner: 'Office or unit leader', due_date: due(10), note: 'Recovers part of the realisation effect in the plan gap', ask: `Why did realisation drop in ${units[0] || 'the unit'} last quarter?`, body: `Review write-offs and discounts on the engagements the analysis named.` });
    drafts.push({ action_type: 'forecast_update', connector: 'Anaplan', title: 'Update the Q4 forecast with the P50 view', owner: 'Finance business partner', due_date: due(5), note: 'Keeps the forecast of record current', ask: 'Forecast revenue to year end', body: `Load the P50 forecast by unit into the Anaplan forecast scenario for review at the regional CFO call.` });
  } else if (last.kind === 'client360') {
    const c = last.clientObj || (last.client && typeof last.client === 'object' ? last.client : { name: ref.labelOf('client', last.client), relationship_partner: 'Relationship partner' }); const best = last.nextBest && last.nextBest.best;
    drafts.push({ action_type: 'introduction', connector: 'Outlook (draft)', title: `Introduction note on ${best ? best.label : 'the next practice'} to ${c.name}`, owner: persona.title, due_date: due(3), effect: best ? await introductionEffect(best.practice || best.id, best.score) : null, ask: 'Where is the white space?', body: `Draft for your edit: a short note to the sponsor proposing a diagnostic conversation on ${best ? best.label.toLowerCase() : 'the next practice'}, referencing the live work.` });
    drafts.push({ action_type: 'relationship', connector: 'Salesforce (contact task)', title: `Reconnect with executives at ${c.name} without contact for 90 days`, owner: c.relationship_partner, due_date: due(14), note: 'Restores decayed relationships before the next pursuit', ask: 'Who in the firm has worked with them?', body: 'Schedule a call with each decayed relationship; the account view lists them.' });
  } else if (last.kind === 'cash') {
    const P = new engine.Params();
    const inv = await db.query(`SELECT i.*, c.name AS client_name FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.status<>'paid' AND i.due_date < ${P.add(engine.TODAY)}::date - 60 ORDER BY i.late_prob DESC, i.amount DESC LIMIT 15`, P.values);
    drafts.push({ key: 'reminders:late-invoices', action_type: 'reminder', connector: 'Outlook (draft reminders)', title: `Reminders on ${inv.length} invoices more than 60 days past due`, owner: 'Billing and collections lead', due_date: due(3), effect: inv.length ? cashEffect(inv) : null, ask: last.question, body: `One reminder per invoice, naming the amount, the days past due and the engagement, copied to the engagement partner${inv.length ? ': ' + inv.slice(0, 6).map(i => i.id).join(', ') + (inv.length > 6 ? ' and others' : '') : ''}.` });
    drafts.push({ action_type: 'reminder', connector: 'Teams (direct message)', title: 'Late timesheet reminders', owner: 'Billing and collections lead', due_date: due(1), note: 'Releases the WIP held by late timesheets for billing', ask: 'How much WIP is held by late timesheets?', body: 'Message each person with a timesheet overdue by more than five days.' });
  } else {
    drafts.push({ action_type: 'note', connector: 'Outlook (draft)', title: 'Share this insight with the accountable leader', owner: persona.title, due_date: due(3), note: 'Puts the insight in front of the person who can act on it', ask: last.question, body: `Draft note summarising: ${last.narrative ? last.narrative.slice(0, 220) : 'the last answer'}` });
  }
  const inserted = [];
  for (const d of drafts) inserted.push(await insert(persona.id, last.question || last.kind, d, { source: 'question', source_kind: last.kind }));
  const total = inserted.reduce((a, r) => a + n(r.payload.impact), 0);
  const narrative = `I have drafted ${countWord(inserted.length, 'action', null, { cap: false })}${total ? ` worth about ${money(total)}` : ''}: ${inserted.map(a => `${a.title} (owner: ${a.owner}, due ${dateLabel(a.due_date)}${a.payload.impact ? ', about ' + money(a.payload.impact) : ''})`).join('; ')}. Nothing leaves the product until the named owner approves it in the action centre.`;
  return { agent: 'Action Agent', drafts: inserted, narrative, spoken: `I have drafted ${countWord(inserted.length, 'action', null, { cap: false })}${total ? ', worth about ' + money(total) : ''}: ${inserted.map(a => a.action_type.replace(/_/g, ' ')).join(', ')}. Each waits for the accountable person to approve it in the action centre.`, followUps: ['Open the action centre', 'Approve the first action', 'Read me the queue'] };
}

// ---- The predictions draft their own actions. Idempotent: an action with the same key that is pending, or was decided in the last week, is not raised again.
async function refreshQueue() {
  await db.query(`DELETE FROM actions WHERE status='pending' AND (payload IS NULL OR payload->>'source' IS NULL)`);
  const existing = new Set((await db.query(`SELECT payload->>'key' AS key FROM actions WHERE payload->>'key' IS NOT NULL AND (status='pending' OR decided_at > now() - interval '7 days')`)).map(r => r.key));
  const drafts = [];
  // 1. Engagements likely to overrun
  const live = await engine.engagementList({}, 'live');
  for (const e of live.filter(x => n(x.overrun_prob) >= 0.5 && recoveryEffect(x).impact > 0).slice(0, 4)) {
    const unit = ref.labelOf('unit', e.unit);
    drafts.push({ key: `recovery:${e.id}`, action_type: 'recovery_plan', connector: 'Teams (engagement channel) and SAP engagement note', title: `Recovery plan for ${e.id} (${e.client_name})`, owner: `Engagement partner, ${unit}`, due_date: due(7), effect: recoveryEffect(e), model: 'Engagement overrun', evidence: `Overrun probability ${pct(e.overrun_prob, 0)}: ${pct(n(e.hours_to_date) / Math.max(1, n(e.budget_hours)), 0)} of budget hours used at ${pct(e.elapsed, 0)} of elapsed time${e.predicted_overrun_date ? ', predicted overrun ' + dateLabel(e.predicted_overrun_date) : ''}`, ask: 'Which of my engagements will overrun budget, and by when?', body: `Agree a recovery plan with the engagement partner: re-baseline the remaining scope, confirm change orders for scope added since signature, and reset the staffing plan to finish within budget. The engagement is re-scored weekly.` });
  }
  // 2. Principal flight risk in the most exposed unit
  const talent = require('./talent'); const h = await talent.heatmap({ level: 'PRINCIPAL' });
  if (h.ranked[0]) { const u = h.ranked[0]; drafts.push({ key: `retention:${u.unit}:PRINCIPAL`, action_type: 'retention_brief', connector: 'Workday (counsellor task) and Teams', title: `Retention conversation briefs for Principals in ${u.label}`, owner: `Counselling partners, ${u.label}`, due_date: due(14), effect: retentionEffect(u.expected, 'PRINCIPAL', u.label), model: 'Flight risk', evidence: `About ${num(u.expected)} expected exits from ${u.n} Principals in six months; drivers: ${h.drivers.slice(0, 2).map(d => d.driver.toLowerCase()).join(', ')}`, ask: 'Where will we lose the most Principals in the next six months, and why?', body: `Prepare a retention conversation for each Principal above 35% flight risk in ${u.label}: drivers, the next promotion window, and a staffing change to reduce hours. Briefs are generated per person for the counselling partner only.` }); }
  // 3. Invoices most likely to pass 90 days
  const cash = require('./cash'); const li = await cash.lateInvoices({ limit: 15 });
  const target = li.invoices.filter(i => n(i.late_prob) >= 0.8 && n(i.days_past_due) > 30);
  if (target.length) drafts.push({ key: 'reminders:late-invoices', action_type: 'reminder', connector: 'Outlook (draft reminders)', title: `Reminders on the ${target.length} invoices most likely to pass 90 days`, owner: 'Billing and collections lead', due_date: due(3), effect: cashEffect(target), model: 'Late payment', evidence: `${target[0].id} (${target[0].client_name}, ${money(target[0].amount)}) leads at ${pct(target[0].late_prob, 0)}: ${(target[0].drivers || []).join(', ').toLowerCase()}`, ask: 'Which invoices are most likely to go past 90 days?', body: `One reminder per invoice, naming the amount, the days past due and the engagement, copied to the engagement partner. Disputed invoices get a call instead of a reminder.` });
  // 4. Stalled opportunities above US$1 million
  const pipeline = require('./pipeline'); const room = await pipeline.room({});
  const stalled = room.stalled.filter(o => n(o.value) >= 1e6).slice(0, 8);
  if (stalled.length) drafts.push({ key: 'stalled:firm', action_type: 'pipeline_push', connector: 'Salesforce (tasks to partners)', title: `Next steps on ${stalled.length} stalled opportunities above US$1 million`, owner: 'Partners owning the opportunities', due_date: due(10), effect: pipelineEffect(stalled), model: 'Win probability', evidence: `No activity for 30 days; the largest is ${stalled[0].id} (${stalled[0].client_name || stalled[0].client_id}, ${money(stalled[0].value)})`, ask: 'Which large deals have not moved for 30 days?', body: `A Salesforce task to each owning partner: confirm the next step and its date within two weeks, or move the opportunity to lost so the forecast stays honest. Opportunities: ${stalled.map(o => o.id).join(', ')}.` });
  const inserted = [];
  for (const d of drafts) {
    if (existing.has(d.key)) { await db.query(`UPDATE actions SET payload = payload || $2 WHERE status='pending' AND payload->>'key' = $1`, [d.key, JSON.stringify({ impact: d.effect ? Math.round(d.effect.impact) : null, impact_text: d.effect ? d.effect.text : null, evidence: d.evidence || null })]); continue; }
    inserted.push(await insert('system', d.evidence, d, { source: 'prediction' }));
  }
  if (inserted.length) await db.query('INSERT INTO audit_log (persona, event, detail) VALUES ($1,$2,$3)', ['system', 'actions_raised', JSON.stringify({ keys: inserted.map(a => a.payload.key), total_impact: inserted.reduce((a, r) => a + n(r.payload.impact), 0) })]);
  return inserted;
}

async function list(persona) {
  const rows = await db.query('SELECT * FROM actions ORDER BY status, created_at DESC');
  const impact = r => n(r.payload && r.payload.impact);
  return rows.sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || (a.status === 'pending' ? impact(b) - impact(a) : new Date(b.decided_at || b.created_at) - new Date(a.decided_at || a.created_at)));
}
// "Four actions are waiting for approval, worth about US$6.1 million."
function summary(rows) {
  const pending = rows.filter(r => r.status === 'pending'); const total = pending.reduce((a, r) => a + n(r.payload && r.payload.impact), 0);
  const text = pending.length ? `${countWord(pending.length, 'action')} ${pending.length === 1 ? 'is' : 'are'} waiting for approval${total ? ', worth about ' + money(total) : ''}.` : 'Nothing is waiting for approval.';
  return { n: pending.length, total, text, pending };
}
async function decide(id, decision, persona, edit) {
  const a = await db.one('SELECT * FROM actions WHERE id=$1', [id]); if (!a) return null;
  if (decision === 'edit') {
    // Editing keeps the draft pending; the edit is logged and the draft is marked as edited by the persona.
    const e = typeof edit === 'string' ? { body: edit } : (edit || {});
    const row = await db.one('UPDATE actions SET body=COALESCE($2, body), owner=COALESCE($3, owner), due_date=COALESCE($4, due_date), title=COALESCE($5, title), payload = payload || $6 WHERE id=$1 RETURNING *', [id, e.body || null, e.owner || null, e.due_date || null, e.title || null, JSON.stringify({ edited_by: persona.title, edited_at: new Date().toISOString() })]);
    await db.query('INSERT INTO audit_log (persona, event, detail) VALUES ($1,$2,$3)', [persona.id, 'action_edited', JSON.stringify({ action_id: id, title: row.title, fields: Object.keys(e) })]);
    return row;
  }
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const row = await db.one('UPDATE actions SET status=$2, decided_at=now(), decided_by=$3, payload = payload || $4 WHERE id=$1 RETURNING *', [id, status, persona.title, JSON.stringify(status === 'approved' ? { connector_result: `Recorded for ${a.connector}; nothing sent (demo mode)`, recorded_at: new Date().toISOString() } : {})]);
  await db.query('INSERT INTO audit_log (persona, event, detail) VALUES ($1,$2,$3)', [persona.id, 'action_' + status, JSON.stringify({ action_id: id, title: a.title, connector: a.connector, approver: persona.title, impact: a.payload && a.payload.impact })]);
  return row;
}
// The staffing manager confirms a proposed match; the assignment is recorded for the staffing system (nothing is sent in demo mode).
async function confirmMatch(persona, candidate, context) {
  const title = `Assign ${candidate.id} (${candidate.level_name || candidate.level}, ${candidate.office_name || candidate.office}) to ${context || 'the requested role'}`;
  const row = await db.one('INSERT INTO actions (persona, trigger_insight, action_type, title, body, owner, due_date, status, connector, decided_at, decided_by, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,$11) RETURNING *',
    [persona.id, context || 'Staffing match', 'staffing_assignment', title, `Proposed by the product: ${(candidate.reasons || []).join('; ')}. Confirmed by the ${persona.title}.`, persona.title, due(1), 'approved', 'Staffing system (generic interface)', persona.title, JSON.stringify({ candidate: candidate.id, connector_result: 'Recorded for the staffing system; nothing sent (demo mode)', recorded_at: new Date().toISOString() })]);
  await db.query('INSERT INTO audit_log (persona, event, detail) VALUES ($1,$2,$3)', [persona.id, 'action_approved', JSON.stringify({ action_id: row.id, title, connector: row.connector, approver: persona.title })]);
  return row;
}
const POLICY = [
  { agent: 'Action Agent', may_read: 'Outputs of other agents, role profile', may_draft: 'Recovery plans, staffing changes, pricing review notes, retention conversation briefs, pipeline tasks, forecast updates, reminders, introduction notes; each with an expected effect and the assumption behind it', may_execute: 'Nothing. Every action is a draft until a named approver approves it', connectors: 'Workday, Salesforce, ServiceNow, Teams, Outlook, Anaplan, staffing system (stubs in demo mode)', approvers: 'The named owner on each draft; the approval is logged with the approver title, time and expected effect' }
];
module.exports = { draftFromContext, refreshQueue, list, summary, decide, confirmMatch, POLICY };
