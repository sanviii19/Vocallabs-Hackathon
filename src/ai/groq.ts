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

function buildPrompt(ev: Stage2Evidence): string {
  // Kept deliberately terse — every extra token here is an extra token charged against
  // the account's tokens-per-minute budget on every single evaluation. See the note by
  // reasoning_effort below for why this matters more than it looks.
  return `Autonomous delivery-fleet safety agent, no human review. Be conservative — only EMERGENCY if evidence doesn't fit an ordinary dead zone.

Rider ${ev.riderName}, zone "${ev.zoneName}" (${ev.zoneIsMapped ? "has a dropout-duration prior" : "UNMAPPED, no prior"}), silent ${ev.silenceSec.toFixed(0)}s, anomaly score ${ev.stage1AnomalyScore.toFixed(2)} (0=explained, 1=anomalous), speed ${ev.lastSpeedKph}km/h, deceleration-at-dropout: ${ev.accelFlag ? "YES, possible fall" : "no"}, battery ${ev.batteryPct}%.

Pick tier: SOFT_WATCH (mild), CUSTOMER_NOTIFY (delay), PEER_CHECK (ask nearby rider), or EMERGENCY (contact emergency contact). Respond with ONLY: {"tierRecommendation": "SOFT_WATCH"|"CUSTOMER_NOTIFY"|"PEER_CHECK"|"EMERGENCY", "confidence": 0-1, "rationale": "one sentence", "nextCheckDelaySec": number}`;
}

/**
 * Calls Groq (OpenAI-compatible chat completions, fast open-weight models) for the
 * Stage-2 judgment. Returns null on any failure — callers MUST fall back to the
 * Stage-1-only deterministic tiering (see engine/stage1.ts:fallbackTier) rather than
 * throwing. This is the "Degrades gracefully" constraint in practice, not just a pitch line.
 *
 * Groq's JSON mode guarantees valid JSON but does not enforce a specific schema (unlike
 * Gemini's responseSchema), so the exact shape is spelled out in the prompt and the
 * response is still validated defensively below before being trusted.
 */
export async function assessWithGroq(ev: Stage2Evidence): Promise<Stage2Result | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const model = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
  const url = "https://api.groq.com/openai/v1/chat/completions";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "You output ONLY a single JSON object matching the exact shape requested. No markdown fences, no prose before or after.",
          },
          { role: "user", content: buildPrompt(ev) },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        // gpt-oss models spend a chunk of the completion on hidden reasoning before the
        // final JSON — "low" effort cut a real test call's total tokens from 673 to 328
        // (reasoning_tokens 282 -> 66) with no meaningful loss in judgment quality. This,
        // not prompt size, was the actual driver of hitting the free-tier TPM limit.
        reasoning_effort: "low",
        // Give enough room for reasoning + the JSON answer to actually finish — too low
        // (250 was tried first) truncates mid-thought and produces invalid JSON instead
        // of saving anything, since a failed call still returns null and falls back anyway.
        max_tokens: 400,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.error(`[stage2] Groq call failed: ${res.status} ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
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
    console.error("[stage2] Groq call threw:", err);
    return null;
  }
}
