/**
 * model-fallback — 为 pi 提供错误重试加多模型接力能力。
 * 初始模型耗尽重试后按配置依次切换到 fallback 模型，
 * fallback 模型错一次就继续切，全部耗尽才停。
 *
 * ── 行为 ──────────────────────────────────────────────────────
 *   分两种角色，policy 不同：
 *
 *   A. 初始模型（用户起手用的那个）：错误时给 pi 内建 retry 一个机会
 *      —— errorMessage 前缀 "connection lost — " 命中 pi 的
 *      _isRetryableError，走指数退避重试。默认 3 次重试 (initialRetries)
 *      用完后 pi 自动放弃，本扩展立即切到下一个 fallback 模型。
 *
 *   B. Fallback 模型（切换后用的）：任何错误都直接切下一个
 *      —— **不**加前缀，pi 看到的是 non-retryable error，不重试；
 *      本扩展立刻挑下一个 fallback 模型继续。每个 fallback 只有 1 次
 *      尝试机会。这避免了 fallback 链路上多次重试拖时间。
 *
 *   两种角色都通过同一段代码实现：
 *      - 维护 isOnFallback 标志；
 *      - 错误阈值：初始模型 = initialRetries + 1（默认 4 = 1 + 3）；
 *        fallback 模型 = 1（错一次就切）；
 *      - 用 setTimeout(100ms) 把 setModel + sendMessage 排到 pi 当前
 *        agent_end 处理完之后，避免和 pi 的 retry teardown 冲突；
 *      - 通过 pi.sendMessage({customType, triggerTurn:true}) 注入一条
 *        custom 消息（在 LLM context 里转 user role，见
 *        pi-coding-agent/dist/core/messages.js convertToLlm），让新模型
 *        看到 “上一个模型失败了，换我接着干” 的明确上下文。
 *
 *   配置列表里所有模型都试过且都失败 → notify error，停止接力。
 *
 *   任意 successful assistant 响应 (stopReason!=="error") → 重置
 *   consecutiveErrors / tried / isOnFallback，下次出错重新走完整流程
 *   （从初始模型重新开始算）。
 *
 * ── 实现要点 ─────────────────────────────────────────────────
 *   • _emitExtensionEvent 透传 messages 引用，原地 mutate errorMessage
 *     对 pi 的 retry 检查生效（与历史 retry-stream-eof 行为一致）。
 *   • pi 在 agent_end 里 "先 emit 给扩展，后跑 _handleRetryableError"，
 *     所以我们在加前缀后还可以 setTimeout 把 fallback 排到 pi give-up
 *     结束之后；fallback 模型上不加前缀时 pi 直接跳过 retry 分支，
 *     setTimeout 也能干净落地。
 *   • initialRetries 必须 与 pi 的 settings.json#retry.maxRetries 保持一致。
 *     pi 未暴露 retry settings 给扩展，所以依赖用户手动对齐。默认
 *     DEFAULT_INITIAL_RETRIES = 3 对齐 pi 未改动时的默认值。推荐的
 *     claude-code parity 配置：
 *        pi settings.json:           retry.maxRetries=9, retry.baseDelayMs=1000
 *        pi-astack-settings.json:    modelFallback.initialRetries=9
 *     这让初始模型拿到 10 次尝试 (1+9)，延迟 1s/2s/4s/.../256s，最差
 *     情况每轮等 ~8.5 分钟才 fallback，与 claude-code 默认行为一致。
 *   • 子进程 pi (dispatch spawn) 同样生效：pi-astack 通过
 *     package.json#pi.extensions: ["./extensions"] 给所有 pi 实例加载。
 *
 * ── 历史 ────────────────────────────────────────────────────
 *   retry-stream-eof（仅匹配流 EOF）→ 2026-05 retry-all-errors（全错误
 *   重试）→ 2026-05 加多模型 fallback（每模型同等重试）→ 2026-05 改成
 *   "初始 N 次 + fallback 各 1 次"的非对称 policy + claude-code parity
 *   delay 调度 → 2026-05 重命名为 model-fallback（凸显主要价值：fallback
 *   链；retry 现在只是 pi 内建能力的代理）。
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

const CANARY_LOG_DIR = path.join(os.homedir(), ".pi-extensions");
const CANARY_LOG_PATH = path.join(CANARY_LOG_DIR, "model-fallback.log");
const CANARY_LOG_MAX_BYTES = 512 * 1024;

/**
 * Matches pi's *out-of-the-box* default maxRetries=3 — chosen so the extension
 * doesn't misbehave on a bare pi install. For claude-code parity (10 attempts,
 * 1s/2s/4s/.../256s) set both:
 *   - pi settings.json#retry.maxRetries = 9, retry.baseDelayMs = 1000
 *   - pi-astack-settings.json#modelFallback.initialRetries = 9
 */
const DEFAULT_INITIAL_RETRIES = 3;

/** Delay after pi's give-up logic before we switch model + trigger continuation. */
const FALLBACK_TRIGGER_DELAY_MS = 100;

// ── Config loading ────────────────────────────────────────────

interface ModelFallbackConfig {
	fallbackModels: string[];
	/** Pi auto-retry count granted to the **initial** model only. Fallback models always get 1 attempt. */
	initialRetries: number;
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
		const initialRetries =
			typeof cfg.initialRetries === "number" && cfg.initialRetries > 0
				? Math.floor(cfg.initialRetries)
				: DEFAULT_INITIAL_RETRIES;
		return { fallbackModels, initialRetries };
	} catch {
		return { fallbackModels: [], initialRetries: DEFAULT_INITIAL_RETRIES };
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
	// Initial model: 1 + initialRetries attempts before we switch (= pi's give-up node).
	const initialErrorThreshold = config.initialRetries + 1;
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
		//     its retries (consecutiveErrors >= initialRetries + 1 = pi's give-up node).
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
					? `${initialErrorThreshold} attempts (1 initial + ${config.initialRetries} retries)`
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
