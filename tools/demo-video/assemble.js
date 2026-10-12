// Cuts the recording at the colour markers, lays the narration and a caption on each scene, and concatenates
// intro + scenes + outro into the final MP4 (1920x1080, 25 fps, AAC stereo). Every cut uses identical encoding so the
// final concat is a stream copy.
const fs = require('fs'); const path = require('path'); const { execFileSync, spawnSync } = require('child_process');
const here = __dirname; const seg = require('./segments.json'); const durations = require('./durations.json');
const FINAL = process.env.FINAL || path.join(here, 'Astra-Insights-for-Kearney-demo.mp4');
const CUTS = path.join(here, 'cuts'); fs.rmSync(CUTS, { recursive: true, force: true }); fs.mkdirSync(CUTS, { recursive: true });
const FPS = 25; const FONT = 'segoeui.ttf'; // copied next to this script by branding.ps1; a drive-letter colon inside a filtergraph is not parsed reliably on Windows
process.chdir(here);

// 1. Classify every frame by mean colour (decode at 16x9 to keep it cheap) and pair magenta runs with the next cyan run.
const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', seg.file, '-vf', `fps=${FPS},scale=16:9`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 }).stdout;
const n = Math.floor(raw.length / (16 * 9 * 3)); const cls = new Array(n);
for (let f = 0; f < n; f++) { let r = 0, g = 0, b = 0; const o = f * 432; for (let i = 0; i < 432; i += 3) { r += raw[o + i]; g += raw[o + i + 1]; b += raw[o + i + 2]; } r /= 144; g /= 144; b /= 144; cls[f] = (r > 180 && b > 180 && g < 90) ? 'M' : (g > 180 && b > 180 && r < 90) ? 'C' : '.'; }
const runs = []; for (let f = 0; f < n; f++) { if (cls[f] === '.') continue; const last = runs[runs.length - 1]; if (last && last.c === cls[f] && f - last.end <= 15) last.end = f; else runs.push({ c: cls[f], start: f, end: f }); } // a marker is held 1.1 s; a dropped frame inside it must not split the run
const pairs = []; for (let i = 0; i < runs.length; i++) { if (runs[i].c !== 'M') continue; const next = runs.slice(i + 1).find(r => r.c === 'C'); if (next) pairs.push({ from: (runs[i].end + 1) / FPS, to: next.start / FPS }); }
console.log(`${n} frames, ${runs.length} marker runs, ${pairs.length} scenes for ${seg.scenes.length} expected`);
if (pairs.length !== seg.scenes.length) { console.error('scene count mismatch; runs:', JSON.stringify(runs.map(r => r.c + '@' + (r.start / FPS).toFixed(1)))); process.exit(1); }

// 2. Cut each scene with its narration (starting when the answer appeared) and a caption band.
const esc = s => s.replace(/\\/g, '\\\\').replace(/'/g, '’').replace(/:/g, '\\:'); // captions use expansion=none, so a percent sign is literal
const list = [path.join(here, 'intro.mp4')];
seg.scenes.forEach((sc, i) => {
  const p = pairs[i]; const start = p.from + 0.12; const dur = Math.max(1, p.to - p.from - 0.24);
  const wav = path.join(here, 'narration', sc.id + '.wav'); const delay = Math.round(Math.max(0, sc.answerAt) * 1000);
  const out = path.join(CUTS, String(i + 1).padStart(2, '0') + '-' + sc.id + '.mp4');
  const vf = `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=${FPS},drawbox=x=0:y=ih-92:w=iw:h=92:color=0x0b1020@0.82:t=fill,drawbox=x=0:y=ih-92:w=iw:h=3:color=0xf5c518@1:t=fill,drawtext=fontfile=${FONT}:expansion=none:text='${esc(sc.caption)}':x=(w-text_w)/2:y=h-62:fontsize=30:fontcolor=white,fade=t=in:st=0:d=0.3,fade=t=out:st=${(dur - 0.3).toFixed(2)}:d=0.3,format=yuv420p`;
  const args = ['-v', 'error', '-y', '-ss', start.toFixed(3), '-i', seg.file, '-i', wav, '-t', dur.toFixed(3), '-filter_complex', `[0:v]${vf}[v];[1:a]adelay=${delay}|${delay},aresample=48000,apad[a]`, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', String(FPS), '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-shortest', out];
  execFileSync('ffmpeg', args, { stdio: 'inherit' });
  console.log(out.split(/[\\/]/).pop(), dur.toFixed(1) + 's', 'narration at', sc.answerAt.toFixed(1) + 's', '(' + (durations[sc.id] || 0) + 's long)');
  list.push(out);
});
list.push(path.join(here, 'outro.mp4'));

// 3. Concatenate by stream copy.
const txt = path.join(here, 'concat.txt'); fs.writeFileSync(txt, list.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', '-movflags', '+faststart', FINAL], { stdio: 'inherit' });
const info = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'csv=p=0', FINAL]).toString().trim();
console.log('FINAL', FINAL, info);
// Contact sheet for a quick visual check.
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', FINAL, '-vf', 'fps=1/6,scale=320:-1,tile=6x8', '-frames:v', '1', path.join(here, 'contact-sheet.png')]);
