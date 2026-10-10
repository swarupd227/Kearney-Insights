'use strict';
/**
 * Demo personas (eight, Section 8 screen 1) and the full role catalogue (27 roles in six tiers, Section 5).
 * A persona carries its data scope and policy; the Guardian enforces it. No person names: titles only.
 */
const PERSONAS = [
  {
    id: 'mp', title: 'Managing Partner and Chairman', tier: 1, titleSource: 'Public', short: 'Managing Partner',
    decides: 'Firm strategy, investment, partner admissions',
    scope: { level: 'firm' }, policy: { individual_people: false, partner_comp: 'aggregate', actions: true },
    headline: [
      { metric: 'net_fee_revenue', cut: {}, period: 'ytd', compare: 'plan' },
      { metric: 'plan_attainment', cut: {}, period: 'qtd' },
      { metric: 'profit_per_partner', cut: {}, period: 'ltm' },
      { metric: 'utilisation', cut: {}, period: 'last_quarter' },
      { metric: 'weighted_pipeline', cut: {}, period: 'open' },
      { metric: 'regretted_attrition', cut: {}, period: 'ltm' }
    ],
    home: 'Revenue against plan, profit per partner, region and practice heatmap, top risks',
    questions: ['Are we on track for the year, and what should I worry about most?', 'Why is Europe behind plan?', 'What if we raise rates by 3% in North America from January?', 'Compare revenue per partner across regions for the last three years'],
    defaultScreen: 'firm'
  },
  {
    id: 'cfo', title: 'Chief Financial Officer', tier: 1, titleSource: 'To confirm', short: 'CFO',
    decides: 'Forecast, pricing policy, cash, FX',
    scope: { level: 'firm' }, policy: { individual_people: false, partner_comp: 'aggregate', actions: true },
    headline: [
      { metric: 'net_fee_revenue', cut: {}, period: 'qtd', compare: 'plan' },
      { metric: 'contribution_margin', cut: {}, period: 'last_quarter' },
      { metric: 'lockup_days', cut: {}, period: 'now' },
      { metric: 'dso', cut: {}, period: 'now' },
      { metric: 'fx_impact', cut: {}, period: 'ytd' },
      { metric: 'write_off_rate', cut: {}, period: 'last_quarter' }
    ],
    home: 'Revenue and margin forecast, lock-up days, DSO, FX impact, write-offs',
    questions: ['Which units will miss plan this quarter, and by how much?', 'Forecast revenue to year end with the confidence band', 'Which invoices are most likely to go past 90 days?', 'Build me the variance bridge for Asia Pacific for September'],
    defaultScreen: 'forecast'
  },
  {
    id: 'rmd_eur', title: 'Regional Managing Director and Chair, Europe', tier: 2, titleSource: 'Public', short: 'RMD Europe',
    decides: 'Regional plan, hiring, cross-unit staffing',
    scope: { level: 'region', region: 'EUR' }, policy: { individual_people: false, partner_comp: 'none', actions: true },
    headline: [
      { metric: 'net_fee_revenue', cut: { region: 'EUR' }, period: 'qtd', compare: 'plan' },
      { metric: 'utilisation', cut: { region: 'EUR' }, period: 'last_quarter' },
      { metric: 'billing_realisation', cut: { region: 'EUR' }, period: 'last_quarter' },
      { metric: 'weighted_pipeline', cut: { region: 'EUR' }, period: 'open' },
      { metric: 'bench_rate', cut: { region: 'EUR' }, period: 'last_month' },
      { metric: 'engagement_score', cut: { region: 'EUR' }, period: 'now' }
    ],
    home: 'Unit league table, utilisation, pipeline coverage, bench, cross-border staffing',
    questions: ['Show me utilisation by unit in Europe against plan for the last six months', 'Why did realisation drop in DACH last quarter?', 'Will it get worse?', 'What should I do about it?'],
    defaultScreen: 'region'
  },
  {
    id: 'gpc_da', title: 'Global Practice Chair, Digital and Analytics', tier: 3, titleSource: 'Public', short: 'Practice Chair D&A',
    decides: 'Offer investment, IP, partner hiring in the practice',
    scope: { level: 'practice', practice: 'DA' }, policy: { individual_people: false, partner_comp: 'none', actions: true },
    headline: [
      { metric: 'net_fee_revenue', cut: { practice: 'DA' }, period: 'ytd', compare: 'ly' },
      { metric: 'revenue_growth', cut: { practice: 'DA' }, period: 'ytd' },
      { metric: 'win_rate', cut: { practice: 'DA' }, period: 'ltm' },
      { metric: 'ip_reuse_rate', cut: { practice: 'DA' }, period: 'ltm' },
      { metric: 'weighted_pipeline', cut: { practice: 'DA' }, period: 'open' },
      { metric: 'staffing_fill_rate', cut: { practice: 'DA' }, period: 'now' }
    ],
    home: 'Practice revenue and growth, win rate, IP reuse, skills supply against demand',
    questions: ['Which offers are growing fastest, and do we have the people to staff them?', 'Which practices grew fastest in the Middle East?', 'Do we have enough agentic AI skills to staff the open Digital and Analytics pipeline?', 'Show me win rate by practice for the last year'],
    defaultScreen: 'practice'
  },
  {
    id: 'gal', title: 'Global Account Leader, Life Insurance Corporation of India', tier: 4, titleSource: 'To confirm', short: 'Global Account Leader',
    decides: 'Long-term client strategy and multi-practice pursuits',
    scope: { level: 'accounts', accounts: ['LIC'], unit: 'IND' }, policy: { individual_people: false, partner_comp: 'own', actions: true },
    headline: [
      { metric: 'net_fee_revenue', cut: { client: 'LIC' }, period: 'ytd', compare: 'ly' },
      { metric: 'account_growth', cut: { client: 'LIC' }, period: 'ytd' },
      { metric: 'weighted_pipeline', cut: { client: 'LIC' }, period: 'open' },
      { metric: 'cross_practice_penetration', cut: { client: 'LIC' }, period: 'ltm' },
      { metric: 'client_satisfaction', cut: { client: 'LIC' }, period: 'now' },
      { metric: 'relationship_breadth', cut: { client: 'LIC' }, period: 'now' }
    ],
    home: 'Account 360: revenue history, relationship map, pipeline, satisfaction, white space',
    questions: ['Prepare me for my meeting with LIC tomorrow', 'Where is the white space?', 'Who in the firm has worked with them?', 'Send me a short audio brief for the car'],
    defaultScreen: 'account'
  },
  {
    id: 'principal', title: 'Principal, DACH', tier: 5, titleSource: 'Career guide', short: 'Principal',
    decides: 'Day-to-day engagement economics, team and client relationships',
    scope: { level: 'engagements', unit: 'DACH', engagements: ['E-1182', 'E-1207'] }, policy: { individual_people: false, partner_comp: 'none', actions: true },
    headline: [
      { metric: 'budget_burn', cut: { engagement: 'E-1182' }, period: 'now' },
      { metric: 'eac', cut: { engagement: 'E-1182' }, period: 'now' },
      { metric: 'billing_realisation', cut: { engagement: 'E-1182' }, period: 'last_quarter' },
      { metric: 'engagement_margin', cut: { engagement: 'E-1182' }, period: 'ltd' },
      { metric: 'staffing_fill_rate', cut: { unit: 'DACH' }, period: 'now' },
      { metric: 'time_entry_compliance', cut: { engagement: 'E-1182' }, period: 'last_month' }
    ],
    home: 'Engagement burn, estimate at completion, realisation forecast, staffing gaps',
    questions: ['Which of my engagements will overrun budget, and by when?', 'If I add one Associate for four weeks, what happens to my margin?', 'Show me the flight risk of my colleagues', 'Who on my team has worked more than 60 hours for three weeks?'],
    defaultScreen: 'engagements'
  },
  {
    id: 'cpo', title: 'Chief People Officer', tier: 6, titleSource: 'To confirm', short: 'CPO',
    decides: 'Talent strategy, pyramid, retention',
    scope: { level: 'firm' }, policy: { individual_people: true, partner_comp: 'none', actions: true },
    headline: [
      { metric: 'regretted_attrition', cut: {}, period: 'ltm' },
      { metric: 'leverage', cut: {}, period: 'now' },
      { metric: 'sustained_hours', cut: {}, period: 'last_month' },
      { metric: 'engagement_score', cut: {}, period: 'now' },
      { metric: 'promotion_velocity', cut: {}, period: 'now' },
      { metric: 'recruiting_conversion', cut: {}, period: 'ytd' }
    ],
    home: 'Headcount against plan, regretted attrition, flight-risk heatmap, promotion pipeline',
    questions: ['Where will we lose the most Principals in the next six months, and why?', 'Show me the highest-risk Principals', 'How many hires does India need next year?', 'How does our pyramid in Asia Pacific compare with last year?'],
    defaultScreen: 'talent'
  },
  {
    id: 'staffing', title: 'Staffing manager', tier: 6, titleSource: 'To confirm', short: 'Staffing manager',
    decides: 'Who works where next',
    scope: { level: 'firm' }, policy: { individual_people: 'availability', partner_comp: 'none', actions: true },
    headline: [
      { metric: 'staffing_fill_rate', cut: {}, period: 'now' },
      { metric: 'time_to_staff', cut: {}, period: 'ltm' },
      { metric: 'bench_rate', cut: {}, period: 'last_month' },
      { metric: 'utilisation', cut: {}, period: 'last_month' },
      { metric: 'sustained_hours', cut: {}, period: 'last_month' },
      { metric: 'learning_hours', cut: {}, period: 'last_quarter' }
    ],
    home: 'Supply and demand by skill and week, bench list, roll-off calendar',
    questions: ['Who can start on a procurement engagement in Riyadh on Monday?', 'Show me Associates with SAP experience rolling off in the next three weeks', 'Which units are below 70% utilisation at Associate level?', 'What is the fill rate for open roles this month?'],
    defaultScreen: 'staffing'
  }
];
// The KNet leader is not one of the eight carousel personas but storyline E needs it; it is available by name.
PERSONAS.push({
  id: 'knet', title: 'KNet leader (Chief Information Officer)', tier: 6, titleSource: 'RFP pack (KNet)', short: 'KNet leader',
  decides: 'IT spend, adoption, service quality', scope: { level: 'firm' }, policy: { individual_people: false, partner_comp: 'none', actions: true },
  headline: [
    { metric: 'overhead_ratio', cut: {}, period: 'ltm' }, { metric: 'knowledge_search_success', cut: {}, period: 'ltm' }, { metric: 'time_entry_compliance', cut: {}, period: 'last_month' }
  ],
  home: 'IT cost per head, application adoption, ticket volumes, agent usage',
  questions: ['Show me what the agents did today', 'What can the Action Agent change?', 'Show me our service desk volumes by application', 'Which applications do fewer than 20% of licensed users open?'],
  defaultScreen: 'observatory', hidden: true
});

const ROLES = [
  { tier: 1, role: 'Managing Partner and Chairman', source: 'Public', decides: 'Firm strategy, investment, partner admissions', persona: 'mp' },
  { tier: 1, role: 'Board member', source: 'Public', decides: 'Oversight, partner compensation policy, capital' },
  { tier: 1, role: 'Global Vice Chair, Strategy and Corporate Development', source: 'Public', decides: 'Acquisitions and their integration' },
  { tier: 1, role: 'Chief Financial Officer', source: 'To confirm', decides: 'Forecast, pricing policy, cash, FX', persona: 'cfo' },
  { tier: 1, role: 'Chief Operating Officer', source: 'To confirm', decides: 'Operating model and business-services cost' },
  { tier: 2, role: 'Regional Managing Director and Chair', source: 'Public', decides: 'Regional plan, hiring, cross-unit staffing', persona: 'rmd_eur' },
  { tier: 2, role: 'Office or unit leader', source: 'To confirm', decides: 'Local hiring, pricing, partner coaching' },
  { tier: 3, role: 'Global Practice Chair', source: 'Public', decides: 'Offer investment, IP, partner hiring in the practice', persona: 'gpc_da' },
  { tier: 3, role: 'Industry practice leader', source: 'To confirm', decides: 'Account strategy and sector priorities' },
  { tier: 3, role: 'Leader of a Kearney company', source: 'Public (company names)', decides: 'Growth and integration of the company' },
  { tier: 4, role: 'Global Account Leader', source: 'To confirm', decides: 'Long-term client strategy and multi-practice pursuits', persona: 'gal' },
  { tier: 4, role: 'Partner', source: 'Public', decides: 'Selling and leading engagements; developing people' },
  { tier: 4, role: 'Associate Partner', source: 'Career guide', decides: 'Leading engagements and building client relationships' },
  { tier: 4, role: 'Partner compensation committee member', source: 'To confirm', decides: 'Partner evaluation and distribution' },
  { tier: 5, role: 'Principal', source: 'Career guide', decides: 'Day-to-day engagement economics, team and client relationships', persona: 'principal' },
  { tier: 5, role: 'Manager or Senior Manager', source: 'Career guide', decides: 'Workplan, team health, billing readiness' },
  { tier: 5, role: 'Associate', source: 'Career guide', decides: 'Own development and next engagement' },
  { tier: 5, role: 'Business Analyst or Senior Business Analyst', source: 'Career guide', decides: 'Own development and use of knowledge' },
  { tier: 6, role: 'Chief People Officer', source: 'To confirm', decides: 'Talent strategy, pyramid, retention', persona: 'cpo' },
  { tier: 6, role: 'Staffing or resource manager', source: 'To confirm', decides: 'Who works where next', persona: 'staffing' },
  { tier: 6, role: 'Recruiting lead', source: 'To confirm', decides: 'Hiring plan and campus programme' },
  { tier: 6, role: 'Finance business partner or FP&A analyst', source: 'To confirm', decides: 'Forecast and variance reporting' },
  { tier: 6, role: 'Billing and collections lead', source: 'To confirm', decides: 'Invoicing and cash' },
  { tier: 6, role: 'Marketing and research lead', source: 'To confirm', decides: 'Campaigns and research publications' },
  { tier: 6, role: 'Knowledge management lead', source: 'To confirm', decides: 'IP curation and search' },
  { tier: 6, role: 'KNet leader (Chief Information Officer)', source: 'RFP pack (KNet)', decides: 'IT spend, adoption, service quality', persona: 'knet' },
  { tier: 6, role: 'Risk, legal and conflicts lead', source: 'To confirm', decides: 'Client acceptance, conflicts, contract risk' }
];
const TIER_NAMES = { 1: 'Firm leadership', 2: 'Regional and office leaders', 3: 'Practice leaders', 4: 'Partners', 5: 'Delivery teams', 6: 'Business services' };
const byId = Object.fromEntries(PERSONAS.map(p => [p.id, p]));
module.exports = { PERSONAS, ROLES, TIER_NAMES, byId };
