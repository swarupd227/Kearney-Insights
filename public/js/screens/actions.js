// Screen 14: action centre, a decision queue. Drafts come from the person's questions and from the predictions themselves;
// each carries an expected effect computed from the data. Nothing leaves the product without a named person's approval.
// Editing happens in place on the card (title, owner, due date, body); the draft stays pending until approved or rejected.
import { state, api, h, ask, screenHead, toast, dateShort, dateTimeShort, F } from '../ui.js';
const n = v => (v === null || v === undefined || isNaN(Number(v))) ? 0 : Number(v);
const spokenMoney = v => F(v, 'money').replace('US$', '').replace('B', ' billion US dollars').replace('M', ' million US dollars').replace('K', ' thousand US dollars');
export async function render(root) {
  const rows = await api('actions?refresh=1&persona=' + state.persona.id);
  const pending = rows.filter(r => r.status === 'pending'), done = rows.filter(r => r.status !== 'pending');
  const total = pending.reduce((a, r) => a + n(r.payload && r.payload.impact), 0);
  const raised = pending.filter(r => r.payload && r.payload.source === 'prediction').length;
  const card = a => {
    const p = a.payload || {}; const el = h('div', { class: 'action ' + a.status });
    const view = () => el.replaceChildren(
      h('div', {},
        h('div', { class: 'row' }, h('div', { class: 't' }, a.title), h('span', { class: 'badge ' + (p.source === 'prediction' ? 'accent' : '') }, p.source === 'prediction' ? 'Raised by the product' : 'From your question')),
        p.impact ? h('div', { class: 'impact' }, h('span', { class: 'v' }, '≈ ' + F(p.impact, 'money')), h('span', { class: 'x' }, p.impact_text)) : p.impact_text ? h('div', { class: 'impact' }, h('span', { class: 'x' }, p.impact_text)) : null,
        h('div', { class: 'meta' }, p.evidence ? 'Why: ' + p.evidence : `Triggered by: “${a.trigger_insight}”`),
        h('div', { class: 'meta' }, `Owner: ${a.owner} · due ${dateShort(a.due_date)} · ${a.connector}${a.status === 'pending' ? '' : ' · ' + a.status + (a.decided_by ? ' by ' + a.decided_by : '')}${p.edited_by ? ' · edited by ' + p.edited_by : ''}`),
        h('div', { class: 'body' }, a.body),
        p.connector_result ? h('div', { class: 'badge accent' }, p.connector_result) : null),
      a.status === 'pending'
        ? h('div', { class: 'btns' }, h('button', { class: 'btn good small', onClick: () => decide(a.id, 'approve') }, 'Approve'), h('button', { class: 'btn small', onClick: edit }, 'Edit'), h('button', { class: 'btn bad small', onClick: () => decide(a.id, 'reject') }, 'Reject'), p.ask ? h('button', { class: 'btn ghost small', title: 'Open the analysis behind this draft', onClick: () => ask(p.ask) }, 'Show the evidence') : null)
        : h('div', { class: 'muted small' }, a.decided_at ? dateTimeShort(a.decided_at) : ''));
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
  async function decide(id, decision) { await api(`actions/${id}/decide`, { body: { decision, persona: state.persona.id } }); toast(decision === 'approve' ? 'Approved and logged. In demo mode the action is recorded and nothing is sent.' : 'Rejected and logged.'); render(root); document.dispatchEvent(new CustomEvent('astra:navigate', { detail: { screen: 'actions', params: {} } })); }
  const spokenQueue = () => pending.length ? `${pending.length === 1 ? 'One action is' : pending.length + ' actions are'} waiting${total ? ', worth about ' + spokenMoney(total) : ''}. ${pending.slice(0, 4).map((a, i) => `${i + 1}: ${a.title}${a.payload && a.payload.impact ? ', about ' + spokenMoney(a.payload.impact) : ''}.`).join(' ')} Say approve or reject with the number.` : 'Nothing is waiting for approval.';
  root.replaceChildren(
    screenHead('Action centre', `${pending.length} waiting for approval${total ? ' · worth about ' + F(total, 'money') : ''}${raised ? ` · ${raised} raised by the predictions` : ''} · Approved actions go to Workday, Salesforce, ServiceNow, Teams or Outlook. In demo mode they are recorded and nothing is sent.`,
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' } }, h('button', { class: 'btn small', title: 'Read the queue aloud', onClick: () => document.dispatchEvent(new CustomEvent('astra:speak', { detail: spokenQueue() })) }, '▶ Read me the queue'), h('button', { class: 'btn small', onClick: () => ask('What should I do about it?') }, 'Draft actions from the last insight'))),
    h('div', { class: 'grid', style: { gap: '10px' } }, ...(pending.length ? pending.map(card) : [h('div', { class: 'card muted' }, 'No drafts waiting. The predictions raise their own drafts each morning; ask “What should I do about it?” after any insight to draft more.')])),
    done.length ? h('div', { style: { marginTop: '20px' } }, h('div', { class: 'muted small', style: { marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '.05em' } }, `Decided (${done.length})`), h('div', { class: 'grid', style: { gap: '10px' } }, ...done.slice(0, 12).map(card))) : null);
}
