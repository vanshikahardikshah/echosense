# Witness: phones that argue before they call for help

Witness is the agent layer on top of EchoSense (Cisco track, Level 3: collective intelligence).

EchoSense turns any phone into a camera-free room sensor (ultrasonic sonar plus sound plus motion). One phone on its own has to decide alone, and it gets fooled: a crash in an action movie, a phone knocked off a table, a fall it cannot see. Witness makes every phone an agent and adds three role agents with competing goals. They argue over the evidence in public, and no agent has the final say.

## The agents

| Agent | Goal | What it does |
|---|---|---|
| Phone agents (one per phone) | Report what it measured, nothing more | Keeps a rolling memory of its own sonar, sound and motion stream. Raises a trigger on an impact, a scream, a sudden movement, a quiet "sudden movement then stillness", a fall alert or a Get help press. When any incident opens, it posts an evidence report with numbers: loudest impact, whether it was watching the person, body burst, stillness afterwards, first movement afterwards, range before and after, whether the phone itself moved, voice or music before, its own on-device verdict. Never raw audio. |
| Responder | Never let a real fall go unanswered | Builds the strongest case for getting help. Asks the person first when they are clearly awake and moving. |
| Skeptic | Prevent false alarms | Looks for a harmless explanation that fits every measurement: the bang came from elsewhere (TV), a phone got knocked over, they moved normally afterwards, they sat down, they are still standing where they were, the data is bad. |
| Auditor | Trust no phone by default | Scores every phone against physics and the other phones: a bang that loud reaches every phone in a room; a phone that heard nothing when two others heard 25 dB is suspect; a burst that a phone watching the person did not see is suspect; a phone whose room echo changed by 15 dB moved itself; a replayed report is rejected. Says whether the danger evidence is corroborated by independent channels. |
| Cartographer | Know the home | Does not vote. Reads the reports against the room map and tells the others where the bang came from and where the person ended up. |

## The protocol

1. Any phone raises a trigger. An incident opens (triggers within 3 s join it).
2. Every streaming phone posts its evidence report about 12 s after the event.
3. Round 1: the three role agents post positions independently (get help, stand down, not sure) with an argument and the evidence they cite.
4. Round 2: each agent reads the others and may change its mind (the console shows "changed its mind").
5. The outcome is a fixed public rule over the round 2 positions. There is no judge agent; anyone holding the board can recompute it.
   * **Get help**: no agent says stand down, and two or more say get help. Calls the caregiver (Twilio voice, press 1 on my way, press 2 false alarm), texts, posts to Discord or Slack, and tells the phones "Help has been called".
   * **Stand down**: no agent says get help, and two or more say stand down.
   * **Ask the person**: anything else. The disagreement is kept on the record and every phone asks "Are you OK?". No answer in 30 s means get help. The person's answer, the caregiver's key press, or the console decide.
6. Phones the Auditor scores below 30% are flagged as untrustworthy (quarantined).

The person always has the last word: pressing Get help on any phone calls immediately, and "I'm OK" stands everything down.

## What changed after real world testing

Testing on a laptop showed a finger snap, then 20 seconds of silence, turning into an emergency. Three fixes came out of that.

**Sound recognition on the phone (YAMNet).** Every phone now runs Google's YAMNet, a network trained on AudioSet (about 2 million YouTube clips, 521 sound classes), in its own worker, in plain TypeScript with no ML runtime. The weights come from the published int8 TFLite model; the port matches it within a few percent (test/yamnet.test.ts). It runs every half second, and right away after any sudden sound. Its classes are grouped into what matters at home: thud, glass, distress (scream, groan, crying), speech, TV or music, small taps and snaps, household objects. A snap, a knock, typing, talking or the TV is labelled harmless on the phone and never starts an incident; very loud sounds still go to the agents in case the model is wrong. Only labels leave the phone.

**Hands free check-in.** Nobody has to find a phone or read a screen. The phone asks out loud ("Are you OK? If you are OK, just say so, or wave your hand") up to three times. Anyone answering in any words, or moving on the sonar, counts as OK; a groan, crying or a scream counts as a call for help; the TV talking does not count (the sound model knows it is the TV), and the phone ignores its own voice. The family gets a Webex note either way ("checked in after a loud bang: they answered out loud, no action needed"), and a call only when the agents agree or nobody answers.

**Stricter evidence.** A sound alone, from one device, with nobody seen moving, is no longer enough to ask anyone. Calling straight away needs something unambiguous: a fall pattern on the sonar, someone in distress, a person who vanished from every sonar right after a heavy thud, or a Get help press. Everything ambiguous asks first.

**Watchful waiting.** When the agents stand down because someone seems to have sat or lain down, that explanation predicts they will move again. If no phone sees them move in the next minute, the hub asks after all.

**Contradictions go to a person.** With only two phones, a hacked phone and an honest one can tell opposite stories and nobody can break the tie. The Auditor now flags that, and the rule sends it to the person instead of letting either story win.

## The Cartographer (room map)

Sonar measures distance, not what things are: it cannot tell a sofa from a TV. So the map is taught once, the way you would show a new carer around. On the console, stand at the sofa and press "I'm standing there: save"; every phone that can see you records how far away you are, and the place becomes a fingerprint of distances. You can also say what each phone sits next to ("by the TV"). On its own it learns where people usually rest (distances where someone stays still for 20 s).

The Cartographer is a fourth agent on the channel. It does not vote; when the evidence is in it tells the others where the bang came from (the loudness pattern across three or more phones, or with fewer phones, which marked place the loudest phone is next to) and where the person ended up (their final distances match the sofa, the bed, or nothing). A TV can only explain a bang if the sound model heard the TV playing. Ending up on the sofa explains stillness, being in the middle of the floor does not.

## Results

Evidence level simulator, 50 randomized trials per scenario, sensor noise, sonar misses, misclassified sounds, the sound model failing to load in 15% of trials, people who shift around while awake. The baselines are each phone's own on-device rule, including the sound model. "After asking" means the person was asked first and help was called when nobody answered (about 40 s slower).

Three phones:

{t3}
Two phones (one of them by the TV):

{t2}
The room map does not change how many falls are caught; it removes questions (the person sitting down on the sofa is no longer asked) and makes the explanations concrete.

Honest limits:

* This is an evidence level simulator: the inputs are what phones report, not raw audio. The sonar and the sound model are validated separately (sonar against a physical acoustic simulation, YAMNet against the original model), and on real iPhones.
* The agents were tuned on most of these scenarios. "Fall out of every phone's view", "Real fall while the TV is on" and "Door slams while walking" were written afterwards.
* Two phones cannot settle who is lying when one is hacked: the person gets asked every time (the 40 asks in that row). Three phones settle it by physics.
* Single occupant homes are assumed (the target: older adults living alone).

Run it yourself: `node dist/eval.cjs --trials 50` (add `--phones 2`), or one trial with every argument: `node dist/eval.cjs --show tv_thud 3 --map`.

## Disagree, negotiate, decide (Cisco Level 3)

Each role agent has its own goal, and the goals pull against each other: the Responder speaks for the person (never miss a fall), the Skeptic speaks for the household (every needless call scares the family until they switch the system off), the Auditor trusts no phone (decide only on evidence that checks out). That tension is the real trade off every fall detector faces.

1. **Positions.** Every incident, all three post a position from the phones' evidence, then read each other and may change their minds. When they agree, that is the decision (about a second, free).
2. **Negotiation, when they disagree.** They do not vote. Each becomes its own Claude, keeping its own goal, and they bargain on the SLIM channel over what to actually do, on a ladder of real actions: do nothing, keep watching, ask "Are you OK?", say "it looks like you may have fallen" and count down, call the family now. A plan can carry a condition: call at once if no phone sees movement within N seconds.
3. **Moves.** Each round every agent makes one move: an offer, a challenge to a specific claim of another agent (with evidence), a concession, a counter offer, or acceptance of another agent's plan. A disputed fact is settled by checking instead of arguing: an agent can broadcast "look again" to every phone on the channel, ask the Cartographer, run the physics check, or read the home history. Those checks show under its move.
4. **Agreement, or not.** A deal is all three standing behind the same plan, in up to three rounds. Collective intelligence does not mean forcing consensus: with no deal, the disagreement itself is the finding (the evidence is not enough to decide), so it stays on the record and the person is asked out loud: the countdown if anyone still wants help called, the gentle question otherwise. If the person cannot answer, a fixed safety rule calls for help.
5. **The plan is carried out**, including its condition, and the person can always answer first: "I'm OK" stands everything down, "help" calls at once.

The console shows the whole exchange as a thread: where each agent started, who challenged whom about what, what they checked, who conceded, and the agreed plan.

**Cost.** Everything that runs all day is local and free: sonar and sound recognition on the phones, speech recognition and the agents' positions on the hub. Claude runs only for the negotiation moves on contested incidents (a few cents each with Haiku), under a hard daily cap (`ECHOSENSE_CLAUDE_DAILY_USD`, default $0.50) shown on the console. With no key or over the cap, a disagreement simply asks the person.

**It learns from people.** Every answer (the person says "I'm OK", the caregiver presses On my way or They are OK, no answer) is the label for that incident in `homememory.json`. A phone whose alarms keep turning out false loses trust with the Auditor, and a sound that was harmless before on the same phone at the same time of day becomes a known pattern for the Skeptic.

## AGNTCY, piece by piece

* **SLIM (transport):** every agent has its own identity (`witness/home/responder`, `witness/home/phone-node-1`, ...) in one MLS encrypted, moderated group session. The moderator removes a phone the Auditor flags; it can no longer read or post.
* **Three communication patterns, as in CoffeeAGNTCY:** group chat (the incident board and the negotiation: everyone hears every report, position and move), broadcast (an agent asks every phone to look again at once), addressed request (one phone).
* **A2A (semantics):** every message on the channel is an A2A Message (role agent, one data part, the incident as contextId). Each agent has an A2A Agent Card at `/agents/<name>/.well-known/agent-card.json`; the directory is at `/agents`. The A2A SLIMRPC binding exists for Python, Go, Java, .NET and Rust but not Node, so the hub sends A2A JSON over the SLIM group session.
* **Observability:** each incident can go out as one OpenTelemetry trace (a span per report, position and agent step) to any OTLP collector, including the AGNTCY observability stack: set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`. The console also shows the channel log for each incident: who sent what, when.

## Asking before calling, and understanding the answer

A fall detecting watch does not call the moment it thinks you fell: it asks, counts down, and calls if you do not answer. Witness does the same, with the agents deciding how hard to ask.

* **Get help** (the agents agree it looks like a fall): every phone says "It looks like you may have fallen. If you are OK, say I'm OK. Otherwise I will call for help." and counts down 25 s (`ECHOSENSE_URGENT_SECONDS`). Moving about does not cancel it: someone hurt on the floor moves too. Help is called at once, with no countdown, if they ask for help, or if a question already went unanswered with physical evidence behind it.
* **A cry for help takes a fast, fixed path** (no negotiation, no Claude): a scream, crying or a very loud shout makes every phone ask "Are you OK? Do you need help?" immediately while the other phones check. "Help" or "I'm hurt" calls at once, "I'm OK" stands it down. No answer calls only if something physical backs it up (a bang, a body movement, or a second phone hearing the cry); a cry heard by one phone alone (it could be a film) gets the countdown first.
* **Not sure**: a gentle "Are you OK?". No answer in 40 s calls.
* **No emergency**: nothing, but if someone dropped and nobody moves for a minute, they are asked anyway.
* **The person always wins.** If they say they are OK at any moment, even while the agents are still arguing, nobody is called. If they say they need help, help is called right away without waiting for the agents.
* **One thing at a time.** While the phones are checking on someone or help is coming, new bumps fold into that incident instead of starting new alarms, and for 20 s after "I'm OK" the bumps of them getting up are ignored (asking for help, a scream, or a phone's own fall alarm always gets through).

**Understanding what they say.** Talking is not the same as "I'm OK": "Nooo, I'm hurt" is speech too. When the person answers, the phone sends just those few seconds of audio to the hub, which turns them into words on the hub itself (Moonshine speech recognition through sherpa-onnx, downloaded once, about 120 MB; audio never leaves the home). Two readers then decide what the words mean, and help always wins: keyword rules that need no network ("help", "hurt", "not OK", "can't get up", a bare "no") and Claude, which reads it the way a person would ("I think I broke my hip"). If it is not an answer at all (the TV, talking to someone else), the phone asks again. What they said is quoted in the caregiver's call, text and Webex card, and Claude writes the caregiver's message in three plain sentences.

## Cisco integration

**AGNTCY SLIM is the channel the agents argue on.** Every agent has its own SLIM identity: `witness/home/responder`, `witness/home/skeptic`, `witness/home/auditor`, and one per phone (`witness/home/phone-node-1`). They all join one SLIM group session, `witness/home/board`, with MLS end to end encryption, so the relay in the middle cannot read a report or an argument. The hub runs the SLIM node in process (Node bindings `@agntcy/slim-bindings`) or connects to an existing node with `SLIM_ENDPOINT`. Each role agent only knows what arrives on the channel and posts under its own identity; the console shows which identity posted every report and position.

The hub is the group's moderator, and that is where quarantine becomes real: when the Auditor scores a phone below 30%, the moderator removes it from the MLS group. It can no longer read the channel or post to it, and it is let back in after two minutes. If an agent goes silent, the outcome is computed from the positions that did arrive, which pushes the rule toward asking the person.

**Cisco Webex is where the caregiver answers.** When the agents call for help, the bot posts an adaptive card with each agent's final position and two buttons, On my way and They are OK. A button press comes back through a signed webhook (HMAC checked) and resolves the incident, and the phones say "Help is on the way".

**Agent directory.** `/agents` on the hub lists every agent with its skills, inputs, outputs and SLIM address.

Without the SLIM package the same protocol runs over an in memory channel (`ECHOSENSE_SLIM=0` forces that).

## Code

* `src/agents/phoneAgent.ts` phone agents: triggers and evidence reports
* `src/agents/roles.ts` Responder, Skeptic, Auditor
* `src/agents/protocol.ts` rounds and the outcome rule
* `src/agents/bus.ts` the channel: AGNTCY SLIM group session (MLS) or in memory
* `src/agents/roleAgent.ts` a role agent as an independent channel participant, and the Cartographer agent
* `src/agents/cartographer.ts` room map, sound source and resting place reasoning
* `src/audio/yamnet.ts`, `src/app/soundai-worker.ts`, `src/audio/soundLabels.ts` sound recognition on the phone
* `src/agents/council.ts` moderator in the hub: incidents, outcome rule, quarantine, actions, demo tools
* `src/agents/negotiation.ts`, `src/agents/negotiator.ts` the action ladder, moves, agreement and compromise; one agent's negotiation move as Claude with tools
* `src/agents/brain.ts` Claude tool loop shared by the agents
* `src/agents/budget.ts` daily cap on Claude spending
* `src/agents/a2a.ts` A2A message envelopes on the channel
* `src/agents/otel.ts` incidents as OpenTelemetry traces
* `src/agents/memory.ts` what the home learns from people's answers
* `src/agents/intent.ts` what a spoken answer means (rules plus Claude, help wins)
* `src/server/stt.ts` speech to text on the hub (Moonshine via sherpa-onnx)
* `src/agents/llm.ts` Claude settings plus the simpler narrate and reason modes
* `src/agents/notify.ts` Twilio call with key press, SMS, Webex card with buttons, webhook, signature checks
* `src/agents/sim.ts`, `src/agents/eval.ts` scenarios, baselines and scoring
* `/agents` on the hub: agent directory (AGNTCY style records)
