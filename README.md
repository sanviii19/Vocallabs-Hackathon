# Field Agent Check-In

Autonomous silence-interpretation agent for a delivery fleet. Full design rationale, architecture, and the hour-by-hour build plan are in [PLAN.md](./PLAN.md) — read that first.

10 simulated riders. No real rider mobile app, no real SMS/telephony/emergency-dispatch integration anywhere — everything notification-related is logged/mocked (see `src/actions/mockActions.ts` and PLAN.md §6).

## Quick start

```bash
bun install
cp .env.example .env      # then set GROQ_API_KEY (optional — falls back to deterministic rules without it)
bun run build              # builds the dashboard bundle into dashboard/dist
bun run dev                 # starts the server with auto-reload at http://localhost:8080
```

Open `http://localhost:8080`. Use the demo controls to inject a single incident or a whole-zone outage (the latter demonstrates the cluster-silence guard — it should collapse into one logged event instead of firing multiple emergencies).

## Eval harness

```bash
bun run eval
```

Runs the 20 scenarios in `eval/scenarios.ts` against the Stage-1 statistical filter (always) and, if `GROQ_API_KEY` is set, against the full Stage-2 reasoning agent too — printing both weighted scores side by side. The gap between them is the concrete, measured version of "why this breaks without AI."

## Deployment (Render, Dockerized)

Render Web Service, connected directly to this GitHub repo — it auto-detects the `Dockerfile`, no config file required. One process serves the API, WebSocket, and the dashboard's static files together, so this is the entire deployment; no separate frontend host needed.

Set these in the Render dashboard's Environment tab (never commit real values):

```
PORT=8080
SIM_SPEED=4
GROQ_MODEL=openai/gpt-oss-20b
GROQ_API_KEY=your-key-here
```

Set the **Health Check Path** to `/health`. Free tier sleeps after ~15 minutes idle; the next request cold-starts in 30–60s — hit the URL yourself before a live demo so it's already warm.

## Project layout

```
src/
  simulator/   synthetic riders, zones, routes, incident/outage injection
  engine/      state machine, Stage-1 statistical filter, cluster-silence guard
  ai/          Stage-2 Groq client + prompt
  actions/     mock notification executors (logged only)
  db/          SQLite schema
  server.ts    HTTP + WebSocket
  index.ts     entrypoint — wires everything together, runs the tick loop
dashboard/     plain React dispatcher view (read-only + demo controls)
eval/          20 scenario fixtures + scorer
```

See PLAN.md for the full design: the state machine, the two-stage AI logic with the actual math, the tiered action ladder, team roles, and the honest failure-log tradeoffs around full autonomy.
