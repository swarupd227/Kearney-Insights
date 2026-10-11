// Chart renderer: interprets the Dashboard Composer Agent's visual grammar with ECharts. Point-and-ask: clicks emit {dim, key, label}.
/* global echarts */
const THEMES = {
  dark: { accent: '#8f7bff', accent2: '#b8acff', good: '#3ddc97', bad: '#ff6b7a', warn: '#ffb454', info: '#5bc0eb', muted: '#8e95a8', faint: '#5d6477', border: '#303747', split: '#1f2532', text: '#e8eaf0', surface: '#12151c', tooltip: '#1d2230', area: '#171b26', areaBorder: '#2a3040', areaHover: '#1f2433', heatLow: '#20243a', heatMid: '#2a2d3a', labelOnBar: '#0b0d12', palette: ['#8f7bff', '#5bc0eb', '#3ddc97', '#ffb454', '#ff6b7a', '#c3a6ff', '#7ed6df', '#f6e58d', '#e17055', '#a29bfe'] },
  light: { accent: '#6b55e6', accent2: '#4f3bc9', good: '#1f9d6a', bad: '#d93a4e', warn: '#c7791a', info: '#2b8fbd', muted: '#5a6172', faint: '#8b91a1', border: '#c9cdd8', split: '#e8eaf1', text: '#15181f', surface: '#ffffff', tooltip: '#ffffff', area: '#e8eaf1', areaBorder: '#c9cdd8', areaHover: '#dde0e8', heatLow: '#eceefb', heatMid: '#e8eaf1', labelOnBar: '#ffffff', palette: ['#6b55e6', '#2b8fbd', '#1f9d6a', '#c7791a', '#d93a4e', '#8d6ae0', '#2aa198', '#b58900', '#cb4b16', '#5b6fe6'] }
};
let T = { ...THEMES.dark };
export function setTheme(name) { Object.assign(T, THEMES[name] || THEMES.dark); }
export function theme() { return T; }
let worldLoaded = null;
export async function ensureWorld() { if (worldLoaded) return worldLoaded; worldLoaded = fetch('vendor/world.json').then(r => r.json()).then(g => { echarts.registerMap('world', g); return true; }).catch(() => false); return worldLoaded; }

export const fmt = {
  money: v => v === null || v === undefined || isNaN(v) ? '–' : (Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v.toFixed(0)).replace(/^(-?)/, '$1US$'),
  pct: (v, d = 1) => v === null || v === undefined || isNaN(v) ? '–' : (v * 100).toFixed(d) + '%',
  pts: v => v === null || v === undefined || isNaN(v) ? '–' : (v > 0 ? '+' : '') + (v * 100).toFixed(1) + ' pts',
  number: v => v === null || v === undefined || isNaN(v) ? '–' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }),
  number1: v => v === null || v === undefined || isNaN(v) ? '–' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 }),
  days: v => v === null || v === undefined || isNaN(v) ? '–' : Math.round(v) + ' d', months: v => v === null || v === undefined ? '–' : Math.round(v) + ' mo', hours: v => v === null || v === undefined ? '–' : Number(v).toFixed(1) + ' h', ratio: v => v === null || v === undefined ? '–' : Number(v).toFixed(1) + 'x', score: v => v === null || v === undefined ? '–' : Number(v).toFixed(1)
};
export function f(v, format) { return (fmt[format] || fmt.number)(v); }
function axisFmt(format) { return v => format === 'money' ? fmt.money(v) : format === 'pct' ? (v * 100).toFixed(0) + '%' : fmt.number(v); }
const base = () => ({ backgroundColor: 'transparent', textStyle: { color: T.text, fontFamily: 'inherit' }, animationDuration: 500, grid: { left: 8, right: 16, top: 30, bottom: 8, containLabel: true }, tooltip: { backgroundColor: T.tooltip, borderColor: T.border, textStyle: { color: T.text, fontSize: 12 } }, legend: { textStyle: { color: T.muted, fontSize: 11 }, top: 0, right: 0, icon: 'circle', itemWidth: 8, itemHeight: 8 } });
const axisStyleOf = () => ({ axisLine: { lineStyle: { color: T.border } }, axisTick: { show: false }, axisLabel: { color: T.muted, fontSize: 11 }, splitLine: { lineStyle: { color: T.split } } });

const instances = new WeakMap();
export function render(el, spec, { onPoint } = {}) {
  if (!el) return null;
  let chart = instances.get(el); if (chart) { chart.dispose(); }
  chart = echarts.init(el, null, { renderer: 'canvas' }); instances.set(el, chart);
  const opt = buildOption(spec);
  if (opt instanceof Promise) { opt.then(o => { chart.setOption(o); }); } else chart.setOption(opt);
  if (onPoint) chart.on('click', p => { const key = (spec.keys && spec.keys[p.dataIndex]) || (spec.points && spec.points[p.dataIndex] && (spec.points[p.dataIndex].unit || spec.points[p.dataIndex].id)) || p.name; onPoint({ dim: spec.dim || (spec.type === 'map' ? 'unit' : null), key, label: p.name, value: p.value, event: p.event && p.event.event }); });
  const ro = new ResizeObserver(() => chart.resize()); ro.observe(el);
  return chart;
}
// PNG of a rendered chart (for the slide export); null if the element has no chart.
export function chartImage(el, { background } = {}) {
  const chart = el && instances.get(el); if (!chart) return null;
  try { return chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: background || T.surface, excludeComponents: ['toolbox'] }); } catch (e) { return null; }
}
export function buildOption(spec) {
  switch (spec.type) {
    case 'line': return lineOpt(spec);
    case 'bar': return barOpt(spec);
    case 'stacked': return stackedShare(spec);
    case 'stackedbar': return stackedBar(spec);
    case 'waterfall': return waterfall(spec);
    case 'forecast': return forecastOpt(spec);
    case 'burndown': return burndownOpt(spec);
    case 'heatmap': return heatmapOpt(spec);
    case 'map': return mapOpt(spec);
    case 'scatter': return scatterOpt(spec);
    case 'funnel': return funnelOpt(spec);
    case 'pyramid': return pyramidOpt(spec);
    case 'network': return networkOpt(spec);
    case 'spark': return sparkOpt(spec);
    default: return base();
  }
}
function lineOpt(s) {
  const o = base(); const series = [];
  if (s.band) { series.push({ name: 'Expected range', type: 'line', data: s.band.lower, lineStyle: { opacity: 0 }, stack: 'band', symbol: 'none', silent: true, areaStyle: { opacity: 0 } }, { name: 'Expected range', type: 'line', data: s.band.upper.map((u, i) => (u === null || s.band.lower[i] === null) ? null : u - s.band.lower[i]), lineStyle: { opacity: 0 }, stack: 'band', symbol: 'none', silent: true, areaStyle: { color: T.accent, opacity: .12 } }); }
  s.series.forEach((se, i) => series.push({ name: se.name, type: 'line', data: se.data, smooth: .25, symbol: 'circle', symbolSize: 5, lineStyle: { width: se.kind === 'plan' ? 1.5 : 2.5, type: se.kind === 'plan' ? 'dashed' : 'solid', color: se.kind === 'plan' ? T.warn : se.kind === 'compare' ? T.info : T.palette[i] }, itemStyle: { color: se.kind === 'plan' ? T.warn : se.kind === 'compare' ? T.info : T.palette[i] }, yAxisIndex: se.kind === 'secondary' ? 1 : 0 }));
  if (s.target) series.push({ name: 'Target', type: 'line', data: s.x.map(() => s.target), symbol: 'none', lineStyle: { type: 'dotted', color: T.good, width: 1.5 } });
  o.xAxis = { type: 'category', data: s.x, ...axisStyleOf(), boundaryGap: false }; o.yAxis = [{ type: 'value', ...axisStyleOf(), axisLabel: { ...axisStyleOf().axisLabel, formatter: axisFmt(s.format) }, scale: true }];
  if (s.series.some(se => se.kind === 'secondary')) o.yAxis.push({ type: 'value', ...axisStyleOf(), splitLine: { show: false }, axisLabel: { ...axisStyleOf().axisLabel, formatter: axisFmt(s.series.find(se => se.kind === 'secondary').format || 'number') } });
  o.series = series; o.tooltip.trigger = 'axis'; o.tooltip.valueFormatter = v => f(v, s.format); return o;
}
function barOpt(s) {
  const o = base(); const horizontal = s.horizontal; const main = s.series[0];
  const colors = main.data.map(v => s.target != null ? (v >= s.target ? T.accent : T.bad) : (v < 0 ? T.bad : T.accent));
  const series = [{ name: main.name, type: 'bar', data: main.data.map((v, i) => ({ value: v, itemStyle: { color: colors[i], borderRadius: 4 } })), barMaxWidth: 26, label: { show: s.x.length <= 12, position: horizontal ? 'right' : 'top', color: T.muted, fontSize: 10.5, formatter: p => f(p.value, s.format) } }];
  s.series.slice(1).forEach(se => series.push({ name: se.name, type: se.kind === 'secondary' ? 'line' : 'bar', data: se.data, barMaxWidth: 26, itemStyle: { color: se.kind === 'compare' ? 'rgba(255,180,84,.55)' : T.info, borderRadius: 4 }, symbol: 'circle', ...(se.kind === 'secondary' ? (horizontal ? { xAxisIndex: 1 } : { yAxisIndex: 1 }) : {}) }));
  if (s.target != null) series.push({ name: 'Target', type: horizontal ? 'bar' : 'line', data: horizontal ? [] : s.x.map(() => s.target), symbol: 'none', lineStyle: { type: 'dotted', color: T.good }, markLine: horizontal ? { silent: true, symbol: 'none', lineStyle: { type: 'dotted', color: T.good }, data: [{ xAxis: s.target }] } : undefined });
  const cat = { type: 'category', data: s.x, ...axisStyleOf(), axisLabel: { ...axisStyleOf().axisLabel, interval: 0, width: horizontal ? 150 : 90, overflow: 'truncate', rotate: horizontal ? 0 : (s.x.length > 6 ? 25 : 0) }, inverse: horizontal };
  const val = { type: 'value', ...axisStyleOf(), axisLabel: { ...axisStyleOf().axisLabel, formatter: axisFmt(s.format) } };
  const sec = s.series.find(se => se.kind === 'secondary');
  if (horizontal) { o.yAxis = cat; o.xAxis = [val]; if (sec) o.xAxis.push({ type: 'value', ...axisStyleOf(), splitLine: { show: false }, axisLabel: { ...axisStyleOf().axisLabel, formatter: axisFmt(sec.format || 'number') }, position: 'top' }); o.grid.top = 26; }
  else { o.xAxis = cat; o.yAxis = [val]; if (sec) o.yAxis.push({ type: 'value', ...axisStyleOf(), splitLine: { show: false }, axisLabel: { ...axisStyleOf().axisLabel, formatter: axisFmt(sec.format || 'number') } }); }
  o.series = series; o.tooltip.trigger = 'axis'; o.tooltip.valueFormatter = v => f(v, s.format); return o;
}
function stackedShare(s) { const o = base(); o.xAxis = { type: 'value', max: 1, ...axisStyleOf(), axisLabel: { ...axisStyleOf().axisLabel, formatter: v => (v * 100).toFixed(0) + '%' } }; o.yAxis = { type: 'category', data: s.x, ...axisStyleOf() }; o.series = s.series.map((se, i) => ({ name: se.name, type: 'bar', stack: 'a', data: se.data, barMaxWidth: 38, itemStyle: { color: T.palette[i % T.palette.length] }, label: { show: true, formatter: p => p.value > 0.04 ? (p.value * 100).toFixed(0) + '%' : '', color: T.labelOnBar, fontSize: 11 } })); o.grid.top = 36; o.tooltip.valueFormatter = v => fmt.pct(v); return o; }
function stackedBar(s) { const o = base(); o.xAxis = { type: 'category', data: s.x, ...axisStyleOf() }; o.yAxis = { type: 'value', ...axisStyleOf(), axisLabel: { ...axisStyleOf().axisLabel, formatter: axisFmt(s.format) } }; o.series = s.series.map((se, i) => ({ name: se.name, type: 'bar', stack: 'a', data: se.data, barMaxWidth: 36, itemStyle: { color: T.palette[i % T.palette.length], borderRadius: i === s.series.length - 1 ? [4, 4, 0, 0] : 0 } })); o.grid.top = 36; o.tooltip.trigger = 'axis'; o.tooltip.valueFormatter = v => f(v, s.format); return o; }
function waterfall(s) {
  const o = base(); const steps = s.steps; const names = steps.map(x => x.label); const inv = []; const vis = []; let run = 0;
  const pct = s.format === 'pct';
  steps.forEach(st => { if (st.kind === 'start' || st.kind === 'end') { inv.push(0); vis.push({ value: st.value, itemStyle: { color: st.kind === 'start' ? T.muted : T.accent, borderRadius: 4 } }); run = st.value; } else { const v = st.value; const b = v >= 0 ? run : run + v; inv.push(b); vis.push({ value: Math.abs(v), itemStyle: { color: v >= 0 ? T.good : T.bad, borderRadius: 4 }, real: v }); run += v; } });
  const ends = steps.filter(x => x.kind !== 'delta').map(x => x.value); const maxDelta = Math.max(1e-9, ...steps.filter(x => x.kind === 'delta').map(x => Math.abs(x.value)));
  const floorNice = v => { if (v <= 0) return 0; const mag = Math.pow(10, Math.floor(Math.log10(v))); return Math.floor(v / mag) * mag; };
  const minBase = pct ? Math.max(0, Math.min(...ends) - 0.15) : (Math.min(...ends) - 4 * maxDelta > 0.5 * Math.max(...ends) ? floorNice(Math.min(...ends) - 4 * maxDelta) : 0);
  const many = names.length > 7;
  o.xAxis = { type: 'category', data: names, ...axisStyleOf(), axisLabel: { ...axisStyleOf().axisLabel, interval: 0, width: many ? 120 : 110, overflow: many ? 'truncate' : 'break', rotate: many ? 28 : 0, fontSize: 10.5 } };
  if (many) o.grid.bottom = 36;
  o.yAxis = { type: 'value', ...axisStyleOf(), min: minBase || undefined, axisLabel: { ...axisStyleOf().axisLabel, formatter: axisFmt(s.format) } };
  if (minBase && !pct) o.title = { text: 'axis starts at ' + f(minBase, s.format), right: 0, top: 0, textStyle: { color: T.faint, fontSize: 10, fontWeight: 'normal' } };
  o.series = [{ type: 'bar', stack: 'w', data: inv, itemStyle: { color: 'transparent' }, silent: true, barMaxWidth: 46 }, { type: 'bar', stack: 'w', data: vis, barMaxWidth: 46, labelLayout: { hideOverlap: true }, label: { show: true, position: 'top', color: T.muted, fontSize: 10.5, formatter: p => { const st = steps[p.dataIndex]; return st.kind === 'delta' ? (pct ? fmt.pts(st.value) : (st.value >= 0 ? '+' : '') + fmt.money(st.value)) : f(st.value, s.format); } } }];
  o.tooltip.formatter = p => { const st = steps[p.dataIndex]; return `${st.label}: ${st.kind === 'delta' ? (pct ? fmt.pts(st.value) : fmt.money(st.value)) : f(st.value, s.format)}`; };
  o.grid.top = 28; return o;
}
function forecastOpt(s) {
  const o = base();
  const bandLow = s.p10, bandW = s.p90.map((v, i) => v === null ? null : v - s.p10[i]);
  o.series = [
    { name: 'P10–P90', type: 'line', data: bandLow, stack: 'b', lineStyle: { opacity: 0 }, symbol: 'none', silent: true, areaStyle: { opacity: 0 } },
    { name: 'P10–P90', type: 'line', data: bandW, stack: 'b', lineStyle: { opacity: 0 }, symbol: 'none', silent: true, areaStyle: { color: T.accent, opacity: .18 } },
    { name: 'Actual', type: 'line', data: s.actual, smooth: .2, symbol: 'circle', symbolSize: 4, lineStyle: { color: T.accent2, width: 2.5 }, itemStyle: { color: T.accent2 } },
    { name: 'Forecast (P50)', type: 'line', data: s.p50, smooth: .2, symbol: 'circle', symbolSize: 4, lineStyle: { color: T.accent, width: 2.5, type: 'dashed' }, itemStyle: { color: T.accent } }
  ];
  if (s.plan) o.series.push({ name: 'Plan', type: 'line', data: s.plan, symbol: 'none', lineStyle: { color: T.warn, width: 1.5, type: 'dotted' }, itemStyle: { color: T.warn } });
  o.series[2].markLine = { silent: true, symbol: 'none', lineStyle: { color: T.faint, type: 'dashed' }, label: { color: T.muted, formatter: 'today' }, data: [{ xAxis: s.splitIndex - 0.5 }] };
  o.xAxis = { type: 'category', data: s.x, ...axisStyleOf(), boundaryGap: false, axisLabel: { ...axisStyleOf().axisLabel, interval: Math.ceil(s.x.length / 12) - 1 } }; o.yAxis = { type: 'value', ...axisStyleOf(), scale: true, axisLabel: { ...axisStyleOf().axisLabel, formatter: axisFmt(s.format) } };
  o.tooltip.trigger = 'axis'; o.tooltip.formatter = ps => { const i = ps[0].dataIndex; const parts = [s.x[i]]; if (s.actual[i] != null) parts.push('Actual ' + f(s.actual[i], s.format)); if (s.p50[i] != null) parts.push(`Forecast ${f(s.p50[i], s.format)} (P10 ${f(s.p10[i], s.format)}, P90 ${f(s.p90[i], s.format)})`); if (s.plan && s.plan[i] != null) parts.push('Plan ' + f(s.plan[i], s.format)); return parts.join('<br>'); };
  return o;
}
function burndownOpt(s) { const o = forecastOpt({ ...s, plan: null, format: 'number' }); o.series[2].name = 'Hours to date'; o.series[3].name = 'Forecast'; o.series.push({ name: 'Budget hours', type: 'line', data: s.x.map(() => s.budget), symbol: 'none', lineStyle: { color: T.warn, type: 'dotted', width: 1.5 } }); o.tooltip.formatter = undefined; o.tooltip.valueFormatter = v => fmt.number(v); return o; }
function heatmapOpt(s) {
  const o = base(); const vals = s.cells.map(c => c.value).filter(v => v !== null); const min = Math.min(...vals), max = Math.max(...vals);
  o.grid = { left: 8, right: 70, top: 10, bottom: 8, containLabel: true };
  o.xAxis = { type: 'category', data: s.x, ...axisStyleOf(), splitArea: { show: false }, axisLabel: { ...axisStyleOf().axisLabel, interval: 0, rotate: s.x.length > 8 ? 35 : 0, fontSize: 10.5 } }; o.yAxis = { type: 'category', data: s.y, ...axisStyleOf(), inverse: true };
  o.visualMap = { min, max, calculable: false, orient: 'vertical', right: 0, top: 'middle', inRange: { color: s.invert ? [T.bad, T.heatMid, T.good] : [T.heatLow, T.accent, T.bad] }, textStyle: { color: T.muted, fontSize: 10 }, formatter: v => f(v, s.format), itemWidth: 10 };
  o.series = [{ type: 'heatmap', data: s.cells.map(c => [c.x, c.y, c.value]), label: { show: true, color: '#fff', fontSize: 10.5, formatter: p => s.format === 'pct' ? (p.value[2] * 100).toFixed(0) + '%' : f(p.value[2], s.format) }, itemStyle: { borderColor: T.surface, borderWidth: 2, borderRadius: 4 }, emphasis: { itemStyle: { borderColor: T.accent2 } } }];
  o.tooltip.formatter = p => { const c = s.cells[p.dataIndex]; return `${s.x[c.x]} · ${s.y[c.y]}<br>${f(c.value, s.format)}${c.n ? ` · ${c.n} people` : ''}${c.expected ? ` · ${c.expected.toFixed(1)} expected exits` : ''}`; };
  return o;
}
async function mapOpt(s) {
  await ensureWorld(); const o = base();
  const vals = s.points.map(p => p.revenue); const maxV = Math.max(...vals);
  o.geo = { map: 'world', roam: true, zoom: 1.25, center: [20, 25], itemStyle: { areaColor: T.area, borderColor: T.areaBorder, borderWidth: .6 }, emphasis: { itemStyle: { areaColor: T.areaHover }, label: { show: false } }, silent: true };
  o.visualMap = { min: 0.9, max: 1.1, dimension: 3, inRange: { color: [T.bad, T.warn, T.good] }, text: ['Ahead of plan', 'Behind plan'], textStyle: { color: T.muted, fontSize: 10 }, left: 0, bottom: 0, orient: 'horizontal', calculable: false, formatter: v => (v * 100).toFixed(0) + '%' };
  o.series = [{ type: 'scatter', coordinateSystem: 'geo', data: s.points.map(p => ({ name: p.label, value: [p.lon, p.lat, p.revenue, p.attainment || 1], unit: p.unit, p })), symbolSize: v => 12 + 44 * Math.sqrt(v[2] / maxV), itemStyle: { opacity: .85, shadowBlur: 12, shadowColor: 'rgba(0,0,0,.4)' }, label: { show: true, formatter: p => p.name, position: 'right', color: T.text, fontSize: 10.5 }, emphasis: { scale: 1.1 } }];
  o.tooltip.formatter = p => { const x = p.data.p; return `<b>${x.label}</b><br>Revenue YTD ${fmt.money(x.revenue)}<br>Plan attainment ${x.attainment ? fmt.pct(x.attainment, 0) : '–'}<br>Growth ${x.growth !== null ? fmt.pct(x.growth, 0) : '–'}<br>${x.users} user IDs · ${x.offices} offices<br><i>Click, then say “Why?”</i>`; };
  o.grid = undefined; return o;
}
function scatterOpt(s) {
  const o = base(); const maxS = Math.max(...s.points.map(p => p.size));
  o.xAxis = { type: 'value', name: 'Elapsed time', nameTextStyle: { color: T.muted, fontSize: 11 }, min: 0, max: 1, ...axisStyleOf(), axisLabel: { ...axisStyleOf().axisLabel, formatter: v => (v * 100).toFixed(0) + '%' } }; o.yAxis = { type: 'value', name: 'Budget hours used', nameTextStyle: { color: T.muted, fontSize: 11 }, min: 0, ...axisStyleOf(), axisLabel: { ...axisStyleOf().axisLabel, formatter: v => (v * 100).toFixed(0) + '%' } };
  o.visualMap = { min: 0, max: 1, dimension: 2, inRange: { color: [T.good, T.warn, T.bad] }, text: ['Overrun likely', 'On track'], textStyle: { color: T.muted, fontSize: 10 }, right: 0, top: 'middle', calculable: false, formatter: v => (v * 100).toFixed(0) + '%' };
  o.series = [{ type: 'scatter', data: s.points.map(p => ({ name: p.label, value: [p.x, p.y, p.prob], id: p.id })), symbolSize: (v, p) => 10 + 30 * Math.sqrt(s.points[p.dataIndex].size / maxS), itemStyle: { opacity: .85 }, markLine: { silent: true, symbol: 'none', lineStyle: { color: T.faint, type: 'dashed' }, data: [[{ coord: [0, 0] }, { coord: [1, 1] }]], label: { show: false } } }];
  o.tooltip.formatter = p => `<b>${p.name}</b><br>Elapsed ${(p.value[0] * 100).toFixed(0)}% · Burn ${(p.value[1] * 100).toFixed(0)}%<br>Overrun probability ${(p.value[2] * 100).toFixed(0)}%`;
  return o;
}
function funnelOpt(s) { const o = base(); o.series = [{ type: 'funnel', left: '4%', width: '55%', sort: 'none', gap: 3, label: { color: T.text, fontSize: 12, formatter: p => `${p.name}: ${p.data.count} · ${fmt.money(p.value)} (weighted ${fmt.money(p.data.weighted)})`, position: 'right' }, labelLine: { lineStyle: { color: T.border } }, itemStyle: { borderColor: T.surface, borderWidth: 2 }, data: s.stages.map((st, i) => ({ name: st.stage, value: st.value, count: st.count, weighted: st.weighted, itemStyle: { color: T.palette[i] } })) }]; o.tooltip.formatter = p => `${p.name}<br>${p.data.count} opportunities · ${fmt.money(p.value)}<br>Weighted ${fmt.money(p.data.weighted)}`; o.grid = undefined; return o; }
function pyramidOpt(s) { const o = base(); const rows = s.rows; o.yAxis = { type: 'category', data: rows.map(r => r.label), ...axisStyleOf(), inverse: true }; o.xAxis = { type: 'value', ...axisStyleOf(), axisLabel: { ...axisStyleOf().axisLabel, formatter: v => fmt.number(v) } }; const total = rows.reduce((a, r) => a + r.now, 0); o.series = [{ name: 'Now', type: 'bar', data: rows.map(r => r.now), itemStyle: { color: T.accent, borderRadius: 4 }, barMaxWidth: 22, label: { show: true, position: 'right', color: T.muted, fontSize: 10.5, formatter: p => `${fmt.number(p.value)} (${(p.value / total * 100).toFixed(0)}%)` } }, { name: 'A year ago', type: 'bar', data: rows.map(r => r.last_year), itemStyle: { color: 'rgba(91,192,235,.55)', borderRadius: 4 }, barMaxWidth: 22 }, { name: 'Target shape', type: 'line', data: rows.map(r => r.target * total), symbol: 'diamond', symbolSize: 10, lineStyle: { opacity: 0 }, itemStyle: { color: T.warn } }]; o.grid.top = 30; o.tooltip.trigger = 'axis'; return o; }
function networkOpt(s) { const o = base(); const client = s.nodes.filter(n => n.side === 'client'), kearney = s.nodes.filter(n => n.side === 'kearney'); const nodes = [...client.map((n, i) => ({ id: n.id, name: n.label, x: 100, y: 40 + i * (340 / Math.max(1, client.length - 1)), symbolSize: 18 + (n.strength || 1) * 4, itemStyle: { color: T.info }, label: { show: true, position: 'left', color: T.text, fontSize: 11 } })), ...kearney.map((n, i) => ({ id: n.id, name: n.label, x: 500, y: 40 + i * (340 / Math.max(1, kearney.length - 1)), symbolSize: 18, itemStyle: { color: T.accent }, label: { show: true, position: 'right', color: T.text, fontSize: 11 } }))]; o.series = [{ type: 'graph', layout: 'none', data: nodes, links: s.links.map(l => ({ source: l.source, target: l.target, lineStyle: { color: l.decayed ? T.bad : T.accent2, type: l.decayed ? 'dashed' : 'solid', width: 1 + (l.strength || 1) / 2, opacity: .8 } })), roam: false, top: 10, bottom: 10, left: 120, right: 90 }]; o.tooltip.formatter = p => p.dataType === 'edge' ? 'Relationship' : p.name; o.grid = undefined; return o; }
function sparkOpt(s) { return { backgroundColor: 'transparent', grid: { left: 0, right: 0, top: 4, bottom: 0 }, xAxis: { type: 'category', show: false, data: s.data.map((_, i) => i), boundaryGap: false }, yAxis: { type: 'value', show: false, scale: true }, series: [{ type: 'line', data: s.data, symbol: 'none', smooth: .3, lineStyle: { color: T[s.color] || s.color || T.accent, width: 1.6 }, areaStyle: { color: T[s.color] || s.color || T.accent, opacity: .12 } }], animation: false, tooltip: { show: false } }; }
