import type { Zone } from "../types";

// Synthetic zone priors. mu/sigma are lognormal params (in simulated seconds)
// for how long a *normal* dead-zone dropout in that area tends to last.
// "unmapped-*" zones deliberately have no fitted prior — they exist to force
// Stage-2 to generalize instead of leaning on a lookup table.
export const ZONES: Zone[] = [
  // Open road still needs its own (short) fitted prior, not the "unmapped" formula —
  // rare brief hiccups here are normal and must score as explainable, not anomalous.
  { id: "open-road", name: "Open Road", dropoutBaseRate: 0.15, mu: Math.log(20), sigma: 0.4 },
  { id: "flyover-7", name: "Flyover 7", dropoutBaseRate: 0.35, mu: Math.log(70), sigma: 0.35 },
  { id: "tunnel-nh4", name: "Tunnel NH4", dropoutBaseRate: 0.4, mu: Math.log(110), sigma: 0.25 },
  { id: "market-basement", name: "Market Basement Loading Dock", dropoutBaseRate: 0.3, mu: Math.log(45), sigma: 0.4 },
  { id: "rural-stretch-9", name: "Rural Stretch, Route 9", dropoutBaseRate: 0.25, mu: Math.log(150), sigma: 0.5 },
  { id: "unmapped-detour-1", name: "Unmapped Detour Zone", dropoutBaseRate: 0.2, mu: null, sigma: null },
];

export function getZone(id: string): Zone {
  const z = ZONES.find((z) => z.id === id);
  if (!z) throw new Error(`Unknown zone: ${id}`);
  return z;
}
