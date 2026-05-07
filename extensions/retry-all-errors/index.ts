/**
 * retry-all-errors — 让 pi 把所有 agent 错误识别为可重试
 *
 * pi 的 `_isRetryableError` 匹配特定关键词才触发重试。
 * 本扩展在 `agent_end` 事件里把所有 stopReason="error" 的
 * errorMessage 前缀 "connection lost — "，让 pi 自动走
 * 3 次指数退避重试。3 次全失败才停止。
 *
 * 实现机制：`_emitExtensionEvent` 透传 messages 引用，
 * 原地 mutate 对 pi 的 retry 检查生效。
 *
 * 本扩展对子进程 pi（dispatch 的 spawn）同样生效，
 * 因为 pi-astack 的 package.json#pi.extensions 被所有 pi 实例自动发现。
 *
 * 历史：曾名 retry-stream-eof（仅匹配流 EOF），2026-05 扩成全错误重试。
 * 仍保留 `retry-stream-eof.log` canary 文件名以维持日志连续性。
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const RETRYABLE_PREFIX = "connection lost — ";

const CANARY_LOG_DIR = path.join(os.homedir(), ".pi-extensions");
const CANARY_LOG_PATH = path.join(CANARY_LOG_DIR, "retry-stream-eof.log");
const CANARY_LOG_MAX_BYTES = 512 * 1024;

function canaryLog(line: string): void {
	try {
		fs.mkdirSync(CANARY_LOG_DIR, { recursive: true });
		try {
			const stat = fs.statSync(CANARY_LOG_PATH);
			if (stat.size > CANARY_LOG_MAX_BYTES) fs.unlinkSync(CANARY_LOG_PATH);
		} catch { /* file doesn't exist */ }
		fs.appendFileSync(CANARY_LOG_PATH, `${new Date().toISOString()} ${line}\n`);
	} catch { /* best-effort */ }
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event, ctx) => {
		let last: (typeof event.messages)[number] | undefined;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			if (event.messages[i].role === "assistant") {
				last = event.messages[i];
				break;
			}
		}
		if (!last) return;

		const msg = last as { stopReason?: string; errorMessage?: string };
		if (msg.stopReason !== "error" || !msg.errorMessage) return;

		// 幂等
		if (msg.errorMessage.startsWith(RETRYABLE_PREFIX)) return;

		// 所有错误都标记为可重试。pi 内建 3 次重试，全失败才停止。
		msg.errorMessage = RETRYABLE_PREFIX + msg.errorMessage;
		canaryLog(`retryable errorMessage="${msg.errorMessage.slice(0, 200).replace(/[\r\n]+/g, " ")}"`);

		ctx.ui?.notify?.("Error detected — auto-retrying", "info");
	});
}
