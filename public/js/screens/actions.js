// Screen 14: action centre. A queue of drafted actions; nothing leaves the product without a named person's approval.
// Editing happens in place on the card (body, owner, due date); the draft stays pending until approved or rejected.
import { state, api, h, ask, screenHead, toast } from '../ui.js';
export async function render(root) {
  const rows = await api('actions?persona=' + state.persona.id);
  const pending = rows.filter(r => r.status === 'pending'), done = rows.filter(r => r.status !== 'pending');
  const card = a => {
    const el = h('div', { class: 'action ' + a.status });
    const view = () => el.replaceChildren(
      h('div', {}, h('div', { class: 't' }, a.title), h('div', { class: 'meta' }, `Owner: ${a.owner} · due ${a.due_date} · ${a.connector} · ${a.status}${a.decided_by ? ' by ' + a.decided_by : ''}${a.payload && a.payload.edited_by ? ' · edited by ' + a.payload.edited_by : ''}`), h('div', { class: 'meta' }, `Triggered by: “${a.trigger_insight}”`), h('div', { class: 'body' }, a.body), a.payload && a.payload.connector_result ? h('div', { class: 'badge accent' }, a.payload.connector_result) : null),
      a.status === 'pending' ? h('div', { class: 'btns' }, h('button', { class: 'btn good small', onClick: () => decide(a.id, 'approve') }, 'Approve'), h('button', { class: 'btn small', onClick: edit }, 'Edit'), h('button', { class: 'btn bad small', onClick: () => decide(a.id, 'reject') }, 'Reject')) : h('div', { class: 'muted small' }, a.decided_at ? new Date(a.decided_at).toUTCString().slice(5, 22) : ''));
    const edit = () => {
      const f = { title: a.title, body: a.body, owner: a.owner, due_date: String(a.due_date).slice(0, 10) };
      const input = (key, type = 'text', style = {}) => h('input', { type, value: f[key], style: { width: '100%', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: '9px', padding: '7px 10px', color: 'var(--text)', ...style }, onInput: e => { f[key] = e.target.value; } });
      const ta = h('textarea', { style: { width: '100%', minHeight: '140px', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: '9px', padding: '10px', color: 'var(--text)', font: 'inherit', lineHeight: '1.5', resize: 'vertical' }, onInput: e => { f.body = e.target.value; } }, a.body);
      el.replaceChildren(
        h('div', {}, h('div', { class: 'muted small', style: { marginBottom: '4px' } }, 'Title'), input('title'), h('div', { class: 'grid cols-2', style: { margin: '10px 0' } }, h('div', {}, h('div', { class: 'muted small', style: { marginBottom: '4px' } }, 'Owner'), input('owner')), h('div', {}, h('div', { class: 'muted small', style: { marginBottom: '4px' } }, 'Due date'), input('due_date', 'date'))), h('div', { class: 'muted small', style: { marginBottom: '4px' } }, 'Draft'), ta, h('div', { class: 'muted small', style: { marginTop: '6px' } }, `Connector: ${a.connector} · the draft stays pending until you approve or reject it`)),
        h('div', { class: 'btns' }, h('button', { class: 'btn primary small', onClick: async () => { const saved = await api(`actions/${a.id}/decide`, { body: { decision: 'edit', persona: state.persona.id, edit: f } }); Object.assign(a, saved); toast('Draft saved and logged'); view(); } }, 'Save'), h('button', { class: 'btn good small', onClick: async () => { await api(`actions/${a.id}/decide`, { body: { decision: 'edit', persona: state.persona.id, edit: f } }); await decide(a.id, 'approve'); } }, 'Save and approve'), h('button', { class: 'btn ghost small', onClick: view }, 'Cancel')));
      setTimeout(() => ta.focus(), 50);
    };
    view(); return el;
  };
  async function decide(id, decision) { await api(`actions/${id}/decide`, { body: { decision, persona: state.persona.id } }); toast(decision === 'approve' ? 'Approved and recorded by the connector stub; nothing sent (demo mode). Logged in the audit trail.' : 'Rejected and logged.'); render(root); document.dispatchEvent(new CustomEvent('astra:navigate', { detail: { screen: 'actions', params: {} } })); }
  root.replaceChildren(screenHead('Action centre', `${pending.length} waiting for approval · Approved actions go to Workday, Salesforce, ServiceNow, Teams or Outlook; in demo mode to a stub that records them and sends nothing`, h('button', { class: 'btn small', onClick: () => ask('What should I do about it?') }, 'Draft actions from the last insight')), h('div', { class: 'grid', style: { gap: '10px' } }, ...(pending.length ? pending.map(card) : [h('div', { class: 'card muted' }, 'No drafts waiting. Ask “What should I do about it?” after any insight and actions will be drafted with an owner and a due date.')])), done.length ? h('div', { style: { marginTop: '20px' } }, h('div', { class: 'muted small', style: { marginBottom: '8px' } }, 'Decided'), h('div', { class: 'grid', style: { gap: '10px' } }, ...done.slice(0, 12).map(card))) : null);
}
