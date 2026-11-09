// node test.js  — mirrors the Rust test in app/src/dsp.rs plus sequencer checks.
const assert = require('assert');
const D = require('./dsp.js')();
const t = D.makeTables();
const { out: w, pitch: p } = D.render(D.DEFAULTS.slice(), 44100, t);
const peak = w.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
assert(w.every(Number.isFinite));
assert(peak > 0.7 && peak <= 0.81, 'peak ' + peak);
assert(Math.abs(p[0] - 324.8) < 2, 'start ' + p[0]);
assert(Math.abs(p[p.length - 1] - 60) < 0.01, 'end ' + p[p.length - 1]);
assert(Math.abs(w[w.length - 1]) < 1e-3, 'tail ' + w[w.length - 1]);
assert.deepStrictEqual(D.rateFactors(44100).map((x) => +x.toFixed(6)), [1, 1]);
assert.strictEqual(D.display(4, D.DEFAULTS), '324.80 Hz (E4)'.replace('E4', D.noteName(324.8)));
// sequencer: 4 steps on at 120 bpm with different params
const presets = require('./presets.js');
const pat = { bpm: 120, swing: 0, length: 16, steps: Array.from({ length: 16 }, (_, i) => ({ on: i % 4 === 0, params: presets[i % presets.length][1].slice() })) };
const buf = D.renderPattern(pat, 48000, t, 1);
assert(buf.every(Number.isFinite));
const stepLen = 48000 * 0.125;
for (const s of [0, 4, 8, 12]) {
  const seg = buf.subarray(s * stepLen, s * stepLen + 2000);
  assert(seg.reduce((m, x) => Math.max(m, Math.abs(x)), 0) > 0.3, 'hit at step ' + s);
}
console.log('ok  peak', peak.toFixed(3), 'start', p[0].toFixed(2), 'pattern samples', buf.length);
