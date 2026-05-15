/**
 * model-fallback — 多模型 fallback 链。
 *
 * 初始模型错误时 pi 内建指数退避重试（依 pi settings#retry.maxRetries）；
 * 耗尽后切成下一个已配置的 fallback 模型继续——直到列表里有人成功，或全部
 * 失败。Fallback 模型任一错误直接切（不重试）。
 *
 * 加 "connection lost — " 前缀让 pi 的 retry regex（含 "connection\\.?lost"）能
 * 命中任意错误上游错误字面不一致的 case，最典型的是 anthropic.js
 * 抛的 "Anthropic stream ended before message_stop"（regex 要的是 "ended
 * without"）。不加前缀则让 pi 跳过 retry 分支（用于 fallback 模型，
 * 不重试）。
 *
 * 【为什么 mutation 在 message_end 而不是 agent_end】
 * pi-coding-agent 的 _handleAgentEvent 是 sync listener，会在 agent_end
 * 分发时**同步**调用 _createRetryPromiseForAgentEnd 评估
 * _isRetryableError——这个评估是 race fix，决定 prompt() 是否要等 retry。
 *
 * 如果 mutation 在 agent_end handler 里，几个事实会合谋让 retry 完全跳过：
 *   1. agent_end emit 同步分发 _handleAgentEvent
 *   2. _createRetryPromiseForAgentEnd 同步评估 —— 读原始 errorMessage
 *      （如 "stream_read_error"）→ regex 不命中 → _retryPromise 不创建
 *   3. _processAgentEvent 入 queue，model-fallback agent_end handler
 *      才进行 mutation——但这时过晚
 *   4. prompt() 的 waitForRetry 看到 _retryPromise=undefined 立即 resolve
 *   5. print mode 退出，后续 setTimeout schedule 的 agent.continue() 永不执行
 *
 * 把 mutation 提前到 message_end handler（在 agent_end 之前 emit），
 * 且 message_end 的 _processAgentEvent 是主动 await——在同一个 microtask
 * drain 中比 agent_end 的同步评估**更早完成**（实证验证：见
 * scripts/smoke-model-fallback-mutation-timing.mjs）。这样 agent_end
 * 评估 _isRetryableError 时看到的是 mutated 版本，retry 能正常启动。
 *
 * agent_end handler 仍保留：
 *   - consecutiveErrors 计数 + fallback 调度（走到 give-up 后切模型）
 *   - 防御式 mutation（如果 message_end 未能 mutate ．例如某些错误路径不
 *     走 message_end）
 *
 * 扩展自动读取 pi settings.json#retry.maxRetries，对齐 give-up 节点。
 * 旧名 retry-stream-eof → retry-all-errors。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	formatLocalIsoTimestamp,
	legacyModelFallbackCanaryPath,
	legacyRetryStreamEofPath,
	ensureProjectGitignoredOnce,
	modelFallbackCanaryPath,
	modelFallbackDir,
} from "../_shared/runtime";

// ── Constants ─────────────────────────────────────────────────

const RETRYABLE_PREFIX = "connection lost — ";

const PI_STACK_SETTINGS_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"pi-astack-settings.json",
);

/** Pi's global settings file — read to auto-detect retry.maxRetries. */
const PI_SETTINGS_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"settings.json",
);

/** Fallback when pi settings.json is missing or has no retry.maxRetries. */
const PI_DEFAULT_MAX_RETRIES = 3;

function loadPiMaxRetries(): number {
	try {
		const raw = JSON.parse(
			fs.readFileSync(PI_SETTINGS_PATH, "utf-8"),
		) as Record<string, unknown>;
		const retry = raw.retry as Record<string, unknown> | undefined;
		if (retry && typeof retry.maxRetries === "number" && retry.maxRetries > 0) {
			return Math.floor(retry.maxRetries);
		}
	} catch {
		/* missing/invalid file — use default */
	}
	return PI_DEFAULT_MAX_RETRIES;
}

/**
 * canary.log location
 *
 * Was `~/.pi-extensions/model-fallback.log` (home-level, single file across
 * all projects). Moved 2026-05-09 to `<projectRoot>/.pi-astack/model-fallback/
 * canary.log` to align with all other pi-astack modules
 * (sediment / memory / compaction-tuner / imagine all live under
 * `<projectRoot>/.pi-astack/<module>/`).
 *
 * Trade-off accepted with the move: cross-project failure patterns are now
 * spread across N project log files instead of one global log. Per-project
 * isolation matches the pi-astack convention and makes `rm -rf .pi-astack/`
 * a clean way to forget all derived state for one project. If a future
 * cross-project view is needed, it can be assembled by globbing
 * `~/<project>/.pi-astack/model-fallback/canary.log` (the literal glob
 * pattern would close this block comment, so it is rendered with a
 * placeholder); the canonical sink stays project-scoped.
 *
 * Legacy files at `~/.pi-extensions/{model-fallback,retry-stream-eof}.log`
 * are NOT auto-migrated (cannot attribute history to a single project).
 * They remain on disk after this change and can be deleted by hand.
 */
const CANARY_LOG_MAX_BYTES = 512 * 1024;

/** Delay after pi's give-up logic before we switch model + trigger continuation. */
const FALLBACK_TRIGGER_DELAY_MS = 100;

// ── Config loading ────────────────────────────────────────────

interface ModelFallbackConfig {
	fallbackModels: string[];
}

function loadConfig(): ModelFallbackConfig {
	try {
		const raw = JSON.parse(
			fs.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8"),
		) as Record<string, unknown>;
		const cfg = (raw.modelFallback as Record<string, unknown> | undefined) ?? {};
		const fallbackModels = Array.isArray(cfg.fallbackModels)
			? (cfg.fallbackModels as unknown[]).filter(
				(x): x is string => typeof x === "string" && x.includes("/"),
			)
			: [];
		return { fallbackModels };
	} catch {
		return { fallbackModels: [] };
	}
}

// ── Canary log (best-effort) ──────────────────────────────────

/**
 * Append a line to `<projectRoot>/.pi-astack/model-fallback/canary.log`.
 * Best-effort: any IO error is swallowed (fallback policy still runs).
 *
 * `projectRoot` is required — caller must resolve from `ctx.cwd` (or
 * `process.cwd()` when ctx is unavailable). The path is rebuilt every call
 * so cwd changes within a long-running pi process route to the right
 * project's log.
 */
function canaryLog(projectRoot: string, line: string): void {
	try {
		const dir = modelFallbackDir(projectRoot);
		const file = modelFallbackCanaryPath(projectRoot);
		fs.mkdirSync(dir, { recursive: true });
		// Round 9 P0 (sonnet R9-5 fix): ensure .pi-astack/ gitignored.
		// Canary log holds errorMessage snippets that may echo provider
		// request body — same exfil risk if accidentally committed.
		// Fire-and-forget (async): the canary writer is sync but the
		// gitignore check is async; not awaiting is OK because it's
		// idempotent + cached + best-effort.
		void ensureProjectGitignoredOnce(projectRoot).catch(() => { /* best-effort */ });
		try {
			const stat = fs.statSync(file);
			if (stat.size > CANARY_LOG_MAX_BYTES) fs.unlinkSync(file);
		} catch {
			/* file doesn't exist */
		}
		fs.appendFileSync(file, `${formatLocalIsoTimestamp()} ${line}\n`);
	} catch {
		/* best-effort */
	}
}

/**
 * One-time noop check: at extension load, if the legacy home-level log files
 * still exist, log a one-line breadcrumb to the new location so the user
 * can find them on inspection. We do NOT auto-delete — those files may
 * contain history from before this migration that is worth keeping.
 */
function noteLegacyLogsIfPresent(projectRoot: string): void {
	try {
		const home = os.homedir();
		const legacy = [
			legacyModelFallbackCanaryPath(home),
			legacyRetryStreamEofPath(home),
		];
		const existing = legacy.filter((p) => {
			try { fs.statSync(p); return true; } catch { return false; }
		});
		if (existing.length > 0) {
			canaryLog(
				projectRoot,
				`legacy-logs-still-on-disk count=${existing.length} paths=[${existing.join(",")}] (safe to rm by hand)`,
			);
		}
	} catch {
		/* best-effort */
	}
}

// ── Helpers ───────────────────────────────────────────────────

function modelKey(m: { provider: string; id: string }): string {
	return `${m.provider}/${m.id}`;
}

function parseEntry(entry: string): { provider: string; id: string } | undefined {
	const idx = entry.indexOf("/");
	if (idx <= 0 || idx >= entry.length - 1) return undefined;
	return { provider: entry.slice(0, idx), id: entry.slice(idx + 1) };
}

// ── Extension entry ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ═══════════════════════════════════════════════════════════════════
	// Sub-pi retry prefix injection (message_end — runs in BOTH main pi
	// AND sub-pi / dispatch_agent / dispatch_parallel).
	// ═══════════════════════════════════════════════════════════════════
	//
	// In sub-pi, this is the ONLY model-fallback behavior: it adds the
	// "connection lost — " prefix so pi's built-in retry regex can match
	// provider-specific error messages that would otherwise be missed
	// (e.g., anthropic "stream ended before message_stop" vs pi's regex
	// expecting "ended without"). Pi's built-in retry is always active
	// in sub-pi (reads settings.json#retry.maxRetries), but without this
	// prefix injection some errors fail the regex check and skip retry
	// entirely — making dispatch sub-agents less resilient than main
	// session turns.
	//
	// Model switching is explicitly NOT done in sub-pi — the guard
	// below blocks agent_end registration. The parent process handles
	// fallback at its level.
	//
	// In main pi, this handler fires first (idempotent — the full
	// message_end handler below adds the same prefix). The main-pi
	// handler also manages resetState / canaryLog / isOnFallback gating
	// which this lightweight handler intentionally does not touch.
	pi.on("message_end", (event) => {
		if (process.env.PI_ABRAIN_DISABLED !== "1") return; // skip in main pi — full handler below
		if (event.message.role !== "assistant") return;
		const msg = event.message as { stopReason?: string; errorMessage?: string };
		if (msg.stopReason !== "error" || !msg.errorMessage) return;
		if (!msg.errorMessage.startsWith(RETRYABLE_PREFIX)) {
			msg.errorMessage = RETRYABLE_PREFIX + msg.errorMessage;
		}
	});

	// ── Sub-pi guard (model switching disabled in sub-pi) ──────────
	// Sub-pi guard (2026-05-14 audit): dispatch sub-agents set
	// PI_ABRAIN_DISABLED=1. model-fallback must not fire inside sub-pi
	// — it would silently switch the sub-agent's model instead of
	// failing fast and letting the parent handle the error.
	if (process.env.PI_ABRAIN_DISABLED === "1") return;

	// ═══════════════════════════════════════════════════════════════════
	// P2 fix (R6 audit): pre-flight check on model-fallback candidates.
	// model-curator may have removed fallback models from the registry
	// via its provider whitelist. Warn on session_start so the user
	// knows before an error hits that their fallback chain is broken.
	// ═══════════════════════════════════════════════════════════════════
	{
		const config = loadConfig();
		if (config.fallbackModels?.length) {
			pi.on("session_start", async (_event, ctx) => {
				try {
					const reg = ctx.modelRegistry;
					if (!reg) return;
					const available: Array<{ provider: string; id: string }> =
						(typeof reg.getAvailable === "function" ? reg.getAvailable() : null) ??
						(typeof reg.getAll === "function" ? reg.getAll() : []) ??
						[];
					const availableIds = new Set(available.map((m) => `${m.provider}/${m.id}`));
					for (const entry of config.fallbackModels!) {
						if (!availableIds.has(entry)) {
							console.error(
								`[model-fallback] WARN: fallback model "${entry}" not in registry — ` +
								`may have been removed by model-curator whitelist`,
							);
							try {
								ctx.ui?.notify?.(
									`model-fallback: "${entry}" absent from registry (check modelCurator.providers whitelist)`,
									"warning",
								);
							} catch { /* best-effort */ }
						}
					}
				} catch { /* best-effort */ }
			});
		}
	}

	const config = loadConfig();
	// Auto-detect pi's retry budget so we always align the give-up node.
	const piMaxRetries = loadPiMaxRetries();
	// Initial model: 1 + piMaxRetries attempts before we switch (= pi's give-up node).
	const initialErrorThreshold = piMaxRetries + 1;
	// Fallback models: any error → switch immediately.
	const fallbackErrorThreshold = 1;

	// Per-session state. Each pi process loads this module once.
	let consecutiveErrors = 0;
	let isOnFallback = false; // true after we've switched at least once on this turn
	const tried = new Set<string>(); // keys: "provider/id"
	let fallbackInFlight = false;

	// resetState() may be called from contexts where we don't have an
	// extension ctx (e.g., on a fallback's success after switching). In
	// those cases we use process.cwd() at the moment of reset; for a
	// long-running pi this is the same as the active project's cwd.
	const resetState = () => {
		if (
			consecutiveErrors !== 0 ||
			tried.size !== 0 ||
			fallbackInFlight ||
			isOnFallback
		) {
			canaryLog(
				path.resolve(process.cwd()),
				`reset consecutiveErrors=${consecutiveErrors} tried=[${[...tried].join(",")}] isOnFallback=${isOnFallback} fallbackInFlight=${fallbackInFlight}`,
			);
		}
		consecutiveErrors = 0;
		isOnFallback = false;
		tried.clear();
		fallbackInFlight = false;
	};

	// At extension activation, surface a one-time pointer to legacy log
	// files so they don't get forgotten on disk.
	noteLegacyLogsIfPresent(path.resolve(process.cwd()));

	// message_end handler —— 主要有两件事：
	//   1. 成功 assistant message 重置 fallback state
	//   2. 错误 assistant message 在这里提前处理 retry prefix mutation
	//      —— 必须在 agent_end 同步评估之前完成（详见文件头注释）。
	// 保持 sync handler——不能加 async，否则 await listener 会意外延迟。
	pi.on("message_end", (event, ctx: any) => {
		if (event.message.role !== "assistant") return;
		const msg = event.message as { stopReason?: string; errorMessage?: string };

		if (msg.stopReason !== "error") {
			resetState();
			return;
		}

		// Error path: 提前 mutation。只在初始模型阶段加前缀——fallback 阶段不
		// 加前缀，让 pi 看到不可 retry 错误、跳过重试分支，交给 agent_end
		// 的 fallback 逻辑决定是否切下一个模型。
		if (
			!isOnFallback &&
			msg.errorMessage &&
			!msg.errorMessage.startsWith(RETRYABLE_PREFIX)
		) {
			msg.errorMessage = RETRYABLE_PREFIX + msg.errorMessage;
			const projectRoot = path.resolve(ctx?.cwd || process.cwd());
			canaryLog(
				projectRoot,
				`mutated@message_end errorMessage="${msg.errorMessage.slice(0, 200).replace(/[\r\n]+/g, " ")}"`,
			);
		}
	});

	pi.on("agent_end", async (event, ctx: any) => {
		// Resolve projectRoot once per agent_end — reused by every canaryLog
		// call below (including the deferred setTimeout closure).
		const projectRoot = path.resolve(ctx?.cwd || process.cwd());

		// Find last assistant message in the turn's messages.
		let last: (typeof event.messages)[number] | undefined;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			if (event.messages[i].role === "assistant") {
				last = event.messages[i];
				break;
			}
		}
		if (!last) return;

		const msg = last as { stopReason?: string; errorMessage?: string };
		if (msg.stopReason !== "error" || !msg.errorMessage) {
			// Successful turn — message_end handler already reset state, but be defensive.
			resetState();
			return;
		}

		consecutiveErrors++;

		// Policy:
		//   - Initial model: prefix → pi auto-retries; we switch only after pi exhausts
		//     its retries (consecutiveErrors >= piMaxRetries + 1 = pi's give-up node).
		//   - Fallback model: do NOT prefix → pi sees non-retryable error and skips its
		//     retry branch; we switch on the very first error (threshold = 1).
		const threshold = isOnFallback ? fallbackErrorThreshold : initialErrorThreshold;
		const allowPiAutoRetry = !isOnFallback;

		// 防御式 mutation：正常路径下 message_end handler 已经 mutate 过，这里
		// idempotent 跳过。但如果 message_end 未被触发过（某些错误路径可能跳过
		// message_end 直接 emit agent_end），这里还是能加上前缀——但这个路径
		// 上的 retry 会失效（因为 _createRetryPromiseForAgentEnd 已评估过原始
		// errorMessage），mutation 只能让 fallback 路径能譯 model-fallback 的意图。
		if (allowPiAutoRetry && !msg.errorMessage.startsWith(RETRYABLE_PREFIX)) {
			msg.errorMessage = RETRYABLE_PREFIX + msg.errorMessage;
			canaryLog(
				projectRoot,
				`mutated@agent_end (defensive—message_end skipped) errorMessage="${msg.errorMessage.slice(0, 200).replace(/[\r\n]+/g, " ")}"`,
			);
			ctx.ui?.notify?.("Error detected — auto-retrying", "info");
		} else if (allowPiAutoRetry) {
			// 已被 message_end mutate——这是 normal path。仅记录调调用于调试，不 notify。
			canaryLog(
				projectRoot,
				`agent_end-skip-already-mutated errorMessage="${msg.errorMessage.slice(0, 80).replace(/[\r\n]+/g, " ")}"`,
			);
		}

		// Trigger our fallback once we hit the per-role threshold. Guarded by
		// fallbackInFlight to avoid double-fire if agent_end is emitted twice.
		if (consecutiveErrors < threshold || fallbackInFlight) return;

		if (config.fallbackModels.length === 0) {
			// No fallback configured → retry-only behavior, no model switching.
			canaryLog(projectRoot, "fallback-disabled (no fallbackModels configured)");
			return;
		}

		const currentModel = ctx.model;
		if (!currentModel) {
			canaryLog(projectRoot, "fallback-skip (ctx.model undefined)");
			return;
		}

		// Mark current as tried so we never re-pick it.
		tried.add(modelKey(currentModel));

		// Find next configured model that's NOT tried, exists in registry, and has auth.
		let next: Model<any> | undefined;
		for (const entry of config.fallbackModels) {
			if (tried.has(entry)) continue;
			const parsed = parseEntry(entry);
			if (!parsed) {
				tried.add(entry);
				ctx.ui?.notify?.(
					`model-fallback: invalid fallback entry "${entry}" (expected "provider/modelId")`,
					"warning",
				);
				continue;
			}
			const candidate = ctx.modelRegistry.find(parsed.provider, parsed.id) as
				| Model<any>
				| undefined;
			if (!candidate) {
				tried.add(entry);
				ctx.ui?.notify?.(
					`model-fallback: model "${entry}" not in registry — skipping`,
					"warning",
				);
				continue;
			}
			if (!ctx.modelRegistry.hasConfiguredAuth(candidate)) {
				tried.add(entry);
				ctx.ui?.notify?.(
					`model-fallback: no auth configured for "${entry}" — skipping`,
					"warning",
				);
				continue;
			}
			tried.add(entry);
			next = candidate;
			break;
		}

		if (!next) {
			ctx.ui?.notify?.(
				`model-fallback: all ${tried.size} fallback model(s) exhausted — giving up`,
				"error",
			);
			canaryLog(projectRoot, `fallback-exhausted tried=[${[...tried].join(",")}]`);
			resetState();
			return;
		}

		const fromKey = modelKey(currentModel);
		const nextKey = modelKey(next);

		// Reset per-model error counter for the new model.
		consecutiveErrors = 0;
		fallbackInFlight = true;
		// Mark that we've left the initial model — every subsequent error switches.
		const becameFallback = !isOnFallback;

		// Defer to AFTER pi's _handleRetryableError finishes its give-up branch
		// (auto_retry_end success=false, _retryAttempt reset to 0). Otherwise our
		// sendMessage/setModel would race with pi's retry teardown.
		setTimeout(async () => {
			try {
				const ok = await pi.setModel(next as Model<any>);
				if (!ok) {
					ctx.ui?.notify?.(
						`model-fallback: setModel("${nextKey}") returned false — fallback aborted`,
						"error",
					);
					canaryLog(projectRoot, `fallback-setModel-failed model=${nextKey}`);
					fallbackInFlight = false;
					return;
				}

				isOnFallback = true;
				canaryLog(
					projectRoot,
					`fallback-switched from=${fromKey} to=${nextKey} role=${becameFallback ? "initial->fallback" : "fallback->fallback"}`,
				);
				ctx.ui?.notify?.(`Falling back: ${fromKey} → ${nextKey}`, "info");

				// Inject a custom message + trigger a new agent turn on the new model.
				// custom messages are converted to user messages in LLM context
				// (see pi-coding-agent/dist/core/messages.js convertToLlm), so the new
				// model gets explicit context that we just switched.
				const priorAttempts = becameFallback
					? `${initialErrorThreshold} attempts (1 initial + ${piMaxRetries} retries)`
					: `1 attempt (no retries on fallback models)`;
				pi.sendMessage(
					{
						customType: "model-fallback",
						content:
							`[model-fallback] Previous model ${fromKey} failed after ${priorAttempts}. ` +
							`Switched to ${nextKey}. Please continue the task from where the failed turn left off.`,
						display: true,
						details: {
							from: fromKey,
							to: nextKey,
							priorAttempts: becameFallback ? initialErrorThreshold : 1,
							role: becameFallback ? "initial->fallback" : "fallback->fallback",
							triedSoFar: [...tried],
						},
					},
					{ triggerTurn: true },
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				canaryLog(projectRoot, `fallback-error ${msg}`);
				ctx.ui?.notify?.(
					`model-fallback: fallback failed: ${msg}`,
					"error",
				);
				fallbackInFlight = false;
			}
			// fallbackInFlight stays true until success or error; reset by
			// resetState() (on next successful response) or above on failure.
		}, FALLBACK_TRIGGER_DELAY_MS);
	});
}
