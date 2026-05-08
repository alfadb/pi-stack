import * as crypto from "node:crypto";
import type { SedimentSettings } from "./settings";
import { parseExplicitMemoryBlocks, previewExtraction } from "./extractor";

interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

export interface LlmExtractorDryRunResult {
  ok: boolean;
  model: string;
  stopReason?: string;
  error?: string;
  rawText?: string;
  extraction?: ReturnType<typeof previewExtraction>;
}

export interface LlmExtractorQualityGate {
  passed: boolean;
  reason: "skip" | "valid_candidates" | "model_error" | "unparseable_output" | "validation_errors" | "too_many_candidates";
  candidateCount: number;
  validationErrorCount: number;
  invalidCandidateCount: number;
  rawTextSha256?: string;
  rawTextPreview?: string;
  rawTextTruncated?: boolean;
}

export interface LlmExtractorAuditSummary {
  ok: boolean;
  model: string;
  stopReason?: string;
  error?: string;
  quality: LlmExtractorQualityGate;
  extraction?: ReturnType<typeof previewExtraction>;
}

function parseModelRef(ref: string): { provider: string; id: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export function buildLlmExtractorPrompt(windowText: string): string {
  return [
    "You are pi-astack sediment extractor in DRY-RUN mode.",
    "Your task: inspect the transcript window and extract only reusable project knowledge.",
    "If there is no durable, reusable insight, output exactly: SKIP",
    "",
    "If there is a candidate, output one or more blocks in this exact format:",
    "MEMORY:",
    "title: Short Descriptive Title",
    "kind: fact|pattern|anti-pattern|decision|maxim|preference|smell",
    "confidence: 3",
    "---",
    "# Short Descriptive Title",
    "",
    "Compiled truth body. Include boundaries and evidence when relevant.",
    "END_MEMORY",
    "",
    "Rules:",
    "- Do not invent facts. Prefer SKIP when uncertain.",
    "- Do not include secrets, API keys, private hostnames, emails, or absolute home paths.",
    "- Do not output JSON or code fences.",
    "- Keep project-specific details only when they are necessary for project memory.",
    "",
    "Transcript window:",
    "<<<PI_SEDIMENT_WINDOW",
    windowText,
    "PI_SEDIMENT_WINDOW>>>",
  ].join("\n");
}

function hashRaw(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function summarizeLlmExtractorDryRun(
  result: LlmExtractorDryRunResult,
  opts: { maxCandidates: number; rawPreviewChars: number },
): LlmExtractorAuditSummary {
  const raw = result.rawText ?? "";
  const extraction = result.extraction;
  const candidateCount = extraction?.count ?? 0;
  const validationErrorCount = extraction?.drafts.reduce((sum, draft) => sum + draft.validationErrors.length, 0) ?? 0;
  const invalidCandidateCount = extraction?.drafts.filter((draft) => draft.validationErrors.length > 0).length ?? 0;

  let reason: LlmExtractorQualityGate["reason"];
  let passed = false;
  if (!result.ok) reason = "model_error";
  else if (!raw || raw === "SKIP") { reason = "skip"; passed = true; }
  else if (candidateCount === 0) reason = "unparseable_output";
  else if (candidateCount > opts.maxCandidates) reason = "too_many_candidates";
  else if (validationErrorCount > 0) reason = "validation_errors";
  else { reason = "valid_candidates"; passed = true; }

  const rawTextPreview = opts.rawPreviewChars > 0 && raw
    ? raw.slice(0, opts.rawPreviewChars)
    : undefined;

  return {
    ok: result.ok,
    model: result.model,
    stopReason: result.stopReason,
    error: result.error,
    extraction,
    quality: {
      passed,
      reason,
      candidateCount,
      validationErrorCount,
      invalidCandidateCount,
      ...(raw ? { rawTextSha256: hashRaw(raw) } : {}),
      ...(rawTextPreview !== undefined ? { rawTextPreview } : {}),
      ...(raw ? { rawTextTruncated: raw.length > opts.rawPreviewChars } : {}),
    },
  };
}

export async function runLlmExtractorDryRun(
  windowText: string,
  deps: {
    settings: SedimentSettings;
    modelRegistry: ModelRegistryLike;
    signal?: AbortSignal;
  },
): Promise<LlmExtractorDryRunResult> {
  const parsed = parseModelRef(deps.settings.extractorModel);
  if (!parsed) {
    return { ok: false, model: deps.settings.extractorModel, error: "invalid extractorModel; expected provider/model" };
  }

  const model = deps.modelRegistry.find(parsed.provider, parsed.id);
  if (!model) {
    return { ok: false, model: deps.settings.extractorModel, error: "extractor model not found in registry" };
  }

  const auth = await deps.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return { ok: false, model: deps.settings.extractorModel, error: auth.error || "extractor model auth unavailable" };
  }

  const piAi: {
    streamSimple(
      model: unknown,
      opts: { messages: unknown[] },
      config: { apiKey: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; maxRetries?: number },
    ): { result(): Promise<{ stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> }> };
  } = await import("@mariozechner/pi-ai");

  const prompt = buildLlmExtractorPrompt(windowText);
  const stream = piAi.streamSimple(
    model,
    {
      messages: [{
        role: "user",
        content: [{ type: "text", text: prompt }],
        timestamp: Date.now(),
      }],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: deps.signal,
      timeoutMs: deps.settings.extractorTimeoutMs,
      maxRetries: deps.settings.extractorMaxRetries,
    },
  );

  const finalMsg = await stream.result();
  if (finalMsg.stopReason === "error" || finalMsg.stopReason === "aborted") {
    return {
      ok: false,
      model: deps.settings.extractorModel,
      stopReason: finalMsg.stopReason,
      error: finalMsg.errorMessage || finalMsg.stopReason,
    };
  }

  const rawText = (finalMsg.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();

  if (!rawText || rawText === "SKIP") {
    return { ok: true, model: deps.settings.extractorModel, stopReason: finalMsg.stopReason, rawText: rawText || "SKIP", extraction: previewExtraction([]) };
  }

  const drafts = parseExplicitMemoryBlocks(rawText);
  return {
    ok: true,
    model: deps.settings.extractorModel,
    stopReason: finalMsg.stopReason,
    rawText,
    extraction: previewExtraction(drafts),
  };
}
