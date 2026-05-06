/**
 * pi-sediment Pensieve writer — agent loop with read-only knowledge probes.
 *
 * The model is given the assistant turn plus a tool set that can grep/read
 * .pensieve/ and search/get gbrain. It explores existing memory however it
 * sees fit, then emits one of:
 *
 *   SKIP                       — no durable insight
 *   SKIP_DUPLICATE: <relPath>   — already covered
 *   ## PENSIEVE mode:update update_path:<relPath> + body  — overwrite
 *   ## PENSIEVE mode:new ...    — create new entry
 */

import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { formatModelRef, loadConfig } from "./config.js";
import { sanitizeContent } from "./prompts.js";
import { logLine, sanitizeSlug, saveParseFailure } from "./utils.js";
import { runAgentLoop } from "./agent-loop.js";
import { buildLookupTools } from "./lookup-tools.js";
import type { ResolvedModel } from "./types.js";

// ── Prompt ─────────────────────────────────────────────────────

const PENSIEVE_PROMPT = `You are the pi-sediment Pensieve curator.

Your job: decide whether a coding-agent turn produced a project-specific
insight worth persisting to .pensieve/, and if so, AVOID DUPLICATING what's
already there. Pensieve stores file paths, module boundaries, call chains,
architectural decisions, and project conventions — anything that is true
for THIS project and would help future work on it.

WORKFLOW:
  1. Read the assistant turn provided by the user.
  2. Use the read-only tools to investigate existing memory:
       - pensieve_grep, pensieve_read, pensieve_list — inspect .pensieve/
       - gbrain_search, gbrain_get — cross-reference cross-project memory
     Call them as many times as you need. Be thorough: check whether an
     existing entry already states this fact, or covers the same TOPIC and
     should be updated rather than duplicated.
  3. Emit ONE final terminal output. After emitting it, stop — do not call
     any more tools.

FOUR POSSIBLE TERMINAL OUTPUTS:

A. No durable insight — emit exactly:
SKIP

B. An existing Pensieve entry already covers this fact and the new material
   adds nothing. Emit exactly one line:
SKIP_DUPLICATE: <existing-relPath-under-.pensieve> — <one-sentence reason>

C. UPDATE an existing entry (same topic, refined / contradicted / extended /
   superseded). Emit a ## PENSIEVE block with mode:update and update_path:

## PENSIEVE
mode: update
update_path: <relative path under .pensieve/, e.g. short-term/decisions/2026-05-04-foo.md>
kind: knowledge | decision | maxim
slug: <existing-slug, do NOT rename>
label: <= 60 char headline
__CONTENT__
---
type: {kind}
title: {one-line title}
id: {existing-slug}
status: active
created: <ORIGINAL created date from the existing entry, verbatim>
updated: {today}
tags: [tag1, tag2]
---

# Title

Full rewritten body (>= 100 words). Incorporate the new insight; do not
blindly duplicate paragraphs from the original. Preserve any timeline
bullets if the file uses a Timeline section.

D. NEW entry (genuinely a different topic). Emit:

## PENSIEVE
mode: new
kind: knowledge | decision | maxim
slug: lowercase-hyphenated-slug
label: <= 60 char headline
__CONTENT__
---
type: {kind}
title: {one-line title}
id: {slug}
status: active
created: {today}
updated: {today}
tags: [tag1, tag2]
---

# Title

Body (>= 100 words) including file paths and module names.

RULES:
- kind: "maxim" for hard rules, "decision" for architectural tradeoffs, "knowledge" for facts
- slug: lowercase hyphenated, no special chars
- For mode=update: do NOT change slug or kind from the existing entry; do NOT
  replace the original 'created:' value
- Include file paths and module names in body
- Default to UPDATE when an existing entry is on the same topic. Default to
  SKIP_DUPLICATE when the new material adds no value. NEW only for genuinely
  new topics. Churn is worse than gaps.
- Output exactly ONE of {SKIP, SKIP_DUPLICATE: ..., ## PENSIEVE ...}, then stop.`;

// ── Locate skill root ──────────────────────────────────────────

function getSkillRoot(): string | null {
  const candidates = [
    process.env.PENSIEVE_SKILL_ROOT,
    path.join(os.homedir(), ".pi", "agent", "skills", "pensieve"),
    path.join(os.homedir(), ".claude", "skills", "pensieve"),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, ".src", "manifest.json"))) return c;
  }
  return null;
}

// ── Helpers ────────────────────────────────────────────────────

async function resolveModel(
  registry: ModelRegistry,
  projectRoot: string,
): Promise<ResolvedModel | { error: string }> {
  const config = loadConfig(projectRoot);
  const m = registry.find(config.model.provider, config.model.modelId);
  if (!m) return { error: `model not found: ${formatModelRef(config.model)}` };
  const auth = await registry.getApiKeyAndHeaders(m);
  if (!auth.ok) return { error: `auth failed: ${auth.error}` };
  if (!auth.apiKey) return { error: "no api key" };
  return { model: m, apiKey: auth.apiKey, headers: auth.headers, display: formatModelRef(config.model) };
}

function extractField(text: string, field: string): string | null {
  const regex = new RegExp(`^${field}:\\s*(.+)$`, "mi");
  const match = text.match(regex);
  return match?.[1]?.trim() ?? null;
}


// ── Public ─────────────────────────────────────────────────────

export type PensieveWriteStatus = "written" | "skipped" | "failed";

export async function writePensieve(
  message: string,
  projectRoot: string,
  registry: ModelRegistry,
): Promise<PensieveWriteStatus> {
  const config = loadConfig(projectRoot);
  const tag = "pensieve-writer";
  const dateIso = new Date().toISOString().slice(0, 10);

  const resolved = await resolveModel(registry, projectRoot);
  if ("error" in resolved) {
    logLine(projectRoot, `${tag} model:error ${resolved.error}`);
    return "failed";
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), config.writeTimeoutMs);

  try {
    const { tools, handlers } = buildLookupTools(projectRoot);
    const userPrompt =
      `Date: ${dateIso}\n\n` +
      `Use the read-only tools to check what's already in .pensieve/ (and gbrain ` +
      `for cross-reference) before deciding. Then emit your terminal output.\n\n` +
      `Assistant turn:\n\n<message>\n${message}\n</message>`;

    const result = await runAgentLoop({
      model: resolved.model,
      apiKey: resolved.apiKey,
      headers: resolved.headers,
      systemPrompt: PENSIEVE_PROMPT,
      userPrompt,
      tools,
      handlers,
      signal: ac.signal,
      maxTokens: 16384,
      reasoning: config.reasoning,
      onEvent: (ev) => {
        if (ev.kind === "tool_call") {
          logLine(projectRoot, `${tag} tool:${ev.name} args=${ev.argSummary.slice(0, 120)}`);
        } else if (ev.kind === "tool_result") {
          logLine(projectRoot, `${tag} tool:${ev.name} → ${ev.ok ? "ok" : "err"} bytes=${ev.bytes}`);
        } else if (ev.kind === "llm_done" && ev.stopReason !== "stop") {
          logLine(projectRoot, `${tag} llm turn=${ev.turn} stop=${ev.stopReason} toolCalls=${ev.toolCalls}`);
        }
      },
    });

    if (!result.ok) {
      logLine(projectRoot, `${tag} agent:${result.stopReason} ${result.errorMessage ?? ""} turns=${result.turns} toolCalls=${result.toolCalls}`);
      return "failed";
    }

    logLine(projectRoot, `${tag} agent:done turns=${result.turns} toolCalls=${result.toolCalls}`);
    const text = result.finalText.trim();

    // Terminal A: SKIP exactly
    if (/^SKIP\s*$/.test(text)) {
      logLine(projectRoot, `${tag} decision:skip`);
      return "skipped";
    }

    // Terminal B: SKIP_DUPLICATE: <relPath> [— reason]
    const dupMatch = text.match(/^SKIP_DUPLICATE:\s*(\S+)\s*(?:[—\-]\s*(.*))?$/m);
    if (dupMatch) {
      const relPath = dupMatch[1];
      const reason = (dupMatch[2] ?? "").trim();
      logLine(projectRoot, `${tag} decision:skip_duplicate path=${relPath} reason="${reason.slice(0, 120)}"`);
      return "skipped";
    }

    // Parse PENSIEVE section
    let clean = text
      .replace(/^```(?:markdown|md)?\s*\n?/i, "")
      .replace(/\n?```\s*$/, "")
      .trim();

    const headerRegex = /^#{2,3}\s+PENSIEVE\s*$/mi;
    // Parse failures from here on: the model's output is deterministically
    // malformed for THIS window. Retrying the same window produces the same
    // malformed output and burns minutes. Return "skipped" so the scheduler
    // advances the checkpoint; future windows can re-attempt if the insight
    // is durable.
    const headerMatch = clean.match(headerRegex);
    if (!headerMatch || headerMatch.index === undefined) {
      const snippet = clean.slice(0, 200).replace(/\s+/g, " ");
      logLine(projectRoot, `${tag} parse:fail no ## PENSIEVE header — advancing checkpoint head="${snippet}"`);
      return "skipped";
    }

    const bodyStart = headerMatch.index + headerMatch[0].length;
    // Keep the full section after ## PENSIEVE. The body may contain nested
    // ## headings; stopping at the next ## would silently truncate content.
    const raw = clean.slice(bodyStart).trim();
    if (!raw) {
      logLine(projectRoot, `${tag} parse:fail empty body — advancing checkpoint`);
      return "skipped";
    }

    const contentIdx = raw.search(/__CONTENT__/i);
    if (contentIdx === -1) {
      logLine(projectRoot, `${tag} parse:fail no __CONTENT__ — advancing checkpoint`);
      return "skipped";
    }

    const header = raw.slice(0, contentIdx).trim();
    let content = raw.slice(contentIdx + "__CONTENT__".length).trim();
    if (!content || content.length < 100) {
      logLine(projectRoot, `${tag} parse:fail content too short — advancing checkpoint`);
      return "skipped";
    }

    content = content.replace(/^\n+/, "");
    if (!content.startsWith("---")) {
      logLine(projectRoot, `${tag} parse:fail content missing frontmatter — advancing checkpoint`);
      return "skipped";
    }
    if (!/^type:\s*(knowledge|decision|maxim)/m.test(content)) {
      logLine(projectRoot, `${tag} parse:fail content missing type — advancing checkpoint`);
      return "skipped";
    }

    const kind = extractField(header, "kind");
    if (!kind || !["knowledge", "decision", "maxim"].includes(kind)) {
      logLine(projectRoot, `${tag} parse:fail invalid kind="${kind}" — advancing checkpoint`);
      return "skipped";
    }

    const slug = sanitizeSlug(extractField(header, "slug") || kind);
    const label = extractField(header, "label") || slug;
    const mode = (extractField(header, "mode") ?? "new").toLowerCase();
    const updatePathRaw = extractField(header, "update_path");

    // Sanitize. On hit return "skipped", not "failed": the model decided
    // (correctly or not) the topic warrants a write, but the content tripped
    // the injection filter. Retrying the same window will produce similar
    // content and trip again — wasted minutes for no progress. Skip and
    // advance the checkpoint; future windows can re-discover the insight.
    //
    // Save the rejected payload so we can audit WHICH content tripped the
    // filter. Pensieve writes go to project-local .pensieve/ rather than a
    // global brain, so a false positive here is locally recoverable, but
    // only if we can see what was rejected. Without this trail the only
    // signal is one log line and a silent checkpoint advance.
    if (!sanitizeContent(content)) {
      saveParseFailure(content, projectRoot, "injection", "pensieve-writer");
      logLine(projectRoot, `${tag} sanitize:reject — dropping write, advancing checkpoint (saved to parse-failures/)`);
      return "skipped";
    }

    // ── Write to Pensieve ──────────────────────────────────
    const pensieveDir = path.join(projectRoot, ".pensieve");
    if (!fs.existsSync(pensieveDir)) return "failed";

    let target: string | undefined;
    let isUpdate = false;

    // mode=update: overwrite the existing file at update_path. Path must
    // resolve safely under .pensieve/ and the file must already exist;
    // otherwise fall through to NEW behavior so we don't silently lose work.
    if (mode === "update" && updatePathRaw) {
      const cleaned = updatePathRaw.replace(/^\.?pensieve[/\\]/, "");
      const candidate = path.resolve(pensieveDir, cleaned);
      const within = candidate.startsWith(pensieveDir + path.sep);
      if (within && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        target = candidate;
        isUpdate = true;
      } else {
        logLine(projectRoot, `${tag} update_path:invalid path="${updatePathRaw}" (within=${within} exists=${fs.existsSync(candidate)}) — falling back to NEW`);
      }
    }

    if (!isUpdate) {
      if (kind === "knowledge") {
        const dir = path.join(pensieveDir, "short-term", "knowledge", slug);
        fs.mkdirSync(dir, { recursive: true });
        target = path.join(dir, "content.md");
      } else if (kind === "decision") {
        const dir = path.join(pensieveDir, "short-term", "decisions");
        fs.mkdirSync(dir, { recursive: true });
        target = path.join(dir, `${dateIso}-${slug}.md`);
      } else {
        const dir = path.join(pensieveDir, "short-term", "maxims");
        fs.mkdirSync(dir, { recursive: true });
        target = path.join(dir, `${slug}.md`);
      }
    }

    let final = target!;
    if (!isUpdate) {
      // Avoid clobbering an existing file by appending -2, -3, ...
      // In the agent-loop era hitting this means the model failed to detect
      // a duplicate it should have UPDATEd — keep but log as a smell.
      let i = 2;
      while (fs.existsSync(final)) {
        const ext = path.extname(target!);
        const base = target!.slice(0, -ext.length);
        final = `${base}-${i}${ext}`;
        i++;
        if (i > 50) break;
      }
      if (final !== target) {
        logLine(projectRoot, `${tag} write:smell slug-collision target=${path.relative(projectRoot, target!)} final=${path.relative(projectRoot, final)}`);
      }
    }
    fs.writeFileSync(final, content, "utf8");
    logLine(projectRoot, `${tag} write:${isUpdate ? "update" : "new"} path=${path.relative(projectRoot, final)}`);

    // Refresh project state
    const skillRoot = getSkillRoot();
    if (skillRoot) {
      const script = path.join(skillRoot, ".src", "scripts", "maintain-project-state.sh");
      if (fs.existsSync(script)) {
        const proc = spawn("bash", [script, "--event", "self-improve", "--note", `pi-sediment: ${label}`], {
          cwd: projectRoot,
          env: { ...process.env, PENSIEVE_SKILL_ROOT: skillRoot, PENSIEVE_PROJECT_ROOT: projectRoot, PENSIEVE_HARNESS: "pi" },
          stdio: "ignore",
          detached: true,
        });
        proc.on("error", () => {});
        proc.unref();
      }
    }

    logLine(projectRoot, `${tag} done: ${kind}/${slug}`);
    return "written";
  } catch (e: any) {
    logLine(projectRoot, `${tag} exception:${e?.message ?? String(e)}`);
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
