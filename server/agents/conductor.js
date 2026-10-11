'use strict';
/**
 * Conductor: reads the user's words and screen context, works out the intent, plans which agents to call and in what order,
 * and merges the results into one spoken and visual answer. It never computes a number itself.
 *
 * Every question follows the eight steps in Section 6: transcribe → classify and plan → resolve metrics → query under RLS →
 * run analytical agents → compose visual and narrative → Guardian → answer with lineage and follow-ups.
 */
const db = require('../db');
const config = require('../config');
const catalogue = require('../metrics/catalogue');
const engine = require('../metrics/engine');
const ref = require('../metrics/refcache');
const parser = require('./parser');
const guardian = require('./guardian');
const composer = require('./composer');
const briefing = require('./briefing');
const variance = require('./variance');
const forecast = require('./forecast');
const trend = require('./trend');
const pipeline = require('./pipeline');
const engagement = require('./engagement');
const talent = require('./talent');
const staffing = require('./staffing');
const client360 = require('./client360');
const scenario = require('./scenario');
const action = require('./action');
const cash = require('./cash');
const observatory = require('./observatory');
const llm = require('./llm');
const personas = require('../personas');
const { fmt, pct, money, countWord } = require('./util');

const sessions = new Map();
function memoryFor(sessionId) { if (!sessions.has(sessionId)) sessions.set(sessionId, { history: [] }); return sessions.get(sessionId); }

class Timeline {
  constructor() { this.steps = []; }
  async run(agent, actionText, fn) { const t0 = Date.now(); const out = await fn(); this.steps.push({ agent, action: actionText, ms: Date.now() - t0 }); return out; }
  note(agent, actionText, ms = 0) { this.steps.push({ agent, action: actionText, ms }); }
}

async function ask({ question, personaId, sessionId = 'default', context = {} }) {
  const t0 = Date.now();
  const persona = personas.byId[personaId] || personas.byId.mp;
  const memory = memoryFor(sessionId);
  const tl = new Timeline();
  const parsed = await tl.run('Conductor', 'Classified intent and planned the work', async () => parser.parse(question, { persona, memory: memory.last ? { client: memory.last.client, metrics: memory.last.metrics } : null }));
  // screen context (point and ask): clicked element supplies the cut
  if (context && context.cut) { for (const [k, v] of Object.entries(context.cut)) if (!parsed.cut[k]) parsed.cut[k] = v; }
  if (context && context.metric && !parsed.metrics.length) parsed.metrics = [context.metric];
  // follow-ups inherit the last cut and metric
  if (parsed.followUp && memory.last) { parsed.cut = { ...memory.last.cut, ...parsed.cut }; if (!parsed.metrics.length && memory.last.metrics) parsed.metrics = memory.last.metrics; parsed.period = parsed.period || memory.last.period; }
  // "only Principals" / "now show the same for Asia Pacific" keep the previous intent
  if (parsed.followUp && memory.last && /^(now |and )?(show|do) (me )?the same|^only |^just |^what about|^same for|^now for|^and (for|in) |(break|split|cut|slice) (it|this|that|the gap|that gap|this gap) (down |up )?(by|as per|per|across)/.test(question.toLowerCase())) { parsed.intent = memory.last.intent || parsed.intent; if (memory.last.compare && !parsed.compare) parsed.compare = memory.last.compare; }

  // Language-model planner: when a provider is configured in Settings the Conductor plans every question with it, using the
  // dictionary parse as a hint (and as the fallback if the model returns nothing usable). Follow-ups keep their context.
  llm.takeUsage();
  const routed = /open the|go to|take me to|action centre|pin this|make this weekly|turn this into a slide|share this|how was this calculated|lineage/.test(question.toLowerCase());
  if (!routed && !parsed.followUp && await llm.enabled() && await llm.plannerEnabled()) {
    const r = ref.get(); const st = await llm.status();
    const dims = { region: r.regions.map(x => x.id), unit: r.units.map(x => x.id), practice: r.practices.map(x => x.id), industry: r.industries.map(x => x.id), level: ['PARTNER', 'AP', 'PRINCIPAL', 'MANAGER', 'ASSOCIATE', 'BA'], client: r.clients.filter(c => c.is_public).map(c => c.id) };
    const hint = { intent: parsed.intent, metrics: parsed.metrics, cut: parsed.cut, groupBy: parsed.groupBy, period: parsed.period, compare: parsed.compare };
    const lp = await tl.run('Conductor', `Planned the question with ${st.label}`, () => llm.planFallback(question, { metricIds: catalogue.metrics.map(m => m.id), dims, persona, hint }));
    if (lp && typeof lp === 'object') {
      const INTENTS = ['lookup', 'compare', 'explain', 'predict', 'simulate', 'act', 'brief', 'match', 'client360', 'knowledge', 'observatory', 'it_service', 'chat'];
      const STICKY = ['client360', 'match', 'act', 'action_centre', 'simulate', 'observatory', 'it_service', 'knowledge', 'brief', 'lineage', 'board'];
      // a conversational answer is allowed only when the dictionary found nothing specific (a plain look-up with no metric)
      if (lp.intent === 'chat') { if (parsed.intent === 'lookup' && !parsed.metrics.length) parsed.intent = 'chat'; }
      else if (INTENTS.includes(lp.intent) && !STICKY.includes(parsed.intent)) parsed.intent = lp.intent;
      if (Array.isArray(lp.metrics)) parsed.metrics = lp.metrics.filter(m => catalogue.byId[m]);
      if (lp.cut && typeof lp.cut === 'object') for (const [k, v] of Object.entries(lp.cut)) if (dims[k] && dims[k].includes(v)) parsed.cut[k] = v;
      if (['month', 'quarter', 'year', 'region', 'unit', 'office', 'practice', 'industry', 'level', 'client', 'engagement'].includes(lp.groupBy)) parsed.groupBy = lp.groupBy;
      if (['last_month', 'last_quarter', 'qtd', 'ytd', 'ltm', 'last_6m', 'last_3y'].includes(lp.period)) parsed.period = lp.period;
      if (['plan', 'ly'].includes(lp.compare)) parsed.compare = lp.compare;
      parsed.plannedBy = st.label;
    }
  }
  const plan = buildPlan(parsed, persona, memory);
  // Guardian pre-check
  const verdict = guardian.check({ parsed, plan }, persona);
  if (verdict.result === 'block') {
    tl.note('Guardian', `Blocked: ${verdict.policy}`);
    await guardian.log(persona.id, 'guardian_block', { question, policy: verdict.policy, reason: verdict.reason });
    const answer = { question, intent: parsed.intent, persona: persona.id, blocked: true, headline: verdict.reason, spoken: `I cannot show that. ${verdict.reason.split('.')[0]}. The block is recorded in the audit log.`, visual: null, table: null, agents: tl.steps, followUps: plan.blockedFollowUps || ['Show aggregates by unit and level instead', 'Show me what the agents did today', 'Open the agent observatory'], guardian: { result: 'block', reason: verdict.reason, policy: verdict.policy, checks: verdict.checks }, lineage: null, seeded: config.demoMode, screen: 'canvas', kind: 'blocked', duration_ms: Date.now() - t0, cost_usd: 0, usage: llm.takeUsage() };
    await logRun(persona, question, parsed.intent, tl, answer, true);
    memory.history.push({ question, kind: 'blocked' });
    return answer;
  }
  if (verdict.result === 'redact') { plan.redact = verdict.reason; plan.aggregateOnly = true; }

  let out;
  try { out = await execute(plan, parsed, persona, memory, tl, context); }
  catch (e) { console.error('agent error', e); out = { headline: 'I could not complete that analysis: ' + e.message, spoken: 'Something went wrong in the analysis. Please try a simpler question.', visual: null, table: null, followUps: persona.questions.slice(0, 3), kind: 'error' }; }
  tl.note('Guardian', `Checked access, privacy and citations: ${verdict.result}${plan.redact ? ' (aggregates only)' : ''}`);
  // optional LLM polish of the spoken answer (numbers checked)
  let spoken = out.spoken || out.headline;
  const llmOn = await llm.enabled();
  if (llmOn && spoken && out.kind !== 'chat') { const st = await llm.status(); const allowed = (spoken.match(/\d[\d,.]*/g) || []).map(s => s.replace(/,/g, '')); const p = await llm.polishNarrative(spoken, allowed); spoken = p.text; tl.note('Briefing Agent', `Spoken answer ${p.polished ? 'polished by ' + st.label : 'from template'}; citation check: ${p.citation}`); }
  const answer = {
    question, intent: parsed.intent, persona: persona.id, blocked: false,
    headline: plan.redact ? `${out.headline} (Shown as aggregates: ${plan.redact}.)` : out.headline, spoken, visual: out.visual || null, visual2: out.visual2 || null, table: out.table || null,
    agents: tl.steps, followUps: (out.followUps || []).slice(0, 3), guardian: { result: verdict.result, checks: verdict.checks, reason: plan.redact || null }, lineage: out.lineage || (out.visual && out.visual.lineage) || null,
    seeded: out.seeded !== undefined ? out.seeded : config.demoMode, screen: out.screen || plan.screen || 'canvas', kind: out.kind || plan.kind, model: out.model || null, assumptions: out.assumptions || null, brief: out.brief || null, audio: out.audio || null, extra: out.extra || null, clarify: out.clarify || null,
    duration_ms: Date.now() - t0, usage: llm.takeUsage(), llm: llmOn ? (await llm.status()).label : null, plannedBy: parsed.plannedBy || 'dictionary parser'
  };
  answer.cost_usd = answer.usage ? Math.round(answer.usage.cost * 10000) / 10000 : 0;
  memory.last = { question, intent: parsed.intent, metrics: parsed.metrics, cut: parsed.cut, period: parsed.period, kind: answer.kind, client: parsed.cut.client || (memory.last && memory.last.client), lineage: answer.lineage, contributors: out.contributors || null, engagements: out.engagements || null, units: out.units || null, ranked: out.ranked || null, people: out.people || null, candidates: out.candidates || (memory.last && parsed.intent === 'action_centre' ? memory.last.candidates : null), roleText: out.roleText || (memory.last && parsed.intent === 'action_centre' ? memory.last.roleText : null), nextBest: out.nextBest || null, clientObj: out.client || null, narrative: answer.headline, compare: parsed.compare || (memory.last && memory.last.compare) };
  memory.history.push({ question, kind: answer.kind });
  await logRun(persona, question, parsed.intent, tl, answer, false);
  return answer;
}

function buildPlan(parsed, persona, memory) {
  const plan = { intent: parsed.intent, kind: parsed.intent, screen: 'canvas', needsIndividualPeople: false, sensitive: null };
  const t = parsed.question.toLowerCase();
  if (parsed.flags.individual_people) { plan.needsIndividualPeople = true; plan.peopleField = /hours|worked more than/.test(t) ? 'hours' : 'flight risk'; plan.blockedFollowUps = ['Where will we lose the most Principals in the next six months, and why?', 'Show sustained hours by unit', 'Show me what the agents did today']; }
  if (parsed.intent === 'match' || (/rolling off|roll.?off/.test(t) && parsed.intent !== 'predict')) { plan.needsIndividualPeople = true; plan.peopleField = 'availability'; }
  if (parsed.metrics.some(m => catalogue.byId[m].sensitive === 'partner_comp')) plan.sensitive = 'partner_comp';
  if (parsed.metrics.includes('profit_per_partner') || /profit per partner/.test(t)) plan.sensitive = 'partner_comp_aggregate';
  return plan;
}

async function execute(plan, parsed, persona, memory, tl, context) {
  const t = parsed.question.toLowerCase();
  const cut = { ...parsed.cut }; delete cut.practices;
  const last = memory.last;
  const scopeDefault = () => persona.scope.region ? { region: persona.scope.region } : persona.scope.practice ? { practice: persona.scope.practice } : {};

  switch (parsed.intent) {
    case 'action_centre': {
      const ord = /\b(second|2nd)\b/.test(t) ? 1 : /\b(third|3rd)\b/.test(t) ? 2 : /\blast\b/.test(t) ? -1 : /\ball\b/.test(t) ? 'all' : 0;
      const verb = /reject|dismiss/.test(t) ? 'reject' : 'approve';
      if (/match|candidate|assignment/.test(t)) {
        const cands = last && last.candidates; if (!cands || !cands.length) return { headline: 'Ask for candidates first, for example "Who can start on a procurement engagement in Riyadh on Monday?", then confirm a match.', spoken: 'Ask for candidates first.', kind: 'action_centre', visual: null, table: null, followUps: ['Who can start on a procurement engagement in Riyadh on Monday?'] };
        const c = ord === -1 ? cands[cands.length - 1] : cands[typeof ord === 'number' ? ord : 0];
        const row = await tl.run('Action Agent', 'Recorded the confirmed assignment in the staffing stub', () => action.confirmMatch(persona, c, last.roleText || 'the requested role'));
        return { headline: `Confirmed: ${row.title}. The assignment is recorded for the staffing system (nothing is sent in demo mode) and your approval is logged.`, spoken: `${c.id} is confirmed for the role. The assignment is recorded and logged.`, kind: 'action_centre', screen: 'actions', visual: null, table: null, followUps: ['Open the action centre', 'Show supply and demand by skill for the next eight weeks', 'Who is rolling off in the next three weeks?'] };
      }
      if (/share/.test(t)) {
        await guardian.log(persona.id, 'share_confirmed', { question: last ? last.question : null });
        tl.note('Dashboard Composer Agent', 'Applied the recipients’ row-level security and shared the board (stub)');
        const sharedQ = [...memory.history].reverse().map(x => x.question).find(q => !/share|confirm|pin this|make this weekly|slide|animate|open my board/i.test(q)) || 'the last answer';
        return { headline: `Shared "${sharedQ}" with the named team. Each recipient sees it under their own row-level security; the share is recorded in the audit trail. (In demo mode nothing leaves the product.)`, spoken: 'Shared, under each recipient’s own access rights.', kind: 'action_centre', visual: null, table: null, followUps: ['Pin this to my board', 'Make this weekly', 'Open my board'] };
      }
      const pending = (await action.list(persona)).filter(a => a.status === 'pending');
      if (!pending.length) return { headline: 'There are no drafted actions waiting for approval. Ask "What should I do about it?" after an insight and actions will be drafted for you.', spoken: 'Nothing is waiting for approval.', kind: 'action_centre', screen: 'actions', visual: null, table: null, followUps: ['What should I do about it?', 'Open the action centre', 'Show me what the agents did today'] };
      const targets = ord === 'all' ? pending : [ord === -1 ? pending[pending.length - 1] : pending[Math.min(typeof ord === 'number' ? ord : 0, pending.length - 1)]];
      const done = []; for (const a of targets) done.push(await tl.run('Action Agent', `${verb === 'approve' ? 'Approved' : 'Rejected'} "${a.title}" and ${verb === 'approve' ? 'recorded it in the ' + a.connector + ' stub' : 'logged the decision'}`, () => action.decide(a.id, verb, persona)));
      const remaining = pending.length - targets.length;
      return { headline: `${verb === 'approve' ? 'Approved' : 'Rejected'}: ${done.map(a => a.title + (a.payload && a.payload.impact ? ` (about ${money(a.payload.impact)})` : '')).join('; ')}. ${verb === 'approve' ? `Recorded for ${done[0].connector}; nothing is sent in demo mode.` : ''} ${remaining} draft${remaining === 1 ? '' : 's'} still waiting.`, spoken: `${verb === 'approve' ? 'Approved' : 'Rejected'} ${done.length === 1 ? 'the action' : done.length + ' actions'}. ${remaining ? remaining + ' still waiting for you.' : 'Nothing else is waiting.'}`, kind: 'action_centre', screen: 'actions', visual: null, table: null, followUps: remaining ? ['Approve the next action', 'Reject the next action', 'Open the action centre'] : ['Open the action centre', 'Show me what the agents did today', 'What has changed since Friday?'] };
    }
    case 'chat': {
      const st = await llm.status();
      const text = await tl.run('Briefing Agent', `Answered conversationally with ${st.label}, grounded in the last answer`, () => llm.converse(parsed.question, { persona, lastAnswer: last ? last.narrative : null, history: memory.history.slice(-4).map(x => x.question) }));
      if (!text) break;
      return { headline: text, spoken: text, kind: 'chat', visual: null, table: null, seeded: false, followUps: persona.questions.slice(0, 3), lineage: { metric: 'conversation', name: 'Conversational answer', formula: 'Language model (prompts only) grounded in the last answer; no new figures', source_system: st.label, stub: 'none', tables: [], seeded: false } };
    }
    case 'observatory': {
      if (/what can the action agent|policy|may (read|change)|allowed/.test(t)) { const r = await tl.run('Guardian', 'Listed agent policy and autonomy levels', () => observatory.policy()); return { ...r, headline: r.narrative, screen: 'observatory', kind: 'policy', seeded: false }; }
      const r = await tl.run('Guardian', 'Compiled agent runs, response times, cost and blocks', () => observatory.summary()); return { ...r, headline: r.narrative, screen: 'observatory', kind: 'observatory', seeded: false };
    }
    case 'it_service': {
      if (/fewer than|adoption|licensed|open/.test(t) && !/ticket|service desk/.test(t)) { const m = t.match(/(\d+)\s?%/); const r = await tl.run('Query Agent', 'Read application adoption from the ServiceNow CMDB stub', () => observatory.adoption({ threshold: m ? parseInt(m[1], 10) / 100 : 0.2 })); return { ...r, headline: r.narrative, screen: 'observatory', kind: 'adoption' }; }
      const r = await tl.run('Query Agent', 'Read ticket volumes by application (real RFP pack path)', () => observatory.tickets()); return { ...r, headline: r.narrative, screen: 'observatory', kind: 'tickets', seeded: r.visual.seeded };
    }
    case 'lineage': {
      const l = last && last.lineage; tl.note('Metric Agent', 'Returned the governed definition and lineage');
      return { headline: l ? `${l.name}: ${l.formula}. Source: ${l.source_system}${l.stub ? ' (demo: ' + l.stub + ')' : ''}. Tables: ${(l.tables || []).join(', ')}. ${l.model ? 'Model: ' + l.model + '. ' : ''}Refreshed ${l.refreshed_at || 'today'}.` : 'Ask about a number first, then I can show how it was calculated.', spoken: l ? `${l.name} is ${l.formula.toLowerCase()}, from ${l.source_system}.` : 'Ask about a number first.', lineage: l, kind: 'lineage', visual: null, table: null, followUps: ['Open the agent observatory', 'Show me what the agents did today', 'Pin this to my board'] };
    }
    case 'board': {
      if (last && /pin|board|weekly/.test(t)) { await db.query('INSERT INTO boards (persona, title, question, visual, schedule) VALUES ($1,$2,$3,$4,$5)', [persona.id, last.question, last.question, JSON.stringify({ kind: last.kind, cut: last.cut, metrics: last.metrics }), /weekly/.test(t) ? 'weekly' : null]); tl.note('Dashboard Composer Agent', 'Pinned the last answer to the personal board'); return { headline: `Pinned "${last.question}" to your board${/weekly/.test(t) ? ' with a weekly refresh' : ''}. A pinned tile keeps its question and refreshes with the data.`, spoken: 'Pinned to your board.', kind: 'board', screen: 'board', visual: null, table: null, followUps: ['Open my board', 'Share this with the DACH leadership team', 'Turn this into a slide'] }; }
      if (/animate|animation|video/.test(t)) { tl.note('Briefing Agent', 'Assembled a Claude Motion prompt from the last answer'); return { headline: `Animation prompt for "${last ? last.question : 'the last answer'}": the question, the chart values and the finding, in the product’s visual style. It is copied to your clipboard; paste it into Claude after /motion to build the animation and export it as MP4.`, spoken: 'The animation prompt is on your clipboard.', kind: 'animate', visual: null, table: null, followUps: ['Turn this into a slide', 'Pin this to my board', 'Open the firm pulse'] }; }
      if (/share/.test(t)) { tl.note('Dashboard Composer Agent', 'Prepared a share; waiting for confirmation'); return { headline: 'Ready to share the last answer with the named team. Sharing needs your confirmation: say "confirm share" and each recipient\'s own access rights will be applied before it is sent.', spoken: 'Ready to share. Please confirm.', kind: 'share', visual: null, table: null, followUps: ['Confirm share', 'Pin this to my board', 'Turn this into a slide'] }; }
      tl.note('Briefing Agent', 'Exported the last answer as a PowerPoint slide (question, finding, visual, table and a source footnote)'); return { headline: `Slide for "${last ? last.question : 'the last answer'}": the question as title, the finding, the visual, the supporting table and a source footnote. The download starts now; the Slide button on any card does the same.`, spoken: 'Your slide is downloading.', kind: 'slide', visual: null, table: null, followUps: ['Pin this to my board', 'Share this with the DACH leadership team', 'Open the firm pulse'] };
    }
    case 'brief': {
      if (/what has changed|what changed|since (friday|monday|yesterday|last week)/.test(t)) {
        const alerts = await tl.run('Trend and Anomaly Agent', 'Scanned the headline metrics for new movements outside their expected range', () => trend.feed(persona, { limit: 5 }));
        const acts = await action.list(persona); const pend = acts.filter(a => a.status === 'pending'); const decided = acts.filter(a => a.decided_at && (Date.now() - new Date(a.decided_at)) < 7 * 86400000);
        const eh = await tl.run('Engagement Health Agent', 'Re-scored live engagements', () => engagement.board({ cut: persona.scope.region ? { region: persona.scope.region } : persona.scope.engagements ? { engagement: persona.scope.engagements } : {}, limit: 3 }));
        const items = [...alerts.map(a => a.text), `${countWord(eh.atRisk, 'live engagement')} ${eh.atRisk === 1 ? 'carries' : 'carry'} an overrun probability above 50%${eh.engagements[0] ? ', led by ' + eh.engagements[0].id : ''}.`, `${countWord(pend.length, 'drafted action')} ${pend.length === 1 ? 'is' : 'are'} waiting for approval${decided.length ? ' and ' + decided.length + ' decided this week' : ''}.`];
        return { headline: `Since Friday: ${items.join(' ')}`, spoken: `Since Friday. ${items.slice(0, 2).join(' ')}`, kind: 'brief', visual: null, table: null, followUps: [alerts[0] ? `Why did ${alerts[0].name.toLowerCase()} move?` : 'Are we on track for the year?', 'Open the action centre', 'Read the brief again, shorter'] };
      }
      const r = await tl.run('Briefing Agent', 'Composed the morning brief from the integration points', () => briefing.morningBrief(persona, { shorter: parsed.flags.shorter }));
      if (/tell me more about the first/.test(t)) { parsed.intent = 'explain'; parsed.metrics = ['plan_attainment']; parsed.compare = 'plan'; parsed.cut = scopeDefault(); plan.kind = 'explain'; return execute(plan, parsed, persona, memory, tl, context); }
      return { headline: r.text, spoken: r.text, kind: 'brief', brief: r, visual: null, table: null, followUps: ['Tell me more about the first point', parsed.flags.shorter ? 'Read the full brief' : 'Read the brief again, shorter', 'What has changed since Friday?'] };
    }
    case 'client360': {
      const clientId = cut.client || (persona.scope.accounts && persona.scope.accounts[0]) || (last && last.client);
      if (!clientId) return { headline: 'Which client do you mean? I know the six publicly reported clients by name and every other client by identifier.', spoken: 'Which client do you mean?', clarify: 'client', visual: null, table: null, followUps: ['Prepare me for my meeting with LIC tomorrow', 'Show client concentration', 'Show account growth by client'] };
      if (/white space|whitespace|next practice|cross-sell|what else could we sell/.test(t)) { const r = await tl.run('Client 360 Agent', 'Ran the next-best practice model on same-industry purchase history', () => client360.whiteSpace(clientId)); return { ...r, headline: r.narrative, screen: 'account', kind: 'client360', client: r.client }; }
      if (/who (in the firm )?(has worked|knows|worked with)|relationship map|who knows/.test(t)) { const r = await tl.run('Client 360 Agent', 'Built the relationship map from Salesforce contacts and engagement history', () => client360.whoKnows(clientId)); return { ...r, headline: r.narrative, screen: 'account', kind: 'client360', needsIndividualPeople: false }; }
      if (/audio|for the car|prepare|brief|meeting/.test(t)) { const r = await tl.run('Client 360 Agent', 'Built the account 360 and the meeting brief', () => client360.meetingBrief(clientId, persona)); tl.note('Pipeline and Win Agent', 'Scored the open opportunities and suggested the next practice'); tl.note('Briefing Agent', `Wrote the one-page brief and a ${/audio|car/.test(t) ? '60-second audio brief, attached to the meeting' : 'spoken summary'}`); return { ...r, headline: r.brief.join(' '), spoken: r.audio, screen: 'account', kind: 'client360', client: r.account.client, nextBest: r.account.nextBest, audio: /audio|car/.test(t) ? r.audio : null, extra: { attachedTo: r.event ? r.event.title : null } }; }
      const r = await tl.run('Client 360 Agent', 'Built the account 360', () => client360.account(clientId)); return { ...r, headline: r.narrative, screen: 'account', kind: 'client360', client: r.client };
    }
    case 'match': {
      if (/rolling off|roll.?off/.test(t)) { const weeks = parsed.horizon && parsed.horizon.weeks ? parsed.horizon.weeks : 3; const r = await tl.run('Staffing Match Agent', 'Listed people rolling off against the roll-off calendar', () => staffing.rollingOff({ cut: { ...cut, level: undefined }, weeks, skills: parsed.skills, level: cut.level || null })); return { ...r, headline: r.narrative, screen: 'staffing', kind: 'match' }; }
      const office = ref.get().offices.find(o => cut.office === o.id);
      const r = await tl.run('Staffing Match Agent', 'Matched available people to the role by skill, level, location, language and availability', () => staffing.candidates({ skills: parsed.skills.length ? parsed.skills : (cut.practice ? [ref.labelOf('practice', cut.practice)] : []), level: cut.level || null, location: office ? office.city : null, unit: cut.unit || null, language: /arabic/.test(t) ? 'Arabic' : null, practice: cut.practice || null }));
      const roleText = `${parsed.skills.length ? parsed.skills.join(' and ') + ' ' : ''}${cut.level ? ref.labelOf('level', cut.level) + ' ' : ''}role${office ? ' in ' + office.city : cut.unit ? ' in ' + ref.labelOf('unit', cut.unit) : ''}${r.start ? ' from ' + require('./util').dateLabel(r.start) : ''}`;
      return { ...r, headline: r.narrative, screen: 'staffing', kind: 'match', roleText };
    }
    case 'knowledge': { const r = await tl.run('Query Agent', 'Searched registered assets, Glean topics and expert skills', () => observatory.knowledgeSearch(parsed.question)); return { ...r, headline: r.narrative, kind: 'knowledge' }; }
    case 'act': {
      const r = await tl.run('Action Agent', 'Drafted actions from the last insight, each with an owner and a due date', () => action.draftFromContext(persona, memory));
      return { ...r, headline: r.narrative, screen: 'actions', kind: 'act' };
    }
    case 'simulate': {
      const sc = parsed.scenario || {};
      if ((sc.add_staff || sc.remove_staff)) { const eid = Array.isArray(cut.engagement) ? cut.engagement[0] : cut.engagement || (persona.scope.engagements && persona.scope.engagements[0]) || (last && last.engagements && last.engagements[0] && last.engagements[0].id); const r = await tl.run('Scenario Agent', 'Ran the staffing what-if on the engagement economics', () => scenario.engagementStaffing({ engagementId: eid, add: sc.add_staff, remove: sc.remove_staff })); if (!r) break; return { ...r, headline: r.narrative, screen: 'engagements', kind: 'simulate' }; }
      if (/compare .* with/.test(t) && sc.rate_pct && sc.realisation_points) { const r = await tl.run('Scenario Agent', 'Compared two scenarios on the driver model', () => scenario.compare({ cut: scopeCutFor(cut, persona), scenarios: [{ label: `Rates +${sc.rate_pct}%`, scenario: { rate_pct: sc.rate_pct } }, { label: `Realisation +${sc.realisation_points} pts`, scenario: { realisation_points: sc.realisation_points } }] })); return { ...r, headline: r.narrative, screen: 'forecast', kind: 'simulate' }; }
      if (!Object.keys(sc).length) return { headline: 'Which driver should I change? I can simulate billing rates, utilisation, realisation, a hiring freeze, fee mix and FX.', spoken: 'Which driver should I change?', clarify: 'scenario', visual: null, table: null, followUps: ['What would a 3% rate increase in North America do to profit per partner?', 'What happens to profit per partner if utilisation drops 3 points?', 'Freeze Associate hiring in Europe for two quarters'] };
      const r = await tl.run('Scenario Agent', 'Ran the what-if on the profit-per-partner driver model', () => scenario.run({ cut: scopeCutFor(cut, persona), scenario: sc }));
      tl.note('Forecast Agent', 'Supplied the twelve-month baseline');
      return { ...r, headline: r.narrative, screen: 'forecast', kind: 'simulate' };
    }
    case 'explain': {
      let metric = parsed.metrics[0] || (last && last.metrics && last.metrics[0]) || 'net_fee_revenue';
      const scopeCut = Object.keys(cut).length ? cut : (context && context.cut ? context.cut : scopeDefault());
      const compare = parsed.compare || (last && last.compare === 'plan' && !parsed.metrics.length ? 'plan' : null) || (/behind plan|plan/.test(t) ? 'plan' : null) || (metric === 'plan_attainment' ? 'plan' : null);
      if (metric === 'plan_attainment' || metric === 'revenue_growth') metric = 'net_fee_revenue';
      if (/why\?*$|why this dip|why did .* (fall|drop|decline)/.test(t) && !parsed.metrics.length && context && context.metric) metric = context.metric;
      const period = parsed.period || (compare === 'plan' ? 'qtd' : 'last_quarter');
      await tl.run('Metric Agent', `Resolved "${catalogue.byId[metric].name}" to its governed definition`, async () => null);
      tl.note('Query Agent', 'Read both periods under row-level security');
      const by = parsed.groupBy && !['month', 'quarter', 'year'].includes(parsed.groupBy) ? parsed.groupBy : null;
      const r = await tl.run('Variance Agent', 'Split the change into drivers and ranked the contributors' + (by ? ' by ' + by : ''), () => variance.explain({ metricId: metric, cut: scopeCut, period, compare: compare || 'prior', by }));
      tl.note('Dashboard Composer Agent', 'Built the waterfall bridge and contributor table');
      return { ...r, headline: r.narrative, screen: metric === 'billing_realisation' ? 'region' : 'canvas', kind: metric === 'billing_realisation' ? 'variance_realisation' : (compare === 'plan' ? 'plan_gap' : 'variance'), extra: { metric } };
    }
    case 'predict': {
      if (/will it get worse|get worse|will (they|these|those) overrun/.test(t) && last && (last.contributors || last.engagements)) { const ids = (last.contributors || last.engagements).map(c => c.engagement || c.id).filter(Boolean); const r = await tl.run('Engagement Health Agent', 'Forecast overrun and realisation at completion for the named engagements', () => engagement.willItGetWorse({ engagements: ids })); return { ...r, headline: r.narrative, screen: 'engagements', kind: 'engagement_health' }; }
      if (/\bhires?\b|hiring need|hiring forecast|recruit/.test(t)) { const r = await tl.run('Talent Risk Agent', 'Ran the hiring need forecast linked to skill demand', () => talent.hiringNeed({ cut: scopeCutFor(cut, persona), year: 2027 })); return { ...r, headline: r.narrative, screen: 'talent', kind: 'talent' }; }
      if (/flight|attrition|lose the most|leave|retention risk|regretted|highest.?risk/.test(t) || parsed.metrics.includes('regretted_attrition')) {
        if (parsed.flags.individual_people) { const r = await tl.run('Talent Risk Agent', 'Listed individual flight-risk scores with drivers (authorised view, logged)', () => talent.individuals({ cut: scopeCutFor(cut, persona), level: cut.level || 'PRINCIPAL' })); await guardian.log(persona.id, 'people_individual_view', { question: parsed.question, level: cut.level || 'PRINCIPAL' }); return { ...r, headline: r.narrative, screen: 'talent', kind: 'talent' }; }
        const r = await tl.run('Talent Risk Agent', 'Scored flight risk by unit and level and aggregated the drivers', () => talent.heatmap({ cut: scopeCutFor(cut, persona), level: cut.level || null, individuals: persona.policy.individual_people === true })); tl.note('Forecast Agent', 'Converted scores to expected exits over six months'); return { ...r, headline: r.narrative, screen: 'talent', kind: 'talent' };
      }
      if (/burnout|60 hours|sustained/.test(t) && parsed.flags.individual_people) { const r = await tl.run('Talent Risk Agent', 'Listed sustained-hours alerts', () => talent.burnout({ cut: scopeCutFor(cut, persona) })); return { ...r, headline: r.narrative, screen: 'talent', kind: 'talent' }; }
      if (/overrun|over budget|budget|my engagements|engagements will/.test(t) || parsed.metrics.includes('budget_burn')) { const r = await tl.run('Engagement Health Agent', 'Scored overrun probability, predicted overrun dates and margin at completion', () => engagement.board({ cut: Object.keys(cut).length ? cut : (persona.scope.engagements ? { engagement: persona.scope.engagements } : scopeDefault()) })); return { ...r, headline: r.narrative, screen: 'engagements', kind: 'engagement_health' }; }
      if (/invoice|pay late|past 90|late payment|collect/.test(t)) { const r = await tl.run('Forecast Agent', 'Scored each open invoice for passing 90 days', () => cash.lateInvoices({ cut: scopeCutFor(cut, persona) })); return { ...r, headline: r.narrative, screen: 'cash', kind: 'cash' }; }
      if (/miss plan|which units|units will|by how much/.test(t)) { const r = await tl.run('Forecast Agent', 'Forecast quarter-end revenue per unit and the probability of reaching plan', () => forecast.unitsAtRisk({ cut: scopeCutFor(cut, persona) })); return { ...r, headline: r.narrative, screen: 'forecast', kind: 'forecast' }; }
      if (/close this quarter|likely to close|most likely to close|which of my opportunities/.test(t)) { const r = await tl.run('Pipeline and Win Agent', 'Ranked open opportunities by win probability with reasons', () => pipeline.likelyToClose({ cut: scopeCutFor(cut, persona) })); return { ...r, headline: r.narrative, screen: 'pipeline', kind: 'pipeline' }; }
      if (/utili[sz]ation/.test(t) || parsed.metrics[0] === 'utilisation') { const r = await tl.run('Forecast Agent', 'Forecast utilisation from assignments, roll-offs and seasonality', () => forecast.utilisation({ cut: scopeCutFor(cut, persona) })); return { ...r, headline: r.narrative, screen: 'region', kind: 'forecast' }; }
      if (/stalled|not moved/.test(t)) { const r = await tl.run('Pipeline and Win Agent', 'Listed stalled deals', () => pipeline.stalledDeals({ cut: scopeCutFor(cut, persona), days: 30 })); return { ...r, headline: r.narrative, screen: 'pipeline', kind: 'pipeline' }; }
      if (/what should i worry|worry about|top risks|risks/.test(t)) { const r = await risks(persona, tl); return r; }
      const r = await tl.run('Forecast Agent', 'Forecast revenue with P10–P90 from booked work, weighted pipeline and the seasonal trend', () => forecast.revenue({ cut: scopeCutFor(cut, persona), horizon: parsed.horizon || { toYearEnd: true } }));
      tl.note('Dashboard Composer Agent', 'Drew the forecast band against plan');
      if (/worry/.test(t)) { const rk = await risks(persona, tl); r.narrative += ' ' + rk.headline; r.followUps = rk.followUps; }
      return { ...r, headline: r.narrative, screen: 'firm', kind: 'forecast', units: null };
    }
    case 'compare': case 'lookup': default: return lookup(plan, parsed, persona, memory, tl, context);
  }
  return lookup(plan, parsed, persona, memory, tl, context);
}
function scopeCutFor(cut, persona, metricId) { const c = { ...cut }; const peopleMetric = metricId && catalogue.byId[metricId] && catalogue.byId[metricId].family === 'C'; if (!Object.keys(c).length) { if (persona.scope.region) c.region = persona.scope.region; if (persona.scope.practice && !peopleMetric) c.practice = persona.scope.practice; if (persona.scope.accounts && !peopleMetric) c.client = persona.scope.accounts[0]; } if (peopleMetric) delete c.client; return c; }

async function risks(persona, tl) {
  const alerts = await tl.run('Trend and Anomaly Agent', 'Scanned the headline metrics for movements outside their expected range', () => trend.feed(persona, { limit: 4 }));
  const eh = await tl.run('Engagement Health Agent', 'Counted engagements likely to overrun', () => engagement.board({ cut: persona.scope.region ? { region: persona.scope.region } : {}, limit: 3 }));
  const th = await tl.run('Talent Risk Agent', 'Found the largest flight-risk cluster', () => talent.heatmap({ level: 'PRINCIPAL' }));
  const items = [...alerts.map(a => a.text), `${eh.atRisk} live engagements have an overrun probability above 50%${eh.engagements[0] ? ', led by ' + eh.engagements[0].id : ''}.`, th.ranked[0] ? `Principal flight risk is concentrated in ${th.ranked[0].label} (about ${th.ranked[0].expected.toFixed(0)} expected exits in six months).` : ''].filter(Boolean);
  return { headline: `Three things to worry about: ${items.slice(0, 3).join(' ')}`, spoken: `Three things to worry about. ${items.slice(0, 3).map(s => s.split('(')[0]).join(' ')}`, kind: 'risks', visual: null, table: null, followUps: ['Why is Europe behind plan?', 'Which of my engagements will overrun budget, and by when?', 'Where will we lose the most Principals in the next six months, and why?'] };
}

async function lookup(plan, parsed, persona, memory, tl, context) {
  const t = parsed.question.toLowerCase();
  const cut = { ...parsed.cut }; delete cut.practices;
  // special comparisons
  if (/buy (from )?only one|only one practice|single practice/.test(t)) return singlePractice(cut, tl);
  if (/pipeline coverage|coverage/.test(t) && !parsed.metrics.includes('weighted_pipeline') || /pipeline coverage/.test(t)) { const r = await tl.run('Pipeline and Win Agent', 'Computed weighted pipeline against the uncovered plan for the next two quarters', () => pipeline.room({ cut: scopeCutFor(cut, persona) })); return { ...r, headline: r.narrative, screen: 'pipeline', kind: 'pipeline' }; }
  if (/not moved|stalled|large deals/.test(t)) { const r = await tl.run('Pipeline and Win Agent', 'Listed stalled deals', () => pipeline.stalledDeals({ cut: scopeCutFor(cut, persona), days: 30 })); return { ...r, headline: r.narrative, screen: 'pipeline', kind: 'pipeline' }; }
  if (/pyramid/.test(t)) { const r = await tl.run('Talent Risk Agent', 'Compared the pyramid with its target shape and last year', () => talent.pyramid({ cut: scopeCutFor(cut, persona) })); return { ...r, headline: r.narrative, screen: 'talent', kind: 'talent' }; }
  if (/open roles|supply and demand|marketplace|skills? (supply|gap)|enough .* skills|agentic ai skills/.test(t)) { const r = await tl.run('Staffing Match Agent', 'Compared skill supply (roll-offs) with demand (open roles) for the next eight weeks', () => staffing.marketplace({ cut: cut.unit || cut.level ? cut : {} })); if (/agentic ai|enough/.test(t)) { const gapRow = r.skills.find(s => /agentic/i.test(s.skill)); r.narrative = `${gapRow ? `Agentic AI: ${gapRow.demand} open roles against ${gapRow.supply} people rolling off with the skill in the next eight weeks (${gapRow.gap >= 0 ? 'covered' : -gapRow.gap + ' short'}). ` : 'No open roles name agentic AI yet. '}${r.narrative}`; } return { ...r, headline: r.narrative, screen: 'staffing', kind: 'staffing' }; }
  if (/wip .*timesheet|held up by|missing timesheets/.test(t)) { const r = await tl.run('Engagement Health Agent', 'Matched aged WIP to late timesheets', () => cash.wipHeldByTimesheets({ cut: scopeCutFor(cut, persona) })); return { ...r, headline: r.narrative, screen: 'cash', kind: 'cash' }; }
  if (/how much work did .* deliver for|cross-border|cross border/.test(t)) return crossBorder(cut, parsed, tl);
  if (/what have we done for/.test(t) && (cut.client || persona.scope.accounts)) { parsed.intent = 'client360'; return execute(plan, parsed, persona, memory, tl, context); }
  if (/action centre|action center|pending actions|my actions|read me the queue/.test(t)) { await action.refreshQueue().catch(() => {}); const rows = await action.list(persona); const sm = action.summary(rows); const queue = sm.pending.slice(0, 4).map((a, i) => `${i + 1}. ${a.title}${a.payload && a.payload.impact ? ' (about ' + money(a.payload.impact) + ')' : ''}`).join('; '); return { headline: `${sm.text}${queue ? ' ' + queue + '.' : ''}`, spoken: `${sm.text}${queue ? ' ' + queue + '. Say approve or reject with the number.' : ''}`, screen: 'actions', kind: 'actions', visual: null, table: null, followUps: ['Approve the first action', 'What should I do about it?', 'Show me what the agents did today'] }; }
  if (/^(open|go to|take me to|show me) (the )?(firm pulse|region|cockpit|talent|staffing|pipeline|forecast|cash|action centre|observatory|account|engagement|practice|board|home)/.test(t)) { const m = t.match(/(firm pulse|region|cockpit|talent|staffing|pipeline|forecast|cash|action centre|observatory|account|engagement|practice|board|home)/)[1]; const screen = { 'firm pulse': 'firm', region: 'region', cockpit: 'region', talent: 'talent', staffing: 'staffing', pipeline: 'pipeline', forecast: 'forecast', cash: 'cash', 'action centre': 'actions', observatory: 'observatory', account: 'account', engagement: 'engagements', practice: 'practice', board: 'board', home: 'home' }[m]; tl.note('Conductor', `Opened the ${m} screen`); return { headline: `Opening the ${m} screen.`, spoken: `Opening ${m}.`, screen, kind: 'navigate', visual: null, table: null, followUps: persona.questions.slice(0, 3) }; }

  // metric lookup
  let metrics = parsed.metrics.length ? parsed.metrics : (memory.last && parsed.followUp && memory.last.metrics ? memory.last.metrics : ['net_fee_revenue']);
  // metric ambiguity: "realisation" alone
  if (/\brealisation\b|\brealization\b/.test(t) && !/billing|collection/.test(t) && !parsed.followUp && !(memory.last && memory.last.metrics && memory.last.metrics.includes('billing_realisation'))) { tl.note('Metric Agent', 'Asked a clarifying question: two realisation metrics match'); return { headline: 'Do you mean billing realisation (fees billed ÷ standard value) or collection realisation (cash collected ÷ fees billed)?', spoken: 'Do you mean billing realisation or collection realisation?', clarify: 'metric', kind: 'clarify', visual: null, table: null, followUps: [parsed.question.replace(/realisation|realization/i, 'billing realisation'), parsed.question.replace(/realisation|realization/i, 'collection realisation')] }; }
  if (metrics.includes('revenue_growth') && /fastest|which practices grew|grew fastest/.test(t)) { parsed.groupBy = parsed.groupBy || 'practice'; }
  const metricId = metrics[0];
  const m = catalogue.byId[metricId];
  let groupBy = parsed.groupBy;
  if (!groupBy && parsed.intent === 'compare') groupBy = cut.unit ? 'practice' : cut.region ? 'unit' : 'region';
  if (!groupBy && (/by unit|units/.test(t))) groupBy = 'unit';
  if (groupBy === 'level' && !cut.level) {} else if (cut.level && groupBy === 'level') groupBy = 'unit';
  if (groupBy === 'application') { parsed.intent = 'it_service'; return execute(plan, parsed, persona, memory, tl, context); }
  if (groupBy === 'client' && !['account_growth', 'net_fee_revenue', 'client_satisfaction', 'relationship_breadth', 'cross_practice_penetration', 'revenue_growth'].includes(metricId)) groupBy = null;
  if (['client_concentration', 'fee_model_mix', 'wip_ageing', 'knowledge_search_success', 'research_reach'].includes(metricId)) groupBy = null;
  if (groupBy && ['partner'].includes(groupBy) && m.sensitive) plan.sensitive = m.sensitive;
  const period = parsed.period || (['pipeline_value', 'weighted_pipeline', 'lockup_days', 'dso', 'leverage', 'staffing_fill_rate', 'relationship_breadth', 'client_satisfaction', 'engagement_score'].includes(metricId) ? 'now' : ['month', 'quarter', 'year'].includes(groupBy) ? (groupBy === 'year' ? 'last_3y' : 'ltm') : 'ltm');
  const scopeCut = scopeCutFor(Object.keys(cut).length ? cut : (parsed.followUp && memory.last ? memory.last.cut : {}), persona, metricId);
  if (plan.aggregateOnly && groupBy && ['unit', 'office', 'engagement', 'client'].includes(groupBy)) groupBy = 'region';
  await tl.run('Metric Agent', `Resolved "${m.name}" (${m.formula})`, async () => null);
  const result = await tl.run('Query Agent', `Read ${m.source} data under row-level security${groupBy ? ', grouped by ' + groupBy : ''}`, () => engine.compute(metricId, { cut: scopeCut, period, groupBy }));
  // comparison: plan or last year
  let opts = {}; let compareValue = null, compareLabel = null;
  if (parsed.compare === 'plan' || /against plan|vs plan/.test(t)) {
    const pa = await tl.run('Query Agent', 'Read the Anaplan plan for the same cut and period', () => engine.compute('plan_attainment', { cut: scopeCut, period: result.period, groupBy: groupBy && !['practice', 'client', 'level', 'office', 'engagement'].includes(groupBy) ? groupBy : null }));
    if (['month', 'quarter', 'year'].includes(groupBy) && metricId === 'net_fee_revenue') opts.plan = result.rows.map(r => { const p = pa.rows.find(x => x.key === r.key); return p ? p.plan : null; });
    else if (groupBy && metricId === 'net_fee_revenue') { opts.compareMap = Object.fromEntries(pa.rows.map(r => [r.key, r.plan])); opts.compareName = 'Plan'; }
    if (metricId === 'utilisation') opts.target = 0.68;
    const tot = pa.rows.reduce((a, r) => ({ a: a.a + (r.actual || 0), p: a.p + (r.plan || 0) }), { a: 0, p: 0 }); if (metricId === 'net_fee_revenue' && tot.p) { compareValue = tot.p; compareLabel = 'plan'; }
  } else if (parsed.compare === 'ly' || /last year|year on year/.test(t)) {
    const ly = await tl.run('Query Agent', 'Read the prior-year period', () => engine.compute(metricId, { cut: scopeCut, period: engine.priorYear(result.period), groupBy }));
    if (groupBy && !['month', 'quarter', 'year'].includes(groupBy)) { opts.compareMap = Object.fromEntries(ly.rows.map(r => [r.key, r.value])); opts.compareName = 'Prior year'; } compareValue = ly.total.value; compareLabel = 'last year';
  }
  if (metricId === 'utilisation' && !opts.target) opts.target = 0.68;
  // client concentration is always shown against the earliest seeded year (2024), the nearest available to "three years ago"
  if (metricId === 'client_concentration') {
    const then = await tl.run('Query Agent', 'Read client concentration for 2024, the earliest year in the data', () => engine.compute('client_concentration', { cut: scopeCut, period: { from: '2024-01-01', to: '2024-12-01', label: '2024' } }));
    const now = await engine.compute('client_concentration', { cut: scopeCut, period: 'ltm' }); const nowMap = Object.fromEntries(now.rows.map(r => [r.key, r.value])), thenMap = Object.fromEntries(then.rows.map(r => [r.key, r.value]));
    const text = `The top 20 clients bring ${pct(nowMap['Top 20'])} of revenue in the ${now.period.label} against ${pct(thenMap['Top 20'])} in 2024 (the earliest year in the data); the top 10 bring ${pct(nowMap['Top 10'])} (${pct(thenMap['Top 10'])}) and the top 50 ${pct(nowMap['Top 50'])} (${pct(thenMap['Top 50'])}). Concentration has ${nowMap['Top 20'] > thenMap['Top 20'] + 0.005 ? 'risen' : nowMap['Top 20'] < thenMap['Top 20'] - 0.005 ? 'fallen' : 'been stable'}.`;
    tl.note('Dashboard Composer Agent', 'Drew the concentration comparison');
    return { headline: text, spoken: text, kind: 'lookup', metrics, lineage: now.lineage, visual: { type: 'bar', title: 'Client concentration', subtitle: `${now.period.label} against 2024`, x: ['Top 10', 'Top 20', 'Top 50'], series: [{ name: now.period.label, data: ['Top 10', 'Top 20', 'Top 50'].map(k => nowMap[k]) }, { name: '2024', data: ['Top 10', 'Top 20', 'Top 50'].map(k => thenMap[k]), kind: 'compare' }], format: 'pct', seeded: true, lineage: now.lineage }, table: now.extra && now.extra.top_clients ? composer.table('Top 20 clients', now.period.label, [['client', 'Client'], ['revenue', 'Revenue', 'money'], ['share', 'Share', 'pct']], now.extra.top_clients.map(c => ({ ...c, client: ref.labelOf('client', c.client) })), now.lineage) : null, followUps: ['Show account growth by client', 'Which of our top Financial Services clients buy from only one practice?', 'Run a concentration risk scenario'] };
  }
  // threshold filters: "below 70%", "above 90%"
  const thr = t.match(/\b(below|under|less than|above|over|more than) (\d+(?:\.\d+)?)\s?%/);
  let narrOverride = null;
  if (thr && groupBy && !['month', 'quarter', 'year'].includes(groupBy)) {
    const lim = parseFloat(thr[2]) / 100; const below = /below|under|less/.test(thr[1]);
    const kept = result.rows.filter(r => r.value !== null && (below ? r.value < lim : r.value > lim)).sort((a, b) => below ? a.value - b.value : b.value - a.value);
    result.rows = kept; result.total = { value: kept.length ? kept.reduce((a, r) => a + r.value, 0) / kept.length : null };
    narrOverride = `${kept.length} ${groupBy}${kept.length === 1 ? '' : 's'} ${kept.length === 1 ? 'is' : 'are'} ${below ? 'below' : 'above'} ${pct(lim, 0)} ${m.name.toLowerCase()}${composer.scopeLabel(scopeCut)} for ${result.period.label}${kept.length ? ': ' + kept.map(r => `${r.label} (${fmt(r.value, m.format)})`).join(', ') : ''}.`;
    tl.note('Query Agent', `Filtered to members ${below ? 'below' : 'above'} ${pct(lim, 0)}`);
  }
  const narr = narrOverride ? { text: narrOverride, spoken: narrOverride + (result.rows[0] ? ` Ask me why ${result.rows[0].label} stands out.` : '') } : briefing.metricNarrative(result, { compareValue, compareLabel });
  // a single headline value is shown with its twelve-month trend when the metric has one
  const SNAPSHOT = ['pipeline_value', 'weighted_pipeline', 'lockup_days', 'dso', 'leverage', 'staffing_fill_rate', 'time_to_staff', 'relationship_breadth', 'client_satisfaction', 'engagement_score', 'promotion_velocity', 'sustained_hours', 'learning_hours', 'recruiting_conversion', 'cross_practice_penetration', 'budget_burn', 'eac', 'fx_impact', 'ip_reuse_rate', 'win_rate', 'client_concentration', 'fee_model_mix', 'wip_ageing', 'knowledge_search_success', 'research_reach', 'counselling_load', 'expert_network_use', 'scope_change_rate', 'new_clients', 'book_to_bill', 'proposal_cycle_time', 'regretted_attrition'].includes(metricId);
  let trend = null;
  if (!groupBy && !SNAPSHOT && result.rows.length === 1) { try { trend = await tl.run('Query Agent', 'Read the twelve-month history for the trend', () => engine.compute(metricId, { cut: scopeCut, period: 'ltm', groupBy: 'month' })); if (!trend.rows.length || trend.rows.length < 3) trend = null; } catch (e) { trend = null; } }
  const visual = await tl.run('Dashboard Composer Agent', `Chose a ${groupBy || trend ? (['month', 'quarter', 'year'].includes(groupBy) || trend ? 'trend line' : 'ranked bar chart') : 'headline tile'} from the visual grammar`, async () => {
    if (trend) { const v = composer.fromMetric(trend, { ...opts, target: opts.target, title: `${m.name}${composer.scopeLabel(scopeCut)}`, subtitle: `${result.period.label}: ${fmt(result.total.value, m.format)} · monthly trend` }); return v; }
    return composer.fromMetric(result, { ...opts, map: groupBy === 'region' && /map/.test(t), delta: compareValue !== null && compareValue !== undefined && result.total.value !== null ? (m.format === 'pct' ? result.total.value - compareValue : result.total.value - compareValue) : null, deltaLabel: compareLabel ? 'vs ' + compareLabel : null });
  });
  tl.note('Briefing Agent', 'Wrote the headline and the spoken answer');
  const extra = result.extra || null;
  const followUps = [`Why did ${m.name.toLowerCase()} change?`, `Forecast ${m.name.toLowerCase()} to year end`, groupBy ? `Show ${m.name.toLowerCase()} by month` : `Show ${m.name.toLowerCase()} by ${scopeCut.region ? 'unit' : 'region'}`];
  if (metricId === 'client_concentration') { followUps[0] = 'How exposed are we to our top 20 clients compared with three years ago?'; }
  return { headline: narr.text, spoken: narr.spoken, visual, table: result.extra && result.extra.top_clients ? composer.table('Top 20 clients', result.period.label, [['client', 'Client'], ['revenue', 'Revenue', 'money'], ['share', 'Share', 'pct']], result.extra.top_clients.map(c => ({ ...c, client: ref.labelOf('client', c.client) })), result.lineage) : null, lineage: result.lineage, followUps, kind: 'lookup', extra, screen: 'canvas', metrics };
}
async function singlePractice(cut, tl) {
  const P = new engine.Params();
  const rows = await tl.run('Query Agent', 'Counted billing practices per account in the last two years', () => db.query(`SELECT c.id, c.name, c.industry, c.fortune_g500, c.relationship_partner, COUNT(DISTINCT e.practice)::int AS practices, MIN(e.practice) AS practice, SUM(x.billed) AS revenue FROM clients c JOIN engagements e ON e.client_id=c.id JOIN (SELECT engagement_id, SUM(billed) billed FROM engagement_months WHERE month >= '2024-10-01' GROUP BY 1) x ON x.engagement_id=e.id WHERE e.start_date >= '2024-10-01' ${engine.cutWhere(cut, { industry: 'c.industry', region: 'c.region', unit: 'c.unit' }, P)} GROUP BY 1,2,3,4,5 HAVING COUNT(DISTINCT e.practice)=1 ORDER BY revenue DESC LIMIT 15`, P.values));
  const list = rows.map(r => ({ ...r, practice_name: ref.labelOf('practice', r.practice), industry_name: ref.labelOf('industry', r.industry) }));
  const nb = []; for (const r of list.slice(0, 5)) { const n = await client360.nextBestPractice({ id: r.id, industry: r.industry, name: r.name }, [r.practice]); r.next_best = n.best ? n.best.label : ''; }
  tl.note('Client 360 Agent', 'Marked each white-space row with the relationship partner and the next-best practice');
  const narrative = `${list.length} of the largest ${cut.industry ? ref.labelOf('industry', cut.industry) + ' ' : ''}clients buy from only one practice: ${list.slice(0, 4).map(r => `${r.name} (${r.practice_name}, ${money(r.revenue)}${r.next_best ? ', next best ' + r.next_best : ''})`).join('; ')}. Each row names the relationship partner who owns the introduction.`;
  return { headline: narrative, spoken: `${list.length} clients buy only one practice. ${list[0] ? list[0].name + ' is the largest, in ' + list[0].practice_name + '.' : ''}`, kind: 'whitespace', screen: 'practice', visual: { type: 'bar', title: 'Single-practice clients by revenue', subtitle: 'Last two years', x: list.map(r => r.name), series: [{ name: 'Revenue', data: list.map(r => r.revenue) }], format: 'money', horizontal: true, seeded: true, lineage: { metric: 'cross_practice_penetration', name: 'Cross-practice penetration', formula: 'Number of practices billing per account', source_system: 'SAP, Salesforce', stub: 'stub:sap', tables: ['engagements', 'engagement_months', 'clients'], seeded: true } }, table: composer.table('White space', 'Clients billing one practice', [['name', 'Client'], ['industry_name', 'Industry'], ['practice_name', 'Practice bought'], ['revenue', 'Revenue (2 years)', 'money'], ['next_best', 'Next-best practice'], ['relationship_partner', 'Relationship partner']], list, null), followUps: ['Where is the white space at LIC?', 'Show cross-practice penetration by industry', 'What should I do about it?'] };
}
async function crossBorder(cut, parsed, tl) {
  const from = cut.unit || 'IND'; const toRegion = cut.region || 'EUR'; const p = engine.periodFor(parsed.period || 'qtd');
  const rows = await tl.run('Query Agent', 'Read engagement hours where the delivering office sits outside the engagement unit', () => db.query(`SELECT e.unit AS eng_unit, SUM(em.hours) AS hours, SUM(em.billed) AS billed FROM engagement_months em JOIN engagements e ON e.id=em.engagement_id JOIN offices o ON o.id=e.office JOIN units u ON u.id=e.unit WHERE em.month BETWEEN $1 AND $2 AND o.unit=$3 AND u.region=$4 AND e.unit<>o.unit GROUP BY 1 ORDER BY 2 DESC`, [p.from, p.to, from, toRegion]));
  const total = rows.reduce((a, r) => a + r.hours, 0); const billed = rows.reduce((a, r) => a + r.billed, 0);
  const narrative = `${ref.labelOf('unit', from)} delivered ${Math.round(total).toLocaleString()} hours (${money(billed)} of standard-value billing) for ${ref.labelOf('region', toRegion)} engagements in ${p.label}: ${rows.slice(0, 4).map(r => `${ref.labelOf('unit', r.eng_unit)} ${Math.round(r.hours).toLocaleString()} hours`).join(', ')}.`;
  return { headline: narrative, spoken: narrative, kind: 'crossborder', screen: 'region', visual: { type: 'bar', title: `Cross-border delivery from ${ref.labelOf('unit', from)} to ${ref.labelOf('region', toRegion)}`, subtitle: p.label, x: rows.map(r => ref.labelOf('unit', r.eng_unit)), series: [{ name: 'Hours', data: rows.map(r => r.hours) }], format: 'number', horizontal: true, seeded: true, lineage: { metric: 'cross_border', name: 'Cross-border staffing', formula: 'Hours where the delivering office is outside the engagement unit', source_system: 'IEM, SAP', stub: 'stub:iem', tables: ['engagement_months', 'engagements', 'offices'], seeded: true } }, table: null, followUps: ['Show utilisation by unit in Europe against plan for the last six months', 'Who can start on a procurement engagement in Riyadh on Monday?', 'Which units are below 70% utilisation at Associate level?'] };
}
async function logRun(persona, question, intent, tl, answer, blocked) {
  const agents = [...new Set(tl.steps.map(s => s.agent))];
  await db.query('INSERT INTO agent_runs (ts, persona, question, intent, agents, duration_ms, cost_usd, guardian, blocked) VALUES (now(), $1,$2,$3,$4,$5,$6,$7,$8)', [persona.id, question, intent, JSON.stringify(agents), answer.duration_ms, answer.cost_usd, JSON.stringify(answer.guardian || {}), blocked]).catch(() => {});
}
module.exports = { ask, memoryFor };
