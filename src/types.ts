// Shared types — the interface between the simulator/engine and the dashboard.
// Committed first so both workstreams can build against it independently.

export type Tier =
  | "NOMINAL"
  | "SOFT_WATCH"
  | "CUSTOMER_NOTIFY"
  | "PEER_CHECK"
  | "EMERGENCY"
  | "RESOLVED";

export interface Zone {
  id: string;
  name: string;
  /** Probability a rider crossing this zone enters a real dead spot at all. */
  dropoutBaseRate: number;
  /** Lognormal distribution params for dropout duration in simulated seconds. Null = unmapped zone (no prior). */
  mu: number | null;
  sigma: number | null;
}

export interface RouteSegment {
  zoneId: string;
  /** Normal (non-dropout) crossing time in simulated seconds. */
  travelTimeSec: number;
}

export interface Rider {
  id: string;
  name: string;
  vehicle: string;
  route: RouteSegment[];
  segmentIndex: number;
  /** Simulated x/y for the dashboard grid, 0..100. */
  x: number;
  y: number;
  speedKph: number;
  batteryPct: number;
}

export interface RiderRuntimeState {
  riderId: string;
  tier: Tier;
  lastPingAt: number; // simulated epoch seconds
  lastZoneId: string;
  lastSpeedKph: number;
  accelFlag: boolean; // simulated "sudden deceleration" evidence
  silentSince: number | null;
  tierEnteredAt: number;
  incidentOpenedAt: number | null;
}

export interface DecisionLogEntry {
  id: number;
  riderId: string;
  ts: number;
  anomalyScore: number;
  stage2Confidence: number | null;
  rationale: string;
  tierBefore: Tier;
  tierAfter: Tier;
  source: "stage1" | "stage2" | "stage2_fallback" | "cluster_guard" | "resolution";
}

export interface MockNotification {
  id: number;
  riderId: string;
  ts: number;
  channel: "push" | "customer_sms" | "peer_request" | "ivr" | "emergency_contact" | "incident_report";
  payload: string;
}

export interface StateSnapshot {
  simTime: number;
  running: boolean;
  zones: Zone[];
  riders: Rider[];
  runtime: RiderRuntimeState[];
  recentDecisions: DecisionLogEntry[];
  recentNotifications: MockNotification[];
}

/** WebSocket message envelope, dashboard <-> server. */
export type ServerMessage =
  | { type: "snapshot"; data: StateSnapshot }
  | { type: "decision"; data: DecisionLogEntry }
  | { type: "notification"; data: MockNotification }
  | { type: "rider_update"; data: { rider: Rider; runtime: RiderRuntimeState } };
