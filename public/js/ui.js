// Shared UI primitives: API client, element builder, visual and table rendering, lineage drawer, point-and-ask.
import { render as renderChart, f as fmtValue, fmt, chartImage } from './charts.js';

// Slide export: posts the answer (headline, chart image, table, lineage) to the server, which returns a .pptx to download.
export async function exportSlide(a, card) {
  const chartEl = card ? card.querySelector('.chart') : null;
  const image = chartEl ? chartImage(chartEl, { background: '#ffffff' }) : null;
  toast('Building the slide…');
  const body = { question: a.question, headline: a.headline, image, table: a.table ? { title: a.table.title, columns: a.table.columns, rows: a.table.rows } : null, lineage: a.lineage || (a.visual && a.visual.lineage) || null, persona: state.persona.id, agents: a.agents, model: a.llm || null };
  const res = await fetch('api/export/slide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { toast('Slide export failed: ' + res.statusText); return; }
  const blob = await res.blob(); const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
  const url = URL.createObjectURL(blob); const link = h('a', { href: url, download: name ? name[1] : 'Astra_slide.pptx' }); document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Slide downloaded');
}

export const state = { persona: null, meta: null, ref: null, session: 'demo-' + Math.random().toString(36).slice(2, 8), screen: 'home', context: null, quiet: false, lang: 'en', answers: [], lastAnswer: null };

export async function api(path, opts = {}) {
  const res = await fetch('api/' + path.replace(/^\//, ''), opts.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) } : { method: opts.method || 'GET' });
  if (!res.ok) { let msg = res.statusText; try { msg = (await res.json()).error || msg; } catch (e) { /* noop */ } throw new Error(msg); }
  return res.json();
}
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v; else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v); else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v); else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v); }
  for (const c of children.flat(Infinity)) { if (c === null || c === undefined || c === false) continue; el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c); }
  return el;
}
// "Animate this": assembles a Claude Motion prompt from an answer (question, finding, chart values, table rows), copies it to the clipboard and shows it.
export function motionPrompt(a) {
  const v = a.visual || {}; const lines = [];
  lines.push(`/motion Make a 20-second, 16:9 animated explainer in a calm dark style (background #0b0d12, one accent #8f7bff, text #e8eaf0, good #3ddc97, bad #ff6b7a, Segoe UI or Inter, large numerals, no stock imagery, no people). Use exactly these numbers and words.`);
  lines.push(`Scene 1 (0–3 s): the question "${a.question}" types in over a pulsing violet orb.`);
  const fmtv = x => (x === null || x === undefined) ? '–' : (v.format === 'pct' ? (x * 100).toFixed(1) + '%' : v.format === 'money' ? 'US$' + (Math.abs(x) >= 1e9 ? (x / 1e9).toFixed(2) + ' billion' : (x / 1e6).toFixed(1) + ' million') : Number(x).toLocaleString('en-US', { maximumFractionDigits: 1 }));
  if (v.type === 'waterfall' && v.steps) lines.push(`Scene 2 (3–12 s): a waterfall titled "${v.title}" builds step by step: ${v.steps.map(s => `${s.label} ${s.kind === 'delta' ? ((s.value >= 0 ? '+' : '') + (v.format === 'pct' ? (s.value * 100).toFixed(1) + ' pts' : fmtv(s.value))) : fmtv(s.value)}`).join(' → ')}. Negative steps in red, positive in green, totals count up.`);
  else if ((v.type === 'line' || v.type === 'forecast') && v.x) { const data = v.series ? v.series[0].data : v.actual; lines.push(`Scene 2 (3–12 s): a line chart titled "${v.title}" draws itself left to right: ${v.x.map((x, i) => `${x} ${fmtv(data[i])}`).filter(s => !/–$/.test(s)).join(', ')}.${v.p50 ? ' Then a dashed forecast continues with a shaded band: ' + v.x.map((x, i) => v.p50[i] !== null ? `${x} ${fmtv(v.p50[i])}` : null).filter(Boolean).join(', ') + '.' : ''}`); }
  else if ((v.type === 'bar' || v.type === 'stackedbar') && v.x) lines.push(`Scene 2 (3–12 s): a ranked bar chart titled "${v.title}" animates in one bar at a time: ${v.x.map((x, i) => `${x} ${fmtv(v.series[0].data[i])}`).join(', ')}.`);
  else if (v.type === 'heatmap' && v.cells) lines.push(`Scene 2 (3–12 s): a heatmap titled "${v.title}" fills cell by cell; the darkest cells are: ${[...v.cells].sort((p, q) => q.value - p.value).slice(0, 5).map(c => `${v.x[c.x]} × ${v.y[c.y]} ${fmtv(c.value)}`).join(', ')}.`);
  else if (v.type === 'kpi') lines.push(`Scene 2 (3–12 s): a single large numeral counts up to ${fmtv(v.value)} under the title "${v.title}".`);
  else if (a.table && a.table.rows) lines.push(`Scene 2 (3–12 s): a table titled "${a.table.title}" reveals its rows one by one: ${a.table.rows.slice(0, 5).map(r => a.table.columns.slice(0, 3).map(c => r[c[0]]).join(' · ')).join('; ')}.`);
  if (a.table && a.table.rows && v.type !== 'table' && v.type !== 'kpi') lines.push(`Scene 3 (12–17 s): three chips slide in with the top rows of "${a.table.title}": ${a.table.rows.slice(0, 3).map(r => a.table.columns.slice(0, 2).map(c => r[c[0]]).join(' · ')).join('; ')}.`);
  lines.push(`Final scene (last 3 s): the finding appears as a caption, one sentence: "${(a.headline || '').split('. ')[0]}." Then fade to the wordmark "Astra Insights for Kearney". Transitions are quick fades and counting numbers; nothing bouncy. Export as MP4.`);
  return lines.join('\n');
}
export async function animateAnswer(a) {
  const text = motionPrompt(a);
  let copied = false; try { await navigator.clipboard.writeText(text); copied = true; } catch (e) { copied = false; }
  const drawer = document.getElementById('drawer'); const body = document.getElementById('drawerBody');
  document.getElementById('drawerTitle').textContent = 'Animate this with Claude Motion';
  body.replaceChildren(h('p', { class: 'small' }, copied ? 'The prompt is on your clipboard. In Claude, paste it into the message box (it starts with /motion) and Claude Motion builds the animation; download it as MP4 or open it in your video tool.' : 'Copy the prompt below, then paste it into Claude’s message box (it starts with /motion).'), h('textarea', { readonly: true, style: { width: '100%', height: '320px', background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: '9px', padding: '10px', fontSize: '12px', fontFamily: 'var(--mono)' } }, text), h('div', { class: 'card-foot' }, h('button', { class: 'btn small', onClick: async () => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch (e) { toast('Select the text and copy it'); } } }, 'Copy again'), h('span', { class: 'muted small' }, 'Motion is a beta on Team and Enterprise plans; an admin enables it under Organization settings → Artifacts.')));
  drawer.classList.add('open'); toast(copied ? 'Motion prompt copied' : 'Motion prompt ready');
}
// Count a numeral up from zero to its value over about a second (used for headline tiles).
export function countUp(el, value, format, ms = 1000) {
  if (value === null || value === undefined || isNaN(value)) return el;
  const t0 = performance.now(); const ease = x => 1 - Math.pow(1 - x, 3);
  const tick = () => { const p = Math.min(1, (performance.now() - t0) / ms); el.textContent = fmtValue(value * ease(p), format); if (p < 1) setTimeout(tick, 24); else el.textContent = fmtValue(value, format); };
  setTimeout(tick, 60); return el;
}
export function toast(msg, ms = 2600) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }
export function ask(question, context = null) { document.dispatchEvent(new CustomEvent('astra:ask', { detail: { question, context } })); }
export function navigate(screen, params = {}) { document.dispatchEvent(new CustomEvent('astra:navigate', { detail: { screen, params } })); }
export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export const F = fmtValue; export const FMT = fmt;

export function seededBadge(seeded = true, label) {
  // Provenance badges are shown only when switched on in Settings; the calculation drawer always names the source.
  if (!(state.meta && state.meta.provenance)) return null;
  if (label) return h('span', { class: 'badge real' }, '● ' + label);
  return seeded ? h('span', { class: 'badge seeded', title: 'Generated by a connector stub from the seed manifest' }, '● Connector stub') : h('span', { class: 'badge real' }, '● Sourced');
}
export function lineageButton(lineage, extra) { return h('button', { class: 'btn ghost small', onClick: () => openLineage(lineage, extra) }, 'How was this calculated?'); }

export function openLineage(l, extra = {}) {
  const drawer = document.getElementById('drawer'); const body = document.getElementById('drawerBody');
  document.getElementById('drawerTitle').textContent = 'How was this calculated?';
  if (!l) { body.innerHTML = '<p class="muted">No lineage is attached to this item.</p>'; drawer.classList.add('open'); return; }
  const dl = h('dl', {},
    h('dt', {}, 'Metric'), h('dd', {}, h('b', {}, l.name || l.metric || '')),
    h('dt', {}, 'Formula'), h('dd', {}, l.formula || '–'),
    h('dt', {}, 'Owner'), h('dd', {}, l.owner || '–'),
    h('dt', {}, 'Source system'), h('dd', {}, l.source_system || '–'),
    
    h('dt', {}, 'Tables'), h('dd', { class: 'mono small' }, (l.tables || []).join(', ') || '–'),
    h('dt', {}, 'Filters'), h('dd', { class: 'mono small' }, l.filters && Object.keys(l.filters).length ? Object.entries(l.filters).filter(([k, v]) => v).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`).join(', ') : 'none'),
    h('dt', {}, 'Period'), h('dd', {}, l.period ? (l.period.label || `${l.period.from} to ${l.period.to}`) : '–'),
    h('dt', {}, 'Rows read'), h('dd', {}, l.row_count != null ? String(l.row_count) : '–'),
    h('dt', {}, 'Refreshed'), h('dd', {}, l.refreshed_at ? new Date(l.refreshed_at).toUTCString().replace(':00 GMT', ' UTC') : 'today 05:30 UTC'),
    h('dt', {}, 'Query time'), h('dd', {}, l.query_ms != null ? l.query_ms + ' ms' : '–')
  );
  const path = h('div', { class: 'lineage-path' }, ...(l.path || ['Source system', 'Data platform', 'Lakehouse table', 'Semantic model', 'Calculation', 'Visual']).flatMap((n, i, a) => [h('div', { class: 'node' }, `${i + 1}. ${String(n).replace(/Connector stub \(demo\) \/ ADF to OneLake \(live\)/, 'Data platform').replace(/Query Agent/, 'Calculation').replace(/Variance Agent/, 'Analysis').replace(/[A-Z][a-z ]+ Agent/, 'Analysis')}`), i < a.length - 1 ? h('div', { class: 'link' }) : null]));
  const model = l.model || (extra && extra.model && extra.model.name);
  const modelBlock = model ? h('div', {}, h('h3', {}, 'Prediction'), h('dl', {}, h('dt', {}, 'Model'), h('dd', {}, typeof model === 'string' ? model : model.name), extra && extra.model && extra.model.version ? [h('dt', {}, 'Version'), h('dd', {}, extra.model.version)] : null, extra && extra.model && extra.model.backtest ? [h('dt', {}, 'Backtest'), h('dd', {}, `MAPE ${(extra.model.backtest.mape * 100).toFixed(1)}% over ${extra.model.backtest.n} months`)] : null, l.backtest ? [h('dt', {}, 'Backtest'), h('dd', {}, `MAPE ${(l.backtest.mape * 100).toFixed(1)}%, band coverage from residuals`)] : null, l.drivers ? [h('dt', {}, 'Top drivers'), h('dd', {}, l.drivers.join('; '))] : null, l.restricted ? [h('dt', {}, 'Access'), h('dd', { class: 'warn' }, l.restricted)] : null)) : null;
  body.replaceChildren(dl, h('h3', {}, 'Lineage'), path, modelBlock || '', l.note ? h('p', { class: 'muted small' }, l.note) : '', h('p', { class: 'muted small' }, 'The path runs from the source system through the data platform into the semantic model that holds every metric definition.'));
  drawer.classList.add('open');
}

export function renderTable(t, opts = {}) {
  if (!t) return null;
  const cols = t.columns;
  const thead = h('tr', {}, ...cols.map(c => h('th', { class: c[2] ? 'num' : '' }, c[1])));
  const limit = opts.limit || 60, total = (t.rows || []).length;
  const rows = (t.rows || []).slice(0, limit).map(r => h('tr', { onClick: opts.onRow ? () => opts.onRow(r) : null, style: opts.onRow ? { cursor: 'pointer' } : null }, ...cols.map(c => cell(r[c[0]], c[2], c[0], r))));
  const wrap = h('div', { class: 'card' }, t.title ? h('h3', {}, t.title) : null, t.subtitle ? h('div', { class: 'sub' }, t.subtitle) : null, h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, thead), h('tbody', {}, ...rows))), h('div', { class: 'card-foot' }, seededBadge(t.seeded !== false), t.lineage ? lineageButton(t.lineage) : null, total > limit ? h('span', { class: 'muted small' }, `Showing ${limit} of ${total} rows; the slide and board carry the full table`) : null));
  return wrap;
}
function cell(v, format, key, row) {
  if (v === null || v === undefined) return h('td', { class: format ? 'num' : '' }, '–');
  if (Array.isArray(v)) return h('td', {}, v.join(', '));
  if (typeof v === 'boolean') return h('td', {}, v ? 'Yes' : '');
  if (format === 'pts') return h('td', { class: 'num ' + (v < 0 ? 'bad' : 'good') }, FMT.pts(v));
  if (format) { const cls = (key === 'gap' || key === 'change' || key === 'contribution') ? (v < 0 ? 'bad' : 'good') : ''; return h('td', { class: 'num ' + cls }, fmtValue(v, format)); }
  if (typeof v === 'number') return h('td', { class: 'num' }, Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2));
  if (/^\d{4}-\d{2}-\d{2}/.test(String(v))) return h('td', {}, String(v).slice(0, 10));
  return h('td', {}, String(v));
}

export function renderVisual(spec, { onPoint, compact = false, titleOverride } = {}) {
  if (!spec) return null;
  if (spec.type === 'table') return renderTable(spec);
  if (spec.type === 'scenario') return scenarioTable(spec);
  if (spec.type === 'kpi') {
    const good = spec.delta == null ? null : spec.delta >= 0;
    return h('div', { class: 'card' }, h('h3', {}, titleOverride || spec.title || ''), spec.subtitle ? h('div', { class: 'sub' }, spec.subtitle) : null,
      countUp(h('div', { class: 'value', style: { fontSize: '40px', fontWeight: 600, letterSpacing: '-.02em', margin: '6px 0 2px' } }, spec.value == null ? '–' : fmtValue(spec.value, spec.format)), spec.value, spec.format),
      spec.delta != null ? h('div', { class: 'small ' + (good ? 'good' : 'bad') }, (spec.format === 'pct' ? FMT.pts(spec.delta) : (spec.delta >= 0 ? '+' : '') + fmtValue(spec.delta, spec.format)) + (spec.deltaLabel ? ' ' + spec.deltaLabel : '')) : null,
      h('div', { class: 'card-foot' }, spec.badge ? seededBadge(false, spec.badge) : seededBadge(spec.seeded !== false), spec.lineage ? lineageButton(spec.lineage) : null));
  }
  const card = h('div', { class: 'card' + (compact ? ' flat' : '') });
  card.appendChild(h('h3', {}, titleOverride || spec.title || ''));
  if (spec.subtitle) card.appendChild(h('div', { class: 'sub' }, spec.subtitle));
  const el = h('div', { class: 'chart' + (spec.type === 'map' || spec.type === 'heatmap' || spec.type === 'network' ? ' tall' : compact ? ' short' : '') });
  card.appendChild(el);
  const foot = h('div', { class: 'card-foot' }, spec.badge ? seededBadge(false, spec.badge) : seededBadge(spec.seeded !== false), spec.lineage ? lineageButton(spec.lineage) : null, spec.type !== 'kpi' ? h('span', { class: 'hint muted small' }, 'Select a point to ask “Why this?” or drill in') : null);
  card.appendChild(foot);
  setTimeout(() =>renderChart(el, spec, { onPoint: onPoint || defaultPointAndAsk(spec, card) }));
  return card;
}
function defaultPointAndAsk(spec, card) {
  return p => {
    document.querySelectorAll('.pop').forEach(x => x.remove());
    const ev = p.event; const rect = card.getBoundingClientRect();
    const x = ev ? ev.offsetX : 40, y = ev ? ev.offsetY : 40;
    const ctx = { cut: p.dim && p.key ? { [p.dim]: p.key } : {}, metric: spec.lineage && spec.lineage.metric && !/^(scenario|account_360|agent_runs|ticket_volumes|staffing_match|flight_risk|engagement_overrun|win_probability|late_payment|cross_border|knowledge|app_adoption)$/.test(spec.lineage.metric) ? spec.lineage.metric : null, label: p.label };
    state.context = ctx;
    const pop = h('div', { class: 'pop', style: { left: Math.min(x + 60, rect.width - 260) + 'px', top: (y + 20) + 'px' } },
      h('span', { class: 'small muted', style: { padding: '4px 6px' } }, p.label || p.key || ''),
      h('button', { class: 'btn small', onClick: () => { pop.remove(); ask('Why?', ctx); } }, 'Why this?'),
      h('button', { class: 'btn small', onClick: () => { pop.remove(); ask(`Drill into ${p.label || p.key}`, ctx); } }, 'Drill in'),
      h('button', { class: 'btn ghost small', onClick: () => pop.remove() }, '✕'));
    card.appendChild(pop);
    setTimeout(() => document.addEventListener('click', e => { if (!pop.contains(e.target)) pop.remove(); }, { once: true }), 50);
  };
}
function scenarioTable(spec) {
  const multi = spec.scenarios && spec.scenarios.length;
  const head = multi ? ['Metric', 'Baseline', ...spec.scenarios] : ['Metric', 'Baseline', 'Scenario', 'Change'];
  const rows = spec.rows.map(r => multi ? h('tr', {}, h('td', {}, r.metric), h('td', { class: 'num' }, fmtValue(r.baseline, r.format)), ...spec.scenarios.map(s => h('td', { class: 'num ' + ((r[s] - r.baseline) >= 0 ? 'good' : 'bad') }, fmtValue(r[s], r.format)))) : h('tr', {}, h('td', {}, r.metric), h('td', { class: 'num' }, fmtValue(r.baseline, r.format)), h('td', { class: 'num' }, fmtValue(r.scenario, r.format)), h('td', { class: 'num delta ' + (r.change >= 0 ? 'good' : 'bad') }, r.format === 'pct' ? FMT.pts(r.change) : (r.change >= 0 ? '+' : '') + fmtValue(r.change, r.format))));
  return h('div', { class: 'card' }, h('h3', {}, spec.title), spec.subtitle ? h('div', { class: 'sub' }, spec.subtitle) : null, h('table', { class: 'data scenario-table' }, h('thead', {}, h('tr', {}, ...head.map((x, i) => h('th', { class: i ? 'num' : '' }, x)))), h('tbody', {}, ...rows)), h('div', { class: 'card-foot' }, seededBadge(true), spec.lineage ? lineageButton(spec.lineage) : null));
}
export function kpiTile(tile, onClick) {
  const good = tile.delta == null ? null : (tile.delta >= 0) === tile.higherIsBetter;
  const statusColor = good === null ? 'var(--faint)' : good ? 'var(--good)' : 'var(--bad)';
  const deltaText = tile.delta == null ? (tile.compare ? '' : '') : (tile.deltaKind === 'pts' ? FMT.pts(tile.delta) : (tile.delta >= 0 ? '+' : '') + (tile.delta * 100).toFixed(1) + '%') + (tile.compare ? ' vs ' + tile.compare.label : '');
  const el = h('div', { class: 'tile', onClick, title: 'Open on the canvas' },
    h('div', { class: 'name' }, h('span', {}, h('span', { class: 'status', style: { background: statusColor } }), tile.name), seededBadge(true)),
    countUp(h('div', { class: 'value' }, tile.value == null ? '–' : fmtValue(tile.value, tile.format)), tile.value, tile.format),
    h('div', { class: 'delta ' + (good === null ? 'muted' : good ? 'good' : 'bad') }, deltaText || tile.period || ''),
    h('div', { class: 'spark' }));
  if (tile.spark && tile.spark.length > 2) setTimeout(() =>renderChart(el.querySelector('.spark'), { type: 'spark', data: tile.spark, color: good === false ? 'bad' : 'accent' }));
  return el;
}
export function answerCard(a, { compact = false } = {}) {
  const card = h('div', { class: 'answer' + (a.blocked ? ' blocked' : '') });
  card.appendChild(h('div', { class: 'q' }, h('span', { class: 'avatar', style: { width: '22px', height: '22px', fontSize: '10px' } }, (state.persona && state.persona.short || 'MP').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()), h('span', {}, a.question), a.blocked ? h('span', { class: 'badge block' }, 'Not permitted for this role') : a.guardian && a.guardian.result === 'redact' ? h('span', { class: 'badge seeded' }, 'Redacted to aggregates') : null));
  card.appendChild(h('div', { class: 'headline', html: emphasise(a.headline) }));
  if (a.audio) card.appendChild(h('div', { class: 'card', style: { marginTop: '10px' } }, h('h3', {}, 'Audio brief (about 60 seconds)'), h('div', { class: 'muted small' }, a.audio), h('div', { class: 'card-foot' }, h('button', { class: 'btn small', onClick: () => document.dispatchEvent(new CustomEvent('astra:speak', { detail: a.audio })) }, '▶ Play'), a.extra && a.extra.attachedTo ? h('span', { class: 'badge accent' }, 'Attached to: ' + a.extra.attachedTo + ' (Outlook stub)') : null)));
  if (a.assumptions && a.assumptions.length) card.appendChild(h('div', { class: 'card', style: { marginTop: '10px' } }, h('h3', {}, 'Assumptions'), h('ul', { class: 'small muted', style: { margin: '4px 0 0 16px' } }, ...a.assumptions.map(x => h('li', {}, x)))));
  const vis = h('div', { class: 'visual-wrap grid' + (a.visual && a.visual2 ? ' cols-2' : '') });
  if (a.visual) vis.appendChild(renderVisual(a.visual, { compact }));
  if (a.visual2) vis.appendChild(renderVisual(a.visual2, { compact }));
  if (a.table) vis.appendChild(Object.assign(renderTable(a.table, { limit: 15 }), { className: 'card' + (a.visual && a.visual2 ? ' span-2' : '') }));
  if (vis.children.length) {
    // One lineage button per answer (in the footer) and one chart hint; the embedded cards keep their badges only.
    [...vis.querySelectorAll('.card-foot')].forEach((f, i) => { f.querySelectorAll('button').forEach(b => b.remove()); if (i > 0) f.querySelectorAll('.hint').forEach(x => x.remove()); if (!f.children.length) f.remove(); });
    card.appendChild(vis);
  }
  const lineage = a.lineage || (a.visual && a.visual.lineage) || (a.table && a.table.lineage) || null;
  if (a.followUps && a.followUps.length) card.appendChild(h('div', { class: 'chips' }, ...a.followUps.map(q => h('button', { class: 'chip', onClick: () => ask(q) }, q))));
  card.appendChild(h('div', { class: 'answer-foot' }, a.seeded === false ? seededBadge(false) : seededBadge(true),  h('span', { class: 'spacer' }), lineage ? lineageButton(lineage, { model: a.model }) : null, h('button', { class: 'btn ghost small', title: 'Pin this answer to your board', onClick: () => ask('Pin this to my board') }, 'Pin'), h('button', { class: 'btn ghost small', title: 'Download this answer as a PowerPoint slide', onClick: () => exportSlide(a, card) }, 'Slide'), h('button', { class: 'btn ghost small', title: 'Build a Claude Motion prompt from this answer', onClick: () => animateAnswer(a) }, 'Animate'), h('button', { class: 'btn ghost small', title: 'Read this answer aloud', onClick: () => document.dispatchEvent(new CustomEvent('astra:speak', { detail: a.spoken })) }, '▶ Listen'), h('button', { class: 'btn ghost small', title: 'Rate this answer', onClick: () => { api('feedback', { body: { value: 1 } }).catch(() => {}); toast('Thanks. Your rating is recorded.'); } }, '👍'), h('button', { class: 'btn ghost small', onClick: () => { api('feedback', { body: { value: -1 } }).catch(() => {}); toast('Thanks. Your rating is recorded.'); } }, '👎')));
  return card;
}
function shortAction(s) { return s.length > 46 ? s.slice(0, 44) + '…' : s; }
function emphasise(text) { return esc(text || '').replace(/([−-]?US\$[\d.,]+ (billion|million|thousand)|[+−-]?\d+(\.\d+)? points|\b\d+(\.\d+)?%|\b[EP]-\d{4,5}\b|\bINV-\d+|\bOPP-[\w]+)/g, '<strong>$1</strong>'); }
export function screenHead(title, sub, right) { return h('div', { class: 'screen-head' }, h('div', {}, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null), right || null); }
export function promptChips(qs) { return h('div', { class: 'chips' }, ...qs.map(q => h('button', { class: 'chip', onClick: () => ask(q) }, '✦ ' + q))); }
