'use strict';
/**
 * Client 360 Agent: account view and meeting brief. Public work is shown as real and sourced; everything financial is seeded.
 * Next-best practice (model 12): collaborative filtering over same-industry purchase history.
 */
const db = require('../db');
const engine = require('../metrics/engine');
const ref = require('../metrics/refcache');
const composer = require('./composer');
const { money, pct, listWords, dateLabel } = require('./util');

async function account(clientId) {
  const c = await db.one('SELECT * FROM clients WHERE id=$1', [clientId]);
  if (!c) return null;
  const years = await db.query(`SELECT date_trunc('year', em.month)::date AS year, e.practice, SUM(em.billed) AS revenue FROM engagement_months em JOIN engagements e ON e.id=em.engagement_id WHERE e.client_id=$1 GROUP BY 1,2 ORDER BY 1,2`, [clientId]);
  const engagements = await db.query(`SELECT e.id, e.practice, e.fee_model, e.start_date, e.end_date, e.status, e.budget_fees, e.partner_id, e.health_score, e.overrun_prob, COALESCE(x.billed,0) AS billed FROM engagements e LEFT JOIN (SELECT engagement_id, SUM(billed) billed FROM engagement_months GROUP BY 1) x ON x.engagement_id=e.id WHERE e.client_id=$1 ORDER BY e.start_date DESC`, [clientId]);
  const contacts = await db.query('SELECT * FROM contacts WHERE client_id=$1 ORDER BY strength DESC', [clientId]);
  const pipeline = await db.query('SELECT * FROM opportunities WHERE client_id=$1 AND outcome IS NULL ORDER BY value DESC', [clientId]);
  const invoices = await db.query(`SELECT COUNT(*)::int AS n, SUM(CASE WHEN status='overdue' THEN amount ELSE 0 END) AS overdue, AVG(late_prob) AS late_prob FROM invoices WHERE client_id=$1 AND status<>'paid'`, [clientId]);
  const practices = [...new Set(engagements.map(e => e.practice))];
  const nbp = await nextBestPractice(c, practices);
  const ytd = years.filter(y => String(y.year).startsWith('2026')).reduce((a, y) => a + y.revenue, 0), ly = years.filter(y => String(y.year).startsWith('2025')).reduce((a, y) => a + y.revenue, 0);
  const yearsList = [...new Set(years.map(y => String(y.year).slice(0, 4)))];
  const revByYear = yearsList.map(y => ({ year: y, series: practices.map(p => years.filter(r => String(r.year).startsWith(y) && r.practice === p).reduce((a, r) => a + r.revenue, 0)) }));
  const partners = [...new Set([c.relationship_partner, ...engagements.map(e => e.partner_id)])].filter(Boolean);
  const knownBy = contacts.filter(ct => ct.kearney_person_id);
  const newExec = contacts.find(ct => /new/i.test(ct.title));
  const publicLine = c.is_public ? `Public record (${c.public_source}, ${c.public_year}): ${c.public_work}.` : 'No public work is recorded for this client.';
  const narrative = `${c.name} is a ${ref.labelOf('industry', c.industry)} client led from ${ref.labelOf('unit', c.unit)}${c.fortune_g500 ? ', in the Fortune Global 500' : ''}. ${publicLine} Revenue is ${money(ytd)} year to date against ${money(ly)} last year, across ${practices.length} practice${practices.length > 1 ? 's' : ''} (${listWords(practices.map(p => ref.labelOf('practice', p)))}). ${engagements.filter(e => e.status === 'live').length} engagements are live. Open pipeline: ${pipeline.length ? listWords(pipeline.map(o => `${o.id} (${ref.labelOf('practice', o.practice)}, ${money(o.value)}, ${pct(o.win_prob, 0)})`)) : 'none'}. Satisfaction ${c.satisfaction ? c.satisfaction.toFixed(1) : 'n/a'} (${c.satisfaction_prev ? c.satisfaction_prev.toFixed(1) : 'n/a'} previously); themes: ${(c.sentiment_themes || []).join(', ')}. ${knownBy.length} client executives have a Kearney relationship owner.${newExec ? ` Note: ${newExec.title.split(':')[0]} is new and ${newExec.kearney_person_id ? 'is known to ' + newExec.kearney_person_id : 'has no Kearney relationship yet'}.` : ''} ${nbp.narrative}`;
  const spoken = `${c.name}: ${money(ytd)} revenue year to date, ${pipeline.length} open opportunit${pipeline.length === 1 ? 'y' : 'ies'}, satisfaction ${c.satisfaction ? c.satisfaction.toFixed(1) : 'n/a'}. ${c.is_public ? 'The public work is the ' + c.public_work.split(' under ')[0].toLowerCase() + '. ' : ''}${nbp.best ? 'The white space is ' + ref.labelOf('practice', nbp.best.practice) + '. ' : ''}Ask me for the relationship map or the white space.`;
  return { agent: 'Client 360 Agent', client: c, public: c.is_public ? { work: c.public_work, year: c.public_year, source: c.public_source, badge: 'Public, sourced' } : null, revenue: { ytd, ly, byYear: revByYear, practices }, engagements, contacts: contacts.map(ct => ({ ...ct, decayed: !ct.last_contact || (new Date(engine.TODAY) - new Date(ct.last_contact)) / 86400000 > 90 })), pipeline, receivables: invoices[0], satisfaction: { now: c.satisfaction, prev: c.satisfaction_prev, themes: c.sentiment_themes }, partners, nextBest: nbp, narrative, spoken,
    visual: { type: 'stackedbar', title: `${c.name}: revenue by practice`, subtitle: 'By year', x: yearsList, series: practices.map((p, i) => ({ name: ref.labelOf('practice', p), data: revByYear.map(y => y.series[i]) })), format: 'money', seeded: true, lineage: lineage(clientId) },
    table: composer.table('Relationship map', 'Client executives and Kearney relationship owners', [['title', 'Client executive'], ['kearney_person_id', 'Kearney owner'], ['last_contact', 'Last contact'], ['strength', 'Strength (1–5)']], contacts, lineage(clientId)),
    followUps: ['Where is the white space?', 'Who in the firm has worked with them?', 'Send me a short audio brief for the car'] };
}
async function nextBestPractice(c, bought) {
  // peers: same-industry clients. Score(practice P) = share of peers who bought any of the client's practices AND also bought P, for P not yet bought.
  const peers = await db.query(`SELECT e.client_id, array_agg(DISTINCT e.practice) AS practices FROM engagements e JOIN clients cl ON cl.id=e.client_id WHERE cl.industry=$1 AND e.client_id<>$2 GROUP BY 1`, [c.industry, c.id]);
  const overlap = peers.filter(p => p.practices.some(x => bought.includes(x)));
  const scores = {};
  for (const p of ref.get().practices.map(x => x.id)) { if (bought.includes(p)) continue; const n = overlap.filter(o => o.practices.includes(p)).length; scores[p] = overlap.length ? n / overlap.length : 0; }
  const ranked = Object.entries(scores).map(([practice, score]) => ({ practice, label: ref.labelOf('practice', practice), score, peers: Math.round(score * overlap.length) })).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const narrative = best ? `Next-best practice: ${best.label}. Of the ${overlap.length} ${ref.labelOf('industry', c.industry)} clients that bought ${listWords(bought.map(b => ref.labelOf('practice', b)))}, ${pct(best.score, 0)} also bought ${best.label}; ${c.name} has not.${ranked[1] ? ` Second: ${ranked[1].label} (${pct(ranked[1].score, 0)}).` : ''}` : 'No white space found.';
  return { best, ranked: ranked.slice(0, 5), peers: overlap.length, bought, narrative, model: { id: 12, name: 'Next-best practice', method: 'Collaborative filtering', accuracy: 'Hit rate 0.43 on past cross-sells (seed)' } };
}
async function whiteSpace(clientId) {
  const a = await account(clientId); if (!a) return null;
  const n = a.nextBest;
  return { agent: 'Client 360 Agent', model: n.model, client: a.client, nextBest: n, narrative: n.narrative + ` The relationship owner for the introduction is ${a.client.relationship_partner}.`, spoken: `The white space at ${a.client.name} is ${n.best ? n.best.label : 'unclear'}: ${n.best ? pct(n.best.score, 0) + ' of similar clients that bought ' + ref.labelOf('practice', n.bought[0]) + ' also bought it' : ''}. I can draft an introduction note for your approval.`,
    visual: { type: 'bar', title: `White space at ${a.client.name}`, subtitle: `Share of ${ref.labelOf('industry', a.client.industry)} peers with the same purchase history who also bought the practice`, x: n.ranked.map(r => r.label), series: [{ name: 'Peer co-purchase rate', data: n.ranked.map(r => r.score) }], format: 'pct', horizontal: true, seeded: true, lineage: { ...lineage(clientId), model: 'Next-best practice v1.0-seed (collaborative filtering, hit rate 0.43)' } },
    table: composer.table('Practices bought', '', [['practice', 'Practice']], n.bought.map(b => ({ practice: ref.labelOf('practice', b) })), lineage(clientId)), followUps: ['Who in the firm has worked with them?', 'Draft an introduction note to the client CEO', 'Send me a short audio brief for the car'] };
}
async function whoKnows(clientId) {
  const a = await account(clientId); if (!a) return null;
  const people = await db.query(`SELECT DISTINCT p.id, p.level, p.office, p.unit FROM engagements e JOIN people p ON p.id IN (e.partner_id, e.principal_id) WHERE e.client_id=$1 ORDER BY p.level`, [clientId]);
  const ownersFromContacts = a.contacts.filter(ct => ct.kearney_person_id);
  const list = people.map(p => ({ id: p.id, level_name: ref.labelOf('level', p.level), office_name: ref.labelOf('office', p.office), role: 'Led engagements', engagements: a.engagements.filter(e => e.partner_id === p.id || e.principal_id === p.id).map(e => e.id).join(', ') }));
  const newExec = a.contacts.find(ct => /new/i.test(ct.title) && ct.kearney_person_id);
  const narrative = `${list.length} people in the firm have led work for ${a.client.name}: ${listWords(list.slice(0, 4).map(p => `${p.id} (${p.level_name}, ${p.office_name})`))}${list.length > 4 ? ' and others' : ''}. ${ownersFromContacts.length} client executives have a named Kearney relationship owner; ${a.contacts.filter(ct => ct.decayed).length} relationships have had no contact for 90 days.${newExec ? ` The new ${newExec.title.split(' (')[0]} is known to ${newExec.kearney_person_id} from a prior role.` : ''} People are shown by identifier.`;
  return { agent: 'Client 360 Agent', people: list, contacts: a.contacts, narrative, spoken: `${list.length} people have worked with ${a.client.name}. ${newExec ? newExec.kearney_person_id + ' knows the new CFO from a prior role.' : ''} Shown by identifier.`,
    visual: { type: 'network', title: `Relationship map: ${a.client.name}`, subtitle: 'Client executives and Kearney owners; dashed = no contact for 90 days', nodes: [...a.contacts.map(ct => ({ id: ct.id, label: ct.title.split(' (')[0].split(':')[0], side: 'client', strength: ct.strength })), ...[...new Set([...a.contacts.map(ct => ct.kearney_person_id), ...list.map(p => p.id)].filter(Boolean))].map(id => ({ id, label: id, side: 'kearney' }))], links: a.contacts.filter(ct => ct.kearney_person_id).map(ct => ({ source: ct.id, target: ct.kearney_person_id, decayed: ct.decayed, strength: ct.strength })), seeded: true, lineage: lineage(clientId) },
    table: composer.table('People who have led work', '', [['id', 'Person'], ['level_name', 'Level'], ['office_name', 'Office'], ['engagements', 'Engagements']], list, lineage(clientId)), followUps: ['Send me a short audio brief for the car', 'Where is the white space?', 'What have we done for this client in the last five years?'] };
}
async function meetingBrief(clientId, persona) {
  const a = await account(clientId); if (!a) return null;
  const ev = await db.one(`SELECT * FROM calendar_events WHERE client_id=$1 AND persona=$2 AND start_ts >= $3 ORDER BY start_ts LIMIT 1`, [clientId, persona.id, engine.TODAY]);
  const live = a.engagements.filter(e => e.status === 'live');
  const brief = [
    `Meeting brief: ${a.client.name}${ev ? ', ' + dateLabel(ev.start_ts.toISOString().slice(0, 10)) : ''}.`,
    a.public ? `Public record: ${a.public.work} (${a.public.source}, ${a.public.year}).` : '',
    `Relationship: ${a.revenue.practices.length} practice${a.revenue.practices.length > 1 ? 's' : ''} (${listWords(a.revenue.practices.map(p => ref.labelOf('practice', p)))}); revenue ${money(a.revenue.ytd)} year to date against ${money(a.revenue.ly)} last year.`,
    live.length ? `Live work: ${listWords(live.map(e => `${e.id} (${ref.labelOf('practice', e.practice)}, health ${e.health_score ?? 'n/a'})`))}.` : 'No live engagements.',
    a.pipeline.length ? `Open pipeline: ${listWords(a.pipeline.map(o => `${o.id} (${ref.labelOf('practice', o.practice)}, ${money(o.value)}, ${pct(o.win_prob, 0)}, ${o.stage})`))}.` : 'No open pipeline.',
    `Satisfaction ${a.satisfaction.now ? a.satisfaction.now.toFixed(1) : 'n/a'} (${a.satisfaction.prev ? a.satisfaction.prev.toFixed(1) : 'n/a'} last survey); themes: ${(a.satisfaction.themes || []).join(', ')}.`,
    a.receivables && a.receivables.overdue > 0 ? `Receivables: ${money(a.receivables.overdue)} overdue; raise gently if the CFO attends.` : 'Receivables: nothing overdue.',
    a.nextBest.best ? `White space: ${a.nextBest.best.label} (${pct(a.nextBest.best.score, 0)} of similar clients bought it). Suggested ask: a diagnostic conversation with the sponsor.` : '',
    a.contacts.some(ct => ct.decayed) ? `Relationship decay: ${a.contacts.filter(ct => ct.decayed).length} executive${a.contacts.filter(ct => ct.decayed).length > 1 ? 's' : ''} without contact for 90 days.` : '',
    a.contacts.find(ct => /new/i.test(ct.title)) ? `New executive: ${a.contacts.find(ct => /new/i.test(ct.title)).title.split(' (')[0]}; ${a.contacts.find(ct => /new/i.test(ct.title) && ct.kearney_person_id) ? a.contacts.find(ct => /new/i.test(ct.title) && ct.kearney_person_id).kearney_person_id + ' knows them from a prior role' : 'no Kearney relationship yet'}.` : ''
  ].filter(Boolean);
  const audio = `${a.client.name} tomorrow. ${a.public ? 'Our public work is the ' + a.public.work.split(' under ')[0].toLowerCase() + '. ' : ''}Revenue ${money(a.revenue.ytd)} year to date, ${a.pipeline.length} open opportunit${a.pipeline.length === 1 ? 'y' : 'ies'} worth ${money(a.pipeline.reduce((s, o) => s + o.value, 0))}. Satisfaction ${a.satisfaction.now ? a.satisfaction.now.toFixed(1) : 'n/a'}. ${a.nextBest.best ? 'The white space is ' + a.nextBest.best.label + '. ' : ''}${a.contacts.find(ct => /new/i.test(ct.title)) ? 'They have a new CFO; ' + (a.contacts.find(ct => /new/i.test(ct.title) && ct.kearney_person_id) ? a.contacts.find(ct => /new/i.test(ct.title) && ct.kearney_person_id).kearney_person_id + ' knows them. ' : 'nobody knows them yet. ') : ''}One ask: a diagnostic conversation with the sponsor.`;
  if (ev) await db.query('UPDATE calendar_events SET attachments = $1 WHERE id=$2', [JSON.stringify([{ type: 'brief', title: 'One-page brief', generated: new Date().toISOString() }, { type: 'audio', title: 'Audio brief (about 60 seconds)', generated: new Date().toISOString() }]), ev.id]);
  return { agent: 'Client 360 Agent', account: a, brief, audio, event: ev, narrative: brief.join(' '), spoken: audio, visual: a.visual, table: a.table, followUps: ['Where is the white space?', 'Who in the firm has worked with them?', 'Draft an introduction note to the client CEO'] };
}
function lineage(clientId) { return { metric: 'account_360', name: 'Account 360', formula: 'Revenue by practice and year; relationship map; open pipeline; satisfaction', owner: 'Global Account Leader', source_system: 'SAP, Salesforce, client feedback system, approved public news feed', stub: 'stub:sap + stub:salesforce + stub:client-feedback; public work from Consultancy.org', tables: ['clients', 'engagements', 'engagement_months', 'contacts', 'opportunities', 'invoices'], filters: { client: clientId }, seeded: true, refreshed_at: engine.TODAY + 'T05:30:00Z', note: 'Public news feed connector is not configured in the demo; the sourced public work is shown instead' }; }
module.exports = { account, whiteSpace, whoKnows, meetingBrief, nextBestPractice };
