'use strict';
/**
 * Astra Insights for Kearney: server entry point.
 * Serves the single-page product from /public and the API from /api. On boot it migrates the schema and,
 * if the database is empty and SEED_ON_BOOT is true, loads the seed so a fresh Azure deployment is demo-ready without a separate step.
 */
const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const ref = require('./metrics/refcache');
const guardian = require('./agents/guardian');

async function main() {
  await db.migrate();
  const seeded = await db.isSeeded();
  if (!seeded && config.seedOnBoot) { console.log('Database is empty: loading the seed (about 30 seconds)…'); await require('./seed/load').load({ log: console.log }); }
  else console.log(`Seed version ${seeded || 'none'}`);
  await ref.load(); await guardian.init();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
  app.use('/api', require('./routes/api'));
  app.use('/vendor', express.static(path.join(__dirname, '..', 'public', 'vendor'), { maxAge: '1d', etag: true }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0, etag: true, cacheControl: true, setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
  app.listen(config.port, () => console.log(`Astra Insights for Kearney listening on :${config.port} (demo today ${config.demoToday}; Azure OpenAI ${config.llmEnabled ? 'on' : 'off'}; Azure Speech ${config.azureSpeechEnabled ? 'on' : 'off'})`));
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
