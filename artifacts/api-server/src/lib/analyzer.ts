import Anthropic from "@anthropic-ai/sdk";
import type { AnalysisResult, SessionCategory, SessionFlag } from "./sessions.js";

if (!process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"] || !process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"]) {
  throw new Error("Anthropic AI integration env vars missing. Ensure AI_INTEGRATIONS_ANTHROPIC_BASE_URL and AI_INTEGRATIONS_ANTHROPIC_API_KEY are set.");
}

const anthropic = new Anthropic({
  baseURL: process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"],
  apiKey: process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"],
});

const SYSTEM_PROMPT = `You are a contract risk analysis engine. You extract and score legal risk from vendor contracts for non-lawyer business operators. You are precise, clause-specific, and non-alarmist. You never give legal advice. You identify risk signals and surface them for human review.
Output ONLY valid JSON. No markdown, no explanation, no preamble. If a category has no relevant clauses, return an empty flags array for it.`;

const CATEGORIES_PROMPT = `Analyze the following vendor contract for legal risk across exactly these 10 categories:
1. AUTO_RENEWAL — automatic renewal terms, notice windows, evergreen clauses
2. TERMINATION — termination for convenience, cure periods, termination fees
3. LIABILITY_CAP — limitation of liability, exclusions, damage caps relative to contract value
4. IP_OWNERSHIP — who owns work product, IP assignment, license grants, moral rights
5. DATA_RIGHTS — data usage, sharing, retention, processing by vendor, GDPR/CCPA exposure
6. INDEMNIFICATION — indemnification scope, mutual vs one-sided, defense obligations
7. GOVERNING_LAW — jurisdiction, dispute resolution, arbitration clauses, class action waivers
8. PAYMENT_TERMS — late fees, price escalation, audit rights, currency/FX risk
9. CONFIDENTIALITY — NDA terms, carve-outs, survival period, permitted disclosures
10. FORCE_MAJEURE — scope of FM events, notice requirements, extended FM termination rights

For each category return:
{
  "categoryId": "AUTO_RENEWAL",
  "label": "Auto-renewal",
  "score": 0-10,
  "severity": "none|low|moderate|high|critical",
  "summary": "One sentence explaining the risk level.",
  "flags": [
    {
      "flagId": "AR_001",
      "excerpt": "Exact quoted text from contract (max 300 chars)",
      "location": "Section 4.2",
      "risk": "Plain-English explanation of why this is a risk (2-3 sentences)",
      "suggestedRedline": "Specific alternative language the user could propose"
    }
  ]
}

Return a JSON object with this exact shape:
{
  "analysisVersion": "1.0",
  "contractSummary": "2-3 sentence overview of what this contract is and who the parties are.",
  "overallRiskScore": 0-10,
  "categories": [ ...array of 10 category objects above... ]
}

CONTRACT TEXT:
---
`;

const CHUNK_SIZE = 35000;
const CHUNK_OVERLAP = 2000;

function scoreToSeverity(score: number): string {
  if (score === 0) return "none";
  if (score <= 3) return "low";
  if (score <= 6) return "moderate";
  if (score <= 8) return "high";
  return "critical";
}

async function analyzeChunk(
  text: string,
  chunkLabel: string,
  retries = 1
): Promise<AnalysisResult> {
  const userMessage = `${CATEGORIES_PROMPT}${text}\n---\n${chunkLabel}`;

  const callClaude = async (): Promise<AnalysisResult> => {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const rawText = response.content.find((b) => b.type === "text")?.text ?? "";
    // Strip markdown code fences if Claude wraps the JSON
    const stripped = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    let parsed: AnalysisResult;
    try {
      parsed = JSON.parse(stripped) as AnalysisResult;
    } catch {
      console.error("Claude returned malformed JSON:", rawText.slice(0, 500));
      throw new Error("MALFORMED_JSON");
    }

    if (!parsed.categories || parsed.categories.length !== 10) {
      throw new Error("MALFORMED_JSON");
    }

    return parsed;
  };

  try {
    return await callClaude();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "MALFORMED_JSON") throw err;

    // Rate limit retry
    if (retries > 0 && (msg.includes("429") || msg.includes("529"))) {
      await new Promise((r) => setTimeout(r, 10000));
      return analyzeChunk(text, chunkLabel, retries - 1);
    }
    throw err;
  }
}

function mergeResults(results: AnalysisResult[]): AnalysisResult {
  if (results.length === 1) return results[0];

  const base = results[0];
  const merged: AnalysisResult = {
    analysisVersion: "1.0",
    contractSummary: results.map((r) => r.contractSummary).join(" "),
    overallRiskScore: 0,
    categories: [],
  };

  const categoryIds = base.categories.map((c) => c.categoryId);

  for (const catId of categoryIds) {
    const allCats = results
      .map((r) => r.categories.find((c) => c.categoryId === catId))
      .filter(Boolean) as SessionCategory[];

    const highestScore = Math.max(...allCats.map((c) => c.score));
    const allFlags: SessionFlag[] = [];
    const seenExcerpts = new Set<string>();

    for (const cat of allCats) {
      for (const flag of cat.flags) {
        if (!flag.excerpt) {
          console.warn(`WARN: empty excerpt in flagId ${flag.flagId}`);
          continue;
        }
        const duplicate = [...seenExcerpts].some(
          (e) => e.includes(flag.excerpt.slice(0, 50)) || flag.excerpt.includes(e.slice(0, 50))
        );
        if (!duplicate) {
          seenExcerpts.add(flag.excerpt);
          allFlags.push(flag);
        }
      }
    }

    merged.categories.push({
      categoryId: catId,
      label: allCats[0].label,
      score: highestScore,
      severity: scoreToSeverity(highestScore),
      summary: allCats.map((c) => c.summary).join(" "),
      flags: allFlags,
    });
  }

  const scores = merged.categories.map((c) => c.score);
  merged.overallRiskScore = Math.round(
    scores.reduce((a, b) => a + b, 0) / scores.length
  );

  return merged;
}

export async function analyzeContract(
  rawText: string
): Promise<{ result?: AnalysisResult; error?: string; largeDocument?: boolean }> {
  const chunks: string[] = [];

  if (rawText.length > CHUNK_SIZE) {
    let start = 0;
    while (start < rawText.length) {
      chunks.push(rawText.slice(start, start + CHUNK_SIZE));
      start += CHUNK_SIZE - CHUNK_OVERLAP;
    }
  } else {
    chunks.push(rawText);
  }

  const largeDocument = chunks.length > 3;

  try {
    const results: AnalysisResult[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const label =
        chunks.length > 1
          ? `(Analyzing section ${i + 1} of ${chunks.length})`
          : "";
      const result = await analyzeChunk(chunks[i], label);
      results.push(result);
    }

    const merged = mergeResults(results);
    return { result: merged, largeDocument };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "MALFORMED_JSON") {
      return { error: "Analysis returned malformed data. Please try again." };
    }
    if (msg.includes("429") || msg.includes("529")) {
      return { error: "Analysis service is busy — please try again in a minute." };
    }
    if (msg.includes("500")) {
      return { error: "Analysis service error. Please try again." };
    }
    return { error: "Analysis failed. Please try again." };
  }
}
