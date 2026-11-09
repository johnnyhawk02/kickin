# Sine Kick — browser version

A JavaScript port of the Rust app in `../app`, plus a 16-step sequencer where every step holds its own complete kick.

## Run it

Open `index.html` in Chrome, Edge, Firefox or Safari. No build, no server, no install.
(If your browser refuses to start audio from a local file, run `python3 -m http.server` in this folder and open http://localhost:8000.)

## Files

- `dsp.js` — the engine, ported line for line from `app/src/dsp.rs` (curve tables, voice, sample-rate factors, display text). Also holds the sequencer clock and the offline pattern renderer.
- `presets.js` — the 27 factory presets from `app/src/presets.rs`.
- `app.js` — UI, AudioWorklet playback, sequencer, WAV export.
- `test.js` — `node test.js`: the same checks as the Rust test (peak, start/end pitch, silent tail) plus a pattern render check.

## Sequencer

- 16 steps. Each step stores all ten knobs (volume, attack, hold, decay, start, end, sweep and the three curves) and a name.
- Click a step to edit it: the knobs, display, preset menu and RANDOM all act on the selected step. Click the light on a step to switch it on/off.
- BPM, swing and pattern length (1–16 steps). Copy/paste a kick between steps, push one kick to every active step, or randomise all active steps.
- The step clock runs inside the audio thread, so timing is sample-accurate, and one voice plays every step, so a new hit de-clicks the previous one exactly like the original engine.
- Editing a knob while the pattern plays changes the kick that is ringing, like turning a knob on the original.
- SAVE HIT writes the selected step as a 24-bit mono WAV; SAVE LOOP writes one seamless bar of the pattern. 44.1k / 48k / 96k picks the rate.
- The pattern is saved in the browser automatically.

Keys: Space play/stop · Enter audition · ←/→ select step · 1–9, 0 toggle steps 1–10 · Cmd/Ctrl+C / V copy/paste a kick.
