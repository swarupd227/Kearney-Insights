// Personal board: pinned questions that re-run and render as live tiles each time the board opens.
import { state, api, h, ask, renderVisual, screenHead, toast, dateShort } from '../ui.js';
export async function render(root) {
  const rows = await api('boards?persona=' + state.persona.id);
  const grid = h('div', { class: 'grid cols-2' });
  root.replaceChildren(screenHead('My board', 'A pinned tile keeps its question and refreshes with the data each time the board opens. Say “Pin this to my board” or “Make this weekly” after any answer.', h('button', { class: 'btn small', onClick: () => render(root) }, '↻ Refresh all')), rows.length ? grid : h('div', { class: 'card muted' }, 'Nothing pinned yet. Ask a question, then say “Pin this to my board”.'));
  for (const b of rows) {
    const card = h('div', { class: 'card' }, h('h3', {}, b.title), h('div', { class: 'sub' }, `${b.schedule ? 'Refreshes ' + b.schedule + ' · ' : ''}pinned ${dateShort(b.created_at)}`), h('div', { class: 'thinking' }, h('span', { class: 'dots' }, h('span'), h('span'), h('span')), h('span', {}, 'Refreshing…')));
    grid.appendChild(card);
    api('ask', { body: { question: b.question, persona: state.persona.id, session: 'board-' + b.id, context: null } }).then(a => {
      const body = h('div', {}, h('div', { class: 'small', style: { marginBottom: '8px' } }, a.headline), a.visual ? renderVisual(a.visual, { compact: true, titleOverride: ' ' }) : null, h('div', { class: 'chips' }, h('button', { class: 'chip', onClick: () => ask(b.question) }, 'Open on the canvas'), h('button', { class: 'chip', onClick: async () => { await api('boards/' + b.id, { method: 'DELETE' }); toast('Unpinned'); render(root); } }, 'Unpin')));
      card.querySelector('.thinking').replaceWith(body);
    }).catch(e => { card.querySelector('.thinking').replaceWith(h('div', { class: 'bad small' }, 'Could not refresh: ' + e.message)); });
  }
}
