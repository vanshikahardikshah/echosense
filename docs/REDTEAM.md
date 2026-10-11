# Red team: morning summary (Oct 11, 2026)

**Rerun it:** `node dist/redteam.cjs` (the scenario families) or `node dist/redteam.cjs --holdout` (the held-out set). Each run is saved to `redteam-out/*.json`.

## What was tested, and what was not

- **Code frozen before the run.** The sha256 of every file under `src` was `8a818f0f…`, and it was identical after the run. No product code changed.
- **Held-out set.** I wrote 8 scenarios before seeing any results (`tools/redteam/holdout.ts`, sha256 `7dfe7763…`), and ran them once, last.
- **What the simulator tests: the decision protocol.** That covers the phone agents → evidence reports → Responder, Skeptic and Auditor → the rule outcome → what the hub does. It also covers watchful waiting and the scream path, which asks at once.
- **What it does not test:**
  - **Real sensing.** Sonar and the sound model are simulated, and failure rates are seeded.
  - **Claude.** Where Claude would negotiate, the run is flagged, not run. No key was used, so nothing was spent.
  - **Speech.** It is tested as text through the rule parser, not as audio.
- **Assumed person.** A non-emergency person answers "I'm OK". An emergency person cannot answer.

## Headline numbers

| | Runs | Caught or correct | Asked first | Wrong |
|---|---|---|---|---|
| Emergencies, 12 families × 10 variants | 120 | 92 countdown → call | 23 ask → call after 40 s silence | **5 missed** |
| Not emergencies, 14 families × 10 variants | 140 | 102 nothing | 35 "Are you OK?" | 3 countdowns (no call if they answer) |
| **Held-out** emergencies, 4 × 10 | 40 | 33 | 4 | **3 missed** |
| **Held-out** non-emergencies, 4 × 10 | 40 | 34 | 5 | 1 countdown |

- **No false calls if the person can answer.** Across all 340 runs, every wrong alarm was a question or a countdown that "I'm OK" cancels.
- **Negotiation (Claude) would run in 55 of 260 family runs (21%).** In the held-out set it would run in 8 of 80.

## Failures by category (8 missed emergencies, 4 countdowns that shouldn't have happened)

| Category | Count | Pattern | Repeats? |
|---|---|---|---|
| Escalation policy | 3 misses (slide out of a chair) | See finding 1 | **Yes: 3 of 10 in one family** |
| Sensing | 4 misses | No phone triggered at all (quiet collapse, two-phone layout, quiet hallway fall), or the only phone that could see was the hacked one | Spread out; limits of the sensors |
| Agent reasoning | 1 miss | Quiet hallway fall: impacts of 11–20 dB, nothing visible, agents stood down | Once |
| Sensing (can't be told apart) | 3 countdowns | A hard sit with a thud, or lying down on the floor on purpose: burst + thud + stillness looks exactly like a fall | Expected; "I'm OK" cancels |
| Evidence semantics | 1 countdown | See finding 2 | Once |

## Findings, in order of importance

### 1. A small twitch turns off the safety net (repeats, not fixed)

Someone sitting slides to the floor. That gives a small burst (16–18 dB), no impact sound, and stillness afterwards.

- **Why the agents stand down.** The Skeptic says "sat down quickly", and the other two agree.
- **Why nothing watches afterwards.** Watchful waiting is only armed when *no* movement at all is seen 1.5–11.5 s afterwards (`firstMoveAfter === null`). One small shift at 6 s turns it off.
- **The obvious fix doesn't work.** I tested "mostly still (≥80%), with no sustained movement" as the condition instead.
  - It arms watching on all 9 slide-from-chair runs.
  - It also arms it on 10 of 10 seated TV crashes and 10 of 10 taps.
  - Someone dozing in front of the TV would then be asked, and if they sleep through it, a call goes out.
- **So this is your decision, not a bug I fix overnight.** A better gate would need a sign that the body moved *lower* or to a new spot (for example, range changed by more than 0.25 m on two phones). That needs testing on real phones first.
- **Real-phone test:** sit in a chair near two phones, slide to the floor, stay down for 90 s.

### 2. Two phones hearing the TV count as corroboration (once)

- **What happened.** In the TV-scream-while-napping scenario, the sound model hadn't loaded (it fails in 15% of simulated trials). The loud TV scream was believed on loudness alone and heard by two phones.
- **Why it matters.** "≥2 phones heard distress" is meant as independent corroboration, but it's one source heard twice. The result was a countdown. A sleeping person who doesn't answer would get a call.
- **Mitigation now:** make sure the console shows the sound model as loaded on every phone before the demo.

### 3. Hallway falls depend on Claude (24 emergency runs)

- **Where Claude decides.** In 24 emergency runs the rules came back ask_human and negotiation would decide. Ten were silent lowering and seven were falls out of every sonar view.
- **The risk.** If the three Claude agents agree on "none" for a hallway fall, nothing arms watchful waiting, because no phone saw the body move.
- **The rules alone ask in all 24.** The open question is what Claude does here, and that is the one Claude test worth paying for: `node dist/eval.cjs --claude 3 --only fall_hallway,soft_collapse`

### 4. Speech: 48 of 53 rule cases pass, and the 5 "failures" can't happen

- **What passes.** The parser got these right:
  - "No, I'm hurt" / "I'm not okay" / "I can't get up" → help.
  - "No no I'm okay don't call" / "um I'm fine" → OK.
  - A bare "no" → asks again.
  - Leaked prompt echo ("…or say help, I am okay") → OK.
- **Why the 5 don't count.** All five assumed the phone says "Do you need help?". It never says that out loud: spoken prompts are always ask1, ask2 or urgent.
- **A small wording risk remains.** For a scream, the phone's screen shows *"I heard someone cry out. Are you OK? Do you need help?"* Someone reading it might say "yes" and mean "yes, I need help", and the parser would read that as OK. Making the screen match the spoken line ("Say I'm OK, or say help") removes it. It's one string; your call.

### Held up well

- A hacked phone faking a fall: 10/10 correct, and 10/10 in the held-out set during a movie.
- Door slams, hammering, taps next to a phone, and a pet knocking over a chair: no alarms.
- Falls in the middle of a loud phone call: 10/10 caught in the held-out set.
- Two-phone falls in the held-out set: 10/10 caught.
- A fall seen by only one phone: 10/10 caught.
- Animated talking read as a "scream": no alarm in 9 of 10, and one question in the 10th.

## What I'd do this morning

1. **Real three-phone testing first.** Add the chair-slide test from finding 1.
2. Check that the sound model shows as loaded on all three phones.
3. If there's budget, run the one Claude eval in finding 3.
4. Decide findings 1 and 4 yourself. I didn't change them.
