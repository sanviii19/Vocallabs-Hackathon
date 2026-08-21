import type { Rider } from "../types";
import { ZONES, getZone } from "./zones";
import { ZONE_POSITIONS, generateRiders } from "./routes";

interface InternalState {
  rider: Rider;
  segmentIndex: number;
  segmentProgressSec: number;
  isDroppedOut: boolean;
  isIncident: boolean;
  dropoutEndsAt: number | null;
  accelFlag: boolean;
  lastPingAt: number;
  pingIntervalSec: number;
}

export interface PingEvent {
  type: "ping";
  riderId: string;
  ts: number;
  zoneId: string;
  speedKph: number;
  accelFlag: boolean;
}

export interface PositionEvent {
  type: "position";
  riderId: string;
  x: number;
  y: number;
}

export type SimEvent = PingEvent | PositionEvent;

/**
 * In-process rider simulator. Stands in for a real fleet of phones — see
 * PLAN.md §3 for why building a real mobile app is out of scope here.
 *
 * Ground truth (isDroppedOut / isIncident) is intentionally NOT exposed to
 * the engine. The engine only ever sees ping events, exactly like it would
 * with real riders — no cheating with the simulator's internal state.
 */
export class Simulator {
  private simTime = 0;
  private states = new Map<string, InternalState>();

  constructor(riderCount: number = 10) {
    const riders = generateRiders(riderCount);
    for (const rider of riders) {
      this.states.set(rider.id, {
        rider,
        segmentIndex: 0,
        segmentProgressSec: 0,
        isDroppedOut: false,
        isIncident: false,
        dropoutEndsAt: null,
        accelFlag: false,
        lastPingAt: 0,
        pingIntervalSec: 8,
      });
    }
  }

  getRiders(): Rider[] {
    return [...this.states.values()].map((s) => s.rider);
  }

  getSimTime(): number {
    return this.simTime;
  }

  /** Force a specific rider into an unresolved incident — the demo's "inject" button. */
  injectIncident(riderId: string) {
    const s = this.states.get(riderId);
    if (!s) return;
    s.isDroppedOut = true;
    s.isIncident = true;
    s.dropoutEndsAt = null;
    s.accelFlag = true;
  }

  /** Drops every rider currently in `zoneId` at once — demo trigger for the cluster-silence guard. */
  injectZoneOutage(zoneId: string) {
    for (const s of this.states.values()) {
      const currentZoneId = s.rider.route[s.rider.segmentIndex].zoneId;
      if (currentZoneId === zoneId && !s.isDroppedOut) {
        s.isDroppedOut = true;
        s.isIncident = false;
        s.dropoutEndsAt = this.simTime + 25; // resolves on its own, like a real outage clearing
      }
    }
  }

  /** Called by the engine once EMERGENCY resolves — simulates help finding the rider. */
  forceResume(riderId: string) {
    const s = this.states.get(riderId);
    if (!s) return;
    s.isDroppedOut = false;
    s.isIncident = false;
    s.dropoutEndsAt = null;
    s.accelFlag = false;
    s.lastPingAt = this.simTime;
  }

  /** Advance the simulation by `dtSec` simulated seconds. Returns events for the engine/dashboard. */
  tick(dtSec: number): SimEvent[] {
    this.simTime += dtSec;
    const events: SimEvent[] = [];

    for (const s of this.states.values()) {
      if (s.isDroppedOut) {
        if (!s.isIncident && s.dropoutEndsAt !== null && this.simTime >= s.dropoutEndsAt) {
          // Normal dead-zone dropout naturally ends — signal resumes.
          s.isDroppedOut = false;
          s.dropoutEndsAt = null;
          s.lastPingAt = this.simTime;
          const zoneId = s.rider.route[s.segmentIndex].zoneId;
          events.push({ type: "ping", riderId: s.rider.id, ts: this.simTime, zoneId, speedKph: s.rider.speedKph, accelFlag: false });
        }
        // Incidents (isIncident=true) never self-resolve — only forceResume() clears them.
        continue;
      }

      // Online: advance along the route.
      s.segmentProgressSec += dtSec;
      const segment = s.rider.route[s.segmentIndex];

      // Interpolate position for the dashboard.
      const nextSegment = s.rider.route[(s.segmentIndex + 1) % s.rider.route.length];
      const from = ZONE_POSITIONS[segment.zoneId];
      const to = ZONE_POSITIONS[nextSegment.zoneId];
      const progress = Math.min(1, s.segmentProgressSec / segment.travelTimeSec);
      s.rider.x = from.x + (to.x - from.x) * progress;
      s.rider.y = from.y + (to.y - from.y) * progress;
      events.push({ type: "position", riderId: s.rider.id, x: s.rider.x, y: s.rider.y });

      // Periodic heartbeat ping while online.
      if (this.simTime - s.lastPingAt >= s.pingIntervalSec) {
        s.lastPingAt = this.simTime;
        events.push({ type: "ping", riderId: s.rider.id, ts: this.simTime, zoneId: segment.zoneId, speedKph: s.rider.speedKph, accelFlag: false });
      }

      // Reached the end of this segment — cross into the next zone.
      if (s.segmentProgressSec >= segment.travelTimeSec) {
        s.segmentIndex = (s.segmentIndex + 1) % s.rider.route.length;
        s.rider.segmentIndex = s.segmentIndex;
        s.segmentProgressSec = 0;

        const enteredZone = getZone(s.rider.route[s.segmentIndex].zoneId);
        if (Math.random() < enteredZone.dropoutBaseRate) {
          s.isDroppedOut = true;
          s.isIncident = false;
          const duration =
            enteredZone.mu !== null && enteredZone.sigma !== null
              ? sampleLognormal(enteredZone.mu, enteredZone.sigma)
              : 30 + Math.random() * 60; // unmapped zone: still finite, just no prior
          s.dropoutEndsAt = this.simTime + duration;
        }
      }
    }

    return events;
  }

  listZones() {
    return ZONES;
  }
}

function sampleLognormal(mu: number, sigma: number): number {
  // Box-Muller for a standard normal, then transform.
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.exp(mu + sigma * z);
}
