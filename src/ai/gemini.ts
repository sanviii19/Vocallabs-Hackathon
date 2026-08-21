import type { Tier } from "../types";

export interface Stage2Evidence {
  riderName: string;
  zoneName: string;
  zoneIsMapped: boolean;
  silenceSec: number;
  stage1AnomalyScore: number;
  lastSpeedKph: number;
  accelFlag: boolean; // simulated "sudden deceleration" signal
  batteryPct: number;
}

export interface Stage2Result {
  tierRecommendation: Tier;
  confidence: number;
  rationale: string;
  nextCheckDelaySec: number;
}

const VALID_TIERS: Tier[] = ["SOFT_WATCH", "CUSTOMER_NOTIFY", "PEER_CHECK", "EMERGENCY"];

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    tierRecommendation: { type: "string", enum: VALID_TIERS },
    confidence: { type: "number" },
    rationale: { type: "string" },
    nextCheckDelaySec: { type: "number" },
  },
  required: ["tierRecommendation", "confidence", "rationale", "nextCheckDelaySec"],
};

function buildPrompt(ev: Stage2Evidence): string {
  return `You are the Stage-2 judgment layer of an autonomous delivery-fleet safety agent. There is NO human dispatcher reviewing your decision — it is executed automatically. Be conservative: only recommend EMERGENCY when the evidence genuinely does not fit an ordinary network dead zone.

Rider: ${ev.riderName}
Last known zone: ${ev.zoneName} (${ev.zoneIsMapped ? "has a historical dropout-duration prior" : "UNMAPPED — no historical prior exists for this zone"})
Silent for: ${ev.silenceSec.toFixed(0)} seconds
Stage-1 statistical anomaly score: ${ev.stage1AnomalyScore.toFixed(2)} (0 = fully explained by normal dead zone, 1 = fully anomalous)
Last known speed: ${ev.lastSpeedKph} km/h
Sudden-deceleration flag at moment of signal loss: ${ev.accelFlag ? "YES — possible fall/crash" : "no"}
Battery at last ping: ${ev.batteryPct}%

Decide the tier: SOFT_WATCH (mild concern, quiet check), CUSTOMER_NOTIFY (delay likely, inform customer), PEER_CHECK (ask a nearby rider to look), or EMERGENCY (high-confidence incident, contact emergency contact automatically). Explain what evidence drove the decision in one or two sentences, and suggest how many more seconds to wait before re-checking if not escalating further right now.`;
}

/**
 * Calls Gemini for the Stage-2 judgment. Returns null on any failure —
 * callers MUST fall back to the Stage-1-only deterministic tiering
 * (see engine/stage1.ts:fallbackTier) rather than throwing. This is the
 * "Degrades gracefully" constraint in practice, not just a pitch line.
 */
export async function assessWithGemini(ev: Stage2Evidence): Promise<Stage2Result | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(ev) }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.2,
        },
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.error(`[stage2] Gemini call failed: ${res.status} ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    const parsed = JSON.parse(text);
    if (!VALID_TIERS.includes(parsed.tierRecommendation)) return null;

    return {
      tierRecommendation: parsed.tierRecommendation,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence))),
      rationale: String(parsed.rationale),
      nextCheckDelaySec: Math.max(5, Number(parsed.nextCheckDelaySec) || 30),
    };
  } catch (err) {
    console.error("[stage2] Gemini call threw:", err);
    return null;
  }
}
