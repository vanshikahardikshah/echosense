# How EchoSense works

## The signal

The phone loops a 21.3 ms waveform (1024 samples at 48 kHz) through its loudspeaker, about 47 times a second. It occupies 18.0 to 20.8 kHz, above what most adults hear, and has no energy at all in the audible band.

The waveform is a Zadoff-Chu style sweep built in the frequency domain: every frequency in the band gets exactly equal energy, with quadratic phase. Quadratic phase in frequency is a linear sweep in time, so this is a chirp whose spectrum is perfectly flat. That choice matters for two reasons we measured during development: an earlier triangular chirp had 24 dB notches in its spectrum, which raised range sidelobes to about -20 dB and smeared moving people across the whole room; the flat design keeps sidelobes at the -31 dB limit of the Hann window next to the peak, falling below -60 dB a metre away, and stays Doppler tolerant.

## Turning echoes into a range profile

For every ping, the microphone samples are correlated with the transmitted waveform (a matched filter). Because the signal repeats exactly, the result is the room's impulse response: one peak per reflector, at a delay proportional to its distance. Each range bin is 3.6 mm; the real resolution, set by the 2.8 kHz bandwidth and the window, is about 12 cm.

Two details make this work on moving people:

* The correlation uses contiguous samples across two pings (linear, not circular, correlation) with a Hann window. A walking person's echo drifts by a fraction of a sample per ping; without these, that drift smears energy across every range. With them, sidelobes stay near -35 dB at walking speed (verified in the tests at 0.5 and 1.2 m/s).
* Only frequency bins inside the sonar band are used, so speech, music and TV are rejected outright (a loud 440 Hz plus 3 kHz test signal comes out 80 dB down).

## Alignment and calibration

The browser's audio path adds an unknown delay between playing and recording. The strongest, earliest arrival is the sound going straight from speaker to microphone, so EchoSense finds that peak, locks onto it, and rotates every profile so it sits at zero distance. It also handles clock drift, dropped audio blocks (tested) and loss of signal.

Calibration has four stages: 0.8 s with the speaker muted to measure ultrasonic background noise; locking onto the direct path; 0.6 s measuring the speaker's own frequency response, which is then equalised; 3 s learning a per-range noise floor for this room.

## Finding people

* **Clutter removal.** Walls and furniture are static. A 1 s moving average of each range bin is subtracted, leaving what changed.
* **Adaptive noise floor per bin and spatial whitening.** Each bin learns its own floor. Residual ultrasonic noise lifts all bins together while a person lifts only a few, so the zone median is divided out.
* **Detection and tracking.** Local peaks above 12 dB that also stand out from their neighbours (cell averaging CFAR) become detections. A Kalman filter per track estimates range and radial speed, with M of N confirmation. It also undoes the chirp's range-Doppler coupling (a target moving at v appears shifted by about 0.15 v metres).
* **Body motion versus breathing.** A 4th order high-pass at 6 Hz across successive pings (a Doppler filter) passes walking, gestures and falls and suppresses breathing by about 60 dB. Without it, breathing at 0.6 m looked as strong as someone walking at 3 m.
* **Impulse blanking.** Keys, crinkling plastic and hard impacts carry real ultrasonic energy. The waveform has none just outside its band, so energy in those guard bands flags a corrupted ping. Corrupted pings are discarded and bridged by interpolation so no filter sees a step.

## Breathing

For each range bin from 0.25 to 2.2 m, the slowly varying echo is removed and the remainder projected onto its main axis in the complex plane. For millimetre chest motion (well under the 9 mm half wavelength) this is proportional to displacement. A 0.1 to 0.9 Hz band-pass isolates respiration, the most periodic bin wins, and its autocorrelation period gives the rate. It needs about 10 s of stillness.

Simulated results: 15/min seated at 0.9 m measured 15.0; 11/min standing at 2 m measured 11.1; 18/min lying on the floor after a fall measured 18.5.

## Passive sound

The audible band (60 Hz to 16 kHz) is analysed per ping: band energies, spectral centroid and flatness, onset flux, and pitch and harmonicity from autocorrelation, against an adaptive ambient floor. Onsets are segmented and classified by structure: impact (sudden, short, low frequency, decaying), glass or metal (sharp, high frequency ringing), scream (loud, sustained, strongly harmonic, high pitch), voice, knock, sustained sound. Regular series (a music beat, hammering) are marked repetitive and discounted. Only these features leave the module; audio is never stored.

This classifier is rule based and was tuned on synthesised sounds. Replacing it with a trained model (for example YAMNet running on device) is a natural next step.

## Motion sensors

Room mode: any movement of the phone pauses the sonar and triggers automatic recalibration once it is still again; a free fall followed by an impact is reported as a drop. Carried mode: classic threshold fall detection (low g, then an impact above about 2.5 g, then a sustained orientation change and stillness).

## Fusion and alerts

No single sense raises a fall in room mode. A fall needs a whole-body motion burst from the sonar, an impact sound within a couple of seconds, and then at least 85% stillness for 4.5 s. An impact with no burst while the sonar was watching someone is treated as a dropped object; a burst with no impact is logged as "sudden movement" (sitting down quickly). An impact while nobody was in view, but someone was seen in the last 90 s, gives a lower severity check-in because the fall may have happened out of view.

A fall starts a check-in: chime, spoken "Are you OK?", two large buttons and a countdown (15, 30 or 60 s). No answer escalates to the console and the optional webhook. A caregiver can confirm from the console. Every alert carries its evidence and a confidence.

## Several phones

The hub gives each phone its own slice of the band (two or three bands, reassigned automatically as phones join), so they do not hear each other's pings. The console converts each phone's slant range to floor distance and solves for position: Gauss-Newton least squares with three or more phones, circle intersection with room bounds to resolve the mirror ambiguity with two, then a smoothing filter. Expect roughly 20 to 40 cm error in practice, because each phone ranges to whatever part of the body reflects most.

## What was tested

* 46 automated tests: FFT, waveform spectrum and audibility, matched filter sidelobes static and moving, tracking accuracy (median error under 25 cm), breathing at two distances, empty room with loud noise, dropped audio relock, a second phone transmitting in its own band, Doppler sign, every sound class, IMU events, trilateration, and full-engine scenarios (fall with and without an answer, the demo script, sitting down, dropped object, noisy empty room, door slam, approach, scream, processing speed).
* The physical room simulator renders exact fractional delays for every reflector, true Doppler and sub-millimetre breathing, reverberation, static clutter with air turbulence, other phones, audible sounds and microphone noise.
* End to end in Chromium, with a rendered room recording fed in as the microphone: the full browser path (getUserMedia, AudioWorklet, worker, engine, UI) produced the expected alerts in order, using about 2% of real time.

## Limits to be honest about

* Not yet tested on a physical iPhone. iOS audio routing and voice processing are the main risks; the Signals tab reports the speaker to mic link and whether echo cancellation stayed on.
* Accuracy on real people in real homes has not been measured. Simulation shows the method works; a pilot is what would establish sensitivity and false alarm rates.
* Phone sonar measures distance, not direction. Positions need two or more phones.
* Range is about 3 m from the phone, and soft furnishings absorb ultrasound.
* Children and pets can hear 18 to 20 kHz.
* iPhones give apps no access to WiFi signal data, so WiFi sensing is not part of this build. It would need extra hardware such as an ESP32 that reports channel state information to the hub.

## References

* R. Nandakumar, S. Gollakota, N. Watson. Contactless sleep apnea detection on smartphones (ApneaApp). MobiSys 2015.
* R. Nandakumar, V. Iyer, D. Tan, S. Gollakota. FingerIO: using active sonar for fine-grained finger tracking. CHI 2016.
* W. Wang, A. X. Liu, K. Sun. Device-free gesture tracking using acoustic signals (LLAP). MobiCom 2016.
* W. Mao, J. He, L. Qiu. CAT: high-precision acoustic motion tracking. MobiCom 2016.
* A. K. Bourke, J. V. O'Brien, G. M. Lyons. Evaluation of a threshold-based tri-axial accelerometer fall detection algorithm. Gait & Posture, 2007.
