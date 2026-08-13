/**
 * Decision capture — the KAIRO-style "what did each agent decide, and why".
 *
 * Every substantial agent turn contains deliberate choices (a tech pick, an
 * approach, a fix). This extracts them into structured AgentDecisions: an
 * Anthropic-API pass when a key is present, a deterministic regex fallback
 * otherwise. The result is persisted per project and surfaced in the Observatory
 * Decision Explorer, the Timeline, and the Time-Travel Replay.
 */

export type DecisionCategory =
  | "architecture"
  | "design"
  | "implementation"
  | "fix"
  | "refactor"
  | "test"
  | "other";

export interface AgentDecision {
  id: string;
  projectId: string;
  chatId: string;
  agentId: string;
  agentRole: string;
  timestamp: number;
  turnIndex: number;
  traceId: string;
  category: DecisionCategory;
  title: string;
  reasoning: string;
  confidence: number; // 0–100
  alternatives: string[];
  filesCreated: string[];
  filesModified: string[];
  artifactNames: string[];
  memoryKeys: string[];
  upstreamDecisionIds: string[];
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
}

export interface DecisionStats {
  total: number;
  byAgent: Record<string, number>;
  byCategory: Record<string, number>;
  avgConfidence: number;
  topAlternatives: string[];
  criticalPath: string[];
}

const CATEGORIES: DecisionCategory[] = ["architecture", "design", "implementation", "fix", "refactor", "test", "other"];

type RawDecision = {
  category: DecisionCategory;
  title: string;
  reasoning: string;
  confidence: number;
  alternatives: string[];
  filesCreated: string[];
  filesModified: string[];
  artifactNames: string[];
};

const DECISION_MODEL = process.env.NOTCH_DECISION_MODEL || "claude-haiku-4-5-20251001";

const DECISION_EXTRACT_PROMPT = `You are analyzing an AI coding agent's turn output.
Extract all significant decisions the agent made. A decision is a deliberate choice
between alternatives — tech choices, architectural decisions, implementation approaches.

For each decision, output JSON with this exact shape:
{
  "decisions": [
    {
      "category": "architecture|design|implementation|fix|refactor|test|other",
      "title": "short label under 60 chars",
      "reasoning": "why the agent chose this (1-2 sentences)",
      "confidence": 85,
      "alternatives": ["other option 1", "other option 2"],
      "filesCreated": ["path/to/file.ts"],
      "filesModified": ["path/to/existing.ts"],
      "artifactNames": ["ComponentName", "functionName"]
    }
  ]
}

Rules:
- Only extract REAL decisions, not descriptions of what was done
- confidence: 90+ very sure, 70-89 reasonably sure, below 70 uncertain
- alternatives: what the agent explicitly considered OR obvious alternatives
- If no clear decisions, return {"decisions": []}
- Output ONLY valid JSON, no markdown, no explanation

Agent turn output to analyze:
`;

/**
 * Truncate to a word boundary with an ellipsis — never mid-word. A decision
 * title cut at a raw 60 chars reads as broken ("…Redis to store and"); cut at
 * the last whole word with an ellipsis reads as intentional.
 */
function clip(s: string, max = 60): string {
  const t = String(s ?? "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-]+$/, "") + "…";
}

/** Coerce one loose object from the model into a well-formed RawDecision. */
function normalizeRaw(d: Record<string, unknown>): RawDecision {
  const cat = String(d.category ?? "other") as DecisionCategory;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
  const conf = Number(d.confidence);
  return {
    category: CATEGORIES.includes(cat) ? cat : "other",
    title: clip(String(d.title ?? "")) || "decision",
    reasoning: String(d.reasoning ?? ""),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(100, Math.round(conf))) : 70,
    alternatives: arr(d.alternatives).slice(0, 6),
    filesCreated: arr(d.filesCreated),
    filesModified: arr(d.filesModified),
    artifactNames: arr(d.artifactNames).slice(0, 12),
  };
}

/** Parse the model's JSON reply (tolerating ```json fences) into RawDecisions. */
export function parseDecisionsJson(text: string): RawDecision[] {
  const cleaned = (text || "").replace(/```json|```/g, "").trim();
  if (!cleaned) return [];
  try {
    const parsed = JSON.parse(cleaned) as { decisions?: unknown };
    const list = Array.isArray(parsed?.decisions) ? parsed.decisions : [];
    return list.map((d) => normalizeRaw((d ?? {}) as Record<string, unknown>));
  } catch {
    return [];
  }
}

/**
 * Regex fallback — pull decisions from natural phrasings ("I'll use X because Y",
 * "Instead of X, I'll Y") when there's no API key or the model returned nothing.
 */
export function extractDecisionsRegex(text: string): RawDecision[] {
  const decisions: RawDecision[] = [];
  const base = { filesCreated: [] as string[], filesModified: [] as string[], artifactNames: [] as string[] };

  const usePattern = /I(?:'ll| will) (?:use|implement|create|build|add|go with|adopt) ([^.]+?) (?:because|since|as|so that) ([^.]+)\./gi;
  let m: RegExpExecArray | null;
  while ((m = usePattern.exec(text)) !== null) {
    decisions.push({ ...base, category: "implementation", title: clip(m[1]!), reasoning: m[2]!.trim(), confidence: 75, alternatives: [] });
  }

  const insteadPattern = /[Ii]nstead of ([^,]+), I(?:'ll| will) ([^.]+)\./g;
  while ((m = insteadPattern.exec(text)) !== null) {
    decisions.push({ ...base, category: "implementation", title: clip(m[2]!), reasoning: `Preferred over: ${m[1]!.trim()}`, confidence: 80, alternatives: [m[1]!.trim()] });
  }

  const choosePattern = /I(?:'ve| have)? (?:chose|decided|opted|picked)(?: to| for)? ([^.]+?)(?: (?:because|since|to) ([^.]+))?\./gi;
  while ((m = choosePattern.exec(text)) !== null) {
    decisions.push({ ...base, category: "implementation", title: clip(m[1]!), reasoning: (m[2] ?? "chosen approach").trim(), confidence: 78, alternatives: [] });
  }

  return decisions.slice(0, 5);
}

/** Call the Anthropic API to extract decisions; empty on any failure. */
async function llmExtract(turnText: string, apiKey: string): Promise<RawDecision[]> {
  if (typeof globalThis.fetch !== "function") return [];
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: DECISION_MODEL,
        max_tokens: 1000,
        messages: [{ role: "user", content: DECISION_EXTRACT_PROMPT + turnText.slice(0, 3000) }],
      }),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = (j.content ?? []).map((c) => c.text ?? "").join("").trim();
    return parseDecisionsJson(text);
  } catch {
    return [];
  }
}

export interface ExtractOpts {
  agentId: string;
  agentRole: string;
  projectId: string;
  chatId: string;
  turnIndex: number;
  traceId: string;
  turnText: string;
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
  filesChanged: string[];
  anthropicApiKey?: string;
}

/** Extract structured decisions from one completed turn. */
export async function extractDecisions(opts: ExtractOpts): Promise<AgentDecision[]> {
  const { turnText, filesChanged, anthropicApiKey } = opts;
  // Skip trivial turns (greetings, acknowledgements).
  if ((turnText ?? "").trim().length < 100) return [];

  let raw: RawDecision[] = [];
  if (anthropicApiKey) raw = await llmExtract(turnText, anthropicApiKey);
  if (raw.length === 0) raw = extractDecisionsRegex(turnText);

  const changed = new Set(filesChanged);
  const now = Date.now();
  return raw.map((d, i) => ({
    id: `${opts.projectId}-${opts.chatId}-t${opts.turnIndex}-d${i}-${now}`,
    projectId: opts.projectId,
    chatId: opts.chatId,
    agentId: opts.agentId,
    agentRole: opts.agentRole,
    timestamp: now,
    turnIndex: opts.turnIndex,
    traceId: opts.traceId,
    category: d.category,
    title: d.title,
    reasoning: d.reasoning,
    confidence: d.confidence,
    alternatives: d.alternatives,
    // Only keep file claims the turn actually changed (when we know the diff).
    filesCreated: changed.size ? d.filesCreated.filter((f) => changed.has(f)) : d.filesCreated,
    filesModified: changed.size ? d.filesModified.filter((f) => changed.has(f)) : d.filesModified,
    artifactNames: d.artifactNames,
    memoryKeys: [],
    upstreamDecisionIds: [],
    tokensUsed: opts.tokensUsed,
    costUsd: opts.costUsd,
    durationMs: opts.durationMs,
  }));
}

/** Roll up decisions for the Explorer header + KAIRO metrics. */
export function decisionStats(decisions: AgentDecision[]): DecisionStats {
  const byAgent: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const altCounts = new Map<string, number>();
  let confSum = 0;
  for (const d of decisions) {
    byAgent[d.agentId] = (byAgent[d.agentId] ?? 0) + 1;
    byCategory[d.category] = (byCategory[d.category] ?? 0) + 1;
    confSum += d.confidence;
    for (const a of d.alternatives) altCounts.set(a, (altCounts.get(a) ?? 0) + 1);
  }
  const topAlternatives = [...altCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a]) => a);
  // Critical path = the ordered chain of agents that made decisions (deduped runs).
  const chain: string[] = [];
  for (const d of [...decisions].sort((a, b) => a.timestamp - b.timestamp)) {
    if (chain[chain.length - 1] !== d.agentId) chain.push(d.agentId);
  }
  return {
    total: decisions.length,
    byAgent,
    byCategory,
    avgConfidence: decisions.length ? Math.round(confSum / decisions.length) : 0,
    topAlternatives,
    criticalPath: chain.slice(0, 8),
  };
}
