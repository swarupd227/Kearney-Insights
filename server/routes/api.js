'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const personas = require('../personas');
const catalogue = require('../metrics/catalogue');
const engine = require('../metrics/engine');
const ref = require('../metrics/refcache');
const conductor = require('../agents/conductor');
const briefing = require('../agents/briefing');
const trend = require('../agents/trend');
const action = require('../agents/action');
const engagement = require('../agents/engagement');
const guardian = require('../agents/guardian');
const llm = require('../agents/llm');
const settingsStore = require('../settings');
const screens = require('./screens');
const { fmt } = require('../agents/util');

const router = express.Router();
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });
const personaOf = req => personas.byId[req.query.persona || req.body?.persona || 'mp'] || personas.byId.mp;

router.get('/health', wrap(async (req, res) => { const seeded = await db.isSeeded(); res.json({ ok: true, seeded, today: config.demoToday, demoMode: config.demoMode }); }));
router.get('/meta', wrap(async (req, res) => {
  const seed = await db.query('SELECT key, value FROM seed_meta');
  const llmStatus = await llm.status(); const ui = await settingsStore.get('ui', {});
  res.json({ personas: personas.PERSONAS.filter(p => !p.hidden).map(slim), hiddenPersonas: personas.PERSONAS.filter(p => p.hidden).map(slim), roles: personas.ROLES, tiers: personas.TIER_NAMES, demoMode: config.demoMode, today: config.demoToday, llm: llmStatus, llmEnabled: llmStatus.configured, provenance: ui.provenance === true, azureSpeech: config.azureSpeechEnabled, seed: Object.fromEntries(seed.map(s => [s.key, s.value])), metrics: catalogue.metrics.map(m => ({ id: m.id, name: m.name, family: catalogue.FAMILY_NAME[m.family], formula: m.formula, source: m.source, companion: m.companion, owner: m.owner, format: m.format })) });
}));

// Settings: language-model connection and UI preferences (stored in app_settings; the API key is never echoed back)
router.get('/settings', wrap(async (req, res) => { const s = (await settingsStore.get('llm', null)) || {}; const ui = await settingsStore.get('ui', {}); res.json({ llm: { provider: s.provider || 'none', endpoint: s.endpoint || '', model: s.model || '', apiVersion: s.apiVersion || '2024-10-21', planner: s.planner !== false, hasKey: Boolean(s.apiKey), keyMasked: s.apiKey ? s.apiKey.slice(0, 4) + '…' + s.apiKey.slice(-4) : null, defaults: llm.DEFAULT_MODELS }, status: await llm.status(), ui: { provenance: ui.provenance === true } }); }));
router.post('/settings', wrap(async (req, res) => {
  const persona = personaOf(req); const b = req.body || {};
  if (b.llm) { const prev = (await settingsStore.get('llm', null)) || {}; const next = { provider: b.llm.provider || 'none', endpoint: (b.llm.endpoint || '').trim(), model: (b.llm.model || '').trim(), apiVersion: (b.llm.apiVersion || '2024-10-21').trim(), apiKey: b.llm.apiKey ? String(b.llm.apiKey).trim() : (b.llm.clearKey ? '' : prev.apiKey || ''), planner: b.llm.planner === undefined ? (prev.planner !== false) : Boolean(b.llm.planner) }; await settingsStore.set('llm', next, persona.title); await db.query('INSERT INTO audit_log (persona, event, detail) VALUES ($1,$2,$3)', [persona.id, 'settings_llm', JSON.stringify({ provider: next.provider, model: next.model, endpoint: next.endpoint, keyChanged: Boolean(b.llm.apiKey || b.llm.clearKey) })]); }
  if (b.ui) { const ui = await settingsStore.get('ui', {}); await settingsStore.set('ui', { ...ui, ...b.ui }, persona.title); }
  llm.clearError();
  res.json({ ok: true, status: await llm.status() });
}));
router.post('/settings/test', wrap(async (req, res) => { const b = req.body && req.body.llm; let override = null; if (b && b.provider && b.provider !== 'none') { const prev = (await settingsStore.get('llm', null)) || {}; override = { provider: b.provider, endpoint: (b.endpoint || '').trim(), model: (b.model || '').trim(), apiVersion: b.apiVersion || '2024-10-21', apiKey: b.apiKey ? String(b.apiKey).trim() : prev.apiKey }; } res.json(await llm.test(override)); }));
function slim(p) { return { id: p.id, title: p.title, short: p.short, tier: p.tier, tierName: personas.TIER_NAMES[p.tier], titleSource: p.titleSource, decides: p.decides, home: p.home, questions: p.questions, defaultScreen: p.defaultScreen, scope: p.scope, policy: p.policy }; }
router.get('/reference', wrap(async (req, res) => { const r = await ref.load(); res.json({ regions: r.regions, units: r.units, offices: r.offices, practices: r.practices, industries: r.industries, levels: r.levels, clients: r.clients.filter(c => c.is_public), companies: r.companies }); }));

// Home and morning brief
router.get('/home/:persona', wrap(async (req, res) => {
  const persona = personas.byId[req.params.persona]; if (!persona) return res.status(404).json({ error: 'unknown persona' });
  const tiles = await Promise.all(persona.headline.map(async h => {
    const m = catalogue.byId[h.metric];
    const period = h.period === 'open' || h.period === 'now' ? 'now' : h.period;
    const cur = await engine.compute(h.metric, { cut: h.cut, period }).catch(() => null);
    // metrics that are a snapshot (open pipeline, lock-up, headcount ratios) have no meaningful month series or prior-month delta
    const snapshot = ['pipeline_value', 'weighted_pipeline', 'lockup_days', 'dso', 'leverage', 'staffing_fill_rate', 'time_to_staff', 'relationship_breadth', 'client_satisfaction', 'engagement_score', 'promotion_velocity', 'sustained_hours', 'learning_hours', 'recruiting_conversion', 'cross_practice_penetration', 'budget_burn', 'eac', 'regretted_attrition', 'fx_impact', 'ip_reuse_rate', 'win_rate'].includes(h.metric);
    let spark = [];
    if (!snapshot) { try { const p = engine.periodFor('ltm'); const s = await engine.compute(h.metric, { cut: h.cut, period: p, groupBy: 'month' }); spark = s.rows.map(r => r.value); } catch (e) { spark = []; } }
    let compare = null;
    if (h.compare === 'plan') { const pa = await engine.compute('plan_attainment', { cut: h.cut, period }).catch(() => null); if (pa && pa.rows[0] && pa.rows[0].plan) compare = { label: 'plan', value: pa.rows[0].plan, attainment: pa.rows[0].value }; }
    else if (h.compare === 'ly' && cur) { const ly = await engine.compute(h.metric, { cut: h.cut, period: engine.priorYear(cur.period) }).catch(() => null); if (ly) compare = { label: 'last year', value: ly.total.value }; }
    else if (!snapshot && cur && cur.period) { const pp = await engine.compute(h.metric, { cut: h.cut, period: engine.priorPeriod(cur.period) }).catch(() => null); if (pp && pp.total.value !== null) compare = { label: 'prior period', value: pp.total.value }; }
    const value = cur ? cur.total.value : null;
    const delta = compare && compare.value !== null && value !== null ? (m.format === 'pct' || m.format === 'ratio' || m.format === 'score' ? value - compare.value : value / compare.value - 1) : null;
    return { metric: h.metric, name: m.name, format: m.format, value, display: fmt(value, m.format), period: cur ? cur.period.label : '', cut: h.cut, spark, compare, delta, deltaKind: m.format === 'pct' || m.format === 'ratio' || m.format === 'score' ? 'pts' : 'pct', higherIsBetter: m.higherIsBetter, lineage: cur ? cur.lineage : null };
  }));
  const brief = await briefing.morningBrief(persona);
  const feed = await trend.feed(persona, { limit: 5 });
  const cards = await needsYou(persona);
  const pending = await db.query('SELECT * FROM actions WHERE status=$1 ORDER BY created_at DESC LIMIT 5', ['pending']);
  const events = await db.query('SELECT * FROM calendar_events WHERE persona=$1 ORDER BY start_ts', [persona.id]);
  res.json({ persona: slim(persona), tiles, brief, feed, cards, pending, events, seeded: config.demoMode });
}));
async function needsYou(persona) {
  const cards = [];
  const scopeCut = persona.scope.region ? { region: persona.scope.region } : persona.scope.practice ? { practice: persona.scope.practice } : persona.scope.accounts ? { client: persona.scope.accounts[0] } : persona.scope.engagements ? { engagement: persona.scope.engagements } : {};
  if (!scopeCut.client && !scopeCut.engagement && !scopeCut.practice) {
    const pa = await engine.compute('plan_attainment', { cut: scopeCut, period: 'qtd', groupBy: 'unit' });
    const worst = pa.rows.filter(r => r.gap !== null).sort((a, b) => a.gap - b.gap)[0];
    if (worst && worst.gap < 0) cards.push({ title: `${worst.label} is ${fmt(-worst.gap, 'money')} behind plan`, body: `Plan attainment ${fmt(worst.value, 'pct')} for ${pa.period.label}. The Variance Agent can split the gap into volume and realisation.`, ask: `Why is ${worst.label} behind plan?`, impact: -worst.gap, agent: 'Trend and Anomaly Agent' });
  }
  const eh = await engagement.board({ cut: scopeCut.practice ? scopeCut : scopeCut, limit: 3 }).catch(() => null);
  if (eh && eh.engagements[0] && eh.engagements[0].overrun_prob >= 0.5) cards.push({ title: `${eh.atRisk} engagements likely to overrun`, body: `${eh.engagements[0].id} (${eh.engagements[0].client_name}) leads at ${fmt(eh.engagements[0].overrun_prob, 'pct')}; predicted ${eh.engagements[0].predicted_overrun_date || 'before completion'}.`, ask: 'Which of my engagements will overrun budget, and by when?', impact: eh.atRisk * 1e6, agent: 'Engagement Health Agent' });
  if (persona.id === 'cpo' || persona.id === 'mp') { const talent = require('../agents/talent'); const h = await talent.heatmap({ level: 'PRINCIPAL' }); if (h.ranked[0]) cards.push({ title: `Principal flight risk concentrated in ${h.ranked[0].label}`, body: `About ${h.ranked[0].expected.toFixed(0)} expected exits in six months from ${h.ranked[0].n} Principals; drivers: ${h.drivers.slice(0, 2).map(d => d.driver.toLowerCase()).join(', ')}.`, ask: 'Where will we lose the most Principals in the next six months, and why?', impact: h.ranked[0].expected * 8e5, agent: 'Talent Risk Agent' }); }
  if (persona.id === 'gal') { cards.push({ title: 'Meeting with LIC leadership tomorrow', body: 'The Client 360 Agent has the account view ready; ask for the brief or the audio version.', ask: 'Prepare me for my meeting with LIC tomorrow', impact: 2.6e6, agent: 'Client 360 Agent' }); }
  if (persona.id === 'cfo') { const cash = require('../agents/cash'); const li = await cash.lateInvoices({ limit: 1 }); cards.push({ title: `${fmt(li.totals.expected_late, 'money')} of invoices likely to pass 90 days`, body: `${li.totals.n} open invoices; ${fmt(li.totals.overdue, 'money')} already overdue.`, ask: 'Which invoices are most likely to go past 90 days?', impact: li.totals.expected_late, agent: 'Forecast Agent' }); }
  if (persona.id === 'staffing') { const st = require('../agents/staffing'); const mk = await st.marketplace({}); const short = mk.skills.filter(s => s.gap < 0); cards.push({ title: `${mk.roles.filter(r => r.status === 'open').length} open roles in the next eight weeks`, body: short.length ? `Tightest skills: ${short.slice(0, 3).map(s => s.skill).join(', ')}.` : 'Supply covers demand.', ask: 'Who can start on a procurement engagement in Riyadh on Monday?', impact: 1e6, agent: 'Staffing Match Agent' }); }
  if (persona.id === 'gpc_da') { const pl = require('../agents/pipeline'); const r = await pl.room({ cut: { practice: 'DA' } }); cards.push({ title: `${r.stalled.length} Digital and Analytics deals stalled`, body: `${fmt(r.weighted, 'money')} weighted pipeline; ${r.stalled[0] ? r.stalled[0].id + ' is the largest stalled deal' : ''}.`, ask: 'Which large deals have not moved for 30 days?', impact: r.stalled.reduce((a, o) => a + o.value, 0), agent: 'Pipeline and Win Agent' }); }
  if (persona.id === 'principal') { const sc = require('../agents/staffing'); cards.push({ title: 'Staffing gap on E-1182', body: 'Two Associate roles open for the Implementation workstream; the Staffing Match Agent can propose candidates.', ask: 'Show me Associates with SAP experience rolling off in the next three weeks', impact: 4e5, agent: 'Staffing Match Agent' }); }
  return cards.sort((a, b) => b.impact - a.impact).slice(0, 3);
}

// Conversation
router.post('/ask', wrap(async (req, res) => {
  const { question, persona, session, context } = req.body || {};
  if (!question) return res.status(400).json({ error: 'question required' });
  const answer = await conductor.ask({ question, personaId: persona || 'mp', sessionId: session || 'default', context: context || {} });
  res.json(answer);
}));
router.post('/feedback', wrap(async (req, res) => { const { runId, value } = req.body; await db.query('UPDATE agent_runs SET feedback=$2 WHERE id=(SELECT id FROM agent_runs ORDER BY id DESC LIMIT 1)', [runId, value]); res.json({ ok: true }); }));

// Metrics and lineage
router.get('/metric/:id', wrap(async (req, res) => { const cut = {}; for (const d of ['region', 'unit', 'office', 'practice', 'industry', 'level', 'client', 'engagement']) if (req.query[d]) cut[d] = req.query[d]; const r = await engine.compute(req.params.id, { cut, period: req.query.period || 'ltm', groupBy: req.query.groupBy || null }); res.json(r); }));
router.get('/lineage/:id', wrap(async (req, res) => { const m = catalogue.byId[req.params.id]; if (!m) return res.status(404).json({ error: 'unknown metric' }); const r = await engine.compute(req.params.id, { period: req.query.period || 'ltm' }); res.json(r.lineage); }));

// Actions (screen 14)
router.get('/actions', wrap(async (req, res) => res.json(await action.list(personaOf(req)))));
router.post('/actions/:id/decide', wrap(async (req, res) => { const persona = personaOf(req); const row = await action.decide(parseInt(req.params.id, 10), req.body.decision, persona, req.body.edit); res.json(row); }));
router.post('/actions/draft', wrap(async (req, res) => { const persona = personaOf(req); const memory = conductor.memoryFor(req.body.session || 'default'); res.json(await action.draftFromContext(persona, memory)); }));

// Boards
router.get('/boards', wrap(async (req, res) => res.json(await db.query('SELECT * FROM boards WHERE persona=$1 ORDER BY created_at DESC', [personaOf(req).id]))));
router.post('/boards', wrap(async (req, res) => { const p = personaOf(req); const row = await db.one('INSERT INTO boards (persona, title, question, visual, schedule) VALUES ($1,$2,$3,$4,$5) RETURNING *', [p.id, req.body.title, req.body.question, JSON.stringify(req.body.visual || {}), req.body.schedule || null]); res.json(row); }));
router.delete('/boards/:id', wrap(async (req, res) => { await db.query('DELETE FROM boards WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));

// Audit
router.get('/audit', wrap(async (req, res) => res.json(await db.query('SELECT * FROM audit_log ORDER BY ts DESC LIMIT 50'))));

// Speech: Azure AI Speech token when configured (browser speech is the fallback)
router.get('/speech/token', wrap(async (req, res) => {
  if (!config.azureSpeechEnabled) return res.json({ provider: 'browser' });
  const r = await fetch(`https://${config.azureSpeech.region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': config.azureSpeech.key, 'Content-Length': '0' } });
  if (!r.ok) return res.json({ provider: 'browser', error: 'token request failed' });
  res.json({ provider: 'azure', token: await r.text(), region: config.azureSpeech.region });
}));

router.use('/screens', screens);
module.exports = router;
