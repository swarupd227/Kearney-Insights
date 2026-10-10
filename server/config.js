'use strict';
require('dotenv').config();

function bool(v, d) { if (v === undefined || v === '') return d; return /^(1|true|yes)$/i.test(v); }

const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgres://astra:astra@localhost:5433/astra',
  pgSsl: bool(process.env.PGSSL, /azure\.com/.test(process.env.DATABASE_URL || '')),
  // Frozen demo clock. "Today" in the product is this date so that rehearsals and the orals show the same values.
  demoToday: process.env.DEMO_TODAY || '2026-10-13',
  demoMode: bool(process.env.DEMO_MODE, true),
  seedVersion: process.env.SEED_VERSION || '1.0.0',
  seedOnBoot: bool(process.env.SEED_ON_BOOT, true),
  // Optional Azure OpenAI (Conductor planning and narrative polish). The product works without it.
  azureOpenAI: {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
    apiKey: process.env.AZURE_OPENAI_API_KEY || '',
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-mini',
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21'
  },
  // Optional Azure AI Speech (in-tenant speech). Browser speech is the fallback.
  azureSpeech: {
    key: process.env.AZURE_SPEECH_KEY || '',
    region: process.env.AZURE_SPEECH_REGION || ''
  }
};
config.llmEnabled = Boolean(config.azureOpenAI.endpoint && config.azureOpenAI.apiKey);
config.azureSpeechEnabled = Boolean(config.azureSpeech.key && config.azureSpeech.region);
module.exports = config;
