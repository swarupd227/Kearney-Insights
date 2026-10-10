// Personal board: pinned questions that refresh with the data.
import { state, api, h, ask, screenHead, toast } from '../ui.js';
export async function render(root) {
  const rows = await api('boards?persona=' + state.persona.id);
  root.replaceChildren(screenHead('My board', 'A pinned tile keeps its question and refreshes with the data. Say “Pin this to my board” or “Make this weekly” after any answer.'), h('div', { class: 'grid cols-3' }, ...(rows.length ? rows.map(b => h('div', { class: 'card' }, h('h3', {}, b.title), h('div', { class: 'sub' }, `${b.schedule ? 'Refreshes ' + b.schedule + ' · ' : ''}pinned ${new Date(b.created_at).toUTCString().slice(5, 16)}`), h('div', { class: 'chips' }, h('button', { class: 'chip', onClick: () => ask(b.question) }, '↻ Refresh'), h('button', { class: 'chip', onClick: async () => { await api('boards/' + b.id, { method: 'DELETE' }); toast('Unpinned'); render(root); } }, 'Unpin')))) : [h('div', { class: 'card muted' }, 'Nothing pinned yet.')])));
}
