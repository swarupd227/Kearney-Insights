// Screen 10: staffing marketplace. Supply and demand by skill and week, open roles, roll-offs, ranked matches on request.
import { state, api, h, ask, renderVisual, renderTable, screenHead } from '../ui.js';
export async function render(root, params) {
  const q = new URLSearchParams(); if (params.unit) q.set('unit', params.unit);
  const d = await api('screens/staffing?' + q.toString());
  const mk = d.marketplace;
  const sel = h('select', { class: 'btn small', onChange: e => { location.hash = '#/staffing/' + (e.target.value ? 'unit=' + e.target.value : ''); } }, h('option', { value: '' }, 'Whole firm'), ...state.ref.units.map(u => h('option', { value: u.id, selected: u.id === params.unit }, u.name)));
  const weekly = renderVisual(mk.visual); const gap = renderVisual(mk.visual2);
  const roles = renderTable(mk.table, { onRow: r => ask(`Who can start on a ${(r.skills || [])[0] || ''} engagement in ${r.location} on ${new Date(r.start_date).toLocaleDateString('en-GB', { weekday: 'long' })}?`) });
  const roll = renderTable({ title: 'Rolling off in the next eight weeks', subtitle: 'Supply, by identifier (availability view, logged)', columns: [['id', 'Person'], ['level_name', 'Level'], ['office_name', 'Office'], ['unit_name', 'Unit'], ['roll_off_date', 'Roll-off'], ['skills', 'Skills']], rows: d.rollingOff, lineage: mk.visual.lineage });
  root.replaceChildren(screenHead('Staffing marketplace', 'Staffing manager, Principal, Associate · proposed matches are confirmed by the staffing manager', sel), h('div', { class: 'card flat', style: { padding: '0 0 8px' } }, mk.narrative), h('div', { class: 'grid cols-2' }, weekly, gap), h('div', { class: 'grid cols-2', style: { marginTop: '16px' } }, roles, roll), h('div', { class: 'chips', style: { marginTop: '12px' } }, ...['Who can start on a procurement engagement in Riyadh on Monday?', 'Show me Associates with SAP experience rolling off in the next three weeks', 'Which units are below 70% utilisation at Associate level?'].map(x => h('button', { class: 'chip', onClick: () => ask(x) }, '✦ ' + x))));
}
