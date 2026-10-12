# Demo video pipeline

Produces `Astra-Insights-for-Kearney-demo.mp4`: an Artizent intro card, the five storylines recorded on the deployed
product with narration in the product's own Azure voice, and an Artizent outro card. About five and a half minutes,
1920x1080, 25 fps, H.264 + AAC.

How it works

1. `beats.js` is the storyboard: persona, action (home screen, a typed question, or a screen), the caption and the narration line.
2. `node narrate.js` synthesises one WAV per beat through the deployed app's Azure Speech token (voice en-GB-SoniaNeural) and writes `durations.json`.
3. `pwsh branding.ps1` builds `intro.mp4` and `outro.mp4` with ffmpeg from `artizent-logo.png` (fonts are copied next to the script because a drive-letter colon inside an ffmpeg filtergraph does not parse on Windows).
4. `node record.js` drives the deployed app with Playwright (headless Chromium, 1920x1080, dark theme, speech muted) and records one `.webm`. Each scene is bracketed by a full-screen magenta frame at its start and a cyan frame at its end, held 1.1 s, so the cut points are read from the frames rather than the script clock. The app is letterboxed above a 92 px band so the command bar stays visible under the caption. `ONLY=A,B` records a subset; `BASE=http://localhost:8080` records a local instance.
5. `node assemble.js` classifies every frame, cuts each scene, lays the narration from the moment the answer appeared, burns the caption into the band, and concatenates intro + scenes + outro by stream copy. It also writes `contact-sheet.png` for a quick visual check.

Requirements: ffmpeg and ffprobe on PATH, Playwright with Chromium (`PLAYWRIGHT_DIR` may point at another project's `node_modules/playwright`), the deployed app with Azure Speech configured in Settings.

Run, in this folder:

```
node narrate.js
pwsh branding.ps1
node record.js
node assemble.js
```

Hold deployments while `record.js` runs: a restart mid-take blanks the page and the take has to be repeated.
