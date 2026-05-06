/**
 * sediment/config — runtime configuration loader.
 *
 * Resolves config from (highest precedence first):
 *   1. environment variables (PI_STACK_SEDIMENT_*)
 *   2. ~/.pi/agent/settings.json → piStack.sediment.{tracks,...}
 *   3. defaults from this module
 *
 * Two-track schema:
 *   piStack.sediment.tracks.project.{model,reasoning,enabled,...}
 *   piStack.sediment.tracks.world.{model,reasoning,enabled,...}
 *
 * Backward compat: if `piStack.sediment.singleAgent.{model,reasoning}` is
 * set, both tracks inherit those values unless overridden per-track.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type Reasoning = "off" | "high" | "xhigh";

export interface PerTrackConfig {
  enabled: boolean;
  modelProvider: string;
  modelId: string;
  reasoning: Reasoning;
  maxTokens: number;
  timeoutMs: number;
}

export interface SedimentConfig {
  /** Hard ceiling on full sediment turn (ms); track timeouts are softer. */
  totalTimeoutMs: number;
  /** Skip if window is smaller than this (chars). */
  minWindowChars: number;
  /** Per-track config; both run in parallel each agent_end. */
  tracks: {
    project: PerTrackConfig;
    world: PerTrackConfig;
  };
}

const DEFAULT_TRACK: PerTrackConfig = {
  enabled: true,
  modelProvider: "deepseek",
  modelId: "deepseek-v4-pro",
  reasoning: "high",
  maxTokens: 16384,
  timeoutMs: 180_000,
};

const DEFAULT_CONFIG: SedimentConfig = {
  totalTimeoutMs: 240_000,
  minWindowChars: 200,
  tracks: {
    project: { ...DEFAULT_TRACK },
    world: { ...DEFAULT_TRACK },
  },
};

function readSettingsFile(): any {
  const home = process.env.HOME ?? "/tmp";
  const settingsPath = path.join(home, ".pi", "agent", "settings.json");
  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    return JSON.parse(raw);
  } catch { return null; }
}

function pickModel(modelRef: string | undefined, fallback: { provider: string; id: string }): { provider: string; id: string } {
  if (!modelRef || typeof modelRef !== "string") return fallback;
  const slash = modelRef.indexOf("/");
  if (slash === -1) return fallback;
  return { provider: modelRef.slice(0, slash), id: modelRef.slice(slash + 1) };
}

function applyOverrides(track: PerTrackConfig, override: any): PerTrackConfig {
  if (!override || typeof override !== "object") return track;
  const out = { ...track };
  if (typeof override.enabled === "boolean") out.enabled = override.enabled;
  if (typeof override.model === "string") {
    const { provider, id } = pickModel(override.model, { provider: out.modelProvider, id: out.modelId });
    out.modelProvider = provider;
    out.modelId = id;
  }
  if (override.reasoning === "off" || override.reasoning === "high" || override.reasoning === "xhigh") {
    out.reasoning = override.reasoning;
  }
  if (typeof override.maxTokens === "number" && override.maxTokens > 0) out.maxTokens = override.maxTokens;
  if (typeof override.timeoutMs === "number" && override.timeoutMs > 0) out.timeoutMs = override.timeoutMs;
  return out;
}

export function loadSedimentConfig(): SedimentConfig {
  const cfg: SedimentConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  const settings = readSettingsFile();
  const sedimentSettings = settings?.piStack?.sediment ?? {};

  // Backward compat: singleAgent block sets the baseline for both tracks
  const singleAgent = sedimentSettings.singleAgent;
  if (singleAgent) {
    cfg.tracks.project = applyOverrides(cfg.tracks.project, singleAgent);
    cfg.tracks.world = applyOverrides(cfg.tracks.world, singleAgent);
    if (typeof singleAgent.minWindowChars === "number") cfg.minWindowChars = singleAgent.minWindowChars;
  }

  // Top-level overrides (apply to both tracks if not specified per-track)
  if (typeof sedimentSettings.minWindowChars === "number") cfg.minWindowChars = sedimentSettings.minWindowChars;
  if (typeof sedimentSettings.totalTimeoutMs === "number") cfg.totalTimeoutMs = sedimentSettings.totalTimeoutMs;

  // Per-track overrides (highest specificity in the JSON layer)
  const tracks = sedimentSettings.tracks ?? {};
  cfg.tracks.project = applyOverrides(cfg.tracks.project, tracks.project);
  cfg.tracks.world = applyOverrides(cfg.tracks.world, tracks.world);

  // Tier 1: env-var overrides (apply to both tracks for ad-hoc testing)
  const envModel = process.env.PI_STACK_SEDIMENT_MODEL;
  if (envModel) {
    const { provider, id } = pickModel(envModel, { provider: cfg.tracks.world.modelProvider, id: cfg.tracks.world.modelId });
    cfg.tracks.project.modelProvider = provider;
    cfg.tracks.project.modelId = id;
    cfg.tracks.world.modelProvider = provider;
    cfg.tracks.world.modelId = id;
  }
  const envReasoning = process.env.PI_STACK_SEDIMENT_REASONING;
  if (envReasoning === "off" || envReasoning === "high" || envReasoning === "xhigh") {
    cfg.tracks.project.reasoning = envReasoning;
    cfg.tracks.world.reasoning = envReasoning;
  }
  const envTimeout = Number(process.env.PI_STACK_SEDIMENT_TIMEOUT_MS);
  if (Number.isFinite(envTimeout) && envTimeout > 0) {
    cfg.tracks.project.timeoutMs = envTimeout;
    cfg.tracks.world.timeoutMs = envTimeout;
  }

  // Per-track env overrides
  const envProjectModel = process.env.PI_STACK_SEDIMENT_PROJECT_MODEL;
  if (envProjectModel) {
    const { provider, id } = pickModel(envProjectModel, { provider: cfg.tracks.project.modelProvider, id: cfg.tracks.project.modelId });
    cfg.tracks.project.modelProvider = provider;
    cfg.tracks.project.modelId = id;
  }
  const envWorldModel = process.env.PI_STACK_SEDIMENT_WORLD_MODEL;
  if (envWorldModel) {
    const { provider, id } = pickModel(envWorldModel, { provider: cfg.tracks.world.modelProvider, id: cfg.tracks.world.modelId });
    cfg.tracks.world.modelProvider = provider;
    cfg.tracks.world.modelId = id;
  }

  return cfg;
}
