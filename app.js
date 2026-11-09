// Sine Kick (browser) — UI, audio and the per-step sequencer.
'use strict';

const DSP = SineKickDSP();
const TABLES = DSP.makeTables();
const KNOB_NAMES = ['VOLUME', 'ATTACK', 'HOLD', 'DECAY', 'START', 'END', 'SWEEP', 'ATT CURVE', 'DEC CURVE', 'SWP CURVE'];
const PITCH_KNOBS = new Set([4, 5, 6, 9]);
const GROUPS = [['ENVELOPE', [1, 2, 3, 7, 8]], ['PITCH', [4, 5, 6, 9]], ['OUTPUT', [0]]];
const SAMPLE_RATES = [44100, 48000, 96000];
const NUM_STEPS = 16;
const STORE_KEY = 'sinekick.pattern.v1';

const presetParams = (name) => {
  const p = FACTORY_PRESETS.find((x) => x[0] === name);
  return (p ? p[1] : DSP.DEFAULTS).slice();
};

// ---------------------------------------------------------------- state
function defaultPattern() {
  const steps = Array.from({ length: NUM_STEPS }, () => ({ on: false, params: DSP.DEFAULTS.slice(), name: 'Default' }));
  const set = (i, name) => { steps[i] = { on: true, params: presetParams(name), name }; };
  set(0, 'Pitchblack 1');
  set(4, 'Sub Heaven');
  set(8, 'Pitchblack 1');
  set(11, 'Soft Cake');
  set(12, 'Tell Me 2');
  set(14, 'Soft Cake');
  return { bpm: 124, swing: 0, length: 16, steps };
}

function loadPattern() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && Array.isArray(p.steps) && p.steps.length === NUM_STEPS) return p;
    }
  } catch (e) { /* storage blocked: use default */ }
  return defaultPattern();
}

let pattern = loadPattern();
let sel = 0;
let clipboard = null;
let rateIdx = 0;
let playing = false;
let nowStep = -1;
let saveTimer = 0;

const cur = () => pattern.steps[sel];

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(pattern)); } catch (e) { /* ignore */ }
  }, 200);
}

// ---------------------------------------------------------------- audio
// The worklet runs the voice *and* the step clock, so timing is sample accurate.
// Its source is built from the same DSP function the page uses, so it works from file:// too.
function workletSource() {
  function processorBody() {
    const DSP = SineKickDSP();
    const TABLES = DSP.makeTables();
    class KickProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.voice = new DSP.Voice(sampleRate, TABLES);
        this.pattern = null;
        this.playing = false;
        this.step = 0;
        this.toNext = 0;
        this.sounding = -1; // step index whose params the voice is using (-1 = audition)
        this.port.onmessage = (e) => this.onMsg(e.data);
      }
      onMsg(m) {
        if (m.type === 'pattern') {
          this.pattern = m.pattern;
          // live-edit the step that is ringing right now, like turning a knob on the plugin
          if (this.sounding >= 0 && this.pattern.steps[this.sounding]) {
            this.voice.setParams(this.pattern.steps[this.sounding].params);
          }
        } else if (m.type === 'play') {
          this.playing = true; this.step = 0; this.toNext = 0;
        } else if (m.type === 'stop') {
          this.playing = false;
        } else if (m.type === 'hit') {
          this.voice.setParams(m.params);
          this.sounding = m.step;
          this.voice.trigger(48, 1);
        } else if (m.type === 'params') {
          if (this.sounding === m.step) this.voice.setParams(m.params);
        }
      }
      process(inputs, outputs) {
        const out = outputs[0];
        const L = out[0], R = out[1];
        const n = L.length;
        const pat = this.pattern;
        for (let i = 0; i < n; i++) {
          if (this.playing && pat) {
            if (this.toNext <= 0) {
              if (this.step >= pat.length) this.step = 0;
              const s = pat.steps[this.step];
              if (s.on) {
                this.voice.setParams(s.params);
                this.sounding = this.step;
                this.voice.trigger(48, 1);
              }
              this.port.postMessage({ type: 'step', step: this.step, at: currentTime + i / sampleRate });
              this.toNext += DSP.samplesPerStep(pat, sampleRate, this.step);
              this.step = (this.step + 1) % pat.length;
            }
            this.toNext -= 1;
          }
          let v = this.voice.next();
          v = v < -1 ? -1 : v > 1 ? 1 : v;
          L[i] = v;
          if (R) R[i] = v;
        }
        return true;
      }
    }
    registerProcessor('sine-kick', KickProcessor);
  }
  return SineKickDSP.toString() + '\n(' + processorBody.toString() + ')();\n';
}

let ctx = null, node = null, audioReady = null;

function ensureAudio() {
  if (audioReady) { if (ctx.state !== 'running') ctx.resume(); return audioReady; }
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  const src = workletSource();
  const blobUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
  const dataUrl = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(src);
  // blob: works when served over http; opened from file:// Chrome needs the data: URL
  audioReady = ctx.audioWorklet.addModule(blobUrl).catch(() => ctx.audioWorklet.addModule(dataUrl)).then(() => {
    node = new AudioWorkletNode(ctx, 'sine-kick', { numberOfInputs: 0, outputChannelCount: [2] });
    node.connect(ctx.destination);
    node.port.onmessage = (e) => {
      if (e.data.type === 'step') scheduleStepLight(e.data.step, e.data.at);
    };
    sendPattern();
  });
  return audioReady;
}

function sendPattern() {
  if (node) node.port.postMessage({ type: 'pattern', pattern });
}

function audition(step = sel) {
  flashPad();
  ensureAudio().then(() => node.port.postMessage({ type: 'hit', params: pattern.steps[step].params.slice(), step }));
}

function togglePlay() {
  ensureAudio().then(() => {
    playing = !playing;
    node.port.postMessage({ type: playing ? 'play' : 'stop' });
    $('#playBtn').classList.toggle('playing', playing);
    $('#playBtn').textContent = playing ? '■ STOP' : '▶ PLAY';
    if (!playing) setNow(-1);
  });
}

// light the playing step when its sound actually comes out of the speakers
function scheduleStepLight(step, at) {
  const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
  const delay = Math.max(0, (at + lat - ctx.currentTime) * 1000);
  setTimeout(() => { if (playing) setNow(step); }, delay);
}

// ---------------------------------------------------------------- DOM helpers
const $ = (q) => document.querySelector(q);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

// ---------------------------------------------------------------- knobs
const knobEls = [];
const A0 = Math.PI * 0.75, SWEEP = Math.PI * 1.5;
function arcPath(cx, cy, r, from, to) {
  const x0 = cx + Math.cos(from) * r, y0 = cy + Math.sin(from) * r;
  const x1 = cx + Math.cos(to) * r, y1 = cy + Math.sin(to) * r;
  const large = to - from > Math.PI ? 1 : 0;
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

function buildKnobs() {
  const wrap = $('#knobs');
  for (const [title, idxs] of GROUPS) {
    const g = el('div', 'kgroup');
    g.style.flex = idxs.length + ' 1 0';
    g.appendChild(el('h3', null, title));
    const row = el('div', 'row');
    for (const i of idxs) {
      const k = el('div', 'knob' + (PITCH_KNOBS.has(i) ? ' pitch' : ''));
      k.innerHTML = `<svg viewBox="0 0 64 64">
          <path class="track" d="${arcPath(32, 32, 27, A0, A0 + SWEEP)}" stroke="rgb(50,54,64)" stroke-width="4" fill="none" stroke-linecap="round"/>
          <path class="fill" stroke="rgb(255,156,46)" stroke-width="4" fill="none" stroke-linecap="round"/>
          <circle class="body" cx="32" cy="32" r="21" fill="rgb(58,62,74)" stroke="rgb(90,96,110)"/>
          <line class="ptr" stroke="rgb(222,224,230)" stroke-width="3" stroke-linecap="round"/>
        </svg><div class="name">${KNOB_NAMES[i]}</div><div class="val"></div>`;
      attachKnob(k, i);
      row.appendChild(k);
      knobEls[i] = k;
    }
    g.appendChild(row);
    wrap.appendChild(g);
  }
}

function attachKnob(k, i) {
  let drag = null;
  k.addEventListener('pointerdown', (e) => {
    k.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, moved: false };
    ensureAudio();
  });
  k.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (dx || dy) drag.moved = true;
    setKnob(i, cur().params[i] + (dx - dy) * (e.shiftKey ? 0.0008 : 0.004));
  });
  const end = () => {
    if (drag && drag.moved && !playing) audition();
    drag = null;
  };
  k.addEventListener('pointerup', end);
  k.addEventListener('pointercancel', () => { drag = null; });
  k.addEventListener('wheel', (e) => {
    e.preventDefault();
    setKnob(i, cur().params[i] - e.deltaY * 0.0005 * (e.shiftKey ? 0.2 : 1));
  }, { passive: false });
  k.addEventListener('dblclick', () => { setKnob(i, DSP.DEFAULTS[i]); if (!playing) audition(); });
}

function setKnob(i, v) {
  v = Math.min(1, Math.max(0, v));
  const s = cur();
  if (s.params[i] === v) return;
  s.params[i] = v;
  s.name = s.name && !s.name.endsWith('*') ? s.name + '*' : (s.name || 'Custom*');
  stepChanged(sel);
  if (node) node.port.postMessage({ type: 'params', step: sel, params: s.params.slice() });
}

function drawKnobs() {
  const p = cur().params;
  for (let i = 0; i < 10; i++) {
    const k = knobEls[i], v = p[i];
    const a = A0 + SWEEP * v;
    const fill = k.querySelector('.fill');
    fill.setAttribute('d', v > 0.001 ? arcPath(32, 32, 27, A0, a) : '');
    const ptr = k.querySelector('.ptr');
    ptr.setAttribute('x1', 32 + Math.cos(a) * 21 * 0.3); ptr.setAttribute('y1', 32 + Math.sin(a) * 21 * 0.3);
    ptr.setAttribute('x2', 32 + Math.cos(a) * 21 * 0.9); ptr.setAttribute('y2', 32 + Math.sin(a) * 21 * 0.9);
    k.querySelector('.val').textContent = DSP.display(i, p);
  }
}

// ---------------------------------------------------------------- waveform display
const waveCache = new Map(); // key -> {out, pitch}
function rendered(params) {
  const key = params.join(',');
  let r = waveCache.get(key);
  if (!r) {
    r = DSP.render(params, 44100, TABLES);
    waveCache.set(key, r);
    if (waveCache.size > 64) waveCache.delete(waveCache.keys().next().value);
  }
  return r;
}

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [g, c.clientWidth, c.clientHeight];
}

function drawWave(g, wave, x0, y0, w, h, color, alpha = 0.85) {
  const n = Math.max(1, wave.length), cols = Math.max(1, Math.floor(w));
  const mid = y0 + h / 2, hh = h / 2;
  g.strokeStyle = color; g.globalAlpha = alpha; g.lineWidth = 1;
  g.beginPath();
  for (let c = 0; c < cols; c++) {
    const a = Math.floor(c * n / cols);
    const b = Math.min(n, Math.max(a + 1, Math.floor((c + 1) * n / cols)));
    let lo = 0, hi = 0;
    for (let s = Math.min(a, n - 1); s < b; s++) { const v = wave[s]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const x = x0 + c + 0.5;
    g.moveTo(x, mid - hi * hh); g.lineTo(x, mid - lo * hh + 0.5);
  }
  g.stroke();
  g.globalAlpha = 1;
}

function drawDisplay() {
  const c = $('#display');
  const [g, W, H] = fitCanvas(c);
  const p = cur().params;
  const { out: wave, pitch } = rendered(p);
  g.fillStyle = 'rgb(14,16,20)'; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgb(52,56,66)'; g.strokeRect(0.5, 0.5, W - 1, H - 1);
  const ix = 14, iy = 26, iw = W - 28, ih = H - 52, mid = iy + ih / 2;
  g.strokeStyle = 'rgb(28,31,38)'; g.lineWidth = 1;
  for (let i = 0; i <= 8; i++) { const x = Math.round(ix + iw * i / 8) + 0.5; g.beginPath(); g.moveTo(x, iy); g.lineTo(x, iy + ih); g.stroke(); }
  g.strokeStyle = 'rgb(40,44,54)'; g.beginPath(); g.moveTo(ix, mid + 0.5); g.lineTo(ix + iw, mid + 0.5); g.stroke();
  drawWave(g, wave, ix, iy, iw, ih, 'rgb(255,156,46)');

  // pitch curve, log scale
  const n = pitch.length;
  let maxf = 30; for (let i = 0; i < n; i++) if (pitch[i] > maxf) maxf = pitch[i];
  const lo = Math.log(20), hi = Math.log(Math.max(200, maxf * 1.15));
  g.strokeStyle = 'rgb(92,196,255)'; g.lineWidth = 2; g.beginPath();
  for (let c2 = 0; c2 < iw; c2 += 2) {
    const i = Math.min(n - 1, Math.floor(c2 * n / iw));
    const t = (Math.log(Math.max(20, pitch[i])) - lo) / (hi - lo);
    const x = ix + c2, y = iy + ih - t * ih;
    c2 === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.stroke();

  g.font = '12px system-ui, sans-serif';
  g.fillStyle = 'rgb(130,136,150)';
  g.textBaseline = 'top'; g.textAlign = 'left';
  g.fillText('STEP ' + (sel + 1) + ' · ' + (cur().name || 'Custom'), 14, 7);
  g.textAlign = 'right';
  g.fillText(Math.round(DSP.P.lengthS(p) * 1000) + ' ms', W - 14, 7);
  g.fillStyle = 'rgb(92,196,255)'; g.textBaseline = 'bottom';
  g.fillText(Math.round(DSP.P.endHz(p)) + ' Hz', W - 14, H - 7);
  g.textAlign = 'left';
  g.fillText(Math.round(DSP.P.startHz(p)) + ' Hz', 14, H - 7);
}

// ---------------------------------------------------------------- sequencer grid
const stepEls = [];
function buildSeq() {
  const wrap = $('#seq');
  for (let i = 0; i < NUM_STEPS; i++) {
    const s = el('div', 'step');
    s.innerHTML = `<div class="top"><span class="num">${i + 1}</span><button class="led" title="On / off"></button></div>
      <canvas></canvas><div class="pname"></div>`;
    s.querySelector('.led').addEventListener('click', (e) => { e.stopPropagation(); toggleStep(i); });
    s.addEventListener('click', () => { select(i); if (!playing) audition(i); });
    wrap.appendChild(s);
    stepEls.push(s);
  }
}

function drawStep(i) {
  const s = pattern.steps[i], e = stepEls[i];
  e.classList.toggle('on', s.on);
  e.classList.toggle('off', !s.on);
  e.classList.toggle('sel', i === sel);
  e.classList.toggle('disabled', i >= pattern.length);
  e.querySelector('.pname').textContent = s.name || 'Custom';
  e.querySelector('.pname').title = s.name || 'Custom';
  const c = e.querySelector('canvas');
  const [g, W, H] = fitCanvas(c);
  g.clearRect(0, 0, W, H);
  // thumbnail drawn on a fixed 1 s time scale so lengths compare across steps
  const { out } = rendered(s.params);
  const len = Math.min(out.length, 44100);
  drawWave(g, out.subarray(0, len), 0, 2, Math.max(1, Math.round(W * len / 44100)), H - 4,
    s.on ? 'rgb(255,156,46)' : 'rgb(130,136,150)', 0.9);
}

function drawSeq() { for (let i = 0; i < NUM_STEPS; i++) drawStep(i); }

function setNow(i) {
  if (nowStep >= 0 && stepEls[nowStep]) stepEls[nowStep].classList.remove('now');
  nowStep = i;
  if (i >= 0) stepEls[i].classList.add('now');
}

function toggleStep(i) {
  if (i >= pattern.length) return;
  pattern.steps[i].on = !pattern.steps[i].on;
  drawStep(i); sendPattern(); persist();
}

function select(i) {
  sel = Math.max(0, Math.min(NUM_STEPS - 1, i));
  refreshEditor();
  drawSeq();
}

// ---------------------------------------------------------------- editor
function refreshEditor() {
  drawKnobs();
  drawDisplay();
  $('#editStep').textContent = sel + 1;
  $('#padStep').textContent = sel + 1;
  const idx = FACTORY_PRESETS.findIndex((x) => x[0] === cur().name);
  $('#preset').value = idx >= 0 ? String(idx) : '';
}

let rafPending = false;
function stepChanged(i) {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    refreshEditor(); drawStep(i); sendPattern(); persist();
  });
}

function applyPreset(idx) {
  const n = FACTORY_PRESETS.length;
  idx = ((idx % n) + n) % n;
  const [name, params] = FACTORY_PRESETS[idx];
  Object.assign(cur(), { params: params.slice(), name });
  if (sel < pattern.length) cur().on = true;
  refreshEditor(); drawStep(sel); sendPattern(); persist();
  if (!playing) audition();
}

// same ranges as the Rust app's RANDOM button
function randomParams() {
  const r = Math.random;
  const p = DSP.DEFAULTS.slice();
  p[0] = 0.6 + 0.25 * r();
  p[1] = r() < 0.8 ? 0 : 0.3 * r();
  p[2] = 0.15 + 0.45 * r();
  p[3] = 0.25 + 0.55 * r();
  p[4] = 0.1 + 0.75 * r();
  p[5] = 0.28 + 0.2 * r();
  p[6] = 0.15 + 0.35 * r();
  p[7] = 0.6 + 0.4 * r();
  p[8] = 0.6 * r();
  p[9] = 0.5 * r();
  return p;
}

// ---------------------------------------------------------------- WAV export
function wav24(samples, rate) {
  const n = samples.length, data = n * 3;
  const buf = new ArrayBuffer(44 + data), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + data, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 3, true); v.setUint16(32, 3, true); v.setUint16(34, 24, true);
  str(36, 'data'); v.setUint32(40, data, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.round(Math.max(-1, Math.min(1, samples[i])) * 8388607);
    v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255); o += 3;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function download(blob, name) {
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------- pad flash
let flashTimer = 0;
function flashPad() {
  const p = $('#pad');
  p.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => p.classList.remove('flash'), 60);
}

// ---------------------------------------------------------------- wiring
function syncTransportUI() {
  $('#bpm').value = pattern.bpm;
  $('#swing').value = pattern.swing;
  $('#swingVal').textContent = Math.round(pattern.swing * 100) + '%';
  $('#length').value = pattern.length;
}

function init() {
  buildKnobs();
  buildSeq();

  const ps = $('#preset');
  ps.appendChild(new Option('— custom —', ''));
  FACTORY_PRESETS.forEach(([name], i) => ps.appendChild(new Option(name, String(i))));
  ps.addEventListener('change', () => { if (ps.value !== '') applyPreset(+ps.value); });
  const curPresetIdx = () => Math.max(0, FACTORY_PRESETS.findIndex((x) => x[0] === (cur().name || '').replace(/\*$/, '')));
  $('#prevPreset').onclick = () => applyPreset(curPresetIdx() - 1);
  $('#nextPreset').onclick = () => applyPreset(curPresetIdx() + 1);

  const len = $('#length');
  for (let i = 1; i <= NUM_STEPS; i++) len.appendChild(new Option(String(i), String(i)));
  len.onchange = () => { pattern.length = +len.value; drawSeq(); sendPattern(); persist(); };
  $('#bpm').onchange = () => {
    pattern.bpm = Math.max(40, Math.min(300, +$('#bpm').value || 120));
    $('#bpm').value = pattern.bpm; sendPattern(); persist();
  };
  $('#swing').oninput = () => {
    pattern.swing = +$('#swing').value;
    $('#swingVal').textContent = Math.round(pattern.swing * 100) + '%';
    sendPattern(); persist();
  };
  syncTransportUI();

  const rates = $('#rates');
  SAMPLE_RATES.forEach((r, i) => {
    const b = el('button', 'btn' + (i === rateIdx ? ' on' : ''), (r / 1000).toFixed(1).replace('.0', '') + 'k');
    b.title = 'Sample rate for saved files';
    b.onclick = () => { rateIdx = i; rates.querySelectorAll('.btn').forEach((x, j) => x.classList.toggle('on', j === i)); };
    rates.appendChild(b);
  });

  $('#playBtn').onclick = togglePlay;
  $('#pad').onpointerdown = () => audition();
  $('#random').onclick = () => {
    Object.assign(cur(), { params: randomParams(), name: 'Random' });
    if (sel < pattern.length) cur().on = true;
    refreshEditor(); drawStep(sel); sendPattern(); persist(); if (!playing) audition();
  };
  $('#randomAll').onclick = () => {
    pattern.steps.forEach((s) => { if (s.on) Object.assign(s, { params: randomParams(), name: 'Random' }); });
    refreshEditor(); drawSeq(); sendPattern(); persist();
  };
  $('#copy').onclick = () => { clipboard = { params: cur().params.slice(), name: cur().name }; };
  $('#paste').onclick = () => {
    if (!clipboard) return;
    Object.assign(cur(), { params: clipboard.params.slice(), name: clipboard.name });
    if (sel < pattern.length) cur().on = true;
    refreshEditor(); drawStep(sel); sendPattern(); persist();
  };
  $('#toAll').onclick = () => {
    const src = cur();
    pattern.steps.forEach((s) => { if (s.on) Object.assign(s, { params: src.params.slice(), name: src.name }); });
    drawSeq(); sendPattern(); persist();
  };
  $('#clear').onclick = () => { pattern.steps.forEach((s) => { s.on = false; }); drawSeq(); sendPattern(); persist(); };

  $('#saveHit').onclick = () => {
    const rate = SAMPLE_RATES[rateIdx];
    const { out } = DSP.render(cur().params, rate, TABLES);
    download(wav24(out, rate), `Sine Kick - step ${sel + 1} - ${(cur().name || 'Custom').replace(/[*\/\\:]/g, '')}.wav`);
  };
  $('#saveLoop').onclick = () => {
    const rate = SAMPLE_RATES[rateIdx];
    // one bar, cut exactly at the loop point so it loops seamlessly in a DAW;
    // rendered twice internally so hits that ring past the end wrap into the start
    const two = DSP.renderPattern(pattern, rate, TABLES, 2);
    const loopLen = two.length / 2;
    const out = two.subarray(loopLen); // second pass already includes the first pass's tail
    download(wav24(out, rate), `Sine Kick loop - ${pattern.bpm} bpm.wav`);
  };

  window.addEventListener('keydown', (e) => {
    const t = e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'Enter') { e.preventDefault(); audition(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); select((sel + 1) % NUM_STEPS); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); select((sel + NUM_STEPS - 1) % NUM_STEPS); }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'c') $('#copy').click();
    else if ((e.metaKey || e.ctrlKey) && e.key === 'v') $('#paste').click();
    else if (/^[0-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey) toggleStep(e.key === '0' ? 9 : +e.key - 1);
  });

  window.addEventListener('resize', () => { drawDisplay(); drawSeq(); });
  refreshEditor();
  drawSeq();
}

init();
