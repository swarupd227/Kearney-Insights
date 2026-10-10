'use strict';
// Runtime settings stored in Postgres (app_settings) and cached in memory: LLM connection, UI preferences.
const db = require('./db');
const cache = new Map();
let loaded = false;
async function loadAll() { const rows = await db.query('SELECT key, value FROM app_settings').catch(() => []); cache.clear(); rows.forEach(r => cache.set(r.key, r.value)); loaded = true; }
async function get(key, fallback = null) { if (!loaded) await loadAll(); return cache.has(key) ? cache.get(key) : fallback; }
async function set(key, value, by = null) { await db.query('INSERT INTO app_settings (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by', [key, JSON.stringify(value), by]); cache.set(key, value); }
module.exports = { get, set, loadAll };
