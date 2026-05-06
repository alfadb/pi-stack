/**
 * sediment extension — two-track background memory write agent (v6.7).
 *
 * Two parallel tracks per agent_end:
 *   - project: writes to <auto-resolved source>, federation=false
 *              source resolved per-turn from .gbrain-source dotfile or
 *              git remote; SKIPped if neither yields an id.
 *   - world:   writes to default, federation=true
 *              always available; captures cross-project principles.
 *
 * Each track has independent:
 *   - checkpoint (sediment-checkpoint-<track>.json)
 *   - model + reasoning config
 *   - system prompt rubric
 *   - tool budget + abort signal
 *
 * The two-track design replaces v6.6's single-agent + single-source approach,
 * which conflated project-specific facts and cross-project principles into
 * one source. See ADR 0011 for rationale.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { scanAndRedact } from "./secret-scanner";
import { writeLogEntry } from "./audit-logger";
import { appendPending } from "./pending-queue";
import { gbrainPut, gbrainGet, gbrainExport } from "./gbrain-writer";
import { runGbrainAgent } from "./gbrain-agent";
import { buildRunWindow, advanceCheckpoint, getCheckpoint } from "./checkpoint";
import { loadSedimentConfig } from "./config";
import type { PerTrackConfig } from "./config";
import type { TrackConfig, TrackName } from "./tracks";
import { resolveProjectSource } from "./source-resolver";
import { ensureSourceRegistered } from "./source-registry";
import {
  registerMemoryPendingCommands,
  registerMemorySourceCommands,
  registerMemoryLogLevelCommand,
} from "./commands";

// ── config (loaded once at startup) ────────────────────────────

const CONFIG = loadSedimentConfig();

// ── state ──────────────────────────────────────────────────────

let jobCounter = 0;
type TrackState = "idle" | "evaluating" | "writing" | "exporting" | "done" | "skip";
let projectState: TrackState = "idle";
let worldState: TrackState = "idle";
let lastPendingCount = 0;
let lastStatusFetchAt = 0;
let uiRef: any = null;
const PENDING_COUNT_TTL_MS = 30_000;
// Set when we auto-register a project source so the next status update
// can show a one-time toast.
let pendingSourceToast: { sourceId: string; rootPath: string } | null = null;

function stateIcon(s: TrackState): string {
  switch (s) {
    case "evaluating": return "🔍";
    case "writing":    return "📝";
    case "exporting":  return "📤";
    case "done":       return "✅";
    case "skip":       return "⊘";  // disabled / skipped this turn (no source / track off)
    case "idle":
    default:           return "💤";
  }
}

function buildFooterText(): string {
  // P: project track, W: world track. 📥 + count only when there's a non-zero
  // pending queue ("there's something waiting for you to review"); hidden
  // otherwise so the normal happy path is visually quiet.
  const base = `P:${stateIcon(projectState)} W:${stateIcon(worldState)}`;
  return lastPendingCount > 0 ? `${base} 📥${lastPendingCount}` : base;
}

function pushFooterState() {
  if (uiRef?.setStatus) {
    uiRef.setStatus("sediment", buildFooterText());
  }
}

function setTrackState(track: TrackName, s: TrackState) {
  if (track === "project") projectState = s;
  else worldState = s;
  pushFooterState();
}

// ── per-track runner ───────────────────────────────────────────

interface TrackRunOutcome {
  trackName: TrackName;
  status: "skip" | "skip_duplicate" | "wrote" | "pending" | "skipped_no_source" | "disabled" | "no_window" | "error";
  slug?: string;
  pendingCount: number;
  writtenCount: number;
  reason: string;
  durationMs: number;
}

async function runOneTrack(args: {
  pi: ExtensionAPI;
  trackName: TrackName;
  trackCfg: PerTrackConfig;
  cwd: string;
  branch: any[];
  registry: any;
  jobId: string;
  dateIso: string;
}): Promise<TrackRunOutcome> {
  const start = Date.now();

  if (!args.trackCfg.enabled) {
    setTrackState(args.trackName, "skip");
    return {
      trackName: args.trackName,
      status: "disabled",
      pendingCount: 0,
      writtenCount: 0,
      reason: "track_disabled_in_config",
      durationMs: 0,
    };
  }

  // ── resolve source ─────────────────────────────────────────
  let sourceId: string;
  if (args.trackName === "world") {
    sourceId = "default";
  } else {
    // project-track: resolve from dotfile / git remote
    const resolved = await resolveProjectSource(args.cwd);
    if (!resolved) {
      writeLogEntry({
        type: "track:source_unresolved" as any, ts: new Date().toISOString(),
        jobId: args.jobId, track: args.trackName,
        cwd: args.cwd,
      } as any);
      setTrackState(args.trackName, "skip");
      return {
        trackName: args.trackName,
        status: "skipped_no_source",
        pendingCount: 0,
        writtenCount: 0,
        reason: "no .gbrain-source dotfile and no git remote — project-track skipped",
        durationMs: Date.now() - start,
      };
    }
    sourceId = resolved.id;

    // Auto-register source if not already registered
    const ensure = await ensureSourceRegistered({
      id: resolved.id,
      rootPath: resolved.rootPath,
    });
    if (!ensure.ok) {
      writeLogEntry({
        type: "track:source_register_failed" as any, ts: new Date().toISOString(),
        jobId: args.jobId, track: args.trackName,
        sourceId: resolved.id, error: ensure.error,
      } as any);
      setTrackState(args.trackName, "skip");
      return {
        trackName: args.trackName,
        status: "error",
        pendingCount: 0,
        writtenCount: 0,
        reason: `source registration failed: ${ensure.error}`,
        durationMs: Date.now() - start,
      };
    }
    if (ensure.created) {
      pendingSourceToast = { sourceId: resolved.id, rootPath: resolved.rootPath };
      writeLogEntry({
        type: "source:auto_registered" as any, ts: new Date().toISOString(),
        jobId: args.jobId, sourceId: resolved.id,
        rootPath: resolved.rootPath, via: resolved.via,
      } as any);
    }
  }

  // ── build incremental window for this track ────────────────
  const window = buildRunWindow(args.branch, args.trackName);
  if (!window) {
    setTrackState(args.trackName, "idle");
    return {
      trackName: args.trackName,
      status: "no_window",
      pendingCount: 0,
      writtenCount: 0,
      reason: "no new entries since last checkpoint",
      durationMs: Date.now() - start,
    };
  }
  if (window.text.length < CONFIG.minWindowChars) {
    advanceCheckpoint(args.trackName, window.toEntryId);
    setTrackState(args.trackName, "idle");
    return {
      trackName: args.trackName,
      status: "no_window",
      pendingCount: 0,
      writtenCount: 0,
      reason: `window too small (${window.text.length} chars)`,
      durationMs: Date.now() - start,
    };
  }

  writeLogEntry({
    type: "window:built" as any, ts: new Date().toISOString(),
    jobId: args.jobId, track: args.trackName,
    fromEntryId: window.fromEntryId, toEntryId: window.toEntryId,
    entryCount: window.entryCount, rawSliceSize: window.rawSliceSize,
    truncated: window.truncated, chars: window.text.length,
    branchLen: args.branch.length, sourceId,
  } as any);

  // ── pre-LLM secret redact ──────────────────────────────────
  const scan = scanAndRedact(window.text);
  const promptText = scan.passed ? window.text : scan.redacted;
  if (!scan.passed) {
    writeLogEntry({
      type: "secret:redact" as any, ts: new Date().toISOString(),
      jobId: args.jobId, track: args.trackName,
      hits: scan.hits, patterns: scan.patterns,
    } as any);
  }

  // ── run agent ──────────────────────────────────────────────
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("track timeout")), args.trackCfg.timeoutMs);
  const onShutdown = () => ac.abort(new Error("session_shutdown"));
  args.pi.on("session_shutdown", onShutdown);

  try {
    const trackConfig: TrackConfig = {
      name: args.trackName,
      source: sourceId,
      modelProvider: args.trackCfg.modelProvider,
      modelId: args.trackCfg.modelId,
      reasoning: args.trackCfg.reasoning,
      maxTokens: args.trackCfg.maxTokens,
      timeoutMs: args.trackCfg.timeoutMs,
      enabled: args.trackCfg.enabled,
    };

    const agentResult = await runGbrainAgent({
      track: trackConfig,
      registry: args.registry,
      windowText: promptText,
      truncated: window.truncated,
      entryCount: window.entryCount,
      dateIso: args.dateIso,
      gbrainColdStart: false,
      signal: ac.signal,
      onEvent: (ev: any) => {
        if (ev.kind === "tool_call") {
          writeLogEntry({
            type: "agent:tool_call" as any, ts: new Date().toISOString(),
            jobId: args.jobId, track: args.trackName,
            name: ev.name, args: ev.argSummary?.slice(0, 200),
          } as any);
        } else if (ev.kind === "tool_result") {
          writeLogEntry({
            type: "agent:tool_result" as any, ts: new Date().toISOString(),
            jobId: args.jobId, track: args.trackName,
            name: ev.name, ok: ev.ok, bytes: ev.bytes,
          } as any);
        } else if (ev.kind === "llm_done") {
          writeLogEntry({
            type: "agent:llm_done" as any, ts: new Date().toISOString(),
            jobId: args.jobId, track: args.trackName,
            turn: ev.turn, stopReason: ev.stopReason, toolCalls: ev.toolCalls,
          } as any);
        }
      },
    });
    clearTimeout(timer);

    writeLogEntry({
      type: "agent:done" as any, ts: new Date().toISOString(),
      jobId: args.jobId, track: args.trackName,
      model: `${trackConfig.modelProvider}/${trackConfig.modelId}`,
      stopReason: agentResult.stopReason, ok: agentResult.ok,
      turns: agentResult.turns, toolCalls: agentResult.toolCalls,
      rawTextLen: agentResult.rawText.length, kind: agentResult.result.kind,
      error: agentResult.errorMessage,
    } as any);

    const r = agentResult.result;
    if (r.kind === "skip") {
      advanceCheckpoint(args.trackName, window.toEntryId);
      setTrackState(args.trackName, "done");
      return {
        trackName: args.trackName, status: "skip",
        pendingCount: 0, writtenCount: 0,
        reason: "agent_skip", durationMs: Date.now() - start,
      };
    }
    if (r.kind === "skip_duplicate") {
      advanceCheckpoint(args.trackName, window.toEntryId);
      setTrackState(args.trackName, "done");
      return {
        trackName: args.trackName, status: "skip_duplicate",
        slug: r.slug,
        pendingCount: 0, writtenCount: 0,
        reason: `agent_skip_duplicate:${r.slug}`,
        durationMs: Date.now() - start,
      };
    }
    if (r.kind === "page") {
      // Post-LLM secret rescan
      const outScan = scanAndRedact(r.output.content);
      if (!outScan.passed) {
        appendPending({
          id: `${args.jobId}-${args.trackName}-secret-out`,
          ts: new Date().toISOString(), jobId: args.jobId,
          reason: "secret_scan_hit",
          candidatePreview: outScan.redacted.slice(0, 500),
          matchedPattern: outScan.patterns.join(","),
          contextHint: `${args.trackName}-track agent output contained secrets, redacted`,
        });
        setTrackState(args.trackName, "done");
        return {
          trackName: args.trackName, status: "pending",
          pendingCount: 1, writtenCount: 0,
          reason: `secret_in_agent_output: ${outScan.patterns.join(",")}`,
          durationMs: Date.now() - start,
        };
      }

      const slug = r.output.updateSlug ?? r.output.title
        .toLowerCase().replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "").slice(0, 80);

      setTrackState(args.trackName, "writing");

      writeLogEntry({
        type: "gbrain:put" as any, ts: new Date().toISOString(),
        jobId: args.jobId, track: args.trackName,
        source: sourceId, slug,
        mode: r.output.updateSlug ? "update" : "new",
        tags: r.output.tags.join(","),
        titleLen: r.output.title.length,
        contentLen: r.output.content.length,
      } as any);

      const page = {
        title: r.output.title,
        slug,
        content: r.output.content,
        tags: r.output.tags,
        tier: "knowledge" as const,
        confidence: 8 as const,
        evidence_source: "ground" as const,
        scope: args.trackName === "project" ? "project" as const : "cross-project" as const,
        status: "active" as const,
      };
      const putResult = await gbrainPut(sourceId, page);
      if (!putResult.ok) {
        writeLogEntry({
          type: "gbrain:put" as any, ts: new Date().toISOString(),
          jobId: args.jobId, track: args.trackName,
          source: sourceId, slug, error: putResult.error,
        } as any);
        setTrackState(args.trackName, "done");
        return {
          trackName: args.trackName, status: "pending",
          pendingCount: 1, writtenCount: 0,
          reason: `gbrain_put_failed: ${putResult.error}`,
          durationMs: Date.now() - start,
        };
      }

      await gbrainGet(sourceId, slug);
      advanceCheckpoint(args.trackName, window.toEntryId);

      // Markdown export per source
      setTrackState(args.trackName, "exporting");
      const exportResult = await gbrainExport(sourceId);
      writeLogEntry({
        type: "export" as any, ts: new Date().toISOString(),
        jobId: args.jobId, track: args.trackName,
        source: sourceId, durationMs: 0,
        pageCount: exportResult.pageCount,
        skipped: !exportResult.ok,
        reason: (exportResult as any).error,
      } as any);

      setTrackState(args.trackName, "done");
      return {
        trackName: args.trackName, status: "wrote",
        slug: `${sourceId}:${slug}`,
        pendingCount: 0, writtenCount: 1,
        reason: "wrote",
        durationMs: Date.now() - start,
      };
    }

    // parse_failure
    setTrackState(args.trackName, "done");
    appendPending({
      id: `${args.jobId}-${args.trackName}-parse-fail`,
      ts: new Date().toISOString(), jobId: args.jobId,
      reason: "parse_failure",
      candidatePreview: agentResult.rawText.slice(0, 1000),
      contextHint: `${args.trackName}-track agent output did not match SKIP / SKIP_DUPLICATE / ## GBRAIN protocol`,
    });
    return {
      trackName: args.trackName, status: "pending",
      pendingCount: 1, writtenCount: 0,
      reason: "parse_failure", durationMs: Date.now() - start,
    };
  } catch (e: any) {
    clearTimeout(timer);
    setTrackState(args.trackName, "done");
    const msg = e?.message ?? String(e);
    return {
      trackName: args.trackName, status: "error",
      pendingCount: 1, writtenCount: 0,
      reason: `track_error: ${msg}`,
      durationMs: Date.now() - start,
    };
  }
}

// ── extension ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", (event: any, ctx: any) => {
    const capturedCwd = ctx.cwd ?? process.cwd();
    const capturedRegistry = ctx.modelRegistry;
    const sessionManager = ctx.sessionManager;
    const jobId = `sediment-${++jobCounter}-${Date.now()}`;
    const startTime = Date.now();

    // Both tracks enter evaluating immediately; runOneTrack overrides per-track
    // when it knows the outcome (skip / no_window / skipped_no_source / disabled).
    projectState = "evaluating";
    worldState = "evaluating";
    pushFooterState();

    setTimeout(async () => {
      const skipReasons: string[] = [];
      const writtenSlugs: string[] = [];
      let totalWritten = 0;
      let totalPending = 0;
      let totalSkipped = 0;

      try {
        // ── scratch repo skip ─────────────────────────────
        try {
          const { existsSync } = await import("node:fs");
          const { join } = await import("node:path");
          if (existsSync(join(capturedCwd, ".gbrain-scratch"))) {
            writeLogEntry({
              type: "job:start", ts: new Date().toISOString(),
              jobId, cwd: capturedCwd, resolverSource: "skipped", scope: "scratch-repo",
            });
            totalSkipped = 1;
            skipReasons.push("scratch_repo");
            return;
          }
        } catch { /* proceed */ }

        writeLogEntry({
          type: "job:start", ts: new Date().toISOString(),
          jobId, cwd: capturedCwd, resolverSource: "two-track", scope: "project+world",
        });

        // ── read full branch ──────────────────────────────
        let branch: any[] = [];
        try {
          branch = sessionManager?.getBranch?.() ?? [];
        } catch (e: any) {
          skipReasons.push(`branch_read_error: ${e?.message ?? e}`);
          totalSkipped = 1;
          return;
        }

        // ── run both tracks in parallel ───────────────────
        const dateIso = new Date().toISOString().slice(0, 10);
        const trackResults = await Promise.allSettled([
          runOneTrack({
            pi, trackName: "project", trackCfg: CONFIG.tracks.project,
            cwd: capturedCwd, branch, registry: capturedRegistry, jobId, dateIso,
          }),
          runOneTrack({
            pi, trackName: "world", trackCfg: CONFIG.tracks.world,
            cwd: capturedCwd, branch, registry: capturedRegistry, jobId, dateIso,
          }),
        ]);

        for (const tr of trackResults) {
          if (tr.status === "fulfilled") {
            const o = tr.value;
            totalWritten += o.writtenCount;
            totalPending += o.pendingCount;
            if (o.writtenCount === 0 && o.pendingCount === 0) totalSkipped += 1;
            if (o.slug && o.status === "wrote") writtenSlugs.push(o.slug);
            skipReasons.push(`${o.trackName}:${o.status}:${o.reason}`);

            writeLogEntry({
              type: "track:end" as any, ts: new Date().toISOString(),
              jobId, track: o.trackName, status: o.status,
              slug: o.slug, durationMs: o.durationMs,
              reason: o.reason,
            } as any);
          } else {
            totalPending += 1;
            skipReasons.push(`track_rejected: ${tr.reason}`);
          }
        }
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        const stack = e?.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : "no stack";
        totalPending += 1;
        skipReasons.push(`sediment_error: ${msg} [${stack}]`);
      } finally {
        writeLogEntry({
          type: "job:end", ts: new Date().toISOString(),
          jobId,
          totalDurationMs: Date.now() - startTime,
          candidatesConsidered: totalWritten + totalPending + totalSkipped,
          written: totalWritten,
          pending: totalPending,
          skipped: totalSkipped,
          skipReasons,
          writtenSlugs,
          voterTools: "[gbrain_search,gbrain_get]",
        });
        // Footer settles to whatever each track ended at; we don't override
        // here so the user can see e.g. P:✅ W:⊘ even after the job ends.
        // (If both ended in idle/skip, that's accurate.)
        pushFooterState();
      }
    }, 0);
  });

  // ── session_shutdown ───────────────────────────────────────
  pi.on("session_shutdown", async (event: any) => {
    writeLogEntry({
      type: "job:end", ts: new Date().toISOString(),
      jobId: `shutdown-${Date.now()}`,
      totalDurationMs: 0,
      candidatesConsidered: 0,
      written: 0, pending: 0, skipped: 1,
      skipReasons: [`session_shutdown_${event?.reason ?? "unknown"}`],
      writtenSlugs: [], voterTools: "[]",
    });
  });

  // ── slash commands ─────────────────────────────────────────
  registerMemoryPendingCommands(pi);
  registerMemorySourceCommands(pi);
  registerMemoryLogLevelCommand(pi);

  // ── footer status ──────────────────────────────────────────
  const updateStatus = async (ctx: any) => {
    const now = Date.now();
    if (now - lastStatusFetchAt >= PENDING_COUNT_TTL_MS) {
      try {
        const { countPending } = await import("./pending-queue");
        lastPendingCount = countPending();
        lastStatusFetchAt = now;
      } catch { /* keep last */ }
    }
    if (ctx?.ui?.setStatus) {
      ctx.ui.setStatus("sediment", buildFooterText());
    }
    // One-time toast for auto-registered source
    if (pendingSourceToast && ctx?.ui?.setStatus) {
      const t = pendingSourceToast;
      pendingSourceToast = null;
      try {
        ctx.ui.setStatus(
          "sediment-toast",
          `📌 auto-registered source '${t.sourceId}' → ${t.rootPath}`,
        );
        // Clear the toast after 5 seconds
        setTimeout(() => {
          try { ctx.ui.setStatus("sediment-toast", undefined); } catch {}
        }, 5000);
      } catch {}
    }
  };

  pi.on("session_start", async (_event: any, ctx: any) => {
    uiRef = ctx.ui;
    projectState = "idle";
    worldState = "idle";
    pushFooterState();
    await updateStatus(ctx);

    writeLogEntry({
      type: "session:start" as any, ts: new Date().toISOString(),
      checkpoints: {
        project: getCheckpoint("project"),
        world: getCheckpoint("world"),
      },
      cwd: ctx.cwd ?? process.cwd(),
      config: {
        project: {
          enabled: CONFIG.tracks.project.enabled,
          model: `${CONFIG.tracks.project.modelProvider}/${CONFIG.tracks.project.modelId}`,
          reasoning: CONFIG.tracks.project.reasoning,
        },
        world: {
          enabled: CONFIG.tracks.world.enabled,
          model: `${CONFIG.tracks.world.modelProvider}/${CONFIG.tracks.world.modelId}`,
          reasoning: CONFIG.tracks.world.reasoning,
        },
        minWindowChars: CONFIG.minWindowChars,
        totalTimeoutMs: CONFIG.totalTimeoutMs,
      },
    } as any);
  });
  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    uiRef = ctx.ui;
    await updateStatus(ctx);
  });
}
