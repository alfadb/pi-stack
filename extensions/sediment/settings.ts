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
  extractorMaxCandidates: 3,
  extractorAuditRawChars: 1_000,
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
  };
}
