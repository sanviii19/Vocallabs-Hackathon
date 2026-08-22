import type { Database } from "bun:sqlite";
import type { Rider, RiderRuntimeState, Tier, DecisionLogEntry, MockNotification } from "../types";
import type { PingEvent } from "../simulator/simulator";
import { getZone } from "../simulator/zones";
import { anomalyScore, fallbackTier } from "./stage1";
import { assessWithGroq, type Stage2Evidence } from "../ai/groq";
import { runTierAction, clusterOutageNotification } from "../actions/mockActions";

const GRACE_SEC = 5; // don't evaluate until silence exceeds this — avoids reacting to ping jitter
const STAGE2_GATE = 0.4; // Stage-1 score above which Stage-2 gets invoked at all
const CLUSTER_THRESHOLD = 3; // total riders silent in the same zone at once => infrastructure event, not N incidents

const DEFAULT_DWELL: Record<string, number> = { SOFT_WATCH: 20, CUSTOMER_NOTIFY: 20, PEER_CHECK: 25 };
const MAX_DWELL: Record<string, number> = { SOFT_WATCH: 30, CUSTOMER_NOTIFY: 30, PEER_CHECK: 40 };
const LADDER: Tier[] = ["SOFT_WATCH", "CUSTOMER_NOTIFY", "PEER_CHECK", "EMERGENCY"];

function nextInLadder(tier: Tier): Tier {
  const idx = LADDER.indexOf(tier);
  return idx >= 0 && idx < LADDER.length - 1 ? LADDER[idx + 1] : "EMERGENCY";
}

export interface EngineDeps {
  db: Database;
  getRider: (id: string) => Rider;
  emitDecision: (d: DecisionLogEntry) => void;
  emitNotification: (n: MockNotification) => void;
  emitRiderUpdate: (riderId: string) => void;
  onForceResume: (riderId: string) => void; // tells the simulator "help arrived, resume"
}

let decisionId = 1;

export class Engine {
  private runtime = new Map<string, RiderRuntimeState>();
  private stage2InFlight = new Set<string>();
  private dwellDeadline = new Map<string, number>();
  private emergencyResumeAt = new Map<string, number>();

  constructor(riders: Rider[], private deps: EngineDeps) {
    for (const r of riders) {
      this.runtime.set(r.id, {
        riderId: r.id,
        tier: "NOMINAL",
        lastPingAt: 0,
        lastZoneId: r.route[0].zoneId,
        lastSpeedKph: r.speedKph,
        accelFlag: false,
        silentSince: null,
        tierEnteredAt: 0,
        incidentOpenedAt: null,
      });
    }
  }

  getRuntimeArray(): RiderRuntimeState[] {
    return [...this.runtime.values()];
  }

  onPing(ev: PingEvent) {
    const rt = this.runtime.get(ev.riderId);
    if (!rt) return;

    if (rt.tier !== "NOMINAL") {
      this.logDecision(rt.riderId, ev.ts, 0, null, "Signal resumed — resolved.", rt.tier, "RESOLVED", "resolution");
      this.dwellDeadline.delete(rt.riderId);
      this.emergencyResumeAt.delete(rt.riderId);
    }

    rt.tier = "NOMINAL";
    rt.lastPingAt = ev.ts;
    rt.lastZoneId = ev.zoneId;
    rt.lastSpeedKph = ev.speedKph;
    rt.accelFlag = ev.accelFlag;
    rt.silentSince = null;
    rt.tierEnteredAt = ev.ts;
    rt.incidentOpenedAt = null;
    this.deps.emitRiderUpdate(ev.riderId);
  }

  /** Called every simulation tick. Synchronous Stage-1 pass; kicks off async Stage-2 as needed. */
  tick(simTime: number) {
    for (const rt of this.runtime.values()) {
      const silenceSec = simTime - rt.lastPingAt;
      if (silenceSec < GRACE_SEC) continue; // covers NOMINAL riders pinging normally — nothing to do yet
      if (rt.silentSince === null) rt.silentSince = rt.lastPingAt;

      const zone = getZone(rt.lastZoneId);
      const score = anomalyScore(silenceSec, zone);

      const deadline = this.dwellDeadline.get(rt.riderId);
      const forcedByDwell = deadline !== undefined && simTime >= deadline;

      // EMERGENCY auto-resolves after a short delay — simulates help finding the rider,
      // so the demo closes the loop instead of sitting at EMERGENCY forever.
      const resumeAt = this.emergencyResumeAt.get(rt.riderId);
      if (resumeAt !== undefined) {
        if (simTime >= resumeAt) {
          this.emergencyResumeAt.delete(rt.riderId);
          this.deps.onForceResume(rt.riderId);
        }
        // Already at EMERGENCY and just waiting on the resume timer — nothing else to decide,
        // and re-invoking Stage-2 here would only burn API quota for no benefit.
        continue;
      }

      // First escalation out of NOMINAL is gated by the score crossing STAGE2_GATE.
      // Once already escalated, only re-evaluate when the dwell timer expires — otherwise
      // every tick would re-call Stage-2 for as long as the score stays high, burning API
      // quota for a decision that hasn't actually changed since the last check.
      const alreadyEscalated = rt.tier !== "NOMINAL";
      const shouldEvaluate = alreadyEscalated ? forcedByDwell : score >= STAGE2_GATE;

      if (shouldEvaluate && !this.stage2InFlight.has(rt.riderId)) {
        this.stage2InFlight.add(rt.riderId);
        this.evaluateWithStage2(rt.riderId, zone.id, score, simTime, forcedByDwell).finally(() =>
          this.stage2InFlight.delete(rt.riderId)
        );
      }
    }
  }

  /**
   * Riders genuinely anomalous in this zone right now — NOT just "more than GRACE_SEC
   * since their last ping," which is true for a large fraction of perfectly healthy
   * riders at any given instant (normal ping cadence is ~8s, well over GRACE_SEC=5s).
   * Using the same STAGE2_GATE bar as the main evaluation keeps this consistent with
   * "anomalous enough to matter," not "between two routine heartbeats."
   */
  private silentRidersInZone(zoneId: string, simTime: number): string[] {
    return [...this.runtime.values()]
      .filter((r) => {
        if (r.lastZoneId !== zoneId) return false;
        const silence = simTime - r.lastPingAt;
        if (silence < GRACE_SEC) return false;
        return anomalyScore(silence, getZone(zoneId)) >= STAGE2_GATE;
      })
      .map((r) => r.riderId);
  }

  private async evaluateWithStage2(riderId: string, zoneId: string, score: number, simTime: number, forcedByDwell: boolean) {
    const rt = this.runtime.get(riderId);
    if (!rt) return;
    const silenceAtCallStart = rt.lastPingAt;

    const rider = this.deps.getRider(riderId);
    const zone = getZone(zoneId);
    const silenceSec = simTime - rt.lastPingAt;

    const evidence: Stage2Evidence = {
      riderName: rider.name,
      zoneName: zone.name,
      zoneIsMapped: zone.mu !== null,
      silenceSec,
      stage1AnomalyScore: score,
      lastSpeedKph: rt.lastSpeedKph,
      accelFlag: rt.accelFlag,
      batteryPct: rider.batteryPct,
    };

    const result = await assessWithGroq(evidence);
    // Re-check: a ping may have arrived (rider resolved/resumed) while the network call
    // was in flight. Compare lastPingAt rather than tier — tier can legitimately still be
    // NOMINAL both before *and* after a real resolution (it started there too).
    const rtNow = this.runtime.get(riderId);
    if (!rtNow || rtNow.lastPingAt !== silenceAtCallStart) return;

    let tierAfter: Tier;
    let confidence: number | null;
    let rationale: string;
    let source: DecisionLogEntry["source"];
    let nextDelay: number;

    if (result) {
      tierAfter = result.tierRecommendation;
      confidence = result.confidence;
      rationale = result.rationale;
      source = "stage2";
      nextDelay = result.nextCheckDelaySec;
    } else {
      tierAfter = fallbackTier(score) === "NOMINAL" ? "SOFT_WATCH" : (fallbackTier(score) as Tier);
      confidence = null;
      rationale = `Stage-2 unreachable (or no API key set) — fell back to the deterministic threshold rule (score ${score.toFixed(2)}). Degrades gracefully by design.`;
      source = "stage2_fallback";
      nextDelay = DEFAULT_DWELL[tierAfter] ?? 20;
    }

    const tierBefore = rtNow.tier;

    // Bounded escalation guarantee: if we've been forced by the dwell timer and the
    // recommendation is to just stay put, override and escalate anyway. No tier waits forever.
    if (forcedByDwell && tierAfter === tierBefore) {
      tierAfter = nextInLadder(tierBefore);
      rationale = `${rationale} [Dwell timer exceeded with no resolution — force-escalated rather than waiting further.]`;
    }

    // Cluster-silence guard: never let an individual EMERGENCY fire during a shared outage.
    if (tierAfter === "EMERGENCY") {
      const clustered = this.silentRidersInZone(zoneId, simTime);
      if (clustered.length >= CLUSTER_THRESHOLD) {
        for (const id of clustered) {
          const r = this.runtime.get(id)!;
          const before = r.tier;
          r.tier = "SOFT_WATCH";
          r.tierEnteredAt = simTime;
          this.dwellDeadline.set(id, simTime + MAX_DWELL.SOFT_WATCH);
          this.logDecision(
            id,
            simTime,
            score,
            null,
            `Cluster-silence guard: ${clustered.length} riders silent simultaneously in ${zone.name} — treated as an infrastructure event, not an individual emergency.`,
            before,
            "SOFT_WATCH",
            "cluster_guard"
          );
          this.deps.emitRiderUpdate(id);
        }
        clusterOutageNotification(this.deps.db, this.deps.emitNotification, zone.name, clustered, simTime);
        return;
      }
    }

    rtNow.tier = tierAfter;
    rtNow.tierEnteredAt = simTime;
    if (rtNow.incidentOpenedAt === null && tierAfter !== "NOMINAL") rtNow.incidentOpenedAt = rtNow.silentSince ?? simTime;

    if (tierAfter === "EMERGENCY") {
      this.dwellDeadline.delete(riderId);
      this.emergencyResumeAt.set(riderId, simTime + 15); // "help arrives" ~15 sim-sec after EMERGENCY fires
    } else {
      this.dwellDeadline.set(riderId, simTime + Math.min(nextDelay, MAX_DWELL[tierAfter] ?? 40));
    }

    this.logDecision(riderId, simTime, score, confidence, rationale, tierBefore, tierAfter, source);
    if (tierBefore !== tierAfter) {
      runTierAction(this.deps.db, this.deps.emitNotification, tierAfter, rider, simTime, rationale);
    }
    this.deps.emitRiderUpdate(riderId);
  }

  private logDecision(
    riderId: string,
    ts: number,
    anomaly: number,
    confidence: number | null,
    rationale: string,
    tierBefore: Tier,
    tierAfter: Tier,
    source: DecisionLogEntry["source"]
  ) {
    this.deps.db.run(
      `INSERT INTO decision_log (rider_id, ts, anomaly_score, stage2_confidence, rationale, tier_before, tier_after, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [riderId, ts, anomaly, confidence, rationale, tierBefore, tierAfter, source]
    );
    const entry: DecisionLogEntry = {
      id: decisionId++,
      riderId,
      ts,
      anomalyScore: anomaly,
      stage2Confidence: confidence,
      rationale,
      tierBefore,
      tierAfter,
      source,
    };
    this.deps.emitDecision(entry);
  }
}
