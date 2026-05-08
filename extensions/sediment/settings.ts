import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asBoolean, asNumber } from "../memory/settings";

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

export interface SedimentSettings {
  enabled: boolean;
  gitCommit: boolean;
  lockTimeoutMs: number;
  defaultConfidence: number;
  minWindowChars: number;
  maxWindowChars: number;
  maxWindowEntries: number;
  extractorModel: string;
  extractorTimeoutMs: number;
  extractorMaxRetries: number;
  extractorMaxCandidates: number;
  extractorAuditRawChars: number;
  autoLlmWriteEnabled: boolean;
  minDryRunSamples: number;
  requiredDryRunPassRate: number;
  // Phase 1.4 LLM auto-write content gates. These shape the
  // `DraftPolicy` passed into `validateProjectEntryDraft` and the
  // `forceProvisional` knob in `writeProjectEntry` whenever sediment
  // takes the LLM auto-write lane (NOT for explicit MEMORY: blocks,
  // which are user-attested and pass through without policy overlay).
  // Defaults are intentionally strict; relaxing them widens the LLM's
  // attack/error surface.
  autoWriteForceProvisional: boolean;
  autoWriteDisallowMaxim: boolean;
  autoWriteDisallowArchived: boolean;
  autoWriteMaxConfidence: number;
  // Soft near-duplicate gate (added 2026-05-08). When true, the LLM
  // auto-write lane rejects candidates whose title shares a rare
  // technical token + high char-trigram overlap + same kind with an
  // existing entry, even if word-trigram jaccard < 0.7. Hard
  // duplicates (slug_exact, word-trigram >= 0.7) are always rejected
  // regardless of this flag. See dedupe.ts for the full rule.
  autoWriteDisallowNearDuplicate: boolean;
  // Operational throttles for the auto-write lane. These all live
  // *after* the readiness gate (autoLlmWriteEnabled + dry-run pass
  // rate) and the content gates (autoWrite*). They cap how often the
  // lane fires once it has cleared the gates.
  autoWriteSampleEveryNRuns: number;
  autoWriteMaxPerHour: number;
  autoWriteRollingWindowSamples: number;
  autoWriteRollingPassRate: number;
  autoWriteRawAuditChars: number;
}

export const DEFAULT_SEDIMENT_SETTINGS: SedimentSettings = {
  enabled: false,
  gitCommit: true,
  lockTimeoutMs: 5_000,
  defaultConfidence: 3,
  minWindowChars: 200,
  maxWindowChars: 200_000,
  maxWindowEntries: 200,
  extractorModel: "deepseek/deepseek-v4-pro",
  extractorTimeoutMs: 180_000,
  extractorMaxRetries: 0,
  // Cap raised from 3 to 5 (2026-05-08): the LLM extractor prompt
  // now requests “at most TWO MEMORY blocks per response”, so a
  // healthy run produces 1–2 candidates and a slightly noisy run
  // produces 3–4. Cap=3 was tripping `too_many_candidates` on those
  // mildly-noisy runs and pushing the rolling-quality gate below
  // threshold for no real reason. Cap=5 still catches true runaway
  // (LLM ignoring the prompt entirely) without flagging benign
  // overshoot.
  extractorMaxCandidates: 5,
  extractorAuditRawChars: 1_000,
  autoLlmWriteEnabled: false,
  minDryRunSamples: 20,
  requiredDryRunPassRate: 0.9,
  autoWriteForceProvisional: true,
  autoWriteDisallowMaxim: true,
  autoWriteDisallowArchived: true,
  autoWriteMaxConfidence: 6,
  autoWriteDisallowNearDuplicate: true,
  autoWriteSampleEveryNRuns: 1,
  autoWriteMaxPerHour: 6,
  // Window raised from 20 to 30 (2026-05-08): a single auto_write
  // failure swung the rolling rate by 5% on a 20-window, which made
  // the gate trip after 4 imperfect rows even when the prior 14 dry-
  // runs were all clean. 30-window halves single-row impact and
  // smooths the signal across roughly the most-recent agent-end day
  // of activity.
  autoWriteRollingWindowSamples: 30,
  autoWriteRollingPassRate: 0.85,
  autoWriteRawAuditChars: 8_000,
};

function loadPiStackSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fsSync.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function resolveSedimentSettings(): SedimentSettings {
  const root = loadPiStackSettings();
  const cfg = (root.sediment as Record<string, unknown>) ?? {};
  return {
    enabled: asBoolean(cfg.enabled, DEFAULT_SEDIMENT_SETTINGS.enabled),
    gitCommit: asBoolean(cfg.gitCommit, DEFAULT_SEDIMENT_SETTINGS.gitCommit),
    lockTimeoutMs: Math.max(100, asNumber(cfg.lockTimeoutMs, DEFAULT_SEDIMENT_SETTINGS.lockTimeoutMs)),
    defaultConfidence: Math.min(10, Math.max(0, asNumber(cfg.defaultConfidence, DEFAULT_SEDIMENT_SETTINGS.defaultConfidence))),
    minWindowChars: Math.max(0, asNumber(cfg.minWindowChars, DEFAULT_SEDIMENT_SETTINGS.minWindowChars)),
    maxWindowChars: Math.max(1_000, asNumber(cfg.maxWindowChars, DEFAULT_SEDIMENT_SETTINGS.maxWindowChars)),
    maxWindowEntries: Math.max(1, Math.floor(asNumber(cfg.maxWindowEntries, DEFAULT_SEDIMENT_SETTINGS.maxWindowEntries))),
    extractorModel: typeof cfg.extractorModel === "string" && cfg.extractorModel.trim()
      ? cfg.extractorModel.trim()
      : DEFAULT_SEDIMENT_SETTINGS.extractorModel,
    extractorTimeoutMs: Math.max(1_000, asNumber(cfg.extractorTimeoutMs, DEFAULT_SEDIMENT_SETTINGS.extractorTimeoutMs)),
    extractorMaxRetries: Math.max(0, Math.floor(asNumber(cfg.extractorMaxRetries, DEFAULT_SEDIMENT_SETTINGS.extractorMaxRetries))),
    extractorMaxCandidates: Math.max(1, Math.floor(asNumber(cfg.extractorMaxCandidates, DEFAULT_SEDIMENT_SETTINGS.extractorMaxCandidates))),
    extractorAuditRawChars: Math.max(0, Math.floor(asNumber(cfg.extractorAuditRawChars, DEFAULT_SEDIMENT_SETTINGS.extractorAuditRawChars))),
    autoLlmWriteEnabled: asBoolean(cfg.autoLlmWriteEnabled, DEFAULT_SEDIMENT_SETTINGS.autoLlmWriteEnabled),
    minDryRunSamples: Math.max(1, Math.floor(asNumber(cfg.minDryRunSamples, DEFAULT_SEDIMENT_SETTINGS.minDryRunSamples))),
    requiredDryRunPassRate: Math.min(1, Math.max(0, asNumber(cfg.requiredDryRunPassRate, DEFAULT_SEDIMENT_SETTINGS.requiredDryRunPassRate))),
    autoWriteForceProvisional: asBoolean(cfg.autoWriteForceProvisional, DEFAULT_SEDIMENT_SETTINGS.autoWriteForceProvisional),
    autoWriteDisallowMaxim: asBoolean(cfg.autoWriteDisallowMaxim, DEFAULT_SEDIMENT_SETTINGS.autoWriteDisallowMaxim),
    autoWriteDisallowArchived: asBoolean(cfg.autoWriteDisallowArchived, DEFAULT_SEDIMENT_SETTINGS.autoWriteDisallowArchived),
    autoWriteMaxConfidence: Math.min(10, Math.max(0, asNumber(cfg.autoWriteMaxConfidence, DEFAULT_SEDIMENT_SETTINGS.autoWriteMaxConfidence))),
    autoWriteDisallowNearDuplicate: asBoolean(cfg.autoWriteDisallowNearDuplicate, DEFAULT_SEDIMENT_SETTINGS.autoWriteDisallowNearDuplicate),
    autoWriteSampleEveryNRuns: Math.max(1, Math.floor(asNumber(cfg.autoWriteSampleEveryNRuns, DEFAULT_SEDIMENT_SETTINGS.autoWriteSampleEveryNRuns))),
    autoWriteMaxPerHour: Math.max(0, Math.floor(asNumber(cfg.autoWriteMaxPerHour, DEFAULT_SEDIMENT_SETTINGS.autoWriteMaxPerHour))),
    autoWriteRollingWindowSamples: Math.max(1, Math.floor(asNumber(cfg.autoWriteRollingWindowSamples, DEFAULT_SEDIMENT_SETTINGS.autoWriteRollingWindowSamples))),
    autoWriteRollingPassRate: Math.min(1, Math.max(0, asNumber(cfg.autoWriteRollingPassRate, DEFAULT_SEDIMENT_SETTINGS.autoWriteRollingPassRate))),
    autoWriteRawAuditChars: Math.max(0, Math.floor(asNumber(cfg.autoWriteRawAuditChars, DEFAULT_SEDIMENT_SETTINGS.autoWriteRawAuditChars))),
  };
}
