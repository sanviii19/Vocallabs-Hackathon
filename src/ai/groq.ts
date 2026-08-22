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

/**
 * Models to try, in order, each on its own separate Groq quota (both tokens-per-minute
 * and tokens-per-day are tracked per model, not shared) — so one model hitting its daily
 * cap doesn't take Stage-2 down for the rest of the day, it just moves to the next.
 *
 * `reasoningEffort` is per-model because the accepted values differ: gpt-oss models take
 * "low"/"medium"/"high", Qwen only takes "none"/"default" — passing the wrong one is a
 * hard 400, not a graceful ignore. Verified live against the real API before committing
 * to these values, not assumed.
 */
const MODEL_CHAIN: { model: string; reasoningEffort: string }[] = [
  { model: process.env.GROQ_MODEL || "openai/gpt-oss-20b", reasoningEffort: "low" },
  { model: "qwen/qwen3.6-27b", reasoningEffort: "none" },
];

function buildPrompt(ev: Stage2Evidence): string {
  // Kept deliberately terse — every extra token here is an extra token charged against
  // the account's tokens-per-minute AND tokens-per-day budget on every single evaluation.
  return `Autonomous delivery-fleet safety agent, no human review. Be conservative — only EMERGENCY if evidence doesn't fit an ordinary dead zone.

Rider ${ev.riderName}, zone "${ev.zoneName}" (${ev.zoneIsMapped ? "has a dropout-duration prior" : "UNMAPPED, no prior"}), silent ${ev.silenceSec.toFixed(0)}s, anomaly score ${ev.stage1AnomalyScore.toFixed(2)} (0=explained, 1=anomalous), speed ${ev.lastSpeedKph}km/h, deceleration-at-dropout: ${ev.accelFlag ? "YES, possible fall" : "no"}, battery ${ev.batteryPct}%.

Pick tier: SOFT_WATCH (mild), CUSTOMER_NOTIFY (delay), PEER_CHECK (ask nearby rider), or EMERGENCY (contact emergency contact). Respond with ONLY: {"tierRecommendation": "SOFT_WATCH"|"CUSTOMER_NOTIFY"|"PEER_CHECK"|"EMERGENCY", "confidence": 0-1, "rationale": "one sentence", "nextCheckDelaySec": number}`;
}

async function callModel(apiKey: string, model: string, reasoningEffort: string, prompt: string): Promise<Stage2Result | null> {
  const url = "https://api.groq.com/openai/v1/chat/completions";

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
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      reasoning_effort: reasoningEffort,
      // Give enough room for reasoning + the JSON answer to actually finish — too low
      // truncates mid-thought and produces invalid JSON instead of saving anything,
      // since a failed call still returns null and falls back anyway.
      max_tokens: 400,
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    console.error(`[stage2] Groq call failed (${model}): ${res.status} ${await res.text()}`);
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
}

/**
 * Calls Groq for the Stage-2 judgment, trying each model in MODEL_CHAIN in order and
 * returning the first success. Returns null only if every model fails — callers MUST
 * fall back to the Stage-1-only deterministic tiering (see engine/stage1.ts:fallbackTier)
 * in that case. This is the "Degrades gracefully" constraint in practice, not just a
 * pitch line: a single model hitting a rate limit or daily cap no longer means the whole
 * reasoning layer goes dark for the rest of the day.
 */
export async function assessWithGroq(ev: Stage2Evidence): Promise<Stage2Result | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const prompt = buildPrompt(ev);

  for (const { model, reasoningEffort } of MODEL_CHAIN) {
    try {
      const result = await callModel(apiKey, model, reasoningEffort, prompt);
      if (result) return result;
    } catch (err) {
      console.error(`[stage2] Groq call threw (${model}):`, err);
    }
  }

  return null;
}
