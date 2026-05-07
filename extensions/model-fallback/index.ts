/**
 * model-fallback — 多模型 fallback 链。
 *
 * 初始模型错误时 pi 内建指数退避重试（依 pi settings#retry.maxRetries）；
 * 耗尽后切成下一个已配置的 fallback 模型继续——直到列表里有人成功，或全部
 * 失败。Falback 模型任一错误直接切（不重试）。
 *
 * pi agent_end 里扩展先于 pi 的 _handleRetryableError 运行：加 "connection
 * lost — " 前缀触发 pi 重试，或不加前缀让 pi 跳过 retry 分支。切换模型 +
 * 继续走 setTimeout(100ms) 落地到 pi give-up 之后。
 *
 * 扩展自动读取 pi settings.json#retry.maxRetries，对齐 give-up 节点。
 * 旧名 retry-stream-eof → retry-all-errors。
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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

const CANARY_LOG_DIR = path.join(os.homedir(), ".pi-extensions");
const CANARY_LOG_PATH = path.join(CANARY_LOG_DIR, "model-fallback.log");
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

function canaryLog(line: string): void {
	try {
		fs.mkdirSync(CANARY_LOG_DIR, { recursive: true });
		try {
			const stat = fs.statSync(CANARY_LOG_PATH);
			if (stat.size > CANARY_LOG_MAX_BYTES) fs.unlinkSync(CANARY_LOG_PATH);
		} catch {
			/* file doesn't exist */
		}
		fs.appendFileSync(CANARY_LOG_PATH, `${new Date().toISOString()} ${line}\n`);
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

	const resetState = () => {
		if (
			consecutiveErrors !== 0 ||
			tried.size !== 0 ||
			fallbackInFlight ||
			isOnFallback
		) {
			canaryLog(
				`reset consecutiveErrors=${consecutiveErrors} tried=[${[...tried].join(",")}] isOnFallback=${isOnFallback} fallbackInFlight=${fallbackInFlight}`,
			);
		}
		consecutiveErrors = 0;
		isOnFallback = false;
		tried.clear();
		fallbackInFlight = false;
	};

	// Reset on any successful assistant message.
	pi.on("message_end", (event, _ctx) => {
		if (event.message.role !== "assistant") return;
		const msg = event.message as { stopReason?: string };
		if (msg.stopReason !== "error") {
			resetState();
		}
	});

	pi.on("agent_end", async (event, ctx) => {
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

		if (allowPiAutoRetry && !msg.errorMessage.startsWith(RETRYABLE_PREFIX)) {
			msg.errorMessage = RETRYABLE_PREFIX + msg.errorMessage;
			canaryLog(
				`retryable errorMessage="${msg.errorMessage.slice(0, 200).replace(/[\r\n]+/g, " ")}"`,
			);
			ctx.ui?.notify?.("Error detected — auto-retrying", "info");
		}

		// Trigger our fallback once we hit the per-role threshold. Guarded by
		// fallbackInFlight to avoid double-fire if agent_end is emitted twice.
		if (consecutiveErrors < threshold || fallbackInFlight) return;

		if (config.fallbackModels.length === 0) {
			// No fallback configured → retry-only behavior, no model switching.
			canaryLog("fallback-disabled (no fallbackModels configured)");
			return;
		}

		const currentModel = ctx.model;
		if (!currentModel) {
			canaryLog("fallback-skip (ctx.model undefined)");
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
			canaryLog(`fallback-exhausted tried=[${[...tried].join(",")}]`);
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
					canaryLog(`fallback-setModel-failed model=${nextKey}`);
					fallbackInFlight = false;
					return;
				}

				isOnFallback = true;
				canaryLog(
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
				canaryLog(`fallback-error ${msg}`);
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
