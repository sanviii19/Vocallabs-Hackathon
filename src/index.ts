import { openDb } from "./db/schema";
import { Simulator } from "./simulator/simulator";
import { Engine } from "./engine/stateMachine";
import { createServer } from "./server";
import type { DecisionLogEntry, MockNotification, StateSnapshot } from "./types";

const PORT = Number(process.env.PORT) || 8080;
const SIM_SPEED = Number(process.env.SIM_SPEED) || 12; // simulated seconds per real second
const TICK_MS = 500;
const RIDER_COUNT = 10;

const db = openDb();

// Seed the zones table (read at runtime from the in-memory ZONES array for speed —
// this keeps the DB copy for inspection/audit, matching the data model in PLAN.md §7).
const { ZONES } = await import("./simulator/zones");
for (const z of ZONES) {
  db.run(
    `INSERT OR REPLACE INTO zones (id, name, dropout_base_rate, mu, sigma) VALUES (?, ?, ?, ?, ?)`,
    [z.id, z.name, z.dropoutBaseRate, z.mu, z.sigma]
  );
}

const simulator = new Simulator(RIDER_COUNT);

const recentDecisions: DecisionLogEntry[] = [];
const recentNotifications: MockNotification[] = [];
const MAX_RECENT = 200;

let broadcastRef: ((msg: any) => void) | null = null;

const engine = new Engine(simulator.getRiders(), {
  db,
  getRider: (id) => simulator.getRiders().find((r) => r.id === id)!,
  emitDecision: (d) => {
    recentDecisions.push(d);
    if (recentDecisions.length > MAX_RECENT) recentDecisions.shift();
    broadcastRef?.({ type: "decision", data: d });
  },
  emitNotification: (n) => {
    recentNotifications.push(n);
    if (recentNotifications.length > MAX_RECENT) recentNotifications.shift();
    broadcastRef?.({ type: "notification", data: n });
  },
  emitRiderUpdate: (riderId) => {
    const rider = simulator.getRiders().find((r) => r.id === riderId)!;
    const runtime = engine.getRuntimeArray().find((r) => r.riderId === riderId)!;
    broadcastRef?.({ type: "rider_update", data: { rider, runtime } });
  },
  onForceResume: (riderId) => {
    simulator.forceResume(riderId);
    const rider = simulator.getRiders().find((r) => r.id === riderId)!;
    engine.onPing({
      type: "ping",
      riderId,
      ts: simulator.getSimTime(),
      zoneId: rider.route[rider.segmentIndex].zoneId,
      speedKph: rider.speedKph,
      accelFlag: false,
    });
  },
});

function getSnapshot(): StateSnapshot {
  return {
    simTime: simulator.getSimTime(),
    running: true,
    zones: simulator.listZones(),
    riders: simulator.getRiders(),
    runtime: engine.getRuntimeArray(),
    recentDecisions,
    recentNotifications,
  };
}

const { server, broadcast } = createServer(PORT, {
  getSnapshot,
  injectIncident: (riderId) => simulator.injectIncident(riderId),
  injectOutage: (zoneId) => simulator.injectZoneOutage(zoneId),
});
broadcastRef = broadcast;

setInterval(() => {
  const dt = SIM_SPEED * (TICK_MS / 1000);
  const events = simulator.tick(dt);

  for (const ev of events) {
    if (ev.type === "ping") {
      engine.onPing(ev);
    } else {
      const rider = simulator.getRiders().find((r) => r.id === ev.riderId)!;
      const runtime = engine.getRuntimeArray().find((r) => r.riderId === ev.riderId)!;
      broadcast({ type: "rider_update", data: { rider, runtime } });
    }
  }

  engine.tick(simulator.getSimTime());
}, TICK_MS);

console.log(`Field Agent Check-In running at http://localhost:${PORT}`);
console.log(`GEMINI_API_KEY ${process.env.GEMINI_API_KEY ? "set" : "NOT set — Stage-2 will fall back to deterministic rules"}`);

export { server };
