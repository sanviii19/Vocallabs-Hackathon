import type { Database } from "bun:sqlite";
import type { MockNotification, Rider, Tier } from "../types";

/**
 * Every function here WRITES A LOG ENTRY ONLY. No SMS/IVR/telephony/
 * emergency-dispatch provider is ever called — see PLAN.md §6 and §16.
 * This is a demo of the escalation *logic*, not a messaging product.
 */

let nextId = 1;

function record(
  db: Database,
  emit: (n: MockNotification) => void,
  riderId: string,
  ts: number,
  channel: MockNotification["channel"],
  payload: string
): MockNotification {
  db.run(
    `INSERT INTO mock_notifications (rider_id, ts, channel, payload) VALUES (?, ?, ?, ?)`,
    [riderId, ts, channel, payload]
  );
  const n: MockNotification = { id: nextId++, riderId, ts, channel, payload };
  emit(n);
  return n;
}

export function runTierAction(
  db: Database,
  emit: (n: MockNotification) => void,
  tier: Tier,
  rider: Rider,
  ts: number,
  rationale: string
) {
  switch (tier) {
    case "SOFT_WATCH":
      record(db, emit, rider.id, ts, "push", `[MOCK PUSH] "${rider.name}, tap to confirm you're safe." (${rationale})`);
      break;
    case "CUSTOMER_NOTIFY":
      record(
        db,
        emit,
        rider.id,
        ts,
        "customer_sms",
        `[MOCK SMS to customer] "Your delivery is delayed due to a connectivity gap. We're actively monitoring the rider and will update you shortly."`
      );
      break;
    case "PEER_CHECK":
      record(
        db,
        emit,
        rider.id,
        ts,
        "peer_request",
        `[MOCK PEER REQUEST] Nearest available rider asked: "Can you see ${rider.name} (${rider.vehicle}) near their last known location?"`
      );
      break;
    case "EMERGENCY":
      record(
        db,
        emit,
        rider.id,
        ts,
        "ivr",
        `[MOCK IVR CALL] Automated call to ${rider.name}: "Press 1 if you're OK, 2 if you need help." (no response assumed)`
      );
      record(
        db,
        emit,
        rider.id,
        ts,
        "emergency_contact",
        `[MOCK CALL/SMS to emergency contact] "We've lost contact with ${rider.name} near their last known location. If this is a mistake, please have them reach out immediately."`
      );
      record(
        db,
        emit,
        rider.id,
        ts,
        "incident_report",
        `[MOCK INCIDENT REPORT FILED — not a real emergency-dispatch API] ${rationale}`
      );
      break;
    default:
      break;
  }
}

export function clusterOutageNotification(
  db: Database,
  emit: (n: MockNotification) => void,
  zoneName: string,
  affectedRiderIds: string[],
  ts: number
) {
  record(
    db,
    emit,
    affectedRiderIds[0],
    ts,
    "incident_report",
    `[CLUSTER GUARD] ${affectedRiderIds.length} riders silent simultaneously in ${zoneName} — treated as one infrastructure event, not ${affectedRiderIds.length} individual emergencies. Affected: ${affectedRiderIds.join(", ")}`
  );
}
