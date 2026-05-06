/**
 * pi-sediment config — model resolution.
 *
 * Default model: deepseek/deepseek-v4-pro
 * Default reasoning: high
 *
 * Override priority (high → low):
 *   1. env: PI_SEDIMENT_MODEL / PI_SEDIMENT_REASONING
 *   2. project: .pi-sediment/config.json → model / reasoning
 *   3. default: deepseek/deepseek-v4-pro / high
 *
 * Reasoning was xhigh during the single-call era when the model had to do all
 * eval-and-write reasoning in one shot. With the agent loop the model
 * iterates with tool feedback, so each turn needs less depth; xhigh on every
 * turn doubled wallclock for negligible quality gain (observed: 2.5 min per
 * SKIP decision with 5-8 turns, vs ~30s on high).
 *
 * Hot-reloaded on every agent_end so users can tweak without restart.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export type ReasoningLevel = "off" | "high" | "xhigh";

export interface SedimentConfig {
  model: ModelRef;
  reasoning: ReasoningLevel;
  evalTimeoutMs: number;
  writeTimeoutMs: number;
}

const DEFAULT_MODEL: ModelRef = {
  provider: "deepseek",
  modelId: "deepseek-v4-pro",
};

const DEFAULT_REASONING: ReasoningLevel = "high";

// ── Helpers ────────────────────────────────────────────────────

function parseModelRef(s: string | undefined | null): ModelRef | null {
  if (!s || typeof s !== "string") return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

function readJsonSafe(p: string): any {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}

// ── Public ─────────────────────────────────────────────────────

export function formatModelRef(r: ModelRef): string {
  return `${r.provider}/${r.modelId}`;
}

export function loadConfig(projectRoot: string): SedimentConfig {
  // 1. env
  const envRef = parseModelRef(process.env.PI_SEDIMENT_MODEL);

  // 2. project config
  const projectConfig = readJsonSafe(path.join(projectRoot, ".pi-sediment", "config.json"));
  const projectRef = parseModelRef(projectConfig?.model);

  // 3. reasoning: env > config > default
  const envReasoning = parseReasoning(process.env.PI_SEDIMENT_REASONING);
  const configReasoning = parseReasoning(projectConfig?.reasoning);
  const reasoning = envReasoning ?? configReasoning ?? DEFAULT_REASONING;

  // 4. default
  const model = envRef ?? projectRef ?? DEFAULT_MODEL;

  return {
    model,
    reasoning,
    evalTimeoutMs: 60_000,
    writeTimeoutMs: 300_000,
  };
}

function parseReasoning(s: string | undefined | null): ReasoningLevel | null {
  if (!s || typeof s !== "string") return null;
  const trimmed = s.trim().toLowerCase();
  if (trimmed === "off" || trimmed === "high" || trimmed === "xhigh") {
    return trimmed as ReasoningLevel;
  }
  return null;
}
