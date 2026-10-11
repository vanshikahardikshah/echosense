# EchoSense

Camera-free room sensing with an ordinary phone. The loudspeaker emits an inaudible ultrasonic signal, the microphone listens to the echoes, and on-device signal processing turns them into presence, distance, approach, contactless breathing rate and fall detection, fused with passive sound events and the phone's motion sensors. Several phones can share a room and be combined into a live floor map.

**Start here: [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md).** How it works: [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md).

## Run it

Needs Node 18 or newer. Nothing to install: the hub is prebuilt into one file.

```
node dist/server.cjs
```

* Phone app: `http://localhost:8080/` (on a phone, use an https address, see the runbook)
* Console: `http://localhost:8080/console`

The `public` folder is also a complete static site: host it anywhere with https (GitHub Pages works) for single-phone use without the hub.

## Develop

```
npm install
npm test          # 46 tests: DSP, sensing, fusion, simulated rooms
npm run build     # browser bundles to public/dist, hub to dist/server.cjs
```

End-to-end check through a real browser audio stack (Chromium with a rendered room recording as the microphone):

```
npx esbuild tools/gen-wav.ts --bundle --platform=node --outfile=/tmp/gen-wav.cjs
node /tmp/gen-wav.cjs demo /tmp/demo.wav
node dist/server.cjs &
CHROME=/path/to/chrome node tools/e2e-mic.mjs /tmp/demo.wav /tmp 80
```

## Layout

```
src/dsp/        sonar: waveform design, matched filter, alignment, clutter removal,
                detection, tracking, Doppler high-pass, breathing, range-Doppler
src/audio/      passive acoustic event detection (impact, glass, scream, voice)
src/motion/     IMU: phone moved / dropped, wearer fall detection
src/fusion/     multimodal fusion, alerts with evidence, check-in, trilateration
src/engine/     the on-device engine that ties it together
src/app/        phone web app (audio I/O, worker, UI)
src/console/    caregiver / demo console (room map, alerts)
src/server/     hub: static hosting, WebSocket relay, band assignment, webhooks
src/sim/        physical room simulator used by tests and the labelled demo mode
test/           automated tests
tools/          build, WAV rendering, browser end-to-end and screenshot scripts
```
