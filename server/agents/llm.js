'use strict';
/**
 * Language-model client, configured from the app's Settings screen (stored in app_settings) or from environment variables.
 * Providers: Azure OpenAI (the specification's default), OpenAI, Anthropic Claude (official SDK).
 * Prompts only: no training or tuning on Kearney data. Used for narrative polish (with a citation check that rejects any
 * number the model did not receive), for planning questions the dictionaries cannot resolve, and for grounded conversation.
 */
const config = require('../config');
const settings = require('../settings');
const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_MODELS = { 'azure-openai': 'gpt-4o-mini', openai: 'gpt-4o-mini', anthropic: 'claude-opus-5-5' };
let anthropicClient = null; let anthropicKey = null;

async function current() {
  const s = await settings.get('llm', null);
  if (s && s.provider && s.provider !== 'none') return { ...s, model: s.model || DEFAULT_MODELS[s.provider], source: 'settings' };
  if (config.azureOpenAI.endpoint && config.azureOpenAI.apiKey) return { provider: 'azure-openai', endpoint: config.azureOpenAI.endpoint, apiKey: config.azureOpenAI.apiKey, model: config.azureOpenAI.deployment, apiVersion: config.azureOpenAI.apiVersion, source: 'environment' };
  if (process.env.ANTHROPIC_API_KEY) return { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL || DEFAULT_MODELS.anthropic, source: 'environment' };
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || DEFAULT_MODELS.openai, endpoint: process.env.OPENAI_BASE_URL || 'https://api.openai.com', source: 'environment' };
  return { provider: 'none', source: 'none' };
}
async function enabled() { return (await current()).provider !== 'none'; }
async function status() { const c = await current(); return { provider: c.provider, model: c.model || null, endpoint: c.endpoint ? c.endpoint.replace(/\/+$/, '') : null, configured: c.provider !== 'none', source: c.source, keyMasked: c.apiKey ? c.apiKey.slice(0, 4) + '…' + c.apiKey.slice(-4) : null, label: labelFor(c), lastError: c.provider !== 'none' ? lastError : null, paused: Date.now() < pausedUntil }; }
function labelFor(c) { if (c.provider === 'none') return 'off'; return `${{ 'azure-openai': 'Azure OpenAI', openai: 'OpenAI', anthropic: 'Anthropic Claude' }[c.provider]} · ${c.model}`; }

// Real token usage and cost per call, drained by the Conductor after each question (US$ per million tokens, input/output).
const PRICES = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5], 'claude-opus-5': [5, 25], 'claude-sonnet-5': [2, 10], 'gpt-4o-mini': [0.15, 0.6], 'gpt-4o': [2.5, 10], 'gpt-4.1': [2, 8], 'gpt-4.1-mini': [0.4, 1.6], 'o4-mini': [1.1, 4.4] };
let usageLog = [];
function recordUsage(model, input, output, ms) { const p = PRICES[model] || PRICES[Object.keys(PRICES).find(k => model && model.startsWith(k))] || [2, 10]; usageLog.push({ model, input, output, cost: (input * p[0] + output * p[1]) / 1e6, ms }); }
function takeUsage() { const u = usageLog; usageLog = []; return { calls: u.length, input: u.reduce((a, x) => a + x.input, 0), output: u.reduce((a, x) => a + x.output, 0), cost: u.reduce((a, x) => a + x.cost, 0), ms: u.reduce((a, x) => a + x.ms, 0) }; }

/**
 * chat(messages, opts) -> string | object (json) | null. messages: [{role:'system'|'user'|'assistant', content}]
 */
let lastError = null; let pausedUntil = 0;
async function chat(messages, { json = false, maxTokens = 600, temperature = 0.2, effort = 'low' } = {}) {
  const c = await current();
  if (c.provider === 'none') return null;
  if (Date.now() < pausedUntil) return null; // authentication failed recently; do not retry on every question
  try {
    const out = c.provider === 'anthropic' ? await anthropicChat(c, messages, { json, maxTokens, effort }) : await openAiChat(c, messages, { json, maxTokens, temperature });
    lastError = null; return out;
  } catch (e) {
    lastError = { message: e.message.split('\n')[0].slice(0, 160), at: new Date().toISOString(), provider: c.provider };
    if (/^40[13]\b/.test(e.message) || e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) pausedUntil = Date.now() + 60000;
    console.error('LLM error:', lastError.message); return null;
  }
}
function clearError() { lastError = null; pausedUntil = 0; }
async function openAiChat(c, messages, { json, maxTokens, temperature }) {
  const azure = c.provider === 'azure-openai';
  const base = (c.endpoint || 'https://api.openai.com').replace(/\/+$/, '');
  const url = azure ? `${base}/openai/deployments/${c.model}/chat/completions?api-version=${c.apiVersion || '2024-10-21'}` : `${base}/v1/chat/completions`;
  const headers = { 'Content-Type': 'application/json', ...(azure ? { 'api-key': c.apiKey } : { Authorization: `Bearer ${c.apiKey}` }) };
  const body = { messages, max_tokens: maxTokens, temperature }; if (!azure) body.model = c.model; if (json) body.response_format = { type: 'json_object' };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 20000); const t0 = Date.now();
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json(); const text = data.choices?.[0]?.message?.content || '';
    if (data.usage) recordUsage(c.model, data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0, Date.now() - t0);
    return json ? safeJson(text) : text;
  } finally { clearTimeout(timer); }
}
function anthropic(c) { if (!anthropicClient || anthropicKey !== c.apiKey) { anthropicClient = new Anthropic({ apiKey: c.apiKey, maxRetries: 1, timeout: 30000 }); anthropicKey = c.apiKey; } return anthropicClient; }
async function anthropicChat(c, messages, { json, maxTokens, effort }) {
  const client = anthropic(c);
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n') + (json ? '\n\nRespond with a single JSON object and nothing else.' : '');
  const turns = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
  const params = { model: c.model, max_tokens: Math.max(256, maxTokens), system, messages: turns, output_config: { effort } };
  const t0 = Date.now();
  let res;
  try {
    // Server-side refusal fallback (routes a declined request to a fallback model inside the same call); falls back to the plain endpoint if the account or model rejects the beta.
    res = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (e) {
    if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError) res = await client.messages.create(params); else throw e;
  }
  if (res.usage) recordUsage(c.model, (res.usage.input_tokens || 0) + (res.usage.cache_read_input_tokens || 0) + (res.usage.cache_creation_input_tokens || 0), res.usage.output_tokens || 0, Date.now() - t0);
  if (res.stop_reason === 'refusal') return null;
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return json ? safeJson(text) : text;
}
function safeJson(t) { if (!t) return null; try { return JSON.parse(t); } catch (e) { const m = t.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch (e2) { return null; } } return null; } }

async function test(override) {
  const c = override && override.provider && override.provider !== 'none' ? { ...override, model: override.model || DEFAULT_MODELS[override.provider] } : await current();
  if (c.provider === 'none') return { ok: false, error: 'No provider configured' };
  const t0 = Date.now();
  try {
    const out = c.provider === 'anthropic' ? await anthropicChat(c, [{ role: 'user', content: 'Reply with the single word OK.' }], { json: false, maxTokens: 256, effort: 'low' }) : await openAiChat(c, [{ role: 'user', content: 'Reply with the single word OK.' }], { json: false, maxTokens: 20, temperature: 0 });
    return { ok: true, model: c.model, provider: c.provider, reply: (out || '').trim().slice(0, 60), ms: Date.now() - t0 };
  } catch (e) {
    let error = e.message;
    if (e instanceof Anthropic.AuthenticationError) error = 'Authentication failed: check the API key';
    else if (e instanceof Anthropic.NotFoundError) error = 'Model not found: check the model ID';
    else if (e instanceof Anthropic.RateLimitError) error = 'Rate limited by the provider';
    else if (e instanceof Anthropic.APIError) error = `API error ${e.status}: ${e.message}`;
    return { ok: false, error, ms: Date.now() - t0 };
  }
}

// Citation check: the polished narrative may only contain numbers that appear in the allowed list.
function numbersIn(text) { return (text.match(/\d[\d,.]*/g) || []).map(s => s.replace(/,/g, '').replace(/\.$/, '')); }
async function polishNarrative(draft, allowedNumbers, { language = 'en' } = {}) {
  if (!(await enabled())) return { text: draft, polished: false, citation: 'pass (template)' };
  const out = await chat([
    { role: 'system', content: 'You rewrite a short spoken analytics answer for a management consulting partner. Keep every number exactly as given, add no new numbers, keep under 60 words, one finding, one number, one suggestion. Plain words, no markdown.' + (language !== 'en' ? ` Answer in language code ${language}.` : '') },
    { role: 'user', content: draft }
  ], { maxTokens: 300 });
  if (!out) return { text: draft, polished: false, citation: 'pass (template)' };
  const allowed = new Set(allowedNumbers.map(String));
  const bad = numbersIn(out).filter(n => !allowed.has(n) && !allowed.has(String(parseFloat(n))));
  if (bad.length) return { text: draft, polished: false, citation: `blocked: model introduced ${bad.join(', ')}` };
  return { text: out.trim(), polished: true, citation: 'pass (LLM, checked)' };
}
async function planFallback(question, { metricIds, dims, persona, hint }) {
  if (!(await enabled())) return null;
  return chat([
    { role: 'system', content: `You are the Conductor of an analytics product for a management consulting partnership. Convert the question into a JSON plan for the analytics engine. Keys: intent (one of lookup, compare, explain, predict, simulate, act, brief, match, client360, knowledge, observatory, it_service, chat), metrics (array of metric ids), cut (object with any of region, unit, practice, industry, level, client), groupBy (one of month, quarter, year, region, unit, office, practice, industry, level, client, engagement or null), period (one of last_month, last_quarter, qtd, ytd, ltm, last_6m, last_3y or null), compare (plan, ly or null), reason (one short sentence). Intent guide: explain = why a metric moved; predict = forecasts, risks, probabilities, who will leave, what will overrun; simulate = what-if; act = draft actions; client360 = a named client, meeting preparation, white space, relationships; match = who can staff a role; brief = the morning brief; chat = a conversational question or a concept explanation with no data request. Valid metric ids: ${metricIds.join(', ')}. Valid dimension members: ${JSON.stringify(dims)}. The user is the ${persona.title}.${hint ? ` A dictionary parser suggests this plan; keep it unless the question clearly means something else: ${JSON.stringify(hint)}.` : ''}` },
    { role: 'user', content: question }
  ], { json: true, maxTokens: 400 });
}
async function converse(question, { persona, lastAnswer, history }) {
  if (!(await enabled())) return null;
  return chat([
    { role: 'system', content: `You are Astra, the insights assistant of Kearney, a management consulting partnership, speaking to the ${persona.title}. Answer in under 120 words, plain words, no markdown. You may explain consulting economics (revenue per partner, leverage, utilisation, realisation, lock-up) and what the product can do (metrics, forecasts, variance bridges, scenarios, staffing matches, drafted actions). Do not invent any figure about the firm: cite numbers only from the context below, otherwise say that the Query Agent can look it up and suggest the exact question to ask.\n\nContext from the last answer: ${lastAnswer ? lastAnswer.slice(0, 1200) : 'none'}` },
    ...(history || []).slice(-4).map(h => ({ role: 'user', content: h })),
    { role: 'user', content: question }
  ], { maxTokens: 400, effort: 'low' });
}
module.exports = { chat, polishNarrative, planFallback, converse, enabled, status, test, current, takeUsage, clearError, DEFAULT_MODELS };
