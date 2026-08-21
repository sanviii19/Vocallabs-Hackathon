import type { Zone } from "../types";

/** Standard normal CDF via the Abramowitz-Stegun erf approximation. */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p =
    d *
    t *
    (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

function lognormalCdf(t: number, mu: number, sigma: number): number {
  if (t <= 0) return 0;
  return normalCdf((Math.log(t) - mu) / sigma);
}

/**
 * Stage 1 — cheap, no model call. Given a rider silent for `silenceSec` in
 * zone `zone`, how anomalous is that relative to this zone's historical
 * dropout-duration distribution?
 *
 * Returns a score in [0, 1]. 0 = fully explained by a normal dead zone,
 * 1 = fully anomalous (either a mapped zone whose duration is way past
 * historical norms, or an unmapped zone with no prior at all).
 */
export function anomalyScore(silenceSec: number, zone: Zone): number {
  if (zone.mu === null || zone.sigma === null) {
    // Unmapped zone: no prior to lean on. Anomaly rises quickly with time,
    // since we have nothing to explain the silence with — this is exactly
    // the case that should route to Stage 2 rather than a lookup.
    return Math.min(1, silenceSec / 90);
  }
  const pExplainable = 1 - lognormalCdf(silenceSec, zone.mu, zone.sigma);
  return 1 - pExplainable;
}

/**
 * Stage-1-only fallback tiering, used if Stage 2 is unreachable (§4/§12 of PLAN.md).
 * Deliberately more conservative than Stage 2 would typically be: a raw statistical
 * score alone can't tell "ordinary but slow crossing of a real dead zone" apart from
 * "genuinely unexplained," so the safety-net path holds off on PEER_CHECK/EMERGENCY
 * until the score is quite extreme, rather than mirroring Stage 2's usual sensitivity.
 */
export function fallbackTier(score: number): "SOFT_WATCH" | "PEER_CHECK" | "EMERGENCY" | "NOMINAL" {
  if (score < 0.3) return "NOMINAL";
  if (score < 0.85) return "SOFT_WATCH";
  if (score < 0.95) return "PEER_CHECK";
  return "EMERGENCY";
}
