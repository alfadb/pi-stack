/**
 * retry-all-errors — 让 pi 把所有 agent 错误识别为可重试，
 * 并在单一模型耗尽重试后按配置切换到下一个 fallback 模型。
 *
 * ── 行为 ──────────────────────────────────────────────────────
 *   1. 任何 stopReason="error" 的 assistant 消息，errorMessage 前缀
 *      "connection lost — " 让 pi 内建 _isRetryableError 命中，走
 *      指数退避重试。3 次重试用完 pi 会自动放弃 (默认 maxRetries=3)。
 *
 *   2. 当前模型连续出错次数 ≥ retriesPerModel+1 时（默认 4 = 1 初始 + 3
 *      重试，正好对齐 pi 的 give-up 节点），本扩展接力：
 *        - 从 retryAllErrors.fallbackModels 列表挑下一个尚未试过、
 *          且在 modelRegistry 中存在 + 已配置 auth 的模型；
 *        - 用 setTimeout 把 setModel + sendMessage 排到 pi 的 give-up
 *          逻辑之后；
 *        - 通过 pi.sendMessage({customType, triggerTurn:true}) 注入一条
 *          custom 消息，触发新一轮 agent loop（在新模型上）。
 *
 *   3. 配置列表里所有模型都试过且都失败 → 给出 notify，停止接力。
 *
 *   4. 任意 successful assistant 响应 (stopReason!=="error") → 重置
 *      consecutiveErrors 与 tried Set，下次出错重新走完整流程。
 *
 * ── 实现要点 ─────────────────────────────────────────────────
 *   • _emitExtensionEvent 透传 messages 引用，原地 mutate errorMessage
 *     对 pi 的 retry 检查生效（与历史 retry-stream-eof 行为一致）。
 *   • pi 在 agent_end 里 “先 emit 给扩展，后跑 _handleRetryableError”，
 *     所以我们在加前缀后还可以 setTimeout 把 fallback 排到 pi give-up
 *     结束之后，避免和 pi 内建 retry 流冲突。
 *   • `consecutiveErrors` 阈值按 pi 默认 maxRetries=3 计；用户改了 pi
 *     设置可在 pi-astack-settings.json 里同步 retriesPerModel。
 *   • 子进程 pi (dispatch spawn) 同样生效：pi-astack 通过
 *     package.json#pi.extensions: ["./extensions"] 给所有 pi 实例加载。
 *
 * ── 历史 ────────────────────────────────────────────────────
 *   原名 retry-stream-eof（仅匹配流 EOF）→ 2026-05 扩成全错误重试 →
 *   2026-05 加上多模型 fallback。canary log 文件名仍沿用
 *   retry-stream-eof.log 以保持日志连续性。
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
const CANARY_LOG_PATH = path.join(CANARY_LOG_DIR, "retry-stream-eof.log");
const CANARY_LOG_MAX_BYTES = 512 * 1024;

/** Matches pi's default maxRetries=3. Override via retryAllErrors.retriesPerModel. */
const DEFAULT_RETRIES_PER_MODEL = 3;

/** Delay after pi's give-up logic before we switch model + trigger continuation. */
const FALLBACK_TRIGGER_DELAY_MS = 100;

// ── Config loading ────────────────────────────────────────────

interface RetryAllErrorsConfig {
	fallbackModels: string[];
	retriesPerModel: number;
}

function loadConfig(): RetryAllErrorsConfig {
	try {
		const raw = JSON.parse(
			fs.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8"),
		) as Record<string, unknown>;
		const cfg = (raw.retryAllErrors as Record<string, unknown> | undefined) ?? {};
		const fallbackModels = Array.isArray(cfg.fallbackModels)
			? (cfg.fallbackModels as unknown[]).filter(
				(x): x is string => typeof x === "string" && x.includes("/"),
			)
			: [];
		const retriesPerModel =
			typeof cfg.retriesPerModel === "number" && cfg.retriesPerModel > 0
				? Math.floor(cfg.retriesPerModel)
				: DEFAULT_RETRIES_PER_MODEL;
		return { fallbackModels, retriesPerModel };
	} catch {
		return { fallbackModels: [], retriesPerModel: DEFAULT_RETRIES_PER_MODEL };
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
	// pi maxRetries=3 means 1 initial + 3 retries = 4 errors before pi gives up.
	const errorThreshold = config.retriesPerModel + 1;

	// Per-session state. Each pi process loads this module once.
	let consecutiveErrors = 0;
	const tried = new Set<string>(); // keys: "provider/id"
	let fallbackInFlight = false;

	const resetState = () => {
		if (consecutiveErrors !== 0 || tried.size !== 0 || fallbackInFlight) {
			canaryLog(
				`reset consecutiveErrors=${consecutiveErrors} tried=[${[...tried].join(",")}] fallbackInFlight=${fallbackInFlight}`,
			);
		}
		consecutiveErrors = 0;
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

		// Idempotent prefix so pi treats this as retryable.
		if (!msg.errorMessage.startsWith(RETRYABLE_PREFIX)) {
			msg.errorMessage = RETRYABLE_PREFIX + msg.errorMessage;
			canaryLog(
				`retryable errorMessage="${msg.errorMessage.slice(0, 200).replace(/[\r\n]+/g, " ")}"`,
			);
			ctx.ui?.notify?.("Error detected — auto-retrying", "info");
		}

		consecutiveErrors++;

		// Pi will give up at this error event when consecutiveErrors > retriesPerModel.
		// (matches pi's `_retryAttempt > settings.maxRetries` give-up branch).
		// Trigger our fallback once — guarded by fallbackInFlight to avoid double-fire
		// in the unlikely case agent_end is emitted twice with the same error.
		if (consecutiveErrors < errorThreshold || fallbackInFlight) return;

		if (config.fallbackModels.length === 0) {
			// No fallback configured → behave like vanilla retry-all-errors. Just stop.
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
					`retry-all-errors: invalid fallback entry "${entry}" (expected "provider/modelId")`,
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
					`retry-all-errors: model "${entry}" not in registry — skipping`,
					"warning",
				);
				continue;
			}
			if (!ctx.modelRegistry.hasConfiguredAuth(candidate)) {
				tried.add(entry);
				ctx.ui?.notify?.(
					`retry-all-errors: no auth configured for "${entry}" — skipping`,
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
				`retry-all-errors: all ${tried.size} fallback model(s) exhausted — giving up`,
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

		// Defer to AFTER pi's _handleRetryableError finishes its give-up branch
		// (auto_retry_end success=false, _retryAttempt reset to 0). Otherwise our
		// sendMessage/setModel would race with pi's retry teardown.
		setTimeout(async () => {
			try {
				const ok = await pi.setModel(next as Model<any>);
				if (!ok) {
					ctx.ui?.notify?.(
						`retry-all-errors: setModel("${nextKey}") returned false — fallback aborted`,
						"error",
					);
					canaryLog(`fallback-setModel-failed model=${nextKey}`);
					fallbackInFlight = false;
					return;
				}

				canaryLog(`fallback-switched from=${fromKey} to=${nextKey}`);
				ctx.ui?.notify?.(`Falling back: ${fromKey} → ${nextKey}`, "info");

				// Inject a custom message + trigger a new agent turn on the new model.
				// custom messages are converted to user messages in LLM context
				// (see pi-coding-agent/dist/core/messages.js convertToLlm), so the new
				// model gets explicit context that we just switched.
				pi.sendMessage(
					{
						customType: "retry-all-errors-fallback",
						content:
							`[retry-all-errors] Previous model ${fromKey} failed after ${errorThreshold} attempts ` +
							`(1 initial + ${config.retriesPerModel} retries). Switched to ${nextKey}. ` +
							`Please continue the task from where the failed turn left off.`,
						display: true,
						details: {
							from: fromKey,
							to: nextKey,
							attemptsPerModel: errorThreshold,
							triedSoFar: [...tried],
						},
					},
					{ triggerTurn: true },
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				canaryLog(`fallback-error ${msg}`);
				ctx.ui?.notify?.(
					`retry-all-errors: fallback failed: ${msg}`,
					"error",
				);
				fallbackInFlight = false;
			}
			// fallbackInFlight stays true until success or error; reset by
			// resetState() (on next successful response) or above on failure.
		}, FALLBACK_TRIGGER_DELAY_MS);
	});
}
