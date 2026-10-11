// Voice: push-to-talk, wake word and spoken answers.
// Engine 1 (preferred when configured in Settings): Azure AI Speech via a short-lived token from the server: neural voice,
// phrase list with the firm's vocabulary, works in every browser, audio stays in the Azure tenant.
// Engine 2 (fallback): the browser's own speech engine (Edge and Chrome). Every spoken answer is also shown as text.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;
const LANG = { en: 'en-GB', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', pt: 'pt-BR', ja: 'ja-JP', ar: 'ar-SA' };
const AZURE_VOICE = { en: 'en-GB-SoniaNeural', de: 'de-DE-KatjaNeural', fr: 'fr-FR-DeniseNeural', es: 'es-ES-ElviraNeural', pt: 'pt-BR-FranciscaNeural', ja: 'ja-JP-NanamiNeural', ar: 'ar-SA-ZariyahNeural' };

export class Voice {
  constructor({ onState, onTranscript, onFinal, onWake, onEngine }) {
    Object.assign(this, { onState, onTranscript, onFinal, onWake, onEngine });
    this.state = 'idle'; this.muted = false; this.lang = 'en'; this.wake = false; this.rec = null; this.wakeRec = null; this.supported = Boolean(SR);
    this.azure = null; this.azureRecognizer = null; this.azureWake = null; this.player = null; this.phrases = []; this.voice = null; this.engine = 'browser';
    if (synth) { const pick = () => { const vs = synth.getVoices(); this.voice = vs.find(v => /en-GB/.test(v.lang) && /Natural|Online|Libby|Sonia|Ryan/.test(v.name)) || vs.find(v => /en-GB/.test(v.lang)) || vs.find(v => /^en/.test(v.lang)) || vs[0]; }; pick(); synth.onvoiceschanged = pick; }
    this.refreshToken();
  }
  setPhrases(list) { this.phrases = [...new Set(list.filter(Boolean))].slice(0, 400); }
  async refreshToken() {
    try {
      const t = await fetch('api/speech/token').then(r => r.json());
      if (t.provider === 'azure' && window.SpeechSDK) { this.azure = { token: t.token, region: t.region, voice: t.voice || AZURE_VOICE.en, issued: Date.now() }; this.engine = 'azure'; this.supported = true; }
      else { this.azure = null; this.engine = 'browser'; this.supported = Boolean(SR); }
    } catch (e) { this.azure = null; this.engine = 'browser'; }
    this.onEngine && this.onEngine(this.engine);
    clearTimeout(this._tokenTimer); if (this.azure) this._tokenTimer = setTimeout(() => this.refreshToken(), 8 * 60 * 1000); // tokens last 10 minutes
  }
  setState(s) { this.state = s; this.onState && this.onState(s); }
  // ---------- Azure helpers ----------
  azureConfig() { const S = window.SpeechSDK; const c = S.SpeechConfig.fromAuthorizationToken(this.azure.token, this.azure.region); c.speechRecognitionLanguage = LANG[this.lang] || 'en-GB'; c.speechSynthesisVoiceName = this.lang === 'en' ? this.azure.voice : (AZURE_VOICE[this.lang] || this.azure.voice); return c; }
  azureRecognizerFor(continuous) {
    const S = window.SpeechSDK; const rec = new S.SpeechRecognizer(this.azureConfig(), S.AudioConfig.fromDefaultMicrophoneInput());
    if (this.phrases.length) { const pl = S.PhraseListGrammar.fromRecognizer(rec); this.phrases.forEach(p => pl.addPhrase(p)); pl.addPhrase('Astra'); }
    return rec;
  }
  // ---------- listening ----------
  listen() {
    if (this.state === 'listening') { this.stop(); return; }
    this.stopSpeaking(); this.stopWake();
    if (this.azure && window.SpeechSDK) return this.listenAzure();
    if (!this.supported) { this.onFinal && this.onFinal(null, 'Speech recognition is not available in this browser. Type the question instead.'); return; }
    const rec = new SR(); rec.lang = LANG[this.lang] || 'en-GB'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    let final = '';
    rec.onstart = () => this.setState('listening');
    rec.onresult = e => { let interim = ''; for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) final += t; else interim += t; } this.onTranscript && this.onTranscript(final || interim); };
    rec.onerror = e => { this.setState('idle'); if (e.error !== 'aborted' && e.error !== 'no-speech') this.onFinal && this.onFinal(null, 'Voice error: ' + e.error); if (e.error === 'no-speech') this.onFinal && this.onFinal(null, 'I did not catch that.'); this.startWake(); };
    rec.onend = () => { if (this.state === 'listening') this.setState('idle'); const text = final.trim(); if (text) this.onFinal && this.onFinal(text); else this.startWake(); };
    this.rec = rec; try { rec.start(); } catch (e) { this.setState('idle'); }
  }
  listenAzure() {
    const S = window.SpeechSDK; const rec = this.azureRecognizerFor(false); this.azureRecognizer = rec; this.setState('listening');
    rec.recognizing = (_, e) => { this.onTranscript && this.onTranscript(e.result.text); };
    rec.recognizeOnceAsync(r => {
      rec.close(); this.azureRecognizer = null; this.setState('idle');
      if (r.reason === S.ResultReason.RecognizedSpeech && r.text && r.text.trim()) { this.onTranscript && this.onTranscript(r.text); this.onFinal && this.onFinal(r.text.trim()); }
      else { this.onFinal && this.onFinal(null, r.reason === S.ResultReason.NoMatch ? 'I did not catch that.' : 'Voice error: ' + (r.errorDetails || r.reason)); this.startWake(); }
    }, err => { rec.close(); this.azureRecognizer = null; this.setState('idle'); this.onFinal && this.onFinal(null, 'Voice error: ' + err); this.startWake(); });
  }
  stop() { if (this.azureRecognizer) { try { this.azureRecognizer.stopContinuousRecognitionAsync(); this.azureRecognizer.close(); } catch (e) { /* noop */ } this.azureRecognizer = null; this.setState('idle'); } if (this.rec) { try { this.rec.stop(); } catch (e) { /* noop */ } } }
  // ---------- speaking ----------
  speak(text, { lang } = {}) {
    if (this.muted || !text) return Promise.resolve();
    this.stopSpeaking();
    if (this.azure && window.SpeechSDK) return this.speakAzure(text, lang);
    if (!synth) return Promise.resolve();
    return new Promise(resolve => {
      const u = new SpeechSynthesisUtterance(text); u.lang = LANG[lang || this.lang] || 'en-GB'; if (this.voice && (!lang || lang === 'en')) u.voice = this.voice; u.rate = 1.02; u.pitch = 1;
      u.onstart = () => this.setState('speaking'); u.onend = () => { this.setState('idle'); resolve(); }; u.onerror = () => { this.setState('idle'); resolve(); };
      synth.speak(u);
    });
  }
  speakAzure(text, lang) {
    const S = window.SpeechSDK;
    return new Promise(resolve => {
      const cfg = this.azureConfig(); if (lang && AZURE_VOICE[lang]) cfg.speechSynthesisVoiceName = AZURE_VOICE[lang];
      this.player = new S.SpeakerAudioDestination(); const out = S.AudioConfig.fromSpeakerOutput(this.player);
      const syn = new S.SpeechSynthesizer(cfg, out); this.synthesizer = syn; this.setState('speaking');
      this.player.onAudioEnd = () => { this.setState('idle'); resolve(); };
      syn.speakTextAsync(text, () => { syn.close(); }, err => { syn.close(); this.setState('idle'); console.warn('Azure speech synthesis failed, falling back to the browser voice:', err); this.azure = null; this.engine = 'browser'; this.onEngine && this.onEngine('browser'); this.speak(text, { lang }).then(resolve); });
    });
  }
  stopSpeaking() {
    if (this.player) { try { this.player.pause(); this.player.close(); } catch (e) { /* noop */ } this.player = null; }
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
    if (this.state === 'speaking') this.setState('idle');
  }
  // ---------- wake word ----------
  setWake(on) { this.wake = on; if (on) this.startWake(); else this.stopWake(); }
  startWake() {
    if (!this.wake || this.wakeRec || this.azureWake || this.state === 'listening') return;
    if (this.azure && window.SpeechSDK) {
      const S = window.SpeechSDK; const rec = this.azureRecognizerFor(true); this.azureWake = rec;
      rec.recognized = (_, e) => { const t = (e.result.text || '').toLowerCase(); if (/\bastra\b/.test(t)) { const after = t.split(/\bastra\b/)[1] || ''; this.stopWake(); if (after.trim().length > 6) { this.onFinal && this.onFinal(after.trim()); this.startWake(); } else { this.onWake && this.onWake(); this.listen(); } } };
      rec.canceled = () => { this.stopWake(); setTimeout(() => this.startWake(), 1500); };
      rec.startContinuousRecognitionAsync(() => {}, () => { this.azureWake = null; });
      return;
    }
    if (!this.supported) return;
    const rec = new SR(); rec.lang = 'en-GB'; rec.continuous = true; rec.interimResults = true;
    rec.onresult = e => { for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript.toLowerCase(); if (/\bastra\b/.test(t)) { const after = t.split(/\bastra\b/)[1] || ''; this.stopWake(); if (after.trim().length > 6 && e.results[i].isFinal) { this.onFinal && this.onFinal(after.trim()); this.startWake(); } else { this.onWake && this.onWake(); this.listen(); } return; } } };
    rec.onerror = () => { this.wakeRec = null; setTimeout(() => this.startWake(), 1500); };
    rec.onend = () => { this.wakeRec = null; if (this.wake && this.state !== 'listening') setTimeout(() => this.startWake(), 400); };
    this.wakeRec = rec; try { rec.start(); } catch (e) { this.wakeRec = null; }
  }
  stopWake() {
    if (this.azureWake) { const r = this.azureWake; this.azureWake = null; try { r.stopContinuousRecognitionAsync(() => r.close(), () => r.close()); } catch (e) { /* noop */ } }
    if (this.wakeRec) { const r = this.wakeRec; this.wakeRec = null; try { r.onend = null; r.stop(); } catch (e) { /* noop */ } }
  }
}
