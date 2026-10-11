'use strict';
/**
 * Briefing Agent: writes and speaks the morning brief, meeting preparation notes and the narrative for any dashboard.
 * The brief follows the fixed template in Section 8 (screen 2); every value comes from the integration points.
 */
const db = require('../db');
const engine = require('../metrics/engine');
const ref = require('../metrics/refcache');
const forecast = require('./forecast');
const talent = require('./talent');
const { money, pct, pts, fmt, num, countWord } = require('./util');

async function morningBrief(persona, { shorter = false } = {}) {
  const scopeCut = persona.scope.region ? { region: persona.scope.region } : persona.scope.practice ? { practice: persona.scope.practice } : persona.scope.accounts ? { client: persona.scope.accounts[0] } : persona.scope.engagements ? { engagement: persona.scope.engagements } : {};
  const scopeName = persona.scope.region ? ref.labelOf('region', persona.scope.region) : persona.scope.practice ? ref.labelOf('practice', persona.scope.practice) : persona.scope.accounts ? ref.labelOf('client', persona.scope.accounts[0]) : persona.scope.engagements ? 'Your engagements' : 'The firm';
  const q = engine.periodFor('qtd');
  const parts = []; const facts = {};
  // 1. Plan gap and largest driver (plan is held by unit, so only geography scopes have a plan)
  if (!scopeCut.practice && !scopeCut.client && !scopeCut.engagement) {
    const pa = await engine.compute('plan_attainment', { cut: scopeCut, period: q, groupBy: 'unit' });
    const total = pa.rows.reduce((a, r) => ({ actual: a.actual + (r.actual || 0), plan: a.plan + (r.plan || 0) }), { actual: 0, plan: 0 });
    const gap = total.actual - total.plan; const worst = [...pa.rows].filter(r => r.gap !== null).sort((a, b) => a.gap - b.gap)[0];
    facts.gap = gap; facts.plan = total.plan; facts.worst = worst;
    const best = [...pa.rows].filter(r => r.gap !== null).sort((a, b) => b.gap - a.gap)[0];
    if (gap < 0) parts.push(`${scopeName} is ${money(Math.abs(gap))} behind plan for ${q.label.replace(' to date', '')}${worst && worst.gap < 0 ? `, mainly because ${worst.label} is ${money(Math.abs(worst.gap))} behind` : ''}.`);
    else parts.push(`${scopeName} is ${money(gap)} ahead of plan for ${q.label.replace(' to date', '')}${best && best.gap > 0 ? `, led by ${best.label}` : ''}${worst && worst.gap < 0 ? `; ${worst.label} is ${money(Math.abs(worst.gap))} behind` : ''}.`);
  } else if (scopeCut.practice) {
    const g = await engine.compute('revenue_growth', { cut: scopeCut, period: 'ytd' }); const rev = await engine.compute('net_fee_revenue', { cut: scopeCut, period: 'ytd' });
    parts.push(`${scopeName} revenue is ${money(rev.total.value)} year to date, ${pct(g.total.value)} against last year.`);
  } else if (scopeCut.client) {
    const rev = await engine.compute('net_fee_revenue', { cut: scopeCut, period: 'ytd' }); const pipe = await engine.compute('weighted_pipeline', { cut: scopeCut, period: 'open' });
    parts.push(`${scopeName}: revenue ${money(rev.total.value)} year to date and ${money(pipe.total.value)} of weighted pipeline. You meet their leadership tomorrow; the brief is ready.`);
  } else if (scopeCut.engagement) {
    const rows = await engine.engagementList({ engagement: scopeCut.engagement }, 'live');
    const top = rows[0]; if (top) parts.push(`${top.id} has used ${pct(top.hours_to_date / top.budget_hours, 0)} of budget hours at ${pct(top.elapsed, 0)} of elapsed time; overrun probability ${pct(top.overrun_prob, 0)}.`);
  }
  // 2. Engagements forecast to overrun next month
  const live = await engine.engagementList(scopeCut.client || scopeCut.engagement ? scopeCut : (scopeCut.practice ? { practice: scopeCut.practice } : scopeCut), 'live');
  const nextMonthEnd = engine.addMonths(engine.monthOf(engine.TODAY), 2);
  const overrun = live.filter(e => e.overrun_prob >= 0.5 && e.predicted_overrun_date && e.predicted_overrun_date < nextMonthEnd);
  facts.overrun = overrun.length;
  parts.push(`${countWord(overrun.length, 'engagement')} ${overrun.length === 1 ? 'is' : 'are'} forecast to overrun next month${overrun[0] ? `, led by ${overrun[0].id}` : ''}.`);
  // 3. Utilisation gap
  if (!scopeCut.client && !scopeCut.engagement) {
    const u = await engine.compute('utilisation', { cut: scopeCut.practice ? scopeCut : scopeCut, period: 'last_month', groupBy: scopeCut.practice ? 'region' : 'unit' });
    const target = 0.68; const rows = u.rows.filter(r => r.value !== null).map(r => ({ ...r, gap: r.value - target })).sort((a, b) => a.gap - b.gap);
    if (rows[0]) { facts.util = rows[0]; parts.push(`${rows[0].label} is ${Math.abs(rows[0].gap * 100).toFixed(1)} points ${rows[0].gap < 0 ? 'below' : 'above'} its utilisation target.`); }
  }
  // 4. People signal for people leaders
  if (persona.id === 'cpo') { const h = await talent.heatmap({ level: 'PRINCIPAL' }); if (h.ranked[0]) parts.push(`${h.ranked[0].label} shows the highest Principal flight risk, about ${num(h.ranked[0].expected)} expected exits in six months.`); }
  // 5. Drafted actions
  const pending = await db.one('SELECT COUNT(*)::int AS n FROM actions WHERE status=$1', ['pending']);
  parts.push(pending.n === 0 ? 'No drafted actions are waiting for your review.' : `I have drafted ${countWord(pending.n, 'action', null, { cap: false })} for your review; ${pending.n === 1 ? 'it is' : 'they are'} waiting in the action centre.`);
  const greeting = 'Good morning.';
  const text = shorter ? `${greeting} ${parts[0]} ${parts[parts.length - 1]}` : `${greeting} ${parts.join(' ')}`;
  return { agent: 'Briefing Agent', text, parts, facts, duration_s: Math.round(text.split(' ').length / 2.6), template: '{Region} is {gap to plan} against plan for the quarter, mainly because {largest driver}. {Number} engagements are forecast to overrun next month. {Unit with highest utilisation gap} is {gap} against its utilisation target. I have drafted {number} actions for your review.' };
}
// Narrative for a metric result: one finding, one number, one suggestion.
function metricNarrative(result, { compare = null, compareValue = null, compareLabel = null } = {}) {
  const m = result.metric; const scope = require('./composer').scopeLabel(result.cut).replace(/^, /, '');
  const where = scope ? ` in ${scope}` : ' for the firm';
  const rows = result.rows.filter(r => r.value !== null);
  if (!rows.length) return { text: `No data for ${m.name.toLowerCase()}${where} in ${result.period.label}.`, spoken: `There is no data for that yet.` };
  if (result.groupBy && result.groupBy !== 'all' && rows.length > 1) {
    const timeDim = ['month', 'quarter', 'year'].includes(result.groupBy);
    if (timeDim && rows.length >= 3) {
      const additive = m.format === 'money' && !['revenue_per_partner', 'revenue_per_professional', 'profit_per_partner', 'effective_rate', 'eac', 'fx_impact'].includes(m.id);
      const last = rows[rows.length - 1], prev = rows[rows.length - 2];
      const lo = rows.reduce((a, r) => (r.value < a.value ? r : a), rows[0]), hi = rows.reduce((a, r) => (r.value > a.value ? r : a), rows[0]);
      const sum = rows.reduce((a, r) => a + r.value, 0), avg = sum / rows.length;
      const step = result.groupBy === 'month' ? 'month' : result.groupBy;
      const d = last.value - prev.value;
      const change = m.format === 'pct' ? pts(d) : (d >= 0 ? 'up ' : 'down ') + fmt(Math.abs(d), m.format);
      const text = additive
        ? `${m.name}${where} totalled ${fmt(sum, m.format)} over ${result.period.label || 'the period'}, averaging ${fmt(avg, m.format)} a ${step}, from a low of ${fmt(lo.value, m.format)} in ${lbl(lo.key, result.groupBy)} to a high of ${fmt(hi.value, m.format)} in ${lbl(hi.key, result.groupBy)}. ${lbl(last.key, result.groupBy)} came in at ${fmt(last.value, m.format)}, ${change} on ${lbl(prev.key, result.groupBy)}${compareValue !== null && compareValue !== undefined ? `; the period total is against ${compareLabel} of ${fmt(compareValue, m.format)}` : ''}.`
        : `${m.name}${where} averaged ${fmt(avg, m.format)} over ${result.period.label || 'the period'}, ranging from ${fmt(lo.value, m.format)} in ${lbl(lo.key, result.groupBy)} to ${fmt(hi.value, m.format)} in ${lbl(hi.key, result.groupBy)}. ${lbl(last.key, result.groupBy)} stands at ${fmt(last.value, m.format)}, ${change} on ${lbl(prev.key, result.groupBy)}${compareValue !== null && compareValue !== undefined ? `, against ${compareLabel} of ${fmt(compareValue, m.format)}` : ''}.`;
      const worry = m.higherIsBetter === (d >= 0) ? '' : ` Ask me why ${lbl(last.key, result.groupBy)} moved.`;
      return { text, spoken: `${m.name}${where}: ${lbl(last.key, result.groupBy)} was ${fmt(last.value, m.format)}, ${change} on the ${step} before. The ${result.period.label || 'period'} low was ${lbl(lo.key, result.groupBy)} and the high ${lbl(hi.key, result.groupBy)}.${worry}` };
    }
    if (timeDim) {
      const first = rows[0], last = rows[rows.length - 1]; const delta = last.value - first.value;
      const text = `${m.name}${where} was ${fmt(last.value, m.format)} in ${lbl(last.key, result.groupBy)}, ${m.format === 'pct' ? pts(delta) : (delta >= 0 ? 'up ' : 'down ') + fmt(Math.abs(delta), m.format)} from ${lbl(first.key, result.groupBy)}${compareValue !== null && compareValue !== undefined ? `, against ${compareLabel} of ${fmt(compareValue, m.format)}` : ''}.`;
      return { text, spoken: text + (m.higherIsBetter === (delta >= 0) ? '' : ' Ask me why.') };
    }
    const sorted = [...rows].sort((a, b) => b.value - a.value); const best = sorted[0], worst = sorted[sorted.length - 1];
    const text = `${m.name}${where} ranges from ${fmt(worst.value, m.format)} (${worst.label}) to ${fmt(best.value, m.format)} (${best.label})${result.period.label ? ' for ' + result.period.label : ''}${result.total && result.total.value !== null ? `; overall ${fmt(result.total.value, m.format)}` : ''}.`;
    return { text, spoken: `${m.name}${where}: ${best.label} is highest at ${fmt(best.value, m.format)} and ${worst.label} lowest at ${fmt(worst.value, m.format)}. Ask me why ${m.higherIsBetter ? worst.label : best.label} stands out.` };
  }
  const v = result.total.value;
  let text = `${m.name}${where} is ${fmt(v, m.format)}${result.period.label ? ' for ' + result.period.label : ''}`;
  if (compareValue !== null && compareValue !== undefined) { const d = v - compareValue; text += `, ${m.format === 'pct' ? pts(d) : (d >= 0 ? 'up ' : 'down ') + fmt(Math.abs(d), m.format)} against ${compareLabel} (${fmt(compareValue, m.format)})`; }
  text += '.';
  return { text, spoken: text + ` Ask me to explain it or forecast it.` };
}
function lbl(key, g) { if (g === 'month') return require('./util').monthLabel(key); if (g === 'quarter') return engine.quarterLabel(key); return key.slice(0, 4); }
module.exports = { morningBrief, metricNarrative };
