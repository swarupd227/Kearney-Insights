'use strict';
// Parser and formatting tests: no database needed. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../server/agents/parser');
const { money, pct, pts } = require('../server/agents/util');
const personas = require('../server/personas');

const P = personas.byId;
const cases = [
  ['Are we on track for the year?', 'predict', {}, ['plan_attainment']],
  ['Why did realisation drop in DACH last quarter?', 'explain', { unit: 'DACH' }, ['billing_realisation'], 'last_quarter'],
  ['Show me utilisation by unit in Europe against plan for the last six months', 'lookup', { region: 'EUR' }, ['utilisation'], 'last_6m', 'unit', 'plan'],
  ['What if we raise rates by 3% in North America from January?', 'simulate', { unit: 'NA' }],
  ['Prepare me for my meeting with LIC tomorrow', 'client360', { client: 'LIC' }],
  ['Where will we lose the most Principals in the next six months, and why?', 'predict', { level: 'PRINCIPAL' }],
  ['Show me the highest-risk Principals', 'predict', { level: 'PRINCIPAL' }],
  ['How many hires does India need next year?', 'predict', { unit: 'IND' }],
  ['Show me what the agents did today', 'observatory', {}],
  ['Show me our service desk volumes by application', 'it_service', {}],
  ['Who can start on a procurement engagement in Riyadh on Monday?', 'match', { practice: 'PROC' }],
  ['Which units are below 70% utilisation at Associate level?', 'compare', { level: 'ASSOCIATE' }, ['utilisation'], null, 'unit'],
  ['Which of our top Financial Services clients buy from only one practice?', 'compare', { industry: 'FS' }],
  ['Which invoices are most likely to go past 90 days?', 'predict', {}],
  ['What should I do about it?', 'act', {}],
  ['Find me Kearney material on retail pricing in the Middle East', 'knowledge', { unit: 'ME' }]
];
for (const [q, intent, cut, metrics, period, groupBy, compare] of cases) {
  test(`parse: ${q}`, () => {
    const p = parse(q, { persona: P.mp });
    assert.strictEqual(p.intent, intent, `intent for "${q}" was ${p.intent}`);
    for (const [k, v] of Object.entries(cut)) assert.strictEqual(p.cut[k], v, `${k} for "${q}" was ${p.cut[k]}`);
    if (metrics) for (const m of metrics) assert.ok(p.metrics.includes(m), `metrics for "${q}" were ${p.metrics}`);
    if (period) assert.strictEqual(p.period, period);
    if (groupBy) assert.strictEqual(p.groupBy, groupBy);
    if (compare) assert.strictEqual(p.compare, compare);
  });
}
test('scenario extraction', () => {
  assert.deepStrictEqual(parse('What if we raise rates by 3% in North America from January?').scenario, { rate_pct: 3, start: '2027-01-01' });
  assert.strictEqual(parse('What happens to profit per partner if utilisation drops 3 points?').scenario.util_points, -3);
  assert.deepStrictEqual(parse('Freeze Associate hiring in Europe for two quarters').scenario.hiring_freeze, { level: 'ASSOCIATE', quarters: 2 });
  assert.deepStrictEqual(parse('If I add one Associate for four weeks, what happens to my margin?').scenario.add_staff, { count: 1, level: 'ASSOCIATE', weeks: 4 });
});
test('individual people flag and persona scope', () => {
  assert.ok(parse('Show me the flight risk of my colleagues', { persona: P.principal }).flags.individual_people);
  assert.ok(!parse('Where will we lose the most Principals?', { persona: P.cpo }).flags.individual_people);
  assert.deepStrictEqual(parse('Which of my engagements will overrun budget, and by when?', { persona: P.principal }).cut.engagement, ['E-1182', 'E-1207']);
});
test('formatting', () => {
  assert.strictEqual(money(2145000000), 'US$2.15 billion');
  assert.strictEqual(money(-5700000), '−US$5.7 million');
  assert.strictEqual(money(0.06), 'US$0.06');
  assert.strictEqual(pct(0.8364), '83.6%');
  assert.strictEqual(pts(-0.082), '-8.2 points');
});
