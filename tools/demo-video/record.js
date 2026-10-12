// Records the storyboard against the deployed app with Playwright (1920x1080 video). Each scene is bracketed by full-screen
// colour markers (magenta at start, cyan at end, held 1.1 s) so the cut points come from the frames, not the script clock.
// Writes segments.json: the webm path and, per scene, the caption and the moment (within the scene) the answer appeared.
const path = require('path'); const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const durations = require('./durations.json');
const beats = require('./beats').filter(b => !process.env.ONLY || process.env.ONLY.split(',').some(p => b.id.startsWith(p))); // ONLY=A,B records a subset for checks
const BASE = process.env.BASE || 'https://ca-astra-insights.proudsand-a3d86f71.northeurope.azurecontainerapps.io';
const OUT = path.join(__dirname, 'rec'); fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } }, colorScheme: 'dark' });
  // Dark theme, and the app letterboxed above the 92 px caption band that assemble.js draws, so the command bar stays visible while a question is typed.
  await context.addInitScript(() => { try { localStorage.setItem('astra.theme', 'dark'); } catch (e) {} document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '#app{height:calc(100vh - 92px)!important} html,body{background:var(--bg)}'; document.head.appendChild(s); }); });
  const page = await context.newPage();
  const scenes = [];
  const flash = async color => { await page.evaluate(c => { const d = document.createElement('div'); d.id = 'mk'; d.style.cssText = `position:fixed;inset:0;background:${c};z-index:99999`; document.body.appendChild(d); }, color); await sleep(1100); await page.evaluate(() => { const d = document.getElementById('mk'); if (d) d.remove(); }); };
  const mute = async () => { try { const b = page.locator('#quietBtn'); if ((await b.textContent()).includes('Speech on')) await b.click(); } catch (e) {} };
  const load = async (persona, hash) => {
    await page.goto(`${BASE}/?v=${Date.now()}${hash || '#/home'}`, { waitUntil: 'networkidle' });
    await page.evaluate(p => localStorage.setItem('astra.persona', p), persona);
    await page.reload({ waitUntil: 'networkidle' });
    await mute();
    await page.waitForSelector('.tile, .answer, .action, .card', { timeout: 30000 });
    await page.evaluate(() => { const m = document.getElementById('personaModal'); if (m) m.classList.remove('open'); });
    await sleep(1200);
  };
  let current = null;
  for (const b of beats) {
    const dwell = Math.max(6, (durations[b.id] || 5) + 1.5) * 1000;
    if (b.kind === 'home' || current !== b.persona) { await load(b.persona, b.kind === 'screen' ? b.hash : '#/home'); current = b.persona; }
    if (b.kind === 'screen' && !(b.kind === 'screen' && current === b.persona && page.url().includes(b.hash))) { await page.goto(`${BASE}/${b.hash}`, { waitUntil: 'networkidle' }); await mute(); await page.waitForSelector('.action, .card', { timeout: 30000 }); await sleep(900); }
    if (b.kind === 'home' || b.kind === 'screen') {
      await flash('#ff00ff'); const t = Date.now(); await sleep(dwell); scenes.push({ id: b.id, caption: b.caption, answerAt: 0.3 }); await flash('#00ffff');
      console.log(b.id, 'scene', ((Date.now() - t) / 1000).toFixed(1) + 's'); continue;
    }
    // ask: type the question like a presenter would, submit, wait for the answer card to replace the thinking card
    const before = await page.locator('.answer .headline').count();
    const input = page.locator('#cmdInput'); await input.click(); await input.fill('');
    await flash('#ff00ff'); const t = Date.now();
    await input.type(b.q, { delay: 28 }); await sleep(350); await input.press('Enter');
    await page.waitForFunction(n => document.querySelectorAll('.answer .headline').length > n, before, { timeout: 90000 });
    await sleep(300);
    const answerAt = (Date.now() - t) / 1000;
    await sleep(dwell);
    scenes.push({ id: b.id, caption: b.q, answerAt });
    await flash('#00ffff');
    console.log(b.id, 'answered at', answerAt.toFixed(1) + 's, scene', ((Date.now() - t) / 1000).toFixed(1) + 's');
  }
  await sleep(800);
  const video = page.video(); await context.close(); const file = await video.path(); await browser.close();
  fs.writeFileSync(path.join(__dirname, 'segments.json'), JSON.stringify({ file, scenes }, null, 2));
  console.log('recorded', file);
})().catch(e => { console.error(e); process.exit(1); });
