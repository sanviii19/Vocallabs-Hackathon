# Field Agent Check-In — Implementation Plan

Autonomous silence-interpretation agent for a delivery/gig fleet. Built for the 24-hour AI hackathon brief in this repo (`Hackathon_Brief_Unique_Project_Unique_Stack.pdf`), Agents & Automation track.

Status: **plan under review — no code written yet.**

---

## Table of Contents

1. [Product Framing](#1-product-framing)
2. [Design Philosophy](#2-design-philosophy)
3. [Architecture & Tech Stack](#3-architecture--tech-stack)
4. [Core Logic — State Machine](#4-core-logic--state-machine)
5. [The Two-Stage AI](#5-the-two-stage-ai)
6. [Tiered Autonomous Action Ladder](#6-tiered-autonomous-action-ladder)
7. [Data Model](#7-data-model)
8. [Module Structure](#8-module-structure)
9. [Team Roles](#9-team-roles)
10. [Build Sequence — Hour by Hour](#10-build-sequence--hour-by-hour)
11. [Eval Harness](#11-eval-harness)
12. [Constraints Declared](#12-constraints-declared)
13. [The Five Questions — Prepared Answers](#13-the-five-questions--prepared-answers)
14. [Rubric Alignment](#14-rubric-alignment)
15. [Known Risks / Failure Log Seed](#15-known-risks--failure-log-seed)
16. [Open Decisions Before Coding Starts](#16-open-decisions-before-coding-starts)

---

## 1. Product Framing

**Who exactly:** a delivery fleet dispatcher currently tracking a fleet of riders alone, and the riders themselves, who currently have no safety net beyond a human noticing a missed check-in in time. The demo simulates a **10-rider fleet** — small enough to follow live on the dashboard, large enough to demonstrate the cluster-silence guard (§4) actually distinguishing one rider's incident from a shared network outage.

**What it does:** watches rider telemetry (GPS, speed, accelerometer, network status), decides whether silence is expected (a known dead zone) or anomalous (a possible incident), and — critically — **resolves the situation entirely on its own**, through a graduated escalation ladder, with no dispatcher approval step anywhere in the runtime loop. The dispatcher dashboard is a read-only window onto what the system already decided and did, not a control panel with buttons.

**Why "no human intervention" changes the design, not just the pitch:** in the original (human-in-the-loop) version, a wrong AI judgment gets caught by a dispatcher before anything bad happens. With the human removed, the AI's judgment *is* the entire safety net. That means the escalation logic must be a closed loop that always terminates in a bounded, deterministic action — it can never wait indefinitely, and it must degrade to a safe default if any component fails.

---

## 2. Design Philosophy

Three filters the brief scores against, and how this project is built to survive each:

1. **Could this exist in 2023?** A fixed-timeout GPS tracker could. A system that fuses route/zone priors, real-time multi-modal evidence, and generalizes to unmapped situations via a reasoning model could not — last-gen tooling didn't make the reasoning-over-structured-and-unstructured-evidence step cheap or reliable enough to run per-event across a fleet.
2. **Remove the AI — does it still work?** It still *runs* (you'd get a standard geofence + speed + heartbeat rule tracker), but it silently reverts to exactly the alert-fatigue problem the project exists to solve — see [§15](#15-known-risks--failure-log-seed) and the design note in [§5](#5-the-two-stage-ai) about making sure the AI's contribution is genuinely load-bearing, not decorative.
3. **What did you build vs. what did the API give you?** The API gives next-token prediction on a JSON schema. Built: the two-stage cost-saving filter, the zone-prior statistical model, the tiered autonomous action ladder, the cluster-silence correlated-outage guard, and the closed-loop execution with zero human step.

---

## 3. Architecture & Tech Stack

Single-process monolith — deliberate, not a shortcut (see rationale below).

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Bun + TypeScript** | Zero-config TS (no build-step friction), built-in SQLite driver, built-in WebSocket, built-in test runner — removes most of the setup tax that eats the first hours of a hackathon |
| Persistence | **SQLite** (`bun:sqlite`) | One file, zero ops. At 10 riders over a one-day demo window, a distributed datastore buys nothing visible |
| Realtime push | **Native WebSocket**, same process | No message broker needed at this scale |
| AI — Stage 2 | **Groq** (fast inference over open-weight models, currently `openai/gpt-oss-20b` — verified against the account's actual `/v1/models` list, not assumed; re-check at build time since Groq's lineup changes), via REST chat completions with `response_format: {type: "json_object"}` | Fast and cheap enough to run per-event rather than per-tick — keeps the cost ceiling low. Swapped in over Gemini after hitting Gemini's free-tier daily request cap during testing |
| Dashboard | **Static React**, served by the same Bun process | One deployed process, one URL, nothing to keep in sync across two deploys |
| Mocked services | **Everything is logged/simulated only — no real SMS, IVR, telephony, or emergency-dispatch provider is integrated anywhere, for any tier, including EMERGENCY.** Every "action" writes a structured entry to a `mock_notifications` table (recipient, channel, payload, timestamp) that the dashboard renders as a message/call log | This is a demo of the *judgment and escalation logic*, not a telephony product — introducing any real external service (Twilio or otherwise) adds dependency risk and cost for zero rubric benefit. State this plainly to judges: every notification tier is real logic behind a mocked channel |
| Deploy | **Fly.io**, Dockerized single container | A Dockerfile pins the exact Bun version and gives full control over the build — avoids Fly's buildpack auto-detection guessing wrong and failing mid-deploy. See Dockerfile note below |

**Why a monolith, not microservices (say this explicitly to judges):** a production version of this system would likely use a message broker, a real time-series store, and a distributed job queue. At 10 simulated riders in a 24-hour build, that architecture adds setup risk with zero visible demo payoff. The migration path (Redis-backed queue, Postgres, real time-series DB) is the answer to "what breaks at 10,000 riders" ([§13](#13-the-five-questions--prepared-answers)), not a gap in this build.

**No real rider mobile app.** A simulator — in-process, synthetic riders emitting GPS/speed/accelerometer ticks with an injectable live incident — stands in for it. This isn't a shortcut either: real background-location/motion permissions on iOS/Android require special entitlements and App Store justification that alone could consume the entire build window.

**Dockerfile plan (removes deployment-day surprises):**

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build        # builds the static dashboard bundle
EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
```

Pin the Bun image tag (`oven/bun:1`, or a specific minor version once you know it), build and run this exact image locally before ever pushing to Fly — `fly deploy` should then be a non-event. `fly.toml` just points at this Dockerfile; no buildpack guessing involved.

---

## 4. Core Logic — State Machine

Every rider is a state machine, not a polled variable:

```
NOMINAL → SOFT_WATCH → CUSTOMER_NOTIFY → PEER_CHECK → EMERGENCY → RESOLVED
```

- Transitions are driven by: the anomaly score crossing thresholds, external confirmations (a peer replies, an IVR call is answered), and **bounded dwell timers** — no state is ever allowed to wait indefinitely; every state has a maximum time budget before it is forced to escalate. This is what makes "no human intervention" a safe claim at all.
- **Cluster-silence pre-check:** before any individual rider is allowed to fire EMERGENCY, check whether N other riders in the same geo-cell dropped silent in the same window. If so, collapse the whole cluster into a single "infrastructure event" log entry instead of N separate escalations. This is the single most important guard against a false-EMERGENCY storm caused by a real cell-tower outage — the main risk introduced by removing the human dispatcher.
- **Hysteresis:** once escalated, require stronger/sustained evidence to de-escalate, to avoid tier-flapping when a rider's signal blips in and out right at a threshold boundary.
- **Idempotency:** state is tracked as an explicit machine (not re-evaluated from scratch each tick), so Tier 3 never fires twice for the same incident.
- Scheduler wakes each rider at their *expected* next-ping time (derived from route + historical speed for that rider/vehicle/time-of-day), not on a fixed poll interval — implemented as a single in-memory timer per rider; no distributed queue needed at this scale.

---

## 5. The Two-Stage AI

This is the part that has to survive "remove the AI, does it still work?" — so the split has to be real, not cosmetic.

### Stage 1 — cheap statistical filter (runs on every wake-up, no model call)

For a rider silent for `t` seconds, last known in zone `Z`:

- Each zone has a fitted dropout-duration distribution: `Lognormal(μ_Z, σ_Z)`, built from historical crossings (bootstrapped synthetically for the demo, but structured as a real posterior that updates from live dropout events).
- `p_explainable = 1 − CDF(t; μ_Z, σ_Z)` — probability a *normal* dead-zone dropout would still be ongoing at duration `t`.
- `Anomaly score A(t) = 1 − p_explainable` — rises over time, faster in zones with tight historical dropouts, slower in high-variance ones.

This alone resolves the common case — cheaply, with no API call — for the large majority of silences that are ordinary dead-zone crossings.

### Stage 2 — LLM reasoning agent (invoked only when `A(t) ≥ ~0.4`)

This is the part a CDF genuinely cannot do — and is the honest answer to "why does this break without AI":

- **Fuses heterogeneous evidence** the statistical layer can't touch: a simulated accelerometer "sudden deceleration" flag, a garbled last app-log line, battery-drain rate, weather. A CDF can't combine "73% statistical anomaly" with "the last two seconds of telemetry before disconnect look like a fall."
- **Generalizes to unmapped zones** — a zone with no fitted distribution yet (most likely what the Hour-12 curveball will test), where the statistical layer has nothing to go on but the reasoning layer can still reason qualitatively from a description.
- **Generates the incident narrative** required for the Tier-3 automated report.

Output is a forced JSON schema:

```json
{
  "tier_recommendation": "SOFT_WATCH | CUSTOMER_NOTIFY | PEER_CHECK | EMERGENCY",
  "confidence": 0.0,
  "rationale": "one paragraph, cites the specific evidence used",
  "next_check_delay_seconds": 0
}
```

### Threshold calibration

Thresholds are not hand-picked. They minimize an asymmetric expected cost:

```
Cost = w_fp · P(unnecessary escalation) + w_fn · P(missed real incident),  with  w_fn ≫ w_fp
```

Calibrate the three tier thresholds empirically against the 20-case eval set ([§11](#11-eval-harness)) rather than guessing — this doubles as your technical-depth talking point and your actual tuning method.

### The honesty check (read before building Stage 1 alone)

If Stage 1 (the CDF filter) were the *entire* system, this project would be a rules engine with a probability sign on it — no different in kind from a nested if/then, and vulnerable to exactly the "remove the AI, does it still work?" challenge. The system only earns its originality score if Stage 2's contribution (multi-modal fusion + generalization to unmapped zones) is real and demonstrated live — not bolted on as a rationale-generator after the rules already decided the tier.

---

## 6. Tiered Autonomous Action Ladder

Every action below is real *logic* behind a mocked *channel* — no push-notification service, SMS/telephony provider, or emergency-dispatch API is actually wired up anywhere in this table, including EMERGENCY. Each action writes a structured entry to `mock_notifications` (recipient, channel, payload, timestamp), which the dashboard renders as a message/call log — this is what you demo instead of a real send.

| Tier | Trigger | Autonomous action (simulated) | Cost of being wrong |
|---|---|---|---|
| SOFT_WATCH | `A(t) ≥ 0.3` | Push notification "tap to confirm safe" + read on-device telemetry | ~0 |
| CUSTOMER_NOTIFY | SOFT_WATCH unresolved past dwell timer | Auto-message the customer: "delivery delayed, actively monitoring" | ~0 |
| PEER_CHECK | `A(t) ≥ 0.6`, or CUSTOMER_NOTIFY unresolved past dwell timer | Auto-ask nearest rider(s) via geofence: "See rider #47 near X?" — combine replies as weak independent evidence (Bayesian update, not a single yes/no gate) | low |
| EMERGENCY | `A(t) ≥ 0.85`, or PEER_CHECK unresolved past dwell timer, **and** cluster-silence check has ruled out an infrastructure event | Automated IVR call (press 1/2/3, works on voice-only signal) → if unanswered, automated call/SMS to emergency contact with generated summary + last location → **mocked** incident report (never a real third-party emergency API) | high |

---

## 7. Data Model

```
zones          id, grid_cell, dropout_base_rate, mu, sigma
riders         id, current_state, last_ping_ts, last_lat, last_lon, last_speed, route_id
routes         id, ordered_zone_sequence, expected_speed_profile
decision_log   rider_id, ts, anomaly_score, stage2_confidence, rationale, tier_before, tier_after
incidents      rider_id, opened_ts, resolved_ts, final_tier, resolution_reason
```

---

## 8. Module Structure

```
/src
  /simulator   synthetic riders, zone/route generator, incident injector
  /engine      state machine, scheduler, Stage-1 anomaly scorer, cluster-silence check
  /ai          Stage-2 prompt, Groq client
  /actions     tier executors — mock logger only, writes to `mock_notifications`
  /db          SQLite schema + queries
  /eval        20 scenario fixtures + scorer script
/dashboard     WebSocket client, synthetic grid view, per-rider decision timeline
```

Shared `RiderState` / `Tier` / `Event` types are the first thing committed (target: Hour 4), so every workstream below can code against the same interface immediately.

---

## 9. Team Roles

Two people, both working from the shared-types commit onward. Split along the natural seam in the architecture: the logic core vs. everything that observes and validates it.

1. **Core owner** — simulator, state machine, scheduler, Stage-1 statistical filter, Stage-2 Groq integration, cluster-silence guard, threshold calibration. This is the tightly-coupled half: Stage 2's output feeds directly into state transitions, so keeping the whole decision pipeline with one person avoids handoff friction mid-build.
2. **Product owner** — dashboard (WebSocket client, synthetic grid view, per-rider decision timeline), eval harness + the 20 scenario fixtures, mock action executors/`mock_notifications` rendering, incident report generator, failure log and pitch prep.

Interface between the two: the shared `RiderState`/`Tier`/`Event` types (committed Hour 3–4) plus the WebSocket message schema — agree on both before splitting off, since they're the only things each side depends on from the other.

---

## 10. Build Sequence — Hour by Hour

Mapped against the brief's own compulsory checkpoints. From Hour 3 onward, read each row as two parallel tracks: the **Core owner** builds the simulator/engine/AI column of work, the **Product owner** builds the dashboard/eval/actions column — they only need to sync at the shared-types commit and at each checkpoint.

| Hour | This project's target |
|---|---|
| 00:00 | Track registered (Agents & Automation) |
| 02:00 | Prior-art search done — name the 3 closest fleet-safety/SOS products, write the one-line difference |
| 03:00 | Idea lock. Shared `RiderState`/`Tier`/`Event` types committed — everyone else starts immediately after |
| 03–06 | Simulator emitting synthetic GPS/speed/accelerometer ticks, with an injectable incident trigger. State machine skeleton with hardcoded thresholds |
| 06:00 | **Checkpoint 1** — explain the state machine to a mentor from the whiteboard, no editor open |
| 06–10 | Stage-1 CDF/traversal-buffer filter wired to real transitions; SOFT_WATCH/CUSTOMER_NOTIFY firing correctly on synthetic data, no LLM call yet |
| 10–12 | **Eval harness built now, before the curveball** — you want a working baseline score to compare against after Hour 12 changes anything |
| 12:00 | **The curveball.** Expect it to test generalization — this is exactly what Stage 2 exists for |
| 12–18 | Stage-2 Groq integration, PEER_CHECK + EMERGENCY tiers, cluster-silence pre-check, mocked action executors |
| 18:00 | **Checkpoint 2** — full loop must run live: inject an incident, watch it walk NOMINAL → EMERGENCY on the dashboard |
| 18–22 | Dashboard polish (read-only, no buttons — say this explicitly to judges), failure log written honestly (Tier-3 autonomy tradeoff goes here, see [§15](#15-known-risks--failure-log-seed)) |
| 22:00 | Code freeze |
| 22–24 | Demo + pitch |

---

## 11. Eval Harness

Build this **before** most of the feature work — it is both your test suite and your threshold-calibration method.

20 scripted scenarios run through the simulator:

- **8 genuine dead-zone crossings**, including several deliberately near the 95th-percentile edge of that zone's historical dropout duration (the ambiguous boundary cases) → should resolve without ever reaching PEER_CHECK or EMERGENCY.
- **6 true incidents** — silence in a zone with normally short/no dropout, or silence paired with a fall-flag → must reach EMERGENCY within a bounded time budget.
- **4 novel-zone cases** with no fitted distribution — your curveball rehearsal → must at least reach PEER_CHECK, never silently stay NOMINAL.
- **2 adversarial/noisy cases** (GPS jitter, a rider legitimately taking an unmapped break) → must resolve via PEER_CHECK confirmation, never false-fire EMERGENCY.

Score with the same asymmetric weighting used for threshold calibration ([§5](#5-the-two-stage-ai)): a missed true incident is weighted far more heavily than an unnecessary peer-check. Rerun after every change; track the score over commits.

---

## 12. Constraints Declared

Brief requires declaring at least 2 of 5. Recommended declaration:

- **Degrades gracefully** — SMS-based fallback heartbeat, full offline dead-zone tolerance, Stage-1-only fallback if Stage 2 (the LLM call) is unreachable.
- **Handle being wrong** — visible confidence scoring at every tier, asymmetric-cost calibrated thresholds, full decision audit log (`decision_log` table).

Also genuinely satisfied as bonus depth (no need to declare, but worth stating if asked): **Two models cooperate** (Stage 1 statistical filter + Stage 2 reasoning agent, genuinely dependent on each other) and **Cost ceiling** (two-stage design keeps LLM calls rare and cheap).

---

## 13. The Five Questions — Prepared Answers

1. **Who exactly:** a delivery fleet dispatcher tracking a fleet of riders alone, and the riders themselves.
2. **Non-obvious hard part:** setting confidence thresholds and tier costs so the system doesn't cry wolf on every ordinary dead-zone crossing (frequent dead zones across even a 10-rider fleet mean frequent silences) while never silently missing a true incident — a decision-theoretic tuning problem, not a coding problem.
3. **Built vs. given:** the API gives next-token prediction on a JSON schema; built = the two-stage cheap-filter/expensive-reasoning pipeline, the zone-prior statistical model, the tiered autonomous action ladder, the cluster-silence guard, and the closed-loop execution with zero human step.
4. **Breaks without AI:** entirely — there is no dispatcher either now, so removing the AI removes all judgment from the system; riders get either a dumb-timeout alert storm or, worse, no escalation logic at all.
5. **What breaks at 10,000 riders:** the peer-verification tier and the cluster-silence guard both currently assume independent per-rider failures; at scale, a real regional network outage needs to be detected and suppressed as one event rather than triggering (or missing) thousands of individual state transitions — this is the stated migration path to a Redis-backed queue and real time-series store.

---

## 14. Rubric Alignment

| Criterion | Weight | How this plan earns it |
|---|---|---|
| Originality | 25% | Full autonomy (no dispatcher approval step) is the differentiator over existing fleet-safety features; state explicitly at the pitch |
| Technical depth | 25% | Two-stage AI, calibrated asymmetric thresholds, cluster-silence guard, eval harness built early |
| Working demo | 20% | Simulator + injectable incident makes a live, on-demand demo possible without real riders |
| Problem clarity | 15% | Named person (the dispatcher), named non-obvious hard part |
| Failure awareness | 15% | The Tier-3 autonomy tradeoff (§15) stated honestly, plus the Q5 scaling answer |

---

## 15. Known Risks / Failure Log Seed

Write this into the failure log rather than hiding it:

- **The single highest-stakes design choice is EMERGENCY-tier autonomy with zero human review.** A false negative here means a real incident with no other safety net, since removing the dispatcher removed the only backstop that existed in the original (human-in-the-loop) design. In a real production deployment, you would very likely keep the automated EMERGENCY action as designed but add an opt-in human-audit layer purely for post-hoc review/liability — not a runtime gate, since that reintroduces the exact bottleneck full autonomy exists to remove.
- **Correlated failures** (a real cell-tower outage) are only partially handled by the cluster-silence guard in this build; a genuinely large simultaneous outage across many zones is the sharpest edge case and the honest answer to Q5.
- **Stage 1's fitted distributions are bootstrapped synthetically** for the demo — real deployment would need genuine historical dropout data per zone before the priors are trustworthy.
- **Emergency dispatch is mocked, full stop.** No real third-party emergency-services integration exists or should be attempted in this build. State this plainly to judges rather than implying a real integration.

---

## 16. Open Decisions Before Coding Starts

Resolved:

- **Team size** — 2 people. Roles split in [§9](#9-team-roles).
- **Rider count for the simulator** — 10.
- **External services** — none. Everything mocked/logged, no Twilio or any other real telephony/SMS provider, no real emergency-dispatch integration, ever.
- **AI provider** — Groq, replacing Gemini after hitting Gemini's free-tier daily request cap during live testing (20 requests/day was unworkable for a hackathon demo). Groq's free tier is far more generous for this workload.
- **Deployment** — Fly.io, Dockerized (Dockerfile in [§3](#3-architecture--tech-stack)).

Still open:

- **Groq API key** — confirm access is ready before Hour 3, and confirm the current recommended model name at console.groq.com/docs/models at build time (this list changes — don't hardcode one into the plan sight unseen).
- **Dashboard map style** — synthetic grid (recommended, faster, zero API-key risk) vs. a real map library.
- **Constraints to formally declare on the submission form** — proposed as "Degrades gracefully" + "Handle being wrong" unless you want to swap in a different pair.
