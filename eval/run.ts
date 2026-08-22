import { getZone } from "../src/simulator/zones";
import { anomalyScore, fallbackTier } from "../src/engine/stage1";
import { assessWithGroq, type Stage2Evidence } from "../src/ai/groq";
import { SCENARIOS, type Category } from "./scenarios";
import type { Tier } from "../src/types";

const CATEGORY_WEIGHT: Record<Category, number> = {
  dead_zone: 1,
  incident: 3, // missing a real incident is the worst failure mode — weighted accordingly
  novel_zone: 1.5,
  adversarial: 1.5,
};

/**
 * `mode` matters for novel_zone: a raw statistical score can't reliably tell "unmapped
 * zone, moderate silence" apart from a case that genuinely warrants a peer-check — only
 * Stage 2, which is explicitly told the zone is unmapped, can make that call with intent.
 * So the fallback bar is just "reacted at all" (not NOMINAL); the full-system bar is the
 * real target behavior, "reached at least PEER_CHECK."
 */
function passes(category: Category, tier: Tier, mode: "fallback" | "stage2"): boolean {
  switch (category) {
    case "dead_zone":
      return tier === "NOMINAL" || tier === "SOFT_WATCH";
    case "incident":
      return tier === "EMERGENCY";
    case "novel_zone":
      return mode === "fallback" ? tier !== "NOMINAL" : tier === "PEER_CHECK" || tier === "EMERGENCY";
    case "adversarial":
      return tier !== "EMERGENCY";
  }
}

function pad(s: string, n: number) {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

async function main() {
  const hasKey = !!process.env.GROQ_API_KEY;
  console.log(`\nField Agent Check-In — Eval Harness (${SCENARIOS.length} scenarios)`);
  console.log(hasKey ? "GROQ_API_KEY set — running both Stage-1-only and full Stage-2 passes.\n" : "GROQ_API_KEY not set — showing Stage-1-only (fallback) results only.\n");

  console.log(
    pad("ID", 4) + pad("Category", 12) + pad("Zone", 18) + pad("t(s)", 6) + pad("Accel", 6) +
    pad("Score", 7) + pad("Fallback", 12) + pad("Stage1 OK", 10) + (hasKey ? pad("Stage2", 12) + pad("Stage2 OK", 10) : "")
  );
  console.log("-".repeat(hasKey ? 108 : 78));

  let fallbackWeightedPass = 0;
  let stage2WeightedPass = 0;
  let totalWeight = 0;

  for (const sc of SCENARIOS) {
    const zone = getZone(sc.zoneId);
    const score = anomalyScore(sc.silenceSec, zone);
    const fbTierRaw = fallbackTier(score);
    const fbTier: Tier = fbTierRaw === "NOMINAL" ? "NOMINAL" : fbTierRaw;
    const fbPass = passes(sc.category, fbTier, "fallback");
    const weight = CATEGORY_WEIGHT[sc.category];
    totalWeight += weight;
    if (fbPass) fallbackWeightedPass += weight;

    let row =
      pad(sc.id, 4) + pad(sc.category, 12) + pad(zone.name, 18) + pad(String(sc.silenceSec), 6) +
      pad(sc.accelFlag ? "yes" : "no", 6) + pad(score.toFixed(2), 7) + pad(fbTier, 12) + pad(fbPass ? "PASS" : "FAIL", 10);

    if (hasKey) {
      const evidence: Stage2Evidence = {
        riderName: "Test Rider",
        zoneName: zone.name,
        zoneIsMapped: zone.mu !== null,
        silenceSec: sc.silenceSec,
        stage1AnomalyScore: score,
        lastSpeedKph: 30,
        accelFlag: sc.accelFlag,
        batteryPct: 80,
      };
      const result = await assessWithGroq(evidence);
      const s2Tier = result?.tierRecommendation ?? fbTier;
      const s2Pass = passes(sc.category, s2Tier, "stage2");
      if (s2Pass) stage2WeightedPass += weight;
      row += pad(s2Tier, 12) + pad(s2Pass ? "PASS" : "FAIL", 10);
    }

    console.log(row);
  }

  console.log("-".repeat(hasKey ? 108 : 78));
  const fbScore = ((fallbackWeightedPass / totalWeight) * 100).toFixed(1);
  console.log(`\nStage-1-only (fallback) weighted score: ${fbScore}%`);
  if (hasKey) {
    const s2Score = ((stage2WeightedPass / totalWeight) * 100).toFixed(1);
    console.log(`Full system (Stage-2) weighted score:   ${s2Score}%`);
    const requiresStage2Count = SCENARIOS.filter((s) => s.requiresStage2).length;
    console.log(
      `\n${requiresStage2Count} of ${SCENARIOS.length} scenarios are specifically designed to be missed by Stage-1 alone ` +
      `(short silence + fall-flag, or a zone with no fitted prior) — the gap between the two scores above is the concrete, ` +
      `measured answer to "why does this break without AI."`
    );
  } else {
    const stage2Only = SCENARIOS.filter((s) => s.requiresStage2).map((s) => s.id).join(", ");
    console.log(`\nSet GROQ_API_KEY and re-run to see the full Stage-2 pass — scenarios ${stage2Only} are designed to fail Stage-1 alone.`);
  }
}

main();
