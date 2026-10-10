'use strict';
/**
 * Agent observatory: runs, response times, cost per answer, accuracy against backtests, Guardian blocks and user feedback.
 * Also serves the real IT service data path (ServiceNow ticket volumes and application adoption) for storyline E.
 */
const db = require('../db');
const engine = require('../metrics/engine');
const action = require('./action');
const composer = require('./composer');
const { money, pct, num } = require('./util');

const REGISTRY = [
  { agent: 'Conductor', job: 'Understands the request and screen context, plans which agents to call and merges the results', reads: 'Role profile, conversation memory, agent registry, screen state', drafts: 'Nothing', autonomy: 'Orchestrates only; never computes a number' },
  { agent: 'Guardian', job: 'Checks every answer for access rights, privacy, citations and policy before display', reads: 'Access policy, row-level security, Schedule O policy pack, sensitive field list', drafts: 'Nothing', autonomy: 'Pass, redact or block; every block logged' },
  { agent: 'Metric Agent', job: 'Resolves words to a governed metric definition', reads: 'Metric catalogue, business glossary, Purview catalogue', drafts: 'Nothing', autonomy: 'Read only' },
  { agent: 'Query Agent', job: 'Runs the resolved request against the semantic model', reads: 'Fabric semantic model, OneLake SQL endpoints, row-level security', drafts: 'Nothing', autonomy: 'Read only' },
  { agent: 'Dashboard Composer Agent', job: 'Chooses the visual and lays out a board', reads: 'Visual grammar, role layout templates', drafts: 'Personal boards', autonomy: 'Sharing needs the user’s confirmation' },
  { agent: 'Variance Agent', job: 'Splits a change into drivers and names the contributors', reads: 'Driver trees, query results for two periods', drafts: 'Nothing', autonomy: 'Read only' },
  { agent: 'Trend and Anomaly Agent', job: 'Separates seasonality from real change and raises alerts', reads: 'Time series per metric and cut', drafts: 'Alerts in the feed', autonomy: 'Read only; alerts only' },
  { agent: 'Forecast Agent', job: 'Forecasts revenue, margin, utilisation, cash and headcount', reads: 'Bookings, pipeline, staffing plan, time entries, history, plan', drafts: 'Nothing', autonomy: 'Read only' },
  { agent: 'Pipeline and Win Agent', job: 'Scores win probability and flags stalled deals', reads: 'Opportunity history, proposal features, partner and client history', drafts: 'Nothing', autonomy: 'Read only' },
  { agent: 'Engagement Health Agent', job: 'Predicts overrun, margin at completion and write-off risk', reads: 'Time entries, budgets, staffing plan, billing history', drafts: 'Nothing', autonomy: 'Read only' },
  { agent: 'Talent Risk Agent', job: 'Predicts regretted attrition and burnout risk with drivers', reads: 'People records, hours, staffing history, promotion timing, aggregated survey results', drafts: 'Nothing', autonomy: 'Read only; individual scores only to the counselling partner and People leaders' },
  { agent: 'Staffing Match Agent', job: 'Matches open roles to available people', reads: 'Staffing demand, skills, roll-off dates, preferences', drafts: 'Proposed matches', autonomy: 'Proposes; the staffing manager confirms' },
  { agent: 'Client 360 Agent', job: 'Builds an account view and a meeting brief', reads: 'SAP, Salesforce, client feedback, approved public news feed', drafts: 'Briefs', autonomy: 'Read only' },
  { agent: 'Scenario Agent', job: 'Runs what-if simulations', reads: 'Driver model, forecast baseline', drafts: 'Saved scenarios per user', autonomy: 'Read only' },
  { agent: 'Briefing Agent', job: 'Writes and speaks briefs and narratives', reads: 'Outputs of other agents, role profile, calendar (with consent)', drafts: 'Briefs, slide exports', autonomy: 'Read only' },
  { agent: 'Action Agent', job: 'Turns an insight into a drafted action', reads: 'Workday, Salesforce, ServiceNow, Teams and Outlook connectors', drafts: 'Actions with an owner and a due date', autonomy: 'Draft only; a named person approves every action' }
];

async function summary({ days = 7 } = {}) {
  const runs = await db.query(`SELECT agent, COUNT(*)::int AS runs, AVG(duration_ms) AS avg_ms, PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY duration_ms) AS p90_ms, AVG(cost_usd) AS avg_cost, SUM(CASE WHEN blocked THEN 1 ELSE 0 END)::int AS blocks, SUM(CASE WHEN feedback=1 THEN 1 ELSE 0 END)::int AS thumbs_up, SUM(CASE WHEN feedback=-1 THEN 1 ELSE 0 END)::int AS thumbs_down FROM agent_runs r, jsonb_array_elements_text(r.agents) agent WHERE r.ts >= $1::timestamptz - make_interval(days => $2) GROUP BY 1 ORDER BY 2 DESC`, [engine.TODAY + 'T23:59:59Z', days]);
  const totals = await db.one(`SELECT COUNT(*)::int AS runs, AVG(duration_ms) AS avg_ms, SUM(cost_usd) AS cost, AVG(cost_usd) AS avg_cost, SUM(CASE WHEN blocked THEN 1 ELSE 0 END)::int AS blocks, SUM(CASE WHEN (guardian->>'result')='redact' THEN 1 ELSE 0 END)::int AS redactions, SUM(CASE WHEN feedback=1 THEN 1 ELSE 0 END)::int AS up, SUM(CASE WHEN feedback=-1 THEN 1 ELSE 0 END)::int AS down FROM agent_runs WHERE ts >= $1::timestamptz - make_interval(days => $2)`, [engine.TODAY + 'T23:59:59Z', days]);
  const today = await db.query(`SELECT id, ts, persona, question, intent, agents, duration_ms, cost_usd, guardian, blocked FROM agent_runs WHERE ts >= $1::timestamptz ORDER BY ts DESC LIMIT 40`, [engine.TODAY + 'T00:00:00Z']);
  const byDay = await db.query(`SELECT date_trunc('day', ts)::date AS day, COUNT(*)::int AS runs, SUM(CASE WHEN blocked THEN 1 ELSE 0 END)::int AS blocks, AVG(duration_ms) AS avg_ms FROM agent_runs WHERE ts >= $1::timestamptz - make_interval(days => $2) GROUP BY 1 ORDER BY 1`, [engine.TODAY + 'T23:59:59Z', days]);
  const models = await liveModelAccuracy(await db.query('SELECT * FROM model_registry ORDER BY id'));
  const audit = await db.query('SELECT * FROM audit_log ORDER BY ts DESC LIMIT 25');
  const byIntent = await db.query(`SELECT intent, COUNT(*)::int AS runs, AVG(duration_ms) AS avg_ms FROM agent_runs WHERE ts >= $1::timestamptz - make_interval(days => $2) GROUP BY 1 ORDER BY 2 DESC`, [engine.TODAY + 'T23:59:59Z', days]);
  const llmStatus = await require('./llm').status();
  const narrative = totals.runs ? `Since first boot the agents have handled ${num(totals.runs)} questions at an average of ${(totals.avg_ms / 1000).toFixed(1)} seconds and ${money(totals.avg_cost || 0)} in model cost per answer (${money(totals.cost || 0)} in total; ${llmStatus.configured ? 'language model: ' + llmStatus.label : 'no language model configured, so model cost is zero'}). The Guardian blocked ${totals.blocks} answers and redacted ${totals.redactions}. Users rated ${totals.up} answers up and ${totals.down} down. ${models.length} models are registered; ${models.filter(m => m.uses_llm).length} use a language model through prompts only.` : `No questions have been asked yet. Every run, block and approval will appear here as it happens. ${llmStatus.configured ? 'Language model: ' + llmStatus.label + '.' : 'No language model is configured (Settings).'}`;
  return { agent: 'Guardian', registry: REGISTRY, runs, totals, today, byDay, byIntent, models, audit, policy: action.POLICY, narrative, spoken: `${num(totals.runs)} questions in ${days} days, ${(totals.avg_ms / 1000).toFixed(1)} seconds on average, ${totals.blocks} Guardian blocks. Every run, block and approval is in the audit trail.`,
    visual: { type: 'bar', title: 'Runs by agent, last 7 days', subtitle: 'With Guardian blocks', x: runs.map(r => r.agent), series: [{ name: 'Runs', data: runs.map(r => r.runs) }, { name: 'Blocks', data: runs.map(r => r.blocks), kind: 'compare' }], format: 'number', horizontal: true, seeded: true, lineage: { metric: 'agent_runs', name: 'Agent runs', formula: 'Count of runs per agent from the agent log', source_system: 'Astra agent log', stub: 'seeded runs + live runs from this session', tables: ['agent_runs', 'audit_log'], seeded: true } },
    table: composer.table('Agents', 'Runs, response time, cost, blocks, feedback', [['agent', 'Agent'], ['runs', 'Runs'], ['avg_ms', 'Avg ms', 'number'], ['p90_ms', 'P90 ms', 'number'], ['avg_cost', 'Cost per answer', 'money'], ['blocks', 'Blocks'], ['thumbs_up', 'Up'], ['thumbs_down', 'Down']], runs, null),
    followUps: ['What can the Action Agent change?', 'Show me our service desk volumes by application', 'Show the lineage of a number'] };
}
// Live accuracy, computed from the data in the database at request time where the data allows it:
// 1 revenue forecast (rolling backtest), 3 win probability (AUC on decided opportunities), 6 late payment (precision/recall on overdue invoices),
// 11 anomaly detection (alerts raised on the firm revenue series). Other models keep their registry figure and are labelled as such.
async function liveModelAccuracy(models) {
  const forecast = require('./forecast'); const trend = require('./trend');
  const out = models.map(m => ({ ...m, accuracy_text: Object.entries(m.accuracy || {}).map(([k, v]) => `${k}: ${v}`).join('; '), accuracy_basis: 'registry' }));
  try {
    const r = await engine.compute('net_fee_revenue', { period: { from: '2024-01-01', to: engine.LAST_CLOSED, label: '' }, groupBy: 'month' });
    const bt = forecast.backtest(r.rows.filter(x => x.value !== null).map(x => ({ month: x.key, value: x.value })));
    const m1 = out.find(m => m.id === 1); if (m1) { m1.accuracy_text = `Backtest MAPE ${(bt.mape * 100).toFixed(1)}% over the last ${bt.n} months (computed now)`; m1.accuracy_basis = 'live'; }
  } catch (e) { /* keep registry */ }
  try {
    const opps = await db.query(`SELECT win_prob, outcome FROM opportunities WHERE outcome IS NOT NULL`);
    const pos = opps.filter(o => o.outcome === 'won').map(o => o.win_prob), neg = opps.filter(o => o.outcome !== 'won').map(o => o.win_prob);
    let wins = 0; for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
    const auc = pos.length && neg.length ? wins / (pos.length * neg.length) : null;
    const m3 = out.find(m => m.id === 3); if (m3 && auc !== null) { m3.accuracy_text = `AUC ${auc.toFixed(2)} on ${opps.length} decided opportunities (computed now)`; m3.accuracy_basis = 'live'; }
  } catch (e) { /* keep registry */ }
  try {
    const inv = await db.query(`SELECT late_prob, status FROM invoices WHERE status <> 'open'`);
    const tp = inv.filter(i => i.late_prob >= 0.5 && i.status === 'overdue').length, fp = inv.filter(i => i.late_prob >= 0.5 && i.status !== 'overdue').length, fn = inv.filter(i => i.late_prob < 0.5 && i.status === 'overdue').length;
    const m6 = out.find(m => m.id === 6); if (m6 && (tp + fp) && (tp + fn)) { m6.accuracy_text = `Precision ${(tp / (tp + fp)).toFixed(2)}, recall ${(tp / (tp + fn)).toFixed(2)} on ${inv.length} settled or overdue invoices (computed now)`; m6.accuracy_basis = 'live'; }
  } catch (e) { /* keep registry */ }
  try {
    const s = await trend.scan('net_fee_revenue', {}, { months: 30 });
    const m11 = out.find(m => m.id === 11); if (m11) { m11.accuracy_text = `${s.alerts.length} alerts on the firm revenue series over 30 months; acceptance rate accrues from user feedback`; m11.accuracy_basis = 'live'; }
  } catch (e) { /* keep registry */ }
  return out;
}
async function policy() {
  const rows = REGISTRY.map(r => ({ ...r }));
  return { agent: 'Guardian', rows, policy: action.POLICY[0], narrative: `The Action Agent can draft ${action.POLICY[0].may_draft.toLowerCase()}. It can execute nothing: every draft waits for ${action.POLICY[0].approvers.toLowerCase()}. Permitted connectors: ${action.POLICY[0].connectors}. This is the same autonomy model as the Astra managed-services proposal: agent records, autonomy levels and an audit trail.`, spoken: 'The Action Agent is draft-only. It can propose staffing changes, pricing reviews, retention briefs and reminders, and a named person approves each one before any connector is called.', table: composer.table('Agent policy', 'What each agent may read and draft', [['agent', 'Agent'], ['reads', 'May read'], ['drafts', 'May draft'], ['autonomy', 'Autonomy']], rows, null, { seeded: false }), visual: null, followUps: ['Show me our service desk volumes by application', 'Show me what the agents did today', 'Open the action centre'] };
}
async function tickets() {
  const rows = await db.query('SELECT application, SUM(incidents)::int AS incidents, SUM(requests)::int AS requests, MIN(source) AS source, COUNT(DISTINCT month)::int AS months FROM servicenow_tickets GROUP BY 1 ORDER BY 2 DESC');
  const byMonth = await db.query('SELECT month, SUM(incidents)::int AS incidents, SUM(requests)::int AS requests FROM servicenow_tickets GROUP BY 1 ORDER BY 1');
  const real = rows.length > 0 && rows.every(r => r.source.startsWith('rfp-pack'));
  const sample = rows.length > 0 && rows.some(r => r.source.startsWith('sample'));
  const narrative = rows.length ? `Service desk volumes by application${real ? ' from the RFP pack ticket extracts' : ''}: ${rows.slice(0, 3).map(r => `${r.application} ${num(r.incidents)} incidents and ${num(r.requests)} requests`).join('; ')} over ${rows[0].months} months. This data reaches the product through the ServiceNow path rather than a finance or people connector.` : 'No ticket data loaded. Place the RFP pack extract at data/servicenow_tickets.csv and reseed.';
  return { agent: 'Query Agent', rows, byMonth, real, sample, narrative, spoken: rows.length ? `${rows[0].application} generates the most tickets, with ${num(rows[0].incidents)} incidents over ${rows[0].months} months.` : 'No ticket data loaded.',
    visual: { type: 'bar', title: 'Service desk tickets by application', subtitle: real ? 'RFP pack ticket extracts' : `Incidents and requests, last ${rows[0] ? rows[0].months : 0} months`, x: rows.map(r => r.application), series: [{ name: 'Incidents', data: rows.map(r => r.incidents) }, { name: 'Requests', data: rows.map(r => r.requests), kind: 'compare' }], format: 'number', horizontal: true, seeded: !real, badge: real ? 'Real: RFP pack' : 'Sample', lineage: { metric: 'ticket_volumes', name: 'Service desk ticket volumes', formula: 'Count of incidents and requests by application and month', source_system: 'ServiceNow (Table API)', stub: real ? 'rfp-pack:ticket-extract (real)' : 'sample file', tables: ['servicenow_tickets'], seeded: !real, path: ['ServiceNow', 'RFP pack extract (CSV)', 'Lakehouse table servicenow_tickets', 'Query Agent', 'Visual'] } },
    table: composer.table('Tickets by application', '', [['application', 'Application'], ['incidents', 'Incidents'], ['requests', 'Requests'], ['source', 'Source']], rows, null, { seeded: !real }), followUps: ['Which applications do fewer than 20% of licensed users open?', 'Show the lineage of this number', 'Show me what the agents did today'] };
}
async function adoption({ threshold = 0.2 } = {}) {
  const rows = (await db.query('SELECT application, licensed, active_30d, active_30d::numeric/licensed AS rate, source FROM app_adoption ORDER BY 4')).map(r => ({ ...r }));
  const low = rows.filter(r => r.rate < threshold);
  return { agent: 'Query Agent', rows, low, narrative: `${low.length} applications are opened by fewer than ${pct(threshold, 0)} of licensed users in the last 30 days: ${low.map(r => `${r.application} (${pct(r.rate, 0)} of ${num(r.licensed)})`).join(', ')}. Licence rationalisation candidates for the KNet cost review.`, spoken: `${low.length} applications are below ${pct(threshold, 0)} adoption, led by ${low[0] ? low[0].application : 'none'}.`, visual: { type: 'bar', title: 'Application adoption, last 30 days', subtitle: 'Active users ÷ licensed users', x: rows.map(r => r.application), series: [{ name: 'Adoption', data: rows.map(r => r.rate) }], format: 'pct', horizontal: true, target: threshold, seeded: true, lineage: { metric: 'app_adoption', name: 'Application adoption', formula: 'Active users in 30 days ÷ licensed users', source_system: 'ServiceNow CMDB, licence reports', stub: 'stub:servicenow-cmdb', tables: ['app_adoption'], seeded: true } }, table: composer.table('Adoption by application', '', [['application', 'Application'], ['licensed', 'Licensed'], ['active_30d', 'Active (30 days)'], ['rate', 'Adoption', 'pct']], rows, null), followUps: ['Show me our service desk volumes by application', 'Show me what the agents did today', 'What can the Action Agent change?'] };
}
async function knowledgeSearch(query) {
  const assets = await db.query('SELECT * FROM knowledge_assets ORDER BY reuse_count DESC');
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && !['find', 'material', 'kearney', 'documents', 'about', 'with', 'from', 'that', 'this', 'what', 'show'].includes(w));
  const hits = assets.map(a => ({ ...a, score: words.filter(w => a.title.toLowerCase().includes(w) || (a.practice || '').toLowerCase().includes(w)).length })).filter(a => a.score > 0).sort((a, b) => b.score - a.score || b.reuse_count - a.reuse_count);
  const topics = await db.query('SELECT * FROM knowledge_search_topics ORDER BY opened::numeric/searches');
  const gap = topics.find(t => words.some(w => t.topic.toLowerCase().includes(w)));
  const experts = await db.query(`SELECT p.id, p.level, p.office, p.skills FROM people p WHERE p.status='active' AND p.client_service AND p.level IN ('PARTNER','AP','PRINCIPAL') AND EXISTS (SELECT 1 FROM unnest(p.skills) s WHERE lower(s) = ANY($1)) ORDER BY p.level LIMIT 6`, [words]);
  const narrative = hits.length ? `${hits.length} assets match: ${hits.slice(0, 3).map(h => `${h.title} (${h.is_public ? 'public publication' : 'internal asset'}, reused ${h.reuse_count} times)`).join('; ')}.` : 'No registered asset matches that topic.' + (gap ? ` Glean shows ${gap.searches} searches for "${gap.topic}" with only ${pct(gap.opened / gap.searches, 0)} ending in a document opened: a content gap for the knowledge team.` : '') + (experts.length ? ` Experts by identifier: ${experts.map(e => e.id).join(', ')}.` : '');
  return { agent: 'Query Agent', hits: hits.slice(0, 8), gap, experts, narrative: narrative + (gap && hits.length ? ` Glean shows ${gap.searches} searches for "${gap.topic}" with ${pct(gap.opened / gap.searches, 0)} success, so this is a known content gap.` : ''), spoken: hits.length ? `${hits.length} assets match, led by ${hits[0].title}.` : 'Nothing registered matches; this is a content gap.', table: composer.table('Matching assets', 'From Beehive, team sites and Glean', [['title', 'Asset'], ['type', 'Type'], ['practice', 'Practice'], ['reuse_count', 'Reused'], ['downloads', 'Downloads']], hits.slice(0, 8), { metric: 'knowledge', name: 'Knowledge search', source_system: 'Glean, Beehive', stub: 'stub:glean', tables: ['knowledge_assets', 'knowledge_search_topics'], seeded: true }), visual: null, followUps: ['Which topics do consultants search for and fail to find?', 'Show IP reuse rate by practice', 'Who are the experts on this topic?'] };
}
module.exports = { summary, policy, tickets, adoption, knowledgeSearch, REGISTRY };
