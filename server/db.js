'use strict';
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined,
  max: 10
});

// pg returns NUMERIC as strings; the product works in numbers.
const types = require('pg').types;
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));
types.setTypeParser(1082, v => v); // DATE as 'YYYY-MM-DD' string

async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}
async function one(text, params) {
  const rows = await query(text, params);
  return rows[0] || null;
}
async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}
async function isSeeded() {
  const r = await one(`SELECT value FROM seed_meta WHERE key='seed_version'`).catch(() => null);
  return r ? r.value : null;
}
// Bulk insert helper: rows is an array of objects with identical keys.
async function bulkInsert(table, rows, chunk = 500) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const values = [];
    const placeholders = slice.map((r, ri) => {
      return '(' + cols.map((c, ci) => { values.push(r[c]); return '$' + (ri * cols.length + ci + 1); }).join(',') + ')';
    });
    await pool.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${placeholders.join(',')} ON CONFLICT DO NOTHING`, values);
  }
}
module.exports = { pool, query, one, migrate, isSeeded, bulkInsert };
