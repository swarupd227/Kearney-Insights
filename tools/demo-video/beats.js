// The demo storyboard: every beat is a persona, an action on the product and a narration line (spoken by the product's own voice).
// kind: 'home' loads the home screen for the persona; 'ask' types a question; 'screen' opens a screen by hash.
module.exports = [
  { id: 'A0', persona: 'mp', kind: 'home', caption: 'Home and morning brief · Managing Partner', say: 'This is Astra Insights for Kearney. The Managing Partner opens the day with a spoken brief: where the firm stands against plan, the engagements about to overrun, and the decisions waiting for approval.' },
  { id: 'A1', persona: 'mp', kind: 'ask', q: 'Are we on track for the year?', say: 'Every question is asked in plain words. The forecast comes with its uncertainty band and the chance of reaching plan, not a single number.' },
  { id: 'A2', persona: 'mp', kind: 'ask', q: 'Why is Europe behind plan?', say: 'Why is Europe behind? The gap is split by unit, then into volume and realisation effects. Every figure traces back to the source system.' },
  { id: 'A3', persona: 'mp', kind: 'ask', q: 'Break it down by practice', say: 'Follow-ups keep the context. The same gap, now allocated to practices.' },
  { id: 'A4', persona: 'mp', kind: 'ask', q: 'What if we raise rates by 3% in North America from January?', say: 'Leaders test decisions before taking them. The scenario lists every assumption it makes.' },
  { id: 'B0', persona: 'rmd_eur', kind: 'home', caption: 'Regional Managing Director, Europe', say: 'The Regional Managing Director for Europe investigates a decline in realisation.' },
  { id: 'B1', persona: 'rmd_eur', kind: 'ask', q: 'Why did realisation drop in DACH last quarter?', say: 'Write-offs, fixed-fee overruns and rate discounts, down to the three engagements that explain most of the change.' },
  { id: 'B2', persona: 'rmd_eur', kind: 'ask', q: 'Will it get worse?', say: 'Prediction at engagement level. E-1207 is likely to overrun in early November.' },
  { id: 'B3', persona: 'rmd_eur', kind: 'ask', q: 'What should I do about it?', say: 'An insight becomes action. Three drafts, each with an owner, a due date and its expected effect in dollars.' },
  { id: 'B4', persona: 'rmd_eur', kind: 'ask', q: 'Approve the first action', say: 'A person approves every action. Nothing leaves the product until they do.' },
  { id: 'B5', persona: 'rmd_eur', kind: 'screen', hash: '#/actions', caption: 'Action centre · the decision queue', say: 'The action centre is a decision queue. The predictions raise their own drafts every morning, ranked by expected effect, each with the evidence behind it.' },
  { id: 'C0', persona: 'gal', kind: 'home', caption: 'Global Account Leader', say: 'A Global Account Leader prepares for a client meeting tomorrow.' },
  { id: 'C1', persona: 'gal', kind: 'ask', q: 'Prepare me for my meeting with LIC tomorrow', say: 'One sentence replaces an afternoon of gathering: the public record, revenue, live work, open pipeline and satisfaction.' },
  { id: 'C2', persona: 'gal', kind: 'ask', q: 'Where is the white space?', say: 'The next-best practice, with the peer evidence behind it.' },
  { id: 'C3', persona: 'gal', kind: 'ask', q: 'Who in the firm has worked with them?', say: 'The firm’s collective relationships become visible, people by identifier.' },
  { id: 'D0', persona: 'cpo', kind: 'home', caption: 'Chief People Officer', say: 'The Chief People Officer looks six months ahead.' },
  { id: 'D1', persona: 'cpo', kind: 'ask', q: 'Where will we lose the most Principals in the next six months, and why?', say: 'Flight risk by unit and level, with its drivers. The Middle East carries the most. Individual scores are shown only to those entitled to see them.' },
  { id: 'D2', persona: 'cpo', kind: 'ask', q: 'How many hires does India need next year?', say: 'Hiring need by level, built from attrition, growth and the shape of the pyramid.' },
  { id: 'D3', persona: 'staffing', kind: 'ask', q: 'Who can start on a procurement engagement in Riyadh on Monday?', say: 'The staffing manager asks for people, not reports. A ranked match, with reasons, which the manager confirms.' },
  { id: 'E0', persona: 'knet', kind: 'ask', q: 'Show me what the agents did today', say: 'Finally, the agents themselves are governed. Every run, its cost, its response time and the accuracy of every model, with an audit trail.' },
  { id: 'E1', persona: 'knet', kind: 'ask', q: 'Show me our service desk volumes by application', say: 'Real IT service data flows through the same path. One product, one conversation, every role.' }
];
