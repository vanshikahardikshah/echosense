# EchoSense demo runbook

Read this first. It gets you from the zip to a working iPhone demo, tells you how to check it works before the meeting, and gives you a five minute script.

## What you are showing

An iPhone lying on a table turns its own speaker and microphone into a sonar. It sends inaudible chirps (18 to 20.8 kHz, about 47 per second), listens to the echoes, and works out:

* someone entering and moving, and how far away they are
* someone approaching the phone
* breathing rate of a still person, with no contact and no camera
* impacts, screams and breaking glass from ordinary sound
* a likely fall (sudden whole body movement plus an impact, then stillness), followed by a spoken "Are you OK?" check-in and escalation to a caregiver console if nobody answers

Everything runs on the phone. No audio is recorded or sent.

## Step 1. Get it onto the iPhone (pick one)

The iPhone only allows microphone access on an https address. Choose the option that fits.

### Option A: free https link, no laptop needed during the demo (recommended for one phone)

1. On github.com, create a new public repository called `echosense`.
2. Click "uploading an existing file". Open the `public` folder from the zip and drag **everything inside it** (index.html, console.html, styles.css, manifest.webmanifest, the icons, and the `dist` and `fonts` folders) into the upload area. Commit.
3. Repository Settings, Pages, Source: "Deploy from a branch", branch `main`, folder `/ (root)`, Save.
4. After about a minute your app is at `https://YOUR-USERNAME.github.io/echosense/`. Open it on the iPhone in Safari.

This gives you the full phone app. The console and multi phone features need the hub (Option B).

### Option B: full system with the laptop console (one or more phones)

On the Mac, in Terminal:

```
cd ~/echosense
node dist/server.cjs
```

It prints the addresses. Leave it running. Then in a second Terminal window:

```
brew install cloudflared        # once
cloudflared tunnel --url http://localhost:8080
```

It prints a link like `https://something-random.trycloudflare.com`. Open that link on the iPhone (and on any extra phones). Open `http://localhost:8080/console` on the Mac to show the room map and alerts.

No Homebrew? `npx cloudflared tunnel --url http://localhost:8080` also works. If neither works, run `node dist/server.cjs --https --port 8443`, open `https://<the Mac's IP>:8443` on the phone, tap "Show Details" then "visit this website" to accept the self-signed certificate.

### Option C: laptop only

Run `node dist/server.cjs` and open `http://localhost:8080` in Chrome on the Mac. The MacBook's own speakers and microphone become the sonar. Good as a backup.

### Make it full screen

In Safari tap Share, then "Add to Home Screen". Launch EchoSense from the home screen icon: no browser bars.

## Step 2. Pre-flight check on the actual iPhone (do this before the meeting)

I could not test on a physical iPhone, so this check matters. It takes five minutes.

1. Volume all the way up, silent switch off, no Bluetooth headphones connected, case off if it covers the bottom speaker.
2. Phone flat on a table, screen up. Tap **Start sensing**, allow the microphone and motion access. Stay still for about five seconds while it says Calibrating.
3. Open the **Signals** tab and look at **Health**:
   * **Speaker to mic link**: 20 dB or more is good. 14 to 20 dB works but has shorter range. Below 14 dB (shown in amber) means the chirp is not reaching the mic well.
   * **Microphone**: if it says "echo cancellation still on", iOS is filtering the signal. Reload the page and start again.
   * **Processing** should be a few percent of real time.
4. Back on **Room**: wave a hand 30 to 60 cm from the phone. A dark trace should appear at that distance on the echogram. Walk away to 2 m and back: the trace follows you and "Someone is approaching" appears when you cross the dashed 1.2 m line.
5. Sit still about 0.7 to 1 m from the phone, breathing normally, for 15 to 20 seconds. "Breathing N/min" appears. Count your breaths for 30 s to compare.

If the link is weak: try more volume, a harder table surface, point the bottom edge of the phone toward where you will sit, and press **Recalibrate now** in Settings. If it still fails, use Option C on the Mac, or the simulated room (below), and say so.

## Step 3. The five minute demo script

1. **The hook (30 s).** "This is a normal iPhone. No camera is on, no wearable, nothing added. It is using its speaker as a sonar." Hand them the phone, or hold it up so they hear nothing.
2. **Presence and distance (1 min).** Walk in from across the room. The echogram draws you as a dark trace and the headline reads "Someone 2.1 m away, approaching". Explain: "Distance up, time to the left. That dark line is me."
3. **Breathing (1.5 min).** Sit down about a metre away and keep still. In 15 to 20 seconds: "Breathing 14/min", plus the chest movement trace. "That is my chest moving a few millimetres, measured from a metre away by sound." This is usually the moment that lands.
4. **Fall and check-in (1.5 min).** Stand up, then drop quickly to the floor or a cushion (do not actually fall) and **slap the floor hard** as you land so there is an impact sound, then lie still for five seconds. The phone shows "Are you OK?", chimes and speaks. Either tap "I'm OK", or let it count down so the console on the laptop shows "No response". Open the alert to show its evidence: what the sonar saw, what the microphone heard, how long you stayed still.
5. **Under the hood (30 s).** Open the Signals tab: range profile, range and speed map, the speaker response it equalised itself, processing cost. "Every alert explains itself with evidence from more than one sense."

### Backup: the simulated room

If the room fights you (very noisy, soft furnishings, weak link), tap **Explore a simulated room** on the start screen, or in Settings choose a scene and press Play. It runs a scripted scene (someone walks in, sits, breathes, stands, falls) through exactly the same signal processing. The app shows an amber **Simulated room** badge the whole time. Say plainly: "This is a simulated scene running through the real pipeline."


## Connecting the phones without a tunnel (recommended)

The free tunnels drop whenever the wifi blips or the laptop sleeps, and come back with a new link. The hub now serves the phones directly on the local network instead:

1. Start the hub: `cd ~/echosense && node dist/server.cjs`. It prints `Phones (same wifi): https://<laptop IP>:8443/`.
2. On each iPhone (same wifi as the laptop), open that address. The first time, Safari says the connection is not private: tap **Show Details**, then **visit this website**. Then tap Start. This address does not change between restarts.
3. If the phones cannot load it (venue wifi often blocks devices from seeing each other): turn on **Personal Hotspot** on one iPhone, connect the laptop and the other phones to it, restart the hub and use the new address it prints.
4. Keep the laptop awake during the demo: run `caffeinate -dis` in a spare Terminal window.
5. Only for the Webex buttons and the Twilio key press: run `sh tools/tunnel.sh` in another window. It keeps a public link open, reconnects by itself, and the hub picks up each new link automatically (no .env edits, no restarts).

## Witness agents (hackathon demo)

Full write-up and results: `docs/WITNESS.md`. The console at `/console` now opens with the Witness panel.

### Setup (once)

0. In the echosense folder run `npm install` (it also installs the speech recogniser). The first time the hub starts it downloads the speech model once (about 110 MB), so do that on good Wi-Fi before the demo; the hub prints `speech understanding on` when it is ready.
   `npm install` needs internet and takes about a minute; it also installs the AGNTCY SLIM library. When the hub starts it should print `Agent channel: AGNTCY SLIM witness/home/board, MLS encrypted`. If it says "in memory", the install did not work; everything still runs, just without SLIM.
1. In the echosense folder: `cp .env.example .env`, then fill in what you have. Nothing is required; without Twilio every call and text shows as a dry run.
   * `ANTHROPIC_API_KEY`: when the three agents disagree, each becomes its own Claude and they negotiate a plan on the SLIM channel (a few cents per disagreement, capped at $0.50 a day). The thread shows on the console. To show it on demand, play "Fall out of every phone's view". If your key starts with sk-ant-usr, also add ANTHROPIC_WORKSPACE_ID=wrkspc_... (the workspace page on console.anthropic.com). The hub prints "Claude key check: OK" when it works.
   * `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `CAREGIVER_PHONE` (verified number on a trial account).
   * `PUBLIC_URL`: your `https://...trycloudflare.com` address, so the caregiver can press 1 or 2 on the call. Restart the hub after changing it.
   * Webex: on developer.webex.com, My Webex Apps, Create a Bot, copy its token into `WEBEX_BOT_TOKEN`, and put your own Webex email in `WEBEX_TO_EMAIL`. With `PUBLIC_URL` set, the card buttons work.
2. Start the hub the usual way (`node dist/server.cjs`) plus `cloudflared tunnel --url http://localhost:8080`. The hub prints whether Claude and Twilio are on.
3. On the console, Demo tools, Test call: your phone should ring.

### Teach the room (2 minutes, once)

1. Put the phones where they will stay, open the console, and open **Room map** under Witness agents.
2. Stand at the sofa facing the phones, type "Sofa", pick Sofa, press **I'm standing there: save**. The line under it says which phones measured you and how far. If it says no phone can see you, move a little closer and try again.
3. Do the same at the TV, the bed or the kitchen counter.
4. Under "What each phone sits next to", set the phone nearest the TV to "the TV".

The map is saved in `homemap.json` next to the hub. It also learns on its own where people usually sit still.

### What changed on the phones

* Every phone runs a sound recognition model (YAMNet). Health shows "Sound model (YAMNet): running" and "Hearing now" with the top labels. A snap, a knock, typing, talking or the TV is shown as "Sound: a small tap or snap" and never starts an alarm.
* The check-in is spoken: "Are you OK? If you are OK, just say so, or wave your hand." Saying anything or moving counts as OK. Groaning or crying counts as help. Tapping still works.
* A laptop can be used as a sensor, but its microphone sits inside what you touch, so taps on it are very loud. If its Health shows the speaker to mic link under 14 dB, it tries a lower band by itself ("Band check" row). On a Mac, also set Mic Mode to Standard in Control Center while the page is using the microphone.

### Three minute script

1. **The problem (simulation).** Pick "Action movie on TV", Play scenario. Phone reports appear, then the agents argue. Point at the line "Without the agents: Phone 3 would have raised a fall alarm on its own". The Skeptic explains why: the bang was loudest on the phone by the TV, which could not see the person.
2. **A fall only one phone can see.** "Fall seen by one phone". The agents call for help; the panel says a majority vote would have missed it.
3. **A hacked phone.** "Hacked phone fakes a fall". The Auditor drops its trust to about 25% because the other phones heard nothing, and flags it.
4. **Live, with your phones.** Two or three phones on the table, sonar running. Sit still in front of Phone 1. Demo tools, Hack a phone: Phone 2, Make it fake a fall. Phone 1's real sonar contradicts it and the agents stand down.
5. **The call.** Tick "Scenarios make real calls", play "Fall seen by one phone". The caregiver phone rings; press 1 and the console shows "Help on the way".
6. **The numbers.** Evaluation button: agents against single phone, any phone and majority vote.

Cisco points to make while it runs: the strip under the title shows the AGNTCY SLIM channel and every agent in it. Each report and argument says which SLIM identity posted it. In the hacked phone scenario, watch that phone get struck out of the member list: it was removed from the encrypted group. When help is called, the Webex card arrives on your phone or laptop and tapping On my way updates the console.

What to say about no central decision maker: every agent posts its position in public; the outcome is a fixed rule anyone can recompute (get help needs two agents and no objection; stand down needs two and no objection; anything else asks the person). The Responder cannot call on its own and the Skeptic cannot silence an alarm on its own.

## What to claim, and what not to

Say:

* The physics is established: smartphone sonar for breathing and motion was shown in peer reviewed work (University of Washington's ApneaApp and FingerIO, among others). We built the product layer: robust signal processing, multimodal fusion, explainable alerts, the check-in and caregiver workflow, and multi phone localisation.
* It runs entirely on the phone, at a few percent of its processing capacity, with no audio recorded.
* On our simulated test rooms it detects falls, breathing (within about 1 breath per minute), approaches and screams. Sitting down, dropped objects, door slams, TV, music and jingling keys do not trigger a fall or a phantom person. (Keys are reported as a "metallic crash" notice, which is the kind of tuning a pilot would refine.)

Do not say:

* That it has a measured accuracy on real people or real homes. It has not been validated on real users yet. The honest line is: "Next step is a pilot to measure real world sensitivity and false alarm rates."
* That it sees direction or makes images of people. Phone sonar measures distance. Position on the room map comes from combining distances from two or three phones.
* That it uses WiFi. iPhones give apps no access to WiFi signal data, so WiFi sensing would need extra hardware such as an ESP32 board. The hub is built to accept other sensors later.
* That it is a medical device. Breathing rate is a wellness indication.

Likely questions:

* **Can people hear it?** Most adults cannot hear above 17 to 18 kHz. Children and pets may. The level is adjustable in Settings.
* **Battery?** It needs the screen on and audio running, so it should stay on a charger, like a bedside clock.
* **What if the phone is moved?** The motion sensor notices, pauses sensing, and relearns the room automatically when it is still again.
* **Several people?** It tracks up to four moving echoes, but breathing and falls are designed for one person living alone.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "The microphone needs a secure (https) address" | You opened an http link on the phone. Use the https link (Option A or B). |
| "Microphone access was declined" | iPhone Settings, Safari, Microphone, Allow. Reload. |
| Stuck on Calibrating | The chirp is not reaching the mic. Volume up, silent off, remove the case, Recalibrate. |
| Speaker to mic link below 14 dB | Same as above. Also try the MacBook (Option C). |
| Everything moves on the echogram when nobody is there | Something nearby is noisy above 18 kHz (some chargers, ultrasonic pest repellers). Move away from it and Recalibrate. |
| A faint whine is audible | Lower Sonar level in Settings. |
| Screen turned off and sensing stopped | Settings, Display and Brightness, Auto-Lock, Never, for the demo. |
| Console shows nothing | Phones must be opened through the hub link (Option B), not GitHub Pages. |

## Commands reference

```
node dist/server.cjs                       # hub on http://localhost:8080
node dist/server.cjs --https --port 8443   # hub with a self-signed certificate
node dist/server.cjs --webhook <URL>       # also post alerts to a Discord or Slack webhook
npm install && npm test                    # run the 46 automated tests (needs Node 18+)
npm run build                              # rebuild after changing the source
```
