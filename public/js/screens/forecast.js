// Screen 12: forecast and scenario studio. Baseline forecast on the left, up to three scenarios on the right, driver controls.
import { state, api, h, ask, renderVisual, renderTable, screenHead, seededBadge, F, toast } from '../ui.js';
export async function render(root, params) {
  const q = new URLSearchParams(); const region = params.region || state.persona.scope.region; if (region) q.set('region', region); if (params.unit) q.set('unit', params.unit);
  const d = await api('screens/forecast?' + q.toString());
  const cut = region ? { region } : {}; if (params.unit) cut.unit = params.unit;
  const sel = h('select', { class: 'btn small', onChange: e => { location.hash = '#/forecast/' + (e.target.value ? 'region=' + e.target.value : 'region='); } }, h('option', { value: '' }, 'Whole firm'), ...state.ref.regions.map(x => h('option', { value: x.id, selected: x.id === region }, x.name)));
  const fc = renderVisual(d.forecast.visual);
  const fy = d.forecast.fullYear;
  const summary = h('div', { class: 'card' }, h('h3', {}, 'Baseline forecast'), h('div', { class: 'sub' }, 'Revenue forecast v1.0-seed · bottom-up reconciled with top-down'), h('div', { class: 'value', style: { fontSize: '30px', fontWeight: 600 } }, F(fy.p50, 'money')), h('div', { class: 'muted small' }, `P10 ${F(fy.p10, 'money')} · P90 ${F(fy.p90, 'money')}${fy.plan ? ` · plan ${F(fy.plan, 'money')} · P(reach plan) ${F(fy.prob_reach_plan, 'pct')}` : ''}`), h('div', { class: 'small', style: { marginTop: '8px' } }, d.forecast.narrative), h('div', { class: 'card-foot' }, seededBadge(true), h('span', { class: 'muted small' }, `Backtest MAPE ${(d.forecast.model.backtest.mape * 100).toFixed(1)}% over ${d.forecast.model.backtest.n} months`)));
  const units = renderTable(d.units.table, { onRow: r => ask(`Why is ${r.label} behind plan?`) });
  // scenario controls
  const ctl = { rate_pct: 0, util_points: 0, realisation_points: 0, fx_pct: 0, freeze: false, freeze_level: 'ASSOCIATE', freeze_q: 2, fixed_fee_shift_pct: 0 };
  const out = h('div', {});
  const slider = (label, key, min, max, step, unit) => { const v = h('span', { class: 'mono small' }, ctl[key] + unit); const inp = h('input', { type: 'range', min, max, step, value: ctl[key], style: { width: '100%', accentColor: 'var(--accent)' }, onInput: e => { ctl[key] = parseFloat(e.target.value); v.textContent = (ctl[key] > 0 ? '+' : '') + ctl[key] + unit; } }); return h('div', { style: { marginBottom: '10px' } }, h('div', { style: { display: 'flex', justifyContent: 'space-between' } }, h('span', { class: 'small' }, label), v), inp); };
  const run = async () => {
    const scenarios = []; const s = {}; if (ctl.rate_pct) s.rate_pct = ctl.rate_pct; if (ctl.util_points) s.util_points = ctl.util_points; if (ctl.realisation_points) s.realisation_points = ctl.realisation_points; if (ctl.fx_pct) s.fx_pct = ctl.fx_pct; if (ctl.fixed_fee_shift_pct) s.fixed_fee_shift_pct = ctl.fixed_fee_shift_pct; if (ctl.freeze) s.hiring_freeze = { level: ctl.freeze_level, quarters: ctl.freeze_q };
    if (!Object.keys(s).length) { toast('Move a driver first'); return; }
    scenarios.push({ label: 'Scenario ' + (out.children.length + 1), scenario: s });
    const r = await api('screens/scenario', { body: { cut, scenarios } });
    out.prepend(h('div', { style: { marginBottom: '12px' } }, renderVisual(r.visual), h('div', { class: 'muted small', style: { margin: '6px 4px' } }, 'Assumptions: ' + (r.assumptions || []).join('; '))));
    if (out.children.length > 3) out.lastChild.remove();
  };
  const studio = h('div', { class: 'card' }, h('h3', {}, 'Scenario controls'), h('div', { class: 'sub' }, 'Change drivers by slider or by voice, for example “Freeze Associate hiring in Europe for two quarters”'),
    slider('Billing rates', 'rate_pct', -5, 8, 0.5, '%'), slider('Utilisation target', 'util_points', -6, 6, 0.5, ' pts'), slider('Billing realisation', 'realisation_points', -5, 8, 0.5, ' pts'), slider('FX move on non-USD revenue', 'fx_pct', -8, 8, 1, '%'), slider('Shift of fees to fixed fee', 'fixed_fee_shift_pct', 0, 30, 5, '%'),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' } }, h('label', { class: 'small' }, h('input', { type: 'checkbox', onChange: e => ctl.freeze = e.target.checked, style: { accentColor: 'var(--accent)' } }), ' Hiring freeze'), h('select', { class: 'btn small', onChange: e => ctl.freeze_level = e.target.value }, ...['BA', 'ASSOCIATE', 'MANAGER', 'PRINCIPAL'].map(l => h('option', { value: l, selected: l === 'ASSOCIATE' }, (state.ref.levels.find(x => x.id === l) || {}).name))), h('select', { class: 'btn small', onChange: e => ctl.freeze_q = parseInt(e.target.value, 10) }, ...[1, 2, 3, 4].map(n => h('option', { value: n, selected: n === 2 }, n + ' quarter' + (n > 1 ? 's' : ''))))),
    h('div', { class: 'card-foot' }, h('button', { class: 'btn primary small', onClick: run }, 'Run scenario'), h('button', { class: 'btn ghost small', onClick: () => ask('Compare a 2% rate increase with a 5-point improvement in realisation') }, 'Compare by voice'), seededBadge(true)));
  root.replaceChildren(screenHead('Forecast and scenario studio', 'CFO, FP&A, Regional MD · Forecast Agent and Scenario Agent', sel), h('div', { class: 'grid cols-3' }, Object.assign(fc, { className: 'card span-2' }), summary), h('div', { class: 'grid cols-2', style: { marginTop: '16px' } }, h('div', {}, studio, h('div', { style: { marginTop: '12px' } }, out)), units));
}
