// Presenter runbook: the five storylines from Section 10 of the specification, with persona switch and click-to-run prompts.
import { state, api, h, ask, screenHead, toast } from '../ui.js';
const STORYLINES = [
  { id: 'A', title: 'The Managing Partner checks whether the firm is on track', minutes: 3, persona: 'mp', intro: 'Select the persona: the product speaks the morning brief first.', steps: [
    { say: 'Are we on track for the year?', does: 'Opens the full-year forecast band against plan', point: 'Forecasts come with their uncertainty, not a single number' },
    { say: 'Why is Europe behind plan?', does: 'Variance bridge for Europe by unit, then volume and realisation effects', point: 'Point and ask: click Europe on the firm pulse map and say “Why?” for the same answer' },
    { say: 'Break it down by practice', does: 'Allocates the plan to practices and names what is bringing it down', point: 'Follow-ups keep the context' },
    { say: 'What if we raise rates by 3% in North America from January?', does: 'Runs the scenario and lists every assumption', point: 'Leaders can test decisions before taking them' }] },
  { id: 'B', title: 'The Regional Managing Director for Europe investigates a realisation decline', minutes: 3, persona: 'rmd_eur', steps: [
    { say: 'Why did realisation drop in DACH last quarter?', does: 'Splits the decline into write-offs, fixed-fee overruns and rate discounts and names the engagements', point: 'The answer explains why, at engagement level' },
    { say: 'Will it get worse?', does: 'Engagement Health forecast with predicted overrun dates', point: 'Prediction at engagement level' },
    { say: 'What should I do about it?', does: 'Drafts a pricing review, a staffing change and a note to the engagement partners', point: 'An insight becomes an action' },
    { say: 'Approve the first action', does: 'Records the approval in the connector stub; the other drafts stay pending', point: 'A person approves every action' }] },
  { id: 'C', title: 'A Global Account Leader prepares for a meeting with Life Insurance Corporation of India', minutes: 3, persona: 'gal', steps: [
    { say: 'Prepare me for my meeting with LIC tomorrow', does: 'Builds the account 360: public work sourced, financials from the connectors', point: 'One sentence replaces an afternoon of gathering' },
    { say: 'Where is the white space?', does: 'Next-best practice with the peer evidence behind it', point: 'Cross-selling with reasons' },
    { say: 'Who in the firm has worked with them?', does: 'Relationship map from CRM contacts and engagement history, people by identifier', point: 'The firm’s collective relationships become visible' },
    { say: 'Send me a short audio brief for the car', does: 'Produces the audio brief and attaches it to the meeting', point: 'The product works where the partner works' }] },
  { id: 'D', title: 'The Chief People Officer finds where talent is at risk', minutes: 3, persona: 'cpo', steps: [
    { say: 'Where will we lose the most Principals in the next six months, and why?', does: 'Flight-risk heatmap by unit and level with the top drivers', point: 'Predictive people analytics with reasons' },
    { say: 'Show me the highest-risk Principals', does: 'Lists them by identifier with drivers, because this role is authorised', point: 'Detail is available to those entitled to it' },
    { say: 'Show me the flight risk of my colleagues', persona: 'principal', does: 'The Guardian blocks the request, explains why, and records the block', point: 'Trust is built into the product' },
    { say: 'How many hires does India need next year?', persona: 'cpo', does: 'Hiring need forecast by level, linked to the skill demand forecast', point: 'Planning, not only reporting' }] },
  { id: 'E', title: 'The KNet leader sees that the agents are governed', minutes: 2, persona: 'knet', steps: [
    { say: 'Show me what the agents did today', does: 'Observatory: runs, response times, cost per answer, model accuracy, Guardian blocks', point: 'Agents are visible and accountable' },
    { say: 'What can the Action Agent change?', does: 'Draft-only rights, named approvers, permitted connectors', point: 'The same autonomy model as the managed-services proposal' },
    { say: 'Show me our service desk volumes by application', does: 'Ticket volumes through the ServiceNow path', point: 'IT service data flows through the same product' },
    { say: 'How was this calculated?', does: 'Lineage from the source through the lakehouse to the visual', point: 'This runs on the data estate we will manage under B4' }] }
];
export async function render(root) {
  const all = [...state.meta.personas, ...state.meta.hiddenPersonas];
  const byId = Object.fromEntries(all.map(p => [p.id, p]));
  const switchTo = async (id) => { if (state.persona.id === id) return; localStorage.setItem('astra.persona', id); location.reload(); };
  const cards = STORYLINES.map(s => h('div', { class: 'card' },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } }, h('h3', {}, `Storyline ${s.id} · ${s.title}`), h('span', { class: 'muted small' }, `${s.minutes} minutes · ${byId[s.persona].title}`)),
    s.intro ? h('div', { class: 'muted small', style: { margin: '4px 0 8px' } }, s.intro) : null,
    h('div', { class: 'chips', style: { marginBottom: '10px' } }, h('button', { class: 'btn small' + (state.persona.id === s.persona ? ' primary' : ''), onClick: () => switchTo(s.persona) }, state.persona.id === s.persona ? '● Persona active' : 'Switch to ' + byId[s.persona].short)),
    h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Presenter says'), h('th', {}, 'Product does'), h('th', {}, 'Point to make'))), h('tbody', {}, ...s.steps.map((st, i) => h('tr', {}, h('td', {}, String(i + 1)), h('td', {}, h('button', { class: 'chip', title: st.persona && st.persona !== state.persona.id ? 'Switches persona first' : 'Run this prompt', onClick: async () => { if (st.persona && st.persona !== state.persona.id) { localStorage.setItem('astra.persona', st.persona); sessionStorage.setItem('astra.pendingAsk', st.say); location.reload(); return; } ask(st.say); } }, '✦ ' + st.say), st.persona && st.persona !== s.persona ? h('div', { class: 'muted small' }, 'as ' + byId[st.persona].short) : null), h('td', { class: 'small' }, st.does), h('td', { class: 'small muted' }, st.point)))))));
  const fallback = h('div', { class: 'card', style: { background: 'var(--surface-2)' } }, h('h3', {}, 'Fallbacks'), h('ul', { class: 'small', style: { margin: '6px 0 0 16px' } }, h('li', {}, 'Room acoustics: type the same prompts in the command bar (Ctrl+K); the script works unchanged.'), h('li', {}, 'Slow network: switch the planner off in Settings (sub-second answers) or set the provider to None.'), h('li', {}, 'One team member drives the screen while the presenter speaks; the chips above are the driver’s click list.'), h('li', {}, 'Opening line: “Everything you will see about Kearney’s structure is real: your 17 units, your offices and their user counts, your practices and your public client work. The financial, people and pipeline values come from the connectors; when we connect to SAP, Workday, IEM and Salesforce, the same screens and agents run on your data.”')));
  root.replaceChildren(screenHead('Presenter runbook', 'Five storylines, about 14 minutes · click a prompt to run it; switching persona reloads the product in about two seconds'), h('div', { class: 'grid', style: { gap: '14px' } }, ...cards, fallback));
}
