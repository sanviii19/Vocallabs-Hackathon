export type Category = "dead_zone" | "incident" | "novel_zone" | "adversarial";

export interface Scenario {
  id: string;
  description: string;
  zoneId: string;
  silenceSec: number;
  accelFlag: boolean;
  category: Category;
  /** True if a pure statistical (Stage-1-only) fallback is expected to miss this one —
   *  these are the fixtures that make the "why does this break without AI" case concrete. */
  requiresStage2: boolean;
}

export const SCENARIOS: Scenario[] = [
  // 8 genuine dead-zone crossings — should never escalate past SOFT_WATCH.
  { id: "D1", description: "Flyover 7, well within normal crossing time", zoneId: "flyover-7", silenceSec: 40, accelFlag: false, category: "dead_zone", requiresStage2: false },
  { id: "D2", description: "Flyover 7, median crossing time", zoneId: "flyover-7", silenceSec: 70, accelFlag: false, category: "dead_zone", requiresStage2: false },
  { id: "D3", description: "Flyover 7, upper-mid crossing time", zoneId: "flyover-7", silenceSec: 95, accelFlag: false, category: "dead_zone", requiresStage2: false },
  { id: "D4", description: "Flyover 7, near the 95th-percentile edge", zoneId: "flyover-7", silenceSec: 118, accelFlag: false, category: "dead_zone", requiresStage2: false },
  { id: "D5", description: "Tunnel NH4, well within normal crossing time", zoneId: "tunnel-nh4", silenceSec: 60, accelFlag: false, category: "dead_zone", requiresStage2: false },
  { id: "D6", description: "Tunnel NH4, median crossing time", zoneId: "tunnel-nh4", silenceSec: 110, accelFlag: false, category: "dead_zone", requiresStage2: false },
  { id: "D7", description: "Tunnel NH4, upper-mid crossing time", zoneId: "tunnel-nh4", silenceSec: 140, accelFlag: false, category: "dead_zone", requiresStage2: false },
  { id: "D8", description: "Tunnel NH4, near the 95th-percentile edge", zoneId: "tunnel-nh4", silenceSec: 160, accelFlag: false, category: "dead_zone", requiresStage2: false },

  // 6 true incidents — must reach EMERGENCY.
  { id: "I1", description: "Rural Stretch 9, silence far past any normal dropout", zoneId: "rural-stretch-9", silenceSec: 380, accelFlag: false, category: "incident", requiresStage2: false },
  { id: "I2", description: "Tunnel NH4, silence far past any normal dropout", zoneId: "tunnel-nh4", silenceSec: 250, accelFlag: false, category: "incident", requiresStage2: false },
  { id: "I3", description: "Open road, short silence but a fall-flag — stats alone see nothing wrong", zoneId: "open-road", silenceSec: 15, accelFlag: true, category: "incident", requiresStage2: true },
  { id: "I4", description: "Flyover 7, ordinary-looking silence but a fall-flag", zoneId: "flyover-7", silenceSec: 50, accelFlag: true, category: "incident", requiresStage2: true },
  { id: "I5", description: "Market basement, ordinary-looking silence but a fall-flag", zoneId: "market-basement", silenceSec: 20, accelFlag: true, category: "incident", requiresStage2: true },
  { id: "I6", description: "Rural Stretch 9, very short silence but a fall-flag", zoneId: "rural-stretch-9", silenceSec: 30, accelFlag: true, category: "incident", requiresStage2: true },

  // 4 novel zones with no fitted distribution — the curveball rehearsal.
  { id: "N1", description: "Unmapped detour zone, moderate silence", zoneId: "unmapped-detour-1", silenceSec: 55, accelFlag: false, category: "novel_zone", requiresStage2: false },
  { id: "N2", description: "Unmapped detour zone, longer silence", zoneId: "unmapped-detour-1", silenceSec: 60, accelFlag: false, category: "novel_zone", requiresStage2: false },
  { id: "N3", description: "Unmapped detour zone, longer still", zoneId: "unmapped-detour-1", silenceSec: 68, accelFlag: false, category: "novel_zone", requiresStage2: false },
  { id: "N4", description: "Unmapped detour zone, near the fallback ceiling", zoneId: "unmapped-detour-1", silenceSec: 75, accelFlag: false, category: "novel_zone", requiresStage2: false },

  // 2 adversarial/noisy cases — must not false-fire EMERGENCY.
  { id: "A1", description: "Market basement, a slightly long but plausible coffee-break stop", zoneId: "market-basement", silenceSec: 55, accelFlag: false, category: "adversarial", requiresStage2: false },
  { id: "A2", description: "Flyover 7, unusually long but not extreme — no fall-flag, normal battery/speed before drop", zoneId: "flyover-7", silenceSec: 105, accelFlag: false, category: "adversarial", requiresStage2: false },
];
