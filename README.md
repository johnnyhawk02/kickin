# Kickin

A 4-operator FM kick drum synth in the browser, with a 16-step sequencer where every step holds its own complete kick.

## Run it

Live at https://johnnyhawk02.github.io/kickin/ — or open `index.html` in Chrome, Edge, Firefox or Safari. No build, no server, no install.
(If your browser refuses to start audio from a local file, run `python3 -m http.server` in this folder and open http://localhost:8000.)

## The sound

- **Pitch sweep:** START → END frequency over SWEEP time, with a curve. All four operators follow it at their own ratio.
- **Amp envelope:** ATTACK, HOLD and DECAY with curves shape the whole kick.
- **Four operators:** each has a RATIO (×0.5 to ×16), a LEVEL, and its own DECAY. On a carrier, LEVEL is how loud it is. On a modulator, the knob reads INDEX and sets how hard it bends the operator it feeds. OP 4 also has FEEDBACK, which goes from a little grit up to noise.
- **Eight algorithms:** these set how the operators are wired, from a full 4→3→2→1 stack to all four running in parallel. The header on each operator shows whether it's an output (OUT) or which operator it modulates (→ 2).
- **16 factory FM presets,** plus RANDOM.

## Sequencer

- 16 steps, and each step stores every setting: the envelope, the pitch sweep, all four operators, feedback and algorithm.
- Click a step to edit it. The knobs, display, preset menu and RANDOM then act on that step. Click the light on a step to switch it on or off.
- BPM, swing and pattern length (1–16 steps). You can copy and paste a kick between steps, push one kick to every active step, or randomise all active steps.
- The step clock runs inside the audio thread, so timing is sample-accurate.
- SAVE HIT writes the selected step as a 24-bit mono WAV. SAVE LOOP writes one bar of the pattern that loops cleanly. 44.1k / 48k / 96k picks the sample rate.
- Your pattern is saved in the browser automatically.

Keys: Space play/stop · Enter audition · ←/→ select step · 1–9, 0 toggle steps 1–10 · Cmd/Ctrl+C / V copy/paste a kick. Knobs: click and drag (shift = fine), double-click to reset.

## Files

- `dsp.js` — the engine: pitch sweep, amp envelope, the four FM operators and their algorithms, the sequencer clock and the offline renderer.
- `presets.js` — the factory FM presets.
- `app.js` — the UI, AudioWorklet playback, sequencer and WAV export.
- `test.js` — run `node test.js` to check the engine and a pattern render.
