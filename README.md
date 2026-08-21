# Field Agent Check-In

Autonomous silence-interpretation agent for a delivery fleet. Full design rationale, architecture, and the hour-by-hour build plan are in [PLAN.md](./PLAN.md) — read that first.

10 simulated riders. No real rider mobile app, no real SMS/telephony/emergency-dispatch integration anywhere — everything notification-related is logged/mocked (see `src/actions/mockActions.ts` and PLAN.md §6).

## Quick start

```bash
bun install
cp .env.example .env      # then set GEMINI_API_KEY (optional — falls back to deterministic rules without it)
bun run build              # builds the dashboard bundle into dashboard/dist
bun run dev                 # starts the server with auto-reload at http://localhost:8080
```

Open `http://localhost:8080`. Use the demo controls to inject a single incident or a whole-zone outage (the latter demonstrates the cluster-silence guard — it should collapse into one logged event instead of firing multiple emergencies).

## Eval harness

```bash
bun run eval
```

Runs the 20 scenarios in `eval/scenarios.ts` against the Stage-1 statistical filter (always) and, if `GEMINI_API_KEY` is set, against the full Stage-2 reasoning agent too — printing both weighted scores side by side. The gap between them is the concrete, measured version of "why this breaks without AI."

## Deployment (Fly.io, Dockerized)

```bash
fly launch --no-deploy      # first time only; it'll detect fly.toml and the Dockerfile
fly secrets set GEMINI_API_KEY=your-key-here
fly deploy
```

Never put `GEMINI_API_KEY` in `fly.toml` or commit it — `fly secrets set` is the only place it should live outside your local `.env`.

## Project layout

```
src/
  simulator/   synthetic riders, zones, routes, incident/outage injection
  engine/      state machine, Stage-1 statistical filter, cluster-silence guard
  ai/          Stage-2 Gemini client + prompt/schema
  actions/     mock notification executors (logged only)
  db/          SQLite schema
  server.ts    HTTP + WebSocket
  index.ts     entrypoint — wires everything together, runs the tick loop
dashboard/     plain React dispatcher view (read-only + demo controls)
eval/          20 scenario fixtures + scorer
```

See PLAN.md for the full design: the state machine, the two-stage AI logic with the actual math, the tiered action ladder, team roles, and the honest failure-log tradeoffs around full autonomy.
