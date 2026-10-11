// Application shell: persona entry, navigation fallback, command bar, voice orb, answer routing.
import { state, api, h, toast, ask, answerCard, esc } from './ui.js';
import { Voice } from './voice.js';
import * as home from './screens/home.js';
import * as canvas from './screens/canvas.js';
import * as firm from './screens/firm.js';
import * as region from './screens/region.js';
import * as practice from './screens/practice.js';
import * as account from './screens/account.js';
import * as engagements from './screens/engagements.js';
import * as talent from './screens/talent.js';
import * as staffing from './screens/staffing.js';
import * as pipelineS from './screens/pipeline.js';
import * as forecastS from './screens/forecast.js';
import * as cash from './screens/cash.js';
import * as actions from './screens/actions.js';
import * as board from './screens/board.js';
import * as observatory from './screens/observatory.js';
import * as settingsScreen from './screens/settings.js';
import * as runbook from './screens/runbook.js';
import { setTheme } from './charts.js';

const SCREENS = { home, canvas, firm, region, practice, account, engagements, talent, staffing, pipeline: pipelineS, forecast: forecastS, cash, actions, board, observatory, settings: settingsScreen, runbook };
const main = document.getElementById('main');
let voice; let briefSpokenFor = new Set();

async function boot() {
  const [meta, ref] = await Promise.all([api('meta'), api('reference')]);
  state.meta = meta; state.ref = ref;
  const saved = localStorage.getItem('astra.persona');
  const all = [...meta.personas, ...meta.hiddenPersonas];
  state.persona = all.find(p => p.id === saved) || meta.personas[0];
  document.getElementById('seedBanner').style.display = meta.provenance ? 'flex' : 'none';
  applyTheme(localStorage.getItem('astra.theme') || 'dark');
  renderLlmChip(meta.llm);
  renderPersonaChip(); buildPersonaModal(all, meta.roles, meta.tiers);
  setupRail(); setupDock(); setupDrawer(); setupVoice();
  document.addEventListener('astra:settings-changed', async () => { const m = await api('meta'); state.meta = m; renderLlmChip(m.llm); document.getElementById('seedBanner').style.display = m.provenance ? 'flex' : 'none'; });
  document.addEventListener('astra:ask', e => handleAsk(e.detail.question, e.detail.context));
  document.addEventListener('astra:navigate', e => go(e.detail.screen, e.detail.params));
  document.addEventListener('astra:speak', e => voice.speak(e.detail));
  window.addEventListener('hashchange', route);
  updateActionCount();
  route();
  if (!localStorage.getItem('astra.persona')) openPersonaModal();
  const pendingAsk = sessionStorage.getItem('astra.pendingAsk'); if (pendingAsk) { sessionStorage.removeItem('astra.pendingAsk'); setTimeout(() => ask(pendingAsk), 800); }
}
function route() { const m = location.hash.match(/^#\/([a-z]+)(?:\/(.*))?/); const screen = m ? m[1] : 'home'; const params = m && m[2] ? Object.fromEntries(new URLSearchParams(m[2])) : {}; show(screen, params); }
export function go(screen, params = {}) { const q = new URLSearchParams(params).toString(); location.hash = '#/' + screen + (q ? '/' + q : ''); }
async function show(screen, params) {
  const mod = SCREENS[screen] || SCREENS.home; state.screen = screen in SCREENS ? screen : 'home';
  document.querySelectorAll('.rail-link').forEach(a => a.classList.toggle('active', a.dataset.screen === state.screen));
  main.replaceChildren(h('div', { class: 'loading' }, 'Loading…'));
  try { await mod.render(main, params); } catch (e) { console.error(e); main.replaceChildren(h('div', { class: 'card' }, h('h3', {}, 'This screen could not load'), h('div', { class: 'muted' }, e.message))); }
  main.scrollTop = 0;
  if (state.screen === 'home' && !briefSpokenFor.has(state.persona.id) && window.__astraBrief) { briefSpokenFor.add(state.persona.id); setTimeout(() => voice.speak(window.__astraBrief), 600); }
}

// ---------- persona ----------
function renderPersonaChip() { const p = state.persona; document.getElementById('personaTitle').textContent = p.title; document.getElementById('personaAvatar').textContent = p.short.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase(); }
function buildPersonaModal(all, roles, tiers) {
  const grid = document.getElementById('personaGrid'); grid.replaceChildren(...all.filter(p => !['knet'].includes(p.id)).map(p => h('div', { class: 'persona-card' + (state.persona.id === p.id ? ' active' : ''), onClick: () => selectPersona(p) }, h('div', { class: 'tier' }, `Tier ${p.tier} · ${p.tierName}`), h('div', { class: 't' }, p.title), h('div', { class: 'd' }, p.decides), h('div', { class: 'q' }, '“' + p.questions[0] + '”'))));
  const knet = all.find(p => p.id === 'knet'); if (knet) grid.appendChild(h('div', { class: 'persona-card', onClick: () => selectPersona(knet), style: { opacity: .85 } }, h('div', { class: 'tier' }, `Tier 6 · storyline E`), h('div', { class: 't' }, knet.title), h('div', { class: 'd' }, knet.decides), h('div', { class: 'q' }, '“' + knet.questions[0] + '”')));
  document.getElementById('rolesList').replaceChildren(...roles.map(r => h('div', {}, h('span', { class: 'tn' }, 'T' + r.tier), h('span', { style: r.persona ? { color: 'var(--accent-2)' } : null }, r.role), h('span', { class: 'src' }, r.source))));
  document.getElementById('personaChip').addEventListener('click', openPersonaModal);
  document.getElementById('personaClose').addEventListener('click', closePersonaModal);
  document.getElementById('personaModal').addEventListener('click', e => { if (e.target.id === 'personaModal') closePersonaModal(); });
}
function openPersonaModal() { document.getElementById('personaModal').classList.add('open'); }
function closePersonaModal() { if (!localStorage.getItem('astra.persona')) localStorage.setItem('astra.persona', state.persona.id); document.getElementById('personaModal').classList.remove('open'); if (!location.hash) go('home'); }
function selectPersona(p) {
  state.persona = p; localStorage.setItem('astra.persona', p.id); renderPersonaChip(); markPrimaryLinks(); state.answers = []; state.session = 'demo-' + Math.random().toString(36).slice(2, 8);
  document.querySelectorAll('.persona-card').forEach(c => c.classList.toggle('active', c.querySelector('.t').textContent === p.title));
  closePersonaModal(); toast(`Guardian loaded the ${p.short} scope`); voice.stopSpeaking();
  if (location.hash === '#/home' || !location.hash) show('home', {}); else go('home');
}

// ---------- rail ----------
function setupRail() {
  document.querySelectorAll('.rail-link').forEach(a => a.addEventListener('click', () => go(a.dataset.screen)));
  document.getElementById('brand').addEventListener('click', () => go('home'));
  const rail = document.getElementById('rail'); const more = document.getElementById('railMore');
  const apply = () => { const collapsed = localStorage.getItem('astra.rail') !== 'expanded'; rail.classList.toggle('collapsed', collapsed); more.textContent = collapsed ? 'More ▾' : 'Fewer ▴'; };
  more.addEventListener('click', () => { localStorage.setItem('astra.rail', rail.classList.contains('collapsed') ? 'expanded' : 'collapsed'); apply(); });
  markPrimaryLinks(); apply();
}
// Collapsed rail shows four items: Home, the canvas, the persona's own workspace and the action centre (plus the current screen).
function markPrimaryLinks() { const primary = new Set(['home', 'canvas', state.persona.defaultScreen, 'actions']); document.querySelectorAll('.rail-link').forEach(a => a.classList.toggle('primary', primary.has(a.dataset.screen))); }
async function updateActionCount() { try { const rows = await api('actions'); const n = rows.filter(r => r.status === 'pending').length; document.getElementById('actionCount').textContent = n ? String(n) : ''; } catch (e) { /* noop */ } }

// ---------- dock: command bar and voice ----------
function setupDock() {
  const form = document.getElementById('cmdForm'); const input = document.getElementById('cmdInput'); const sug = document.getElementById('cmdSuggest');
  form.addEventListener('submit', e => { e.preventDefault(); const q = input.value.trim(); if (!q) return; input.value = ''; sug.classList.remove('open'); ask(q); });
  let items = []; let active = -1;
  const refresh = () => {
    const q = input.value.trim().toLowerCase(); items = [];
    const pq = state.persona.questions.filter(x => !q || x.toLowerCase().includes(q)).slice(0, 4).map(x => ({ t: x, cat: 'For your role' }));
    const metrics = q.length >= 2 ? state.meta.metrics.filter(m => m.name.toLowerCase().includes(q)).slice(0, 4).map(m => ({ t: `Show ${m.name.toLowerCase()} by ${state.persona.scope.region ? 'unit' : 'region'}`, cat: 'Metrics' })) : [];
    const clients = q.length >= 2 ? state.ref.clients.filter(c => c.name.toLowerCase().includes(q)).slice(0, 3).map(c => ({ t: `Prepare me for my meeting with ${c.name}`, cat: 'Clients' })) : [];
    const units = q.length >= 2 ? [...state.ref.regions, ...state.ref.units].filter(u => u.name.toLowerCase().includes(q)).slice(0, 3).map(u => ({ t: `Why is ${u.name} behind plan?`, cat: 'Geography' })) : [];
    items = [...pq, ...metrics, ...clients, ...units]; active = -1;
    if (!items.length) { sug.classList.remove('open'); return; }
    let lastCat = null; sug.replaceChildren(...items.flatMap((it, i) => { const nodes = []; if (it.cat !== lastCat) { nodes.push(h('div', { class: 'cat' }, it.cat)); lastCat = it.cat; } nodes.push(h('div', { 'data-i': i, onMousedown: e => { e.preventDefault(); input.value = ''; sug.classList.remove('open'); ask(it.t); } }, it.t)); return nodes; }));
    sug.classList.add('open');
  };
  input.addEventListener('focus', refresh); input.addEventListener('input', refresh); input.addEventListener('blur', () => setTimeout(() => sug.classList.remove('open'), 120));
  input.addEventListener('keydown', e => { if (!sug.classList.contains('open')) return; const opts = [...sug.querySelectorAll('div[data-i]')]; if (e.key === 'ArrowDown') { active = Math.min(active + 1, opts.length - 1); } else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); } else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); input.value = ''; sug.classList.remove('open'); ask(items[active].t); return; } else if (e.key === 'Escape') { sug.classList.remove('open'); return; } else return; e.preventDefault(); opts.forEach((o, i) => o.classList.toggle('active', i === active)); });
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.focus(); input.select(); } if ((e.ctrlKey || e.metaKey) && e.code === 'Space') { e.preventDefault(); voice.listen(); } if (e.key === 'Escape') { voice.stopSpeaking(); document.getElementById('drawer').classList.remove('open'); } });
  document.getElementById('quietBtn').addEventListener('click', () => { state.quiet = !state.quiet; voice.muted = state.quiet; if (state.quiet) voice.stopSpeaking(); document.getElementById('quietBtn').textContent = state.quiet ? '🔇 Quiet mode' : '🔈 Speech on'; toast(state.quiet ? 'Quiet mode: speech output off; every answer is still shown as text' : 'Speech output on'); });
  document.getElementById('helpBtn').addEventListener('click', () => { const b = document.getElementById('drawerBody'); document.getElementById('drawerTitle').textContent = 'Using Astra'; b.innerHTML = `<ul class="help-list"><li><b>Ctrl+K</b> focuses the command bar; <b>Enter</b> asks.</li><li><b>Ctrl+Space</b> or the orb: push to talk (browser speech; Azure AI Speech in live mode).</li><li><b>Wake word</b>: switch it on and say “Astra, …”.</li><li><b>Point and ask</b>: click a bar, point or region and choose “Why this?”.</li><li><b>Follow-up chips</b> under every answer reach the next insight in two taps.</li><li><b>How was this calculated?</b> opens the calculation and lineage drawer.</li><li><b>Esc</b> stops speech and closes drawers.</li><li>Demo clock: today is ${state.meta.today}.</li></ul>`; document.getElementById('drawer').classList.add('open'); });
}
function setupDrawer() { document.getElementById('drawerClose').addEventListener('click', () => document.getElementById('drawer').classList.remove('open')); }
// ---------- theme and model status ----------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme); document.body.setAttribute('data-theme', theme);
  localStorage.setItem('astra.theme', theme); setTheme(theme);
  const b = document.getElementById('themeBtn'); if (b) b.textContent = theme === 'light' ? '☾ Dark' : '☀ Light';
  document.getElementById('themeBtn').onclick = () => { applyTheme(theme === 'light' ? 'dark' : 'light'); show(state.screen, {}); };
}
function renderLlmChip(l) { const c = document.getElementById('llmChip'); if (!c) return; const err = l && l.lastError; c.textContent = l && l.configured ? (err ? `LLM: ${l.label} ⚠` : `LLM: ${l.label}`) : 'LLM: off'; c.title = l && l.configured ? (err ? `Last call failed: ${err.message}. Open Settings.` : `Language model from ${l.source}: ${l.label}. Open Settings to change.`) : 'No language model configured. Open Settings to connect one.'; c.onclick = () => go('settings'); c.style.borderColor = l && l.configured ? (err ? 'var(--bad)' : 'var(--good)') : ''; }
function setupVoice() {
  const orb = document.getElementById('orb'); const st = document.getElementById('orbState'); const tr = document.getElementById('transcript');
  voice = new Voice({
    onState: s => { orb.className = 'orb ' + s; st.textContent = { idle: voice.wake ? 'Say “Astra”' : 'Tap to talk', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking… (Esc to stop)' }[s] || s; },
    onTranscript: t => { tr.textContent = t ? '“' + t + '”' : ''; },
    onFinal: (text, err) => { if (err) { toast(err); tr.textContent = ''; return; } tr.textContent = '“' + text + '”'; ask(text); setTimeout(() => { tr.textContent = ''; }, 4000); },
    onWake: () => toast('Listening…')
  });
  if (!voice.supported) { st.textContent = 'Voice needs Edge or Chrome'; }
  orb.addEventListener('click', () => voice.listen());
  document.getElementById('wakeToggle').addEventListener('change', e => { voice.setWake(e.target.checked); st.textContent = e.target.checked ? 'Say “Astra”' : 'Tap to talk'; });
}

// ---------- asking ----------
let busy = false;
async function handleAsk(question, context) {
  if (busy) { toast('One moment, the agents are still working on the last question.'); return; }
  busy = true; voice.stopSpeaking(); voice.setState('thinking');
  const ctx = context || state.context || null; state.context = null;
  if (state.screen !== 'canvas') { go('canvas'); await new Promise(r => setTimeout(r, 60)); }
  const pending = canvas.showThinking(question);
  try {
    const a = await api('ask', { body: { question, persona: state.persona.id, session: state.session, context: ctx } });
    state.answers.push(a); state.lastAnswer = a;
    canvas.showAnswer(a, pending);
    if (a.kind === 'act') updateActionCount();
    if (a.kind === 'navigate' && a.screen) { setTimeout(() => go(a.screen), 300); }
    voice.setState('idle');
    if (a.spoken && !state.quiet) voice.speak(a.spoken);
  } catch (e) { canvas.showError(e.message, pending); voice.setState('idle'); }
  busy = false;
}
boot().catch(e => { console.error(e); main.replaceChildren(h('div', { class: 'card' }, h('h3', {}, 'Astra could not start'), h('div', { class: 'muted' }, esc(e.message) + '. Is the API running and the database seeded?'))); });
