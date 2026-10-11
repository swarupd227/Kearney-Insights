'use strict';
/**
 * Action Agent: turns an insight into drafted actions with an owner and a due date. Draft only: a named person approves every action.
 * Approved actions go to a stub that records them and sends nothing (demo mode).
 */
const db = require('../db');
const engine = require('../metrics/engine');
const ref = require('../metrics/refcache');
const { money, pct, dateLabel } = require('./util');

function due(days) { const d = new Date(engine.TODAY + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }

async function draftFromContext(persona, memory) {
  const drafts = [];
  const last = memory && memory.last;
  if (!last) return { drafts: [], narrative: 'Ask me about a metric, an engagement, a client or a team first, and I will draft actions from that insight.' };
  if (last.kind === 'variance_realisation' || last.kind === 'engagement_health') {
    const contributors = (last.contributors || last.engagements || []).slice(0, 3);
    const unit = last.cut && last.cut.unit ? ref.labelOf('unit', last.cut.unit) : 'the unit';
    const ids = contributors.map(c => c.engagement || c.id);
    drafts.push({ action_type: 'pricing_review', connector: 'Salesforce (opportunity and contract notes)', title: `Pricing review for ${ids.join(', ')}`, owner: 'Office or unit leader, ' + unit, due_date: due(10), body: `Review rate discounts and fixed-fee scope on ${ids.join(', ')}: realisation ${contributors.map(c => `${c.engagement || c.id} ${pct(c.realisation ?? c.realisation_forecast, 0)}`).join(', ')}. Confirm change orders for scope added since signature and reset discount authority above 10%.` });
    drafts.push({ action_type: 'staffing_change', connector: 'Staffing system (generic interface)', title: `Staffing change: add cross-border capacity to ${ids[0] || 'the engagement'}`, owner: 'Staffing manager', due_date: due(5), body: `Replace two Associate roles on ${ids[0] || 'the engagement'} with Associates rolling off in another European unit within two weeks, to reduce overrun hours at a lower loaded cost. candidates are proposed on request.` });
    drafts.push({ action_type: 'note', connector: 'Outlook (draft to engagement partners)', title: `Note to the engagement partners on ${ids.join(', ')}`, owner: persona.title, due_date: due(2), body: `Draft for your edit: "The SAP data shows realisation on ${ids.join(', ')} below the unit average, driven by write-offs and fixed-fee overrun. Please confirm the recovery plan, the change-order position and the expected margin at completion by ${dateLabel(due(7))}."` });
  } else if (last.kind === 'talent') {
    const unit = last.ranked && last.ranked[0] ? last.ranked[0].label : 'the unit';
    const people = last.people ? last.people.slice(0, 3).map(p => p.id) : [];
    drafts.push({ action_type: 'retention_brief', connector: 'Workday (counsellor task) and Teams', title: `Retention conversation briefs for ${people.length ? people.join(', ') : 'the highest-risk Principals in ' + unit}`, owner: 'Counselling partners', due_date: due(14), body: `Prepare a retention conversation for each person: drivers (time since promotion, sustained hours), the next promotion window, and a staffing change to reduce hours. Briefs are generated per person for the counselling partner only.` });
    drafts.push({ action_type: 'promotion_review', connector: 'Workday (Career Roadmap System)', title: `Early promotion review for Principals in ${unit}`, owner: 'Chief People Officer', due_date: due(21), body: `Bring forward the promotion committee review for Principals in ${unit} with more than 40 months in level and sustained hours above six weeks.` });
    drafts.push({ action_type: 'staffing_change', connector: 'Staffing system', title: `Rebalance hours in ${unit}`, owner: 'Staffing manager', due_date: due(7), body: `Cap new assignments for people with four or more weeks above 60 recorded hours and add capacity from the bench.` });
  } else if (last.kind === 'plan_gap' || last.kind === 'forecast') {
    const units = (last.units || []).filter(u => u.gap < 0).slice(0, 2).map(u => u.label);
    drafts.push({ action_type: 'pipeline_push', connector: 'Salesforce (tasks to partners)', title: `Pipeline acceleration in ${units.join(' and ') || 'the units behind plan'}`, owner: 'Regional Managing Director', due_date: due(14), body: `Ask the partners who own stalled opportunities above US$1 million in ${units.join(' and ') || 'these units'} to confirm next steps within two weeks; the pipeline view lists them.` });
    drafts.push({ action_type: 'pricing_review', connector: 'Salesforce', title: `Realisation review in ${units[0] || 'the unit with the largest realisation effect'}`, owner: 'Office or unit leader', due_date: due(10), body: `Review write-offs and discounts on the engagements the analysis named.` });
    drafts.push({ action_type: 'forecast_update', connector: 'Anaplan', title: 'Update the Q4 forecast with the P50 view', owner: 'Finance business partner', due_date: due(5), body: `Load the P50 forecast by unit into the Anaplan forecast scenario for review at the regional CFO call.` });
  } else if (last.kind === 'client360') {
    const c = last.client;
    drafts.push({ action_type: 'introduction', connector: 'Outlook (draft)', title: `Introduction note on ${last.nextBest && last.nextBest.best ? last.nextBest.best.label : 'the next practice'} to ${c.name}`, owner: persona.title, due_date: due(3), body: `Draft for your edit: a short note to the sponsor proposing a diagnostic conversation on ${last.nextBest && last.nextBest.best ? last.nextBest.best.label.toLowerCase() : 'the next practice'}, referencing the live work.` });
    drafts.push({ action_type: 'relationship', connector: 'Salesforce (contact task)', title: `Reconnect with executives at ${c.name} without contact for 90 days`, owner: c.relationship_partner, due_date: due(14), body: 'Schedule a call with each decayed relationship; the account view lists them.' });
  } else if (last.kind === 'cash') {
    drafts.push({ action_type: 'reminder', connector: 'Outlook (draft reminders)', title: 'Reminders to engagement managers on unbilled WIP over 60 days', owner: 'Billing and collections lead', due_date: due(3), body: 'One reminder per engagement with unbilled work older than 60 days, listing the amount and the missing timesheets.' });
    drafts.push({ action_type: 'reminder', connector: 'Teams (direct message)', title: 'Late timesheet reminders', owner: 'Billing and collections lead', due_date: due(1), body: 'Message each person with a timesheet overdue by more than five days.' });
  } else {
    drafts.push({ action_type: 'note', connector: 'Outlook (draft)', title: 'Share this insight with the accountable leader', owner: persona.title, due_date: due(3), body: `Draft note summarising: ${last.narrative ? last.narrative.slice(0, 220) : 'the last answer'}` });
  }
  const inserted = [];
  for (const d of drafts) {
    const row = await db.one('INSERT INTO actions (persona, trigger_insight, action_type, title, body, owner, due_date, status, connector, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [persona.id, last.question || last.kind, d.action_type, d.title, d.body, d.owner, d.due_date, 'pending', d.connector, JSON.stringify({ source_kind: last.kind })]);
    inserted.push(row);
  }
  const narrative = `I have drafted ${inserted.length} action${inserted.length === 1 ? '' : 's'}: ${inserted.map(a => `${a.title} (owner: ${a.owner}, due ${dateLabel(a.due_date)})`).join('; ')}. Nothing leaves the product until the named owner approves it in the action centre.`;
  return { agent: 'Action Agent', drafts: inserted, narrative, spoken: `I have drafted ${inserted.length} actions: ${inserted.map(a => a.action_type.replace('_', ' ')).join(', ')}. Each waits for the accountable person to approve it in the action centre.`, followUps: ['Open the action centre', 'Approve the first action', 'Show me what the agents did today'] };
}
async function list(persona, { all = false } = {}) {
  const rows = all ? await db.query('SELECT * FROM actions ORDER BY status, created_at DESC') : await db.query('SELECT * FROM actions ORDER BY status, created_at DESC');
  return rows;
}
async function decide(id, decision, persona, edit) {
  const a = await db.one('SELECT * FROM actions WHERE id=$1', [id]); if (!a) return null;
  const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'edited';
  const row = await db.one('UPDATE actions SET status=$2, decided_at=now(), decided_by=$3, body=COALESCE($4, body), payload = payload || $5 WHERE id=$1 RETURNING *', [id, status, persona.title, edit || null, JSON.stringify(status === 'approved' ? { connector_result: `Recorded by the ${a.connector} stub; nothing sent (demo mode)`, recorded_at: new Date().toISOString() } : {})]);
  await db.query('INSERT INTO audit_log (persona, event, detail) VALUES ($1,$2,$3)', [persona.id, 'action_' + status, JSON.stringify({ action_id: id, title: a.title, connector: a.connector, approver: persona.title })]);
  return row;
}
// The staffing manager confirms a proposed match; the Action Agent records the assignment in the staffing stub (nothing is sent in demo mode).
async function confirmMatch(persona, candidate, context) {
  const title = `Assign ${candidate.id} (${candidate.level_name || candidate.level}, ${candidate.office_name || candidate.office}) to ${context || 'the requested role'}`;
  const row = await db.one('INSERT INTO actions (persona, trigger_insight, action_type, title, body, owner, due_date, status, connector, decided_at, decided_by, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,$11) RETURNING *',
    [persona.id, context || 'Staffing match', 'staffing_assignment', title, `Proposed by the product: ${(candidate.reasons || []).join('; ')}. Confirmed by the ${persona.title}.`, persona.title, due(1), 'approved', 'Staffing system (generic interface)', persona.title, JSON.stringify({ candidate: candidate.id, connector_result: 'Recorded by the staffing stub; nothing sent (demo mode)', recorded_at: new Date().toISOString() })]);
  await db.query('INSERT INTO audit_log (persona, event, detail) VALUES ($1,$2,$3)', [persona.id, 'action_approved', JSON.stringify({ action_id: row.id, title, connector: row.connector, approver: persona.title })]);
  return row;
}
const POLICY = [
  { agent: 'Action Agent', may_read: 'Outputs of other agents, role profile', may_draft: 'Staffing changes, pricing review notes, retention conversation briefs, pipeline tasks, forecast updates, reminders, introduction notes', may_execute: 'Nothing. Every action is a draft until a named approver approves it', connectors: 'Workday, Salesforce, ServiceNow, Teams, Outlook, Anaplan, staffing system (stubs in demo mode)', approvers: 'The named owner on each draft; the approval is logged with the approver title and time' }
];
module.exports = { draftFromContext, list, decide, confirmMatch, POLICY };
