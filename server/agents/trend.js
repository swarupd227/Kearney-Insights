'use strict';
/**
 * Trend and Anomaly Agent (model 11): seasonal decomposition with robust thresholds.
 * Separates seasonality from real change and raises an alert when a metric leaves its expected range.
 */
const engine = require('../metrics/engine');
const ref = require('../metrics/refcache');
const { fmt, monthLabel, pts } = require('./util');

function decompose(series) {
  // series: [{month, value}] monthly. Expected = trailing-12 level × month-of-year seasonal index. Residual z via MAD.
  const vals = series.map(s => s.value); const n = vals.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const win = vals.slice(Math.max(0, i - 12), i); if (win.length < 6) { out.push({ ...series[i], expected: null, lower: null, upper: null, z: null }); continue; }
    const level = win.reduce((a, b) => a + b, 0) / win.length;
    const sameMonth = series.slice(0, i).filter(s => s.month.slice(5, 7) === series[i].month.slice(5, 7)).map(s => s.value);
    const seasonal = sameMonth.length ? (sameMonth.reduce((a, b) => a + b, 0) / sameMonth.length) / (series.slice(0, i).reduce((a, s) => a + s.value, 0) / i) : 1;
    const expected = level * seasonal;
    const resid = win.map((v, k) => v - (level)); const med = median(resid); const mad = median(resid.map(r => Math.abs(r - med))) * 1.4826 || Math.abs(level) * 0.03;
    const z = (vals[i] - expected) / mad;
    out.push({ ...series[i], expected, lower: expected - 2.5 * mad, upper: expected + 2.5 * mad, z });
  }
  return out;
}
function median(a) { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

async function scan(metricId, cut = {}, { months = 24 } = {}) {
  const to = engine.LAST_CLOSED; const from = engine.addMonths(to, -months + 1);
  const r = await engine.compute(metricId, { cut, period: { from, to, label: '' }, groupBy: 'month' });
  const series = r.rows.filter(x => x.value !== null).map(x => ({ month: x.key, value: x.value }));
  const dec = decompose(series);
  const alerts = dec.filter(d => d.z !== null && Math.abs(d.z) > 2.5).map(d => ({ metric: metricId, name: r.metric.name, month: d.month, value: d.value, expected: d.expected, z: d.z, direction: d.z > 0 ? 'above' : 'below', severity: Math.abs(d.z) > 4 ? 'high' : 'medium', good: (d.z > 0) === r.metric.higherIsBetter, cut, text: `${r.metric.name}${scopeText(cut)} was ${fmt(d.value, r.metric.format)} in ${monthLabel(d.month)}, ${d.z > 0 ? 'above' : 'below'} its expected range (expected ${fmt(d.expected, r.metric.format)}).` }));
  const last = dec[dec.length - 1];
  return { metric: r.metric, series: dec, alerts, latest: last, visual: { type: 'line', title: `${r.metric.name}${scopeText(cut)} with expected band`, subtitle: `Last ${months} months`, x: dec.map(d => monthLabel(d.month)), series: [{ name: r.metric.name, data: dec.map(d => d.value) }], band: { lower: dec.map(d => d.lower), upper: dec.map(d => d.upper), expected: dec.map(d => d.expected) }, format: r.metric.format, seeded: true, lineage: { ...r.lineage, model: 'Metric anomaly detection v1.0-seed (seasonal decomposition, MAD thresholds)' } } };
}
async function feed(persona, { limit = 6 } = {}) {
  // Scan the persona's headline metrics and a few firm-wide watch metrics; return ranked alerts for the insight feed.
  const watch = [...persona.headline.map(h => ({ metric: h.metric, cut: h.cut })), { metric: 'billing_realisation', cut: persona.scope.region ? { region: persona.scope.region } : {} }, { metric: 'write_off_rate', cut: persona.scope.region ? { region: persona.scope.region } : {} }];
  const seen = new Set(); const alerts = [];
  for (const w of watch) {
    const key = w.metric + JSON.stringify(w.cut); if (seen.has(key)) continue; seen.add(key);
    if (['pipeline_value', 'weighted_pipeline', 'leverage', 'staffing_fill_rate', 'relationship_breadth', 'lockup_days', 'dso', 'client_satisfaction', 'cross_practice_penetration', 'promotion_velocity', 'regretted_attrition', 'engagement_score', 'sustained_hours', 'budget_burn', 'eac', 'recruiting_conversion', 'time_to_staff', 'learning_hours', 'knowledge_search_success', 'overhead_ratio', 'bench_rate', 'ip_reuse_rate', 'win_rate', 'account_growth'].includes(w.metric)) continue;
    try { const s = await scan(w.metric, w.cut, { months: 20 }); alerts.push(...s.alerts.filter(a => a.month >= engine.addMonths(engine.LAST_CLOSED, -3))); } catch (e) { /* skip */ }
  }
  alerts.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  return alerts.slice(0, limit);
}
function scopeText(cut) { const parts = []; for (const d of ['region', 'unit', 'practice', 'client', 'level']) if (cut[d]) parts.push(ref.labelOf(d, cut[d])); return parts.length ? ' in ' + parts.join(', ') : ''; }
module.exports = { scan, feed, decompose };
