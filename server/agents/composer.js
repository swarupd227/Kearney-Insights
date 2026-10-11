'use strict';
/**
 * Dashboard Composer Agent: fixed visual grammar.
 * trend -> line with expected band; comparison -> ranked bar; change -> waterfall; parts of a whole -> stacked bar; geography -> map.
 * Output is a visual spec rendered by the client (public/js/charts.js). No numbers are computed here.
 */
const ref = require('../metrics/refcache');
const { monthLabel } = require('./util');

function fromMetric(result, opts = {}) {
  const m = result.metric; const g = result.groupBy; const rows = result.rows;
  const seeded = true;
  const title = opts.title || `${m.name}${scopeLabel(result.cut)}${g && g !== 'all' ? ' by ' + g.replace('_', ' ') : ''}`;
  const subtitle = opts.subtitle || (result.period ? result.period.label : '');
  if (result.bands) {
    return { type: 'bar', title, subtitle, x: rows.map(r => r.key), series: [{ name: m.name, data: rows.map(r => r.value) }], format: m.format, seeded, lineage: result.lineage };
  }
  if ((g === 'month' || g === 'quarter' || g === 'year') && rows.length && !/^\d{4}-\d{2}-\d{2}$/.test(String(rows[0].key))) {
    return { type: 'kpi', title: m.name + scopeLabel(result.cut), subtitle: (result.period ? result.period.label : '') + ' · no time series is available for this metric', value: result.total.value, format: m.format, seeded, lineage: result.lineage };
  }
  if (g === 'month' || g === 'quarter' || g === 'year') {
    const x = rows.map(r => g === 'month' ? monthLabel(r.key) : g === 'quarter' ? qLabel(r.key) : r.key.slice(0, 4));
    const series = [{ name: m.name, data: rows.map(r => r.value) }];
    if (opts.plan) series.push({ name: 'Plan', data: opts.plan, kind: 'plan' });
    if (opts.compareSeries) series.push(opts.compareSeries);
    return { type: 'line', title, subtitle, x, series, format: m.format, seeded, lineage: result.lineage, band: opts.band || null, target: opts.target || null };
  }
  if (g === 'fee_model' || m.id === 'fee_model_mix' || m.id === 'client_concentration') {
    return { type: 'stacked', title, subtitle, x: [m.name], series: rows.map(r => ({ name: r.label, data: [r.value] })), format: m.format, seeded, lineage: result.lineage };
  }
  if (g === 'region' && opts.map) {
    return { type: 'map', title, subtitle, points: rows, format: m.format, seeded, lineage: result.lineage };
  }
  if (g && g !== 'all') {
    const sorted = [...rows].filter(r => r.value !== null).sort((a, b) => (m.higherIsBetter ? b.value - a.value : a.value - b.value));
    const series = [{ name: m.name, data: sorted.map(r => r.value) }];
    if (opts.compareMap) series.push({ name: opts.compareName || 'Comparison', data: sorted.map(r => opts.compareMap[r.key] ?? null), kind: 'compare' });
    return { type: 'bar', title, subtitle, x: sorted.map(r => r.label), keys: sorted.map(r => r.key), dim: g, series, format: m.format, seeded, lineage: result.lineage, target: opts.target || null, horizontal: sorted.length > 6 };
  }
  return { type: 'kpi', title, subtitle, value: result.total.value, format: m.format, seeded, lineage: result.lineage, delta: opts.delta || null, deltaLabel: opts.deltaLabel || null };
}
function waterfall(title, subtitle, steps, format, lineage) {
  // steps: [{label, value, kind: 'start'|'delta'|'end'}]
  return { type: 'waterfall', title, subtitle, steps, format, seeded: true, lineage };
}
function heatmap(title, subtitle, xLabels, yLabels, cells, format, lineage, opts = {}) {
  return { type: 'heatmap', title, subtitle, x: xLabels, y: yLabels, cells, format, seeded: true, lineage, ...opts };
}
function table(title, subtitle, columns, rows, lineage, opts = {}) { return { type: 'table', title, subtitle, columns, rows, seeded: opts.seeded !== false, lineage, ...opts }; }
function forecastChart(title, subtitle, history, forecast, plan, format, lineage) {
  const x = [...history.map(h => monthLabel(h.month)), ...forecast.map(f => monthLabel(f.month))];
  return { type: 'forecast', title, subtitle, x, actual: [...history.map(h => h.value), ...forecast.map(() => null)], p50: [...history.map(() => null), ...forecast.map(f => f.p50)], p10: [...history.map(() => null), ...forecast.map(f => f.p10)], p90: [...history.map(() => null), ...forecast.map(f => f.p90)], plan: plan || null, format, seeded: true, lineage, splitIndex: history.length };
}
// Sentence form of the scope: " in Europe", " in DACH, Principal". Chart titles keep the comma form from scopeLabel.
function scopeIn(cut) { const l = scopeLabel(cut); return l ? ' in' + l.slice(1) : ''; }
function scopeLabel(cut) {
  if (!cut) return '';
  const parts = [];
  for (const d of ['region', 'unit', 'office', 'practice', 'industry', 'level', 'client']) { if (d === 'region' && (cut.unit || cut.office)) continue; if (cut[d] && typeof cut[d] === 'string') parts.push(ref.labelOf(d, cut[d])); }
  if (cut.engagement) parts.push(Array.isArray(cut.engagement) ? cut.engagement.join(', ') : cut.engagement);
  return parts.length ? ', ' + parts.join(', ') : '';
}
function qLabel(s) { const d = new Date(s + 'T00:00:00Z'); return 'Q' + (Math.floor(d.getUTCMonth() / 3) + 1) + ' ' + d.getUTCFullYear(); }
module.exports = { scopeIn, fromMetric, waterfall, heatmap, table, forecastChart, scopeLabel };
