'use strict';
/**
 * Interpretation layer. The analytics produce facts (series, tables, bridges, drivers) and a template sentence that
 * states them. When a language model is configured, it receives those facts and writes what they mean for the person
 * asking: the finding, the so-what and the next step. Every number in its answer must already appear in the facts,
 * otherwise the template answer is kept. The template is never discarded: it travels with the answer as "all the figures".
 */
const llm = require('./llm');
const { fmt, pts } = require('./util');

// Answer kinds that are not analyses (navigation, approvals, the brief, conversation) keep their own wording.
const SKIP = new Set(['chat', 'blocked', 'error', 'action_centre', 'actions', 'act', 'board', 'share', 'slide', 'animate', 'brief', 'lineage', 'navigate', 'policy', 'observatory', 'knowledge', 'clarify', 'match', 'staffing']);
const skip = kind => !kind || SKIP.has(kind);

function numbersIn(text) { return (String(text || '').match(/\d[\d,.]*/g) || []).map(s => s.replace(/,/g, '').replace(/\.$/, '')); }
const PCT_KEY = /rate|prob|realisation|margin|attainment|share|risk|utilisation|growth|pct|elapsed|burn|coverage|penetration|win|leverage_pct|score_pct/i;
function f(v, format, key) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') { const x = Number(v); if (isNaN(x) || v.trim() === '' || /[-]\d{2}-/.test(v)) return v; v = x; }
  if (typeof v !== 'number') return String(v);
  const fm = format || (PCT_KEY.test(key || '') && Math.abs(v) <= 1.5 ? 'pct' : Math.abs(v) >= 1000 ? 'money' : 'number');
  try { const s = fm === 'pts' ? pts(v) : fmt(v, fm); return s === undefined || s === null ? String(v) : String(s); } catch (e) { return String(v); }
}

// A compact, formatted statement of everything the answer carries, for the model and for the number check.
function factsFor(out) {
  const lines = [];
  const v = out.visual;
  if (v) {
    lines.push(`Chart: ${v.title || ''}${v.subtitle ? ' (' + v.subtitle + ')' : ''}`);
    if (Array.isArray(v.x) && Array.isArray(v.series)) for (const s of v.series.slice(0, 3)) lines.push(`${s.name || 'Series'}: ${v.x.slice(0, 16).map((x, i) => `${x} ${f(s.data && s.data[i], v.format) ?? '–'}`).join('; ')}`);
    if (Array.isArray(v.steps)) lines.push(`Bridge: ${v.steps.map(st => { const isPts = v.format === 'pct' && st.kind === 'delta'; return `${st.label} ${st.kind === 'delta' && !isPts && st.value >= 0 ? '+' : ''}${f(st.value, isPts ? 'pts' : v.format)}`; }).join('; ')}`);
    if (v.type === 'forecast' && Array.isArray(v.x) && Array.isArray(v.p50)) { const pts = v.x.map((x, i) => v.p50[i] != null ? `${x} ${f(v.p50[i], v.format)}${v.plan && v.plan[i] != null ? ' (plan ' + f(v.plan[i], v.format) + ')' : ''}` : null).filter(Boolean); if (pts.length) lines.push(`Forecast by month (P50): ${pts.join('; ')}`); const act = v.x.map((x, i) => v.actual[i] != null ? `${x} ${f(v.actual[i], v.format)}` : null).filter(Boolean).slice(-6); if (act.length) lines.push(`Recent actuals: ${act.join('; ')}`); }
    if (Array.isArray(v.cells) && Array.isArray(v.x) && Array.isArray(v.y)) lines.push(`Highest cells: ${[...v.cells].sort((a, b) => b.value - a.value).slice(0, 6).map(c => `${v.y[c.y]} in ${v.x[c.x]} ${f(c.value, v.format)}`).join('; ')}`);
    if (Array.isArray(v.rows) && v.type === 'scenario') lines.push(`Scenario: ${v.rows.map(r => `${r.metric} ${f(r.baseline, r.format)} to ${f(r.scenario, r.format)}`).join('; ')}`);
  }
  const fy = out.fullYear;
  if (fy) lines.push(`Full year: forecast ${f(fy.p50, 'money')} (P10 ${f(fy.p10, 'money')}, P90 ${f(fy.p90, 'money')})${fy.plan ? `, plan ${f(fy.plan, 'money')}, gap ${f(fy.gap, 'money')}, probability of reaching plan ${f(fy.prob_reach_plan, 'pct')}` : ''}${fy.with_actions ? `, with approved actions ${f(fy.with_actions, 'money')} and gap ${f(fy.gap_with_actions, 'money')}` : ''}, booked to date ${f(fy.actual_ytd, 'money')}`);
  const t = out.table;
  if (t && Array.isArray(t.columns) && Array.isArray(t.rows)) {
    lines.push(`Table: ${t.title || ''}${t.subtitle ? ' (' + t.subtitle + ')' : ''}`);
    for (const r of t.rows.slice(0, 10)) lines.push('  ' + t.columns.slice(0, 9).map(c => `${c[1]} ${f(r[c[0]], c[2], c[0]) ?? '–'}`).join(', '));
  }
  if (Array.isArray(out.drivers)) lines.push(`Drivers: ${out.drivers.slice(0, 6).map(d => `${d.driver || d.name || ''} ${f(d.effect ?? d.value, d.format, d.driver)}`).join('; ')}`);
  if (Array.isArray(out.assumptions) && out.assumptions.length) lines.push(`Assumptions: ${out.assumptions.join('; ')}`);
  if (out.model && out.model.name) lines.push(`Model: ${out.model.name}${out.model.backtest && out.model.backtest.mape ? `, backtest error ${f(out.model.backtest.mape, 'pct')}` : ''}`);
  return lines.join('\n');
}

async function interpret({ question, persona, out, previous }) {
  if (skip(out.kind) || !out.headline) return null;
  if (!(await llm.enabled())) return null;
  const facts = factsFor(out);
  const allowed = new Set(numbersIn(facts + '\n' + out.headline).map(n => String(parseFloat(n))));
  const system = `You are Astra, the insights assistant of Kearney, a management consulting partnership. You are speaking to the ${persona.title}, who decides on ${persona.decides || 'the matters of that role'}. You receive the facts an analysis produced and a template sentence that states them correctly. Write what the facts mean for this person.
Return JSON with four strings: finding, so_what, next_step, spoken.
finding: the one thing the data says, at most 30 words, carrying the one or two figures that matter most.
so_what: why it matters for this role: compare with plan, the prior period, other units or the trend, using only the facts given; name the risk or the opportunity; at most 45 words.
next_step: one concrete thing to decide, do or ask next, at most 22 words; when a question is the natural next step, phrase it as something they can say to Astra.
spoken: the same message in at most 45 words for a voice assistant, with at most two figures.
Rules: British English, plain words, no markdown, no headings, no bullet points, no preamble. Use only numbers that appear in the facts or the template, written exactly as they appear there (same rounding, same unit); never compute or round a new number. Do not invent causes; where you infer one, write "likely". Refer to engagements, opportunities, invoices and people only by the identifiers given. Do not repeat the template; interpret it. If the facts are thin, keep the finding and say what to ask next.`;
  const user = `Question: ${question}\nTemplate answer (every figure in it is correct): ${out.headline}${previous ? `\nPrevious answer in this conversation: ${String(previous).slice(0, 500)}` : ''}\nFacts:\n${facts}`;
  let r;
  try { r = await llm.chat([{ role: 'system', content: system }, { role: 'user', content: user }], { json: true, maxTokens: 600 }); } catch (e) { return { citation: 'model error: ' + e.message }; }
  if (!r) return null;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { const m = r.match(/\{[\s\S]*\}/); r = m ? (() => { try { return JSON.parse(m[0]); } catch (e2) { return null; } })() : null; } }
  if (!r || typeof r !== 'object') return { citation: 'model returned no usable answer' };
  const parts = ['finding', 'so_what', 'next_step'].map(k => typeof r[k] === 'string' ? r[k].trim() : '').filter(Boolean);
  if (!parts.length) return { citation: 'model returned no finding' };
  const text = parts.join(' ').replace(/\s+/g, ' ');
  const spoken = typeof r.spoken === 'string' && r.spoken.trim() ? r.spoken.trim() : text;
  const bad = numbersIn(text + ' ' + spoken).map(n => String(parseFloat(n))).filter(n => !allowed.has(n));
  if (bad.length) return { citation: `blocked: the model introduced ${[...new Set(bad)].slice(0, 4).join(', ')}` };
  if (text.split(/\s+/).length > 160) return { citation: 'blocked: too long' };
  return { text, spoken, citation: 'pass: every number is in the result' };
}

module.exports = { interpret, factsFor, skip };
