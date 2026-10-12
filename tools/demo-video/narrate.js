// Synthesises one WAV per beat with the product's own Azure voice (token from the deployed app), and writes durations.json.
const fs = require('fs'); const path = require('path');
const BASE = (process.env.BASE || 'https://ca-astra-insights.proudsand-a3d86f71.northeurope.azurecontainerapps.io');
const OUT = path.join(__dirname, 'narration'); fs.mkdirSync(OUT, { recursive: true });
const beats = require('./beats');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
(async () => {
  const t = await (await fetch(BASE + '/api/speech/token')).json();
  if (t.provider !== 'azure') throw new Error('Azure voice not configured on the deployed app');
  const durations = {};
  for (const b of beats) {
    const file = path.join(OUT, b.id + '.wav');
    const ssml = `<speak version='1.0' xml:lang='en-GB'><voice name='${t.voice}'><prosody rate='-4%'>${esc(b.say)}</prosody></voice></speak>`;
    const r = await fetch(`https://${t.region}.tts.speech.microsoft.com/cognitiveservices/v1`, { method: 'POST', headers: { Authorization: 'Bearer ' + t.token, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm', 'User-Agent': 'astra-demo-video' }, body: ssml });
    if (!r.ok) throw new Error(`TTS ${b.id}: ${r.status} ${await r.text()}`);
    const buf = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(file, buf);
    durations[b.id] = Math.round(((buf.length - 44) / (24000 * 2)) * 100) / 100;
    console.log(b.id, durations[b.id] + 's', b.say.slice(0, 60));
  }
  fs.writeFileSync(path.join(__dirname, 'durations.json'), JSON.stringify(durations, null, 2));
  console.log('total narration', Object.values(durations).reduce((a, v) => a + v, 0).toFixed(1) + 's');
})().catch(e => { console.error(e); process.exit(1); });
