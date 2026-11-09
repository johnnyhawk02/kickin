// Kickin engine: a 4-operator FM kick.
//
// The pitch sweep (start -> end frequency along a curve) and the attack / hold /
// decay amp envelope come from the original sine kick (port of app/src/dsp.rs).
// The single sine is replaced by four FM operators that all follow the swept
// pitch at their own ratio, each with its own level and decay envelope, wired
// by one of eight algorithms. Operator 4 has feedback.
//
// Everything lives inside one factory function so the exact same source can be
// stringified into the AudioWorklet (no build step, works from file://).
function SineKickDSP() {
  const CURVE_ROWS = 40;
  const CURVE_COLS = 128;
  const CURVE_MAX_ROW = 39;
  const TAU = Math.PI * 2;

  const KEYS = ['volume', 'attack', 'hold', 'decay', 'startFreq', 'endFreq',
    'sweepTime', 'attackCurve', 'decayCurve', 'sweepCurve',
    'ratio1', 'ratio2', 'ratio3', 'ratio4',
    'level1', 'level2', 'level3', 'level4',
    'opDecay1', 'opDecay2', 'opDecay3', 'opDecay4',
    'feedback', 'algorithm'];
  const NUM_PARAMS = KEYS.length; // 24
  const RATIO = 10, LEVEL = 14, OPDECAY = 18, FEEDBACK = 22, ALGO = 23;

  // Operator frequency ratios a ratio knob steps through.
  const RATIOS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const ratioKnob = (r) => RATIOS.indexOf(r) / (RATIOS.length - 1);

  // mods[j] = operators that modulate operator j (0 = op 1 ... 3 = op 4).
  // Modulation always flows from a higher operator to a lower one.
  const ALGORITHMS = [
    { name: '4→3→2→1', mods: [[1], [2], [3], []], carriers: [0] },
    { name: '(3+4)→2→1', mods: [[1], [2, 3], [], []], carriers: [0] },
    { name: '(2 + 4→3)→1', mods: [[1, 2], [], [3], []], carriers: [0] },
    { name: '(2+3+4)→1', mods: [[1, 2, 3], [], [], []], carriers: [0] },
    { name: '2→1 + 4→3', mods: [[1], [], [3], []], carriers: [0, 2] },
    { name: '4→(1, 2, 3)', mods: [[3], [3], [3], []], carriers: [0, 1, 2] },
    { name: '1 + 4→3→2', mods: [[], [2], [3], []], carriers: [0, 1] },
    { name: '1+2+3+4', mods: [[], [], [], []], carriers: [0, 1, 2, 3] },
  ];
  const algoKnob = (a) => a / (ALGORITHMS.length - 1);

  const DEFAULTS = [0.8, 0.0, 0.5, 0.5, 0.2, 0.5, 0.5, 1.0, 0.0, 0.0,
    ratioKnob(1), ratioKnob(1), ratioKnob(3), ratioKnob(1),
    1.0, 0.25, 0.0, 0.0,
    1.0, 0.15, 0.2, 0.2,
    0.0, algoKnob(0)];

  // Older saved steps had only the ten sine-kick knobs: fill in the FM part.
  const upgrade = (p) => (p.length >= NUM_PARAMS ? p : p.concat(DEFAULTS.slice(p.length)));

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  // Two families of 40 curves x 128 points. rising goes 0 -> 1 (attack),
  // falling goes 1 -> 0 (decay and pitch sweep).
  function makeTables() {
    const rising = new Float32Array(CURVE_ROWS * CURVE_COLS);
    const falling = new Float32Array(CURVE_ROWS * CURVE_COLS);
    for (let row = 0; row < CURVE_ROWS; row++) {
      const u = row / CURVE_MAX_ROW;
      const upper = u >= 0.5;
      const a = (upper ? u : 1 - u) - 0.5;
      const k = a * 20 + 1; // bend amount 1..11
      const weight = (1 - 1 / k) - 1 / Math.pow(k, 4);
      const straight = 1 - weight;
      const shape = (x) => Math.pow(x, k) * weight + straight * x;
      for (let col = 0; col < CURVE_COLS; col++) {
        const x = col / 127;
        let r, f;
        if (upper) { r = shape(x); f = 1 - shape(x); }
        else { r = 1 - shape(1 - x); f = shape(1 - x); }
        rising[row * CURVE_COLS + col] = clamp01(r);
        falling[row * CURVE_COLS + col] = clamp01(f);
      }
    }
    return { rising, falling };
  }

  // Bilinear lookup: row 0..39 (fractional), pos 0..1.
  function lookup(table, row, pos) {
    const p = pos * 127;
    let c0 = p | 0;
    const fc = p - c0;
    const c1 = c0 < 127 ? c0 + 1 : 127;
    if (c0 > 127) c0 = 127;
    const r0 = row | 0;
    const fr = row - r0;
    const r1 = row < CURVE_MAX_ROW ? r0 + 1 : 39;
    const at = (r, c) => table[r * CURVE_COLS + c];
    const a = at(r0, c0) + (at(r1, c0) - at(r0, c0)) * fr;
    const b = at(r0, c1) + (at(r1, c1) - at(r0, c1)) * fr;
    return a + (b - a) * fc;
  }

  // Params are plain arrays of ten 0..1 knob values, in KEYS order.
  const P = {
    volume: (p) => p[0],
    attackMs: (p) => 5 + 995 * p[1],
    holdS: (p) => 0.001 + 0.999 * p[2] * p[2] * p[2],
    decayMs: (p) => 5 + 995 * p[3],
    startHz: (p) => 5 + 7995 * p[4] * p[4],
    endHz: (p) => 5 + 110 * p[5],
    sweepMs: (p) => 999 * p[6] * p[6] * p[6] + 0.001,
    attackRow: (p) => (1 - p[7]) * CURVE_MAX_ROW,
    decayRow: (p) => p[8] * CURVE_MAX_ROW,
    sweepRow: (p) => p[9] * CURVE_MAX_ROW,
    lengthS: (p) => (P.attackMs(p) + P.decayMs(p)) / 1000 + P.holdS(p),
    ratio: (p, op) => RATIOS[Math.round(p[RATIO + op] * (RATIOS.length - 1))],
    // carriers: output gain; modulators: modulation index in radians (0..10, squared for fine low end)
    level: (p, op) => p[LEVEL + op],
    index: (p, op) => p[LEVEL + op] * p[LEVEL + op] * 10,
    // time to fall 60 dB
    opDecayMs: (p, op) => 5 + 2995 * p[OPDECAY + op] * p[OPDECAY + op],
    feedback: (p) => p[FEEDBACK] * 1.5,
    algorithm: (p) => Math.round(p[ALGO] * (ALGORITHMS.length - 1)),
  };

  // Factors the plugin derives from the sample rate; both exactly 1 at 44.1 kHz.
  function rateFactors(sr) {
    const a = 2 * (1 - Math.pow(2, -44100 / sr));
    const c1 = 9748.380445950273;
    const c2 = 0.00010257588085804681;
    const f = 1 / (a * c2 / (1 - Math.exp(-1 / ((sr / 44100) * c1))));
    return [a, f];
  }

  const ATTACK = 0, HOLD = 1, DECAY = 2, DONE = 3;

  class Voice {
    constructor(sampleRate, tables) {
      this.sr = sampleRate;
      this.tables = tables;
      const [a, f] = rateFactors(sampleRate);
      this.envCoef = a * 0.08 * f;
      this.knobCoef = 0.002 * a * f;
      this.volCoef = a * 0.002 * f;
      this.declickKeep = a * -0.2 * f + 1;
      this.declickFollow = a * 0.1 * f;
      this.active = false;
      this.stage = DONE;
      this.attackPos = 0; this.decayPos = 0; this.holdCount = 0; this.sweepPos = 0;
      this.phase = 0; this.velocity = 1; this.keytrack = 1;
      this.envSmooth = 0; this.declickSrc = 0; this.declick = 0; this.lastOut = 0;
      this.freqNow = 0;
      this.opPhase = new Float64Array(4);
      this.opEnv = new Float64Array(4);
      this.opCoef = new Float64Array(4);
      this.opRatio = new Float64Array(4);
      this.opOut = new Float64Array(4);
      this.fb1 = 0; this.fb2 = 0;
      this.setParams(DEFAULTS.slice());
      this.settle();
    }

    setParams(p) {
      p = upgrade(p);
      this.params = p;
      const spm = this.sr * 0.001;
      this.attackInc = 1 / (P.attackMs(p) * spm);
      this.decayInc = 1 / (P.decayMs(p) * spm);
      this.holdSamples = (P.holdS(p) * this.sr) | 0;
      this.sweepInc = 1 / (P.sweepMs(p) * spm);
      this.tAttackRow = P.attackRow(p);
      this.tDecayRow = P.decayRow(p);
      this.tSweepRow = P.sweepRow(p);
      this.startHz = P.startHz(p);
      this.endHz = P.endHz(p);
      this.algo = ALGORITHMS[P.algorithm(p)];
      this.isCarrier = [0, 1, 2, 3].map((j) => this.algo.carriers.includes(j));
      this.opAmt = [0, 1, 2, 3].map((j) => (this.isCarrier[j] ? P.level(p, j) : P.index(p, j)));
      let sum = 0;
      for (const c of this.algo.carriers) sum += P.level(p, c);
      this.norm = 1 / Math.max(1, sum);
      this.fbAmt = P.feedback(p);
      for (let j = 0; j < 4; j++) {
        this.opRatio[j] = P.ratio(p, j);
        this.opCoef[j] = Math.exp(Math.log(0.001) / (P.opDecayMs(p, j) * spm));
      }
    }

    // Jump every glide straight to the knob values (the plugin does this at start-up).
    settle() {
      this.attackRow = this.tAttackRow;
      this.decayRow = this.tDecayRow;
      this.sweepRow = this.tSweepRow;
      this.volSmooth = this.params[0];
    }

    // Velocity off in the plugin = 1.0, key follow off = note 48.
    trigger(note = 48, velocity = 1) {
      this.keytrack = Math.pow(2, (note - 48) / 12);
      this.velocity = velocity;
      this.phase = 0;
      this.opPhase.fill(0);
      this.opEnv.fill(1);
      this.fb1 = 0; this.fb2 = 0;
      this.holdCount = 0;
      this.freqNow = this.startHz;
      this.active = true;
      this.stage = ATTACK;
      this.attackPos = 0; this.decayPos = 0; this.sweepPos = 0;
      this.declickSrc = this.lastOut;
      this.declick = this.lastOut;
      this.envSmooth = 0;
    }

    next() {
      const t = this.tables;
      let env = 0, osc = 0;
      if (this.active) {
        const c = this.knobCoef;
        this.attackRow += (this.tAttackRow - this.attackRow) * c;
        this.decayRow += (this.tDecayRow - this.decayRow) * c;
        this.sweepRow += (this.tSweepRow - this.sweepRow) * c;

        // pitch sweep
        this.sweepPos = Math.min(this.sweepPos + this.sweepInc, 1);
        const shape = lookup(t.falling, this.sweepRow, this.sweepPos);
        const freq = (this.startHz - this.endHz) * shape + this.endHz * this.keytrack;
        this.freqNow = freq;
        // four FM operators, computed from op 4 down so modulators are ready first
        const w = TAU * freq / this.sr;
        const mods = this.algo.mods, o = this.opOut;
        osc = 0;
        for (let j = 3; j >= 0; j--) {
          let pm = 0;
          const m = mods[j];
          for (let k = 0; k < m.length; k++) pm += o[m[k]];
          if (j === 3 && this.fbAmt > 0) pm += this.fbAmt * (this.fb1 + this.fb2) * 0.5;
          const s = Math.sin(this.opPhase[j] + pm);
          if (j === 3) { this.fb2 = this.fb1; this.fb1 = s; }
          const e = this.opEnv[j];
          this.opEnv[j] = e * this.opCoef[j];
          this.opPhase[j] += w * this.opRatio[j];
          if (this.isCarrier[j]) { o[j] = 0; osc += s * e * this.opAmt[j]; }
          else o[j] = s * e * this.opAmt[j];
        }
        osc *= this.norm;
        this.phase += w;

        // amplitude envelope
        switch (this.stage) {
          case ATTACK:
            this.attackPos += this.attackInc;
            if (this.attackPos >= 1) { this.attackPos = 1; this.stage = HOLD; }
            env = this.velocity * lookup(t.rising, this.attackRow, this.attackPos);
            break;
          case HOLD:
            this.holdCount++;
            if (this.holdCount >= this.holdSamples) this.stage = DECAY;
            env = this.velocity;
            break;
          case DECAY:
            this.decayPos += this.decayInc;
            if (this.decayPos >= 1) { this.decayPos = 1; this.stage = DONE; }
            env = this.velocity * lookup(t.falling, this.decayRow, this.decayPos);
            break;
          default:
            env = 0;
        }
      }
      this.volSmooth -= (this.volSmooth - this.params[0]) * this.volCoef;
      this.envSmooth += (env - this.envSmooth) * this.envCoef;
      let out = osc * this.envSmooth;
      // fade out whatever the previous hit was doing, to avoid clicks
      this.declickSrc *= this.declickKeep;
      this.declick -= (this.declick - this.declickSrc) * this.declickFollow;
      out += this.declick;
      this.lastOut = out;
      return out * this.volSmooth;
    }
  }

  // Render one hit offline (for drawing and for saving to a file).
  function render(params, sampleRate, tables) {
    const v = new Voice(sampleRate, tables);
    v.setParams(params);
    v.settle();
    v.trigger(48, 1);
    const n = ((P.lengthS(params) + 0.01) * sampleRate) | 0;
    const out = new Float32Array(n);
    const pitch = new Float32Array(n);
    for (let i = 0; i < n; i++) { out[i] = v.next(); pitch[i] = v.freqNow; }
    return { out, pitch };
  }

  // ---- sequencer clock (shared by the live worklet and offline export) ----
  // pattern = { bpm, swing (0..0.75), length (1..16), steps: [{ on, params }] }
  function samplesPerStep(pattern, sr, stepIndex) {
    const base = (60 / pattern.bpm) / 4 * sr; // 16th notes
    const sw = pattern.swing || 0;
    // swing pushes odd 16ths later: even step is longer, odd step shorter
    return stepIndex % 2 === 0 ? base * (1 + sw / 2) : base * (1 - sw / 2);
  }

  // Offline render of `loops` passes of the pattern through one voice, so
  // consecutive hits interact exactly as they do live.
  function renderPattern(pattern, sampleRate, tables, loops = 1) {
    const v = new Voice(sampleRate, tables);
    const first = pattern.steps.find((s, i) => i < pattern.length && s.on);
    if (first) { v.setParams(first.params); v.settle(); }
    let total = 0;
    for (let i = 0; i < pattern.length; i++) total += samplesPerStep(pattern, sampleRate, i);
    const loopLen = Math.round(total);
    const tail = loops === 1 ? Math.round(sampleRate * 1.2) : 0;
    const n = loopLen * loops + tail;
    const out = new Float32Array(n);
    let nextStepAt = 0, step = 0, acc = 0;
    for (let i = 0; i < n; i++) {
      if (i >= nextStepAt && i < loopLen * loops) {
        const s = pattern.steps[step];
        if (s && s.on) { v.setParams(s.params); v.trigger(48, 1); }
        acc += samplesPerStep(pattern, sampleRate, step);
        nextStepAt = Math.round(acc);
        step = (step + 1) % pattern.length;
      }
      out[i] = v.next();
    }
    return out;
  }

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function noteName(hz) {
    const n = Math.trunc(12 * Math.log2(hz / 427.65) + 69);
    const idx = n < 12 ? 0 : Math.min(n, 139) - 12;
    return NOTE_NAMES[idx % 12] + Math.floor(idx / 12);
  }

  // Knob value text, matching the original display.
  function display(i, p) {
    const v = p[i];
    switch (i) {
      case 0: return Math.trunc(v * 100) + '%';
      case 1: case 3: {
        const ms = 5 + 995 * v;
        return ms >= 1000 ? '1 s' : ms.toFixed(2) + ' ms';
      }
      case 2: case 6: return (1000 * (0.001 + 0.999 * v * v * v)).toFixed(1) + ' ms';
      case 4: { const hz = P.startHz(p); return hz.toFixed(2) + ' Hz (' + noteName(hz) + ')'; }
      case 5: { const hz = P.endHz(p); return hz.toFixed(2) + ' Hz (' + noteName(hz) + ')'; }
      case 7: case 8: case 9: break;
      case FEEDBACK: return Math.round(v * 100) + '%';
      case ALGO: return (P.algorithm(p) + 1) + ': ' + ALGORITHMS[P.algorithm(p)].name;
      default:
        if (i >= RATIO && i < LEVEL) return '×' + P.ratio(p, i - RATIO);
        if (i >= LEVEL && i < OPDECAY) {
          const op = i - LEVEL;
          const car = ALGORITHMS[P.algorithm(p)].carriers.includes(op);
          return car ? Math.round(v * 100) + '% out' : 'idx ' + P.index(p, op).toFixed(2);
        }
        if (i >= OPDECAY && i < FEEDBACK) {
          const ms = P.opDecayMs(p, i - OPDECAY);
          return ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : ms.toFixed(0) + ' ms';
        }
    }
    {
        if (v === 0.5) return 'Linear';
        if (v > 0.5) return '+' + Math.trunc((2 * v - 1) * 100) + '% Convex';
        return '-' + Math.trunc((1 - 2 * v) * 100) + '% Concave';
    }
  }

  return { CURVE_ROWS, CURVE_COLS, KEYS, NUM_PARAMS, RATIO, LEVEL, OPDECAY, FEEDBACK, ALGO,
    RATIOS, ratioKnob, ALGORITHMS, algoKnob, upgrade, DEFAULTS, makeTables, lookup, P, rateFactors,
    Voice, render, samplesPerStep, renderPattern, noteName, display };
}

if (typeof module !== 'undefined') module.exports = SineKickDSP;
