# Field Agent Check-In — Explained Simply

## The one-sentence version

We built a computer program that watches over delivery riders (like food delivery guys on bikes), and if one of them suddenly goes quiet, the program tries to figure out on its own whether that's totally normal or something to actually worry about — without needing a human to check.

## The problem, as a story

Imagine you run a delivery company with 10 riders on scooters, dropping off packages all over the city. You're the only person watching over all of them, and your job is to make sure nobody's in trouble — like if someone crashes their scooter and nobody knows.

Here's the annoying part: your phone loses signal in normal places all the time. Tunnels. Parking basements. Some back road with weak network. When a rider goes through one of those spots, their location just... stops updating for a bit. Totally normal. Happens 50 times a day.

But once in a while, a rider actually gets into real trouble — falls off their bike, phone dies at a bad time, gets lost somewhere unsafe — and THAT also looks exactly the same on your screen: "no update from this rider."

So how do you tell the difference between "he's just in the tunnel" and "he might actually need help"?

## The dumb way to solve this (and why it fails)

The obvious fix: "if no update for 10 minutes, send me an alert."

Sounds fine, until you actually try it:

- Set the timer too short (like 5 minutes), and you get spammed with alerts almost every hour, because riders pass through tunnels and dead zones constantly. This is exactly the **boy who cried wolf** problem — after the 20th fake alarm that day, you stop paying attention to ANY alarm. Which means when a REAL emergency happens, you probably ignore it too, because you're used to it being nothing.
- Set the timer too long (like 20 minutes) to avoid the spam, and now if someone's actually hurt, you don't find out for 20 whole minutes. Way too slow.

You can't win with just a timer. The timer doesn't know anything about the *situation* — it doesn't know if this rider is in a tunnel that usually takes 1 minute to cross, or standing still in the middle of an open road where nobody ever loses signal. It just counts seconds.

## Our idea: give the system actual judgment, not just a stopwatch

Instead of one dumb timer for everybody, our system learns the *personality* of each spot on the map:

- "This tunnel usually causes about 1-2 minutes of silence. Totally normal."
- "This open road almost never has signal problems. If someone goes quiet here, that's weird."

So the system isn't asking "how many seconds has it been?" — it's asking **"given where this rider is, is this amount of silence normal or not?"** That's a much smarter question, and it's the whole point of the project.

## How it actually thinks — a two-step brain

We built the "judgment" part in two steps, kind of like a bouncer at a club:

**Step 1 — the quick glance (cheap, instant, no fancy AI needed).**
The system does some quick math: "based on how this spot usually behaves, is this silence normal so far?" If yes, it just relaxes and keeps watching. This happens constantly and costs nothing, like a bouncer glancing at everyone walking by.

**Step 2 — the closer look (this is where the real AI comes in).**
Only when Step 1 gets suspicious does the system call in the smart AI (we use Groq, which runs AI models really fast) to actually think about it properly: "Okay, this rider's been quiet for a while, they're in a normal-ish spot, BUT their phone's motion sensor detected something like a sudden fall right before they went silent. That's not just a normal tunnel thing." The AI can notice things the quick math can't — like a fall being detected, or a totally new area we've never mapped before.

This is important: a dumb calculator alone can't catch the "fall detected" case if the silence itself doesn't look unusual yet. Only the smarter AI, looking at the *whole picture*, catches it. That's the actual reason this project needs AI at all — take the AI away, and it goes back to being a dumb timer that misses real emergencies and cries wolf on fake ones.

## What happens next — the escalation ladder

Once the system decides something might be wrong, it doesn't panic and call 911 immediately. It goes up a ladder, step by step, like a video game health bar:

1. **Quiet check-in** — sends a gentle notification to the rider's phone: "hey, you good?"
2. **Tell the customer** — lets the customer know their delivery might be a little delayed, just in case.
3. **Ask a nearby rider** — pings another rider who's close by: "hey, can you check if you see them?"
4. **Full emergency** — if nothing above worked and things still look bad, it automatically calls the rider, texts their emergency contact, and writes up a full incident report — all by itself.

Each step only happens if the one before it didn't resolve things. It never just jumps straight to "call emergency contact" without trying the gentler steps first.

## The big twist: nobody has to approve any of this

Normally you'd think a human dispatcher should approve before, say, calling someone's emergency contact. We deliberately built it **without** that human approval step. The system decides AND acts completely on its own, all the way up to the final emergency step.

Why do this? Because if a human always has to be watching and clicking "yes, escalate" — you're back to square one, needing a person glued to a screen all day. The whole point is that the system can be trusted to handle it by itself, the same way a smoke detector doesn't need someone to approve "yes, that's actually smoke" before it beeps.

(We do keep one safety net: if the smart AI can't be reached for some reason — no internet, API down, whatever — the system doesn't just freeze or panic. It falls back to a simpler, more cautious version of the same judgment, so it never goes completely blind.)

## One more clever bit: not confusing "one person's problem" with "everyone's problem"

Imagine an entire cell tower actually goes down, and suddenly 6 out of 10 riders all go silent at once, all in the same area. A dumb system would think "6 emergencies!!" and blow up your phone with 6 alerts.

Our system checks for this: if a bunch of riders in the *same area* all go quiet *at the same time*, it's smart enough to say "this looks like a shared network problem, not 6 separate people in trouble," and it treats it as ONE event instead of panicking six times over.

## How it's actually built (in plain terms)

Since this was built for a hackathon and we don't have real delivery riders with real phones to test on, here's what's really running under the hood:

- **A pretend fleet of riders** — basically a little simulation, like NPCs in a video game, that move around a fake map, occasionally lose signal in "dead zones," and can be told to "have an emergency right now" with a button, so we can demo it live.
- **The brain** (the two-step judgment system described above).
- **The action-takers** — the parts that "send" the notifications, calls, and texts. Important: in this hackathon version, none of these are real. No real text message gets sent, no real phone call happens, and it definitely never contacts real emergency services. Everything is just logged and shown on screen, like a fire drill instead of a real fire. This was a deliberate choice — the point of this build is to prove the *thinking* works, not to hook up real telecom services.
- **A screen (dashboard)** — a simple webpage where you can watch all the riders, see what tier they're in, and read the system's reasoning for every decision it made, in plain English.

## Quick glossary

- **Dead zone** — a place with no phone signal (tunnel, basement, rural road).
- **Tier / escalation ladder** — the step-by-step levels of concern, from "quiet check-in" up to "full emergency."
- **Stage 1 / Stage 2** — the two-step brain: quick math first, smart AI second (only when needed).
- **Mocked / simulated** — fake, for demo purposes. Nothing real actually gets sent or called.
- **Autonomous** — works entirely on its own, no human has to click "approve."
- **Cluster guard** — the check that tells "one person's problem" apart from "the whole area lost signal."

## Why this is actually hard (and not just a fancy timer with extra steps)

The honest challenge isn't writing code that checks a clock. It's:

1. Teaching the system what "normal" looks like for dozens of different spots, instead of using one rule for everywhere.
2. Making sure it doesn't cry wolf so often that people start ignoring it.
3. Making sure it never freezes up waiting for more information — it always eventually decides and acts, within a set time limit.
4. Trusting it to act completely on its own, safely, without a human double-checking every decision.

That combination — smart, fast, cautious, and fully self-running — is the real project. Everything else (the pretend riders, the map, the dashboard) just exists to prove that the core idea actually works.
