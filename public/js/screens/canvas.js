// Screen 3: conversation canvas. Answer cards stack in conversation order; command bar and orb stay docked.
import { state, h, answerCard, promptChips, screenHead } from '../ui.js';
let list;
export async function render(root) {
  list = h('div', { class: 'canvas' });
  if (!state.answers.length) list.appendChild(h('div', { class: 'card flat', style: { textAlign: 'center', padding: '40px 20px' } }, h('div', { style: { fontSize: '22px', fontWeight: 600 } }, 'Ask anything about the firm.'), h('div', { class: 'muted', style: { margin: '6px 0 16px' } }, 'Speak, type or point. The Conductor plans the work, the specialists do it, the Guardian checks it, and every number can be traced.'), promptChips(state.persona.questions)));
  for (const a of state.answers) list.appendChild(answerCard(a));
  root.replaceChildren(screenHead('Conversation canvas', `${state.persona.title} · ${state.answers.length} answer${state.answers.length === 1 ? '' : 's'} this session`), list);
}
export function showThinking(question) {
  if (!list || !list.isConnected) return null;
  const empty = list.querySelector('.card.flat'); if (empty) empty.remove();
  const el = h('div', { class: 'answer' }, h('div', { class: 'q' }, h('span', {}, question)), h('div', { class: 'thinking' }, h('span', { class: 'dots' }, h('span'), h('span'), h('span')), h('span', {}, 'Conductor is planning · Metric Agent resolving · Query Agent reading under row-level security…')));
  list.appendChild(el); el.scrollIntoView({ behavior: 'smooth', block: 'end' }); return el;
}
export function showAnswer(a, pending) { const card = answerCard(a); if (pending && pending.isConnected) pending.replaceWith(card); else if (list && list.isConnected) list.appendChild(card); setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80); }
export function showError(msg, pending) { const card = h('div', { class: 'answer blocked' }, h('div', { class: 'headline' }, 'The agents could not answer: ' + msg)); if (pending && pending.isConnected) pending.replaceWith(card); else if (list) list.appendChild(card); }
