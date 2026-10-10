// Voice: push-to-talk and wake word with the browser speech APIs (Edge and Chrome); Azure AI Speech when the server issues a token.
// Every spoken answer is also shown as text; quiet mode switches speech output off.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;
const LANG_VOICES = { en: 'en-GB', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', pt: 'pt-BR', ja: 'ja-JP', ar: 'ar-SA' };

export class Voice {
  constructor({ onState, onTranscript, onFinal, onWake }) {
    this.onState = onState; this.onTranscript = onTranscript; this.onFinal = onFinal; this.onWake = onWake;
    this.state = 'idle'; this.muted = false; this.lang = 'en'; this.wake = false; this.rec = null; this.wakeRec = null; this.supported = Boolean(SR);
    this.azure = null; this.voice = null;
    fetch('api/speech/token').then(r => r.json()).then(t => { if (t.provider === 'azure') this.azure = t; }).catch(() => {});
    if (synth) { const pick = () => { const vs = synth.getVoices(); this.voice = vs.find(v => /en-GB/.test(v.lang) && /Natural|Online|Libby|Sonia|Ryan/.test(v.name)) || vs.find(v => /en-GB/.test(v.lang)) || vs.find(v => /^en/.test(v.lang)) || vs[0]; }; pick(); synth.onvoiceschanged = pick; }
  }
  setState(s) { this.state = s; this.onState && this.onState(s); }
  listen() {
    if (!this.supported) { this.onFinal && this.onFinal(null, 'Speech recognition is not available in this browser. Type the question instead.'); return; }
    if (this.state === 'listening') { this.stop(); return; }
    this.stopSpeaking(); this.stopWake();
    const rec = new SR(); rec.lang = LANG_VOICES[this.lang] || 'en-GB'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    let final = '';
    rec.onstart = () => this.setState('listening');
    rec.onresult = e => { let interim = ''; for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) final += t; else interim += t; } this.onTranscript && this.onTranscript(final || interim); };
    rec.onerror = e => { this.setState('idle'); if (e.error !== 'aborted' && e.error !== 'no-speech') this.onFinal && this.onFinal(null, 'Voice error: ' + e.error); if (e.error === 'no-speech') this.onFinal && this.onFinal(null, 'I did not catch that.'); this.startWake(); };
    rec.onend = () => { if (this.state === 'listening') this.setState('idle'); const text = final.trim(); if (text) this.onFinal && this.onFinal(text); else this.startWake(); };
    this.rec = rec; try { rec.start(); } catch (e) { this.setState('idle'); }
  }
  stop() { if (this.rec) { try { this.rec.stop(); } catch (e) { /* noop */ } } }
  speak(text, { lang } = {}) {
    if (!synth || this.muted || !text) return Promise.resolve();
    this.stopSpeaking();
    return new Promise(resolve => {
      const u = new SpeechSynthesisUtterance(text); u.lang = LANG_VOICES[lang || this.lang] || 'en-GB'; if (this.voice && (!lang || lang === 'en')) u.voice = this.voice; u.rate = 1.02; u.pitch = 1;
      u.onstart = () => this.setState('speaking'); u.onend = () => { this.setState('idle'); resolve(); }; u.onerror = () => { this.setState('idle'); resolve(); };
      synth.speak(u);
    });
  }
  stopSpeaking() { if (synth && (synth.speaking || synth.pending)) synth.cancel(); if (this.state === 'speaking') this.setState('idle'); }
  setWake(on) { this.wake = on; if (on) this.startWake(); else this.stopWake(); }
  startWake() {
    if (!this.wake || !this.supported || this.wakeRec || this.state === 'listening') return;
    const rec = new SR(); rec.lang = 'en-GB'; rec.continuous = true; rec.interimResults = true;
    rec.onresult = e => { for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript.toLowerCase(); if (/\bastra\b/.test(t)) { const after = t.split(/\bastra\b/)[1] || ''; this.stopWake(); if (after.trim().length > 6 && e.results[i].isFinal) { this.onFinal && this.onFinal(after.trim()); this.startWake(); } else { this.onWake && this.onWake(); this.listen(); } return; } } };
    rec.onerror = () => { this.wakeRec = null; setTimeout(() => this.startWake(), 1500); };
    rec.onend = () => { this.wakeRec = null; if (this.wake && this.state !== 'listening') setTimeout(() => this.startWake(), 400); };
    this.wakeRec = rec; try { rec.start(); } catch (e) { this.wakeRec = null; }
  }
  stopWake() { if (this.wakeRec) { const r = this.wakeRec; this.wakeRec = null; try { r.onend = null; r.stop(); } catch (e) { /* noop */ } } }
}
