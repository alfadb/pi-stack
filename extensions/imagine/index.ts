/**
 * imagine extension for pi-stack — AI image generation via OpenAI Responses API.
 *
 * Rewritten 2026-05-07 to piggyback on the user's existing openai provider
 * configuration. No model registration, no custom provider, no piStack config
 * needed — just uses pi's native modelRegistry to:
 *   1. getApiKeyForProvider("openai") → API key
 *   2. Find openai-responses model → get baseUrl (the Responses API endpoint)
 *   3. Call POST {baseUrl}/v1/responses with image_generation_call
 *
 * No extra config: key and baseUrl both come from the openai provider — the
 * same one your chat models use. If you've pointed openai at a proxy, images
 * go through the same proxy automatically.
 *
 * Output: PNG saved to <cwd>/.pi-stack/imagine/, returned inline (base64) when
 * the caller's model supports image input.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

// ── Constants ───────────────────────────────────────────────────

/** Persistent output directory under the project root. Each extension owns
 *  its own subdirectory under .pi-stack/ for clean separation. The whole
 *  .pi-stack/ tree should be in the project's .gitignore. */
const OUTPUT_DIR = path.join(".pi-stack", "imagine");
const ALLOWED_SIZES = ["1024x1024", "1792x1024", "1024x1792"] as const;
const ALLOWED_QUALITIES = ["standard", "hd"] as const;
const ALLOWED_STYLES = ["vivid", "natural"] as const;

// ── Output path ─────────────────────────────────────────────────

async function makeOutputPath(cwd: string): Promise<string> {
  const outDir = path.join(cwd || os.homedir(), OUTPUT_DIR);
  await fs.mkdir(outDir, { recursive: true });
  const suffix = crypto.randomBytes(4).toString("hex");
  const filename = `image-${Date.now()}-${suffix}.png`;
  return path.join(outDir, filename);
}

// ── Core image generation ───────────────────────────────────────

interface ImagineParams {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  style?: string;
}

async function generateImage(
  params: ImagineParams,
  opts: {
    cwd: string;
    callerSupportsImages: boolean;
    signal?: AbortSignal;
    baseUrl: string;
    apiKey: string;
  },
) {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");

  // Style is encoded into the prompt — the Responses image_generation_call
  // path does not accept a style API parameter.
  const styledPrompt = params.style
    ? `${params.prompt}\n\n[Style: ${params.style}]`
    : params.prompt;

  const reqBody: Record<string, unknown> = {
    model: params.model || "gpt-image-2",
    input: styledPrompt,
  };
  if (params.size) reqBody.size = params.size;
  if (params.quality) reqBody.quality = params.quality;

  const url = `${baseUrl}/v1/responses`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(reqBody),
      signal: opts.signal,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Image generation network error: ${msg}` };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown");
    return {
      ok: false,
      error: `Image generation HTTP ${response.status}: ${errText.slice(0, 500)}`,
    };
  }

  const data = (await response.json()) as Record<string, unknown>;

  let imageBase64 = "";
  let actualSize: string | undefined;
  let actualQuality: string | undefined;

  const output = data?.output as Array<Record<string, unknown>> | undefined;
  for (const item of output ?? []) {
    if (item.type === "image_generation_call" && item.result) {
      imageBase64 = item.result as string;
      actualSize = item.size as string | undefined;
      actualQuality = item.quality as string | undefined;
      break;
    }
  }

  if (!imageBase64) {
    return { ok: false, error: "No image data in API response." };
  }

  const filepath = await makeOutputPath(opts.cwd);
  try {
    await fs.writeFile(filepath, Buffer.from(imageBase64, "base64"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Failed to save image to disk: ${msg}` };
  }

  return {
    ok: true,
    filepath,
    model: reqBody.model as string,
    requestedSize: params.size,
    actualSize,
    requestedQuality: params.quality,
    actualQuality,
    ...(opts.callerSupportsImages
      ? { imageBase64, mimeType: "image/png" as const }
      : {}),
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).toLowerCase() as T;
  if (allowed.some((a) => a.toLowerCase() === s.toLowerCase())) return s;
  throw new Error(
    `Invalid ${label} "${String(value)}". Allowed: ${allowed.join(", ")}`,
  );
}

// ── Extension entry ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "imagine",
    label: "AI Image Generation",
    description:
      "Generate images using gpt-image-2 via the OpenAI Responses API. " +
      "Call when the user asks to create, generate, or draw an image. " +
      "Uses your existing openai provider API key and endpoint — no extra config.",
    promptSnippet: "imagine(prompt, size?, quality?, style?, model?)",
    promptGuidelines: [
      "Use imagine when the user asks for image generation, illustration, or visual creation.",
      "Model is always gpt-image-2. Default quality is hd. Default size is 1024x1024.",
      "Uses your existing openai provider API key — no additional configuration needed.",
      "The tool saves the PNG to .pi-stack/imagine/ and returns it inline when the caller supports images.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "Image description/prompt — be detailed and specific",
      }),
      model: Type.Optional(Type.String({
        description: "Image model (always gpt-image-2)",
      })),
      size: Type.Optional(Type.String({
        description: "Image dimensions: 1024x1024, 1792x1024, or 1024x1792",
      })),
      quality: Type.Optional(Type.String({
        description: "Quality level: standard or hd (default)",
      })),
      style: Type.Optional(Type.String({
        description: "Style hint: vivid (hyper-real, dramatic) or natural (realistic, subdued)",
      })),
    }),

    prepareArguments(args: Record<string, unknown>) {
      return {
        prompt: String(args.prompt ?? ""),
        model: args.model ? String(args.model) : undefined,
        size: validateEnum(args.size, ALLOWED_SIZES, "size"),
        quality: validateEnum(args.quality, ALLOWED_QUALITIES, "quality"),
        style: validateEnum(args.style, ALLOWED_STYLES, "style"),
      };
    },

    async execute(
      _id: string,
      params: ImagineParams,
      signal: AbortSignal,
      _onUpdate: unknown,
      ctx: {
        cwd: string;
        model?: { input?: string[] };
        modelRegistry: {
          getAll(): Array<{ provider: string; baseUrl: string; api: string }>;
          getApiKeyForProvider(provider: string): Promise<string | undefined>;
        };
      },
    ) {
      // ── Key + baseUrl both from the existing openai provider ─
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("openai");
      if (!apiKey) {
        return {
          content: [{
            type: "text" as const,
            text:
              "❌ No API key configured for the openai provider. " +
              "imagine uses your existing openai provider — the same one your chat models use. " +
              "Configure an API key for the openai provider to enable image generation.",
          }],
          details: { error: "no openai API key" },
          isError: true,
        };
      }

      // Derive the image generation endpoint from the openai provider baseUrl.
      // The provider may use a completions-style baseUrl (https://x.com/v1) or
      // a responses-style one (https://x.com). We need the host root + /v1/responses.
      // Strip /v1 suffix if present to avoid double /v1.
      const allModels = ctx.modelRegistry.getAll();
      const anyOpenai = allModels.find((m) => m.provider === "openai");
      const raw = anyOpenai?.baseUrl || "https://api.openai.com";
      // Remove trailing slashes, then strip /v1 if it's the last path segment
      const baseUrl = raw.replace(/\/+$/, "").replace(/\/v1$/, "");

      // ── Generate ──────────────────────────────────────────
      const callerSupportsImages = !!ctx.model?.input?.includes?.("image");

      const result = await generateImage(params, {
        cwd: ctx.cwd,
        callerSupportsImages,
        signal,
        baseUrl,
        apiKey,
      });

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `❌ ${result.error}` }],
          details: { error: result.error },
          isError: true,
        };
      }

      const sizeInfo = result.actualSize ?? result.requestedSize ?? "default";
      const qualityInfo = result.actualQuality ?? result.requestedQuality ?? "default";
      const text =
        `✅ Image saved: ${result.filepath}\n` +
        `Model: ${result.model} | Size: ${sizeInfo} | Quality: ${qualityInfo}`;

      const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
        { type: "text", text },
      ];
      if (result.imageBase64 && result.mimeType) {
        content.push({
          type: "image",
          data: result.imageBase64,
          mimeType: result.mimeType,
        });
      }

      return {
        content,
        details: {
          model: result.model,
          requestedSize: result.requestedSize,
          actualSize: result.actualSize,
          requestedQuality: result.requestedQuality,
          actualQuality: result.actualQuality,
          path: result.filepath,
        },
      };
    },
  });
}
