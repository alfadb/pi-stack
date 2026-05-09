#!/usr/bin/env node
/**
 * Mutation timing regression for model-fallback Fix B (2026-05-09).
 *
 * pi-coding-agent's _handleAgentEvent is a synchronous arrow listener
 * registered into agent.processEvents(). When agent emits agent_end,
 * the listener synchronously calls _createRetryPromiseForAgentEnd
 * which evaluates _isRetryableError on the current errorMessage —
 * THIS is the moment that decides whether prompt() will await retry.
 *
 * model-fallback's job is to mutate errorMessage (prepend
 * "connection lost — ") so the regex matches. If mutation happens
 * inside the agent_end handler, it is too late — the sync evaluation
 * has already returned. Fix B moves mutation to the message_end
 * handler instead.
 *
 * For Fix B to work, the message_end async _processAgentEvent (which
 * is where extension handlers run) must complete BEFORE the
 * synchronous _createRetryPromiseForAgentEnd(agent_end) evaluation.
 *
 * This test simulates the exact sequence and asserts the ordering
 * holds. If Node ever changes microtask scheduling such that
 * Promise.resolve() continuation runs before queued .then()
 * callbacks, this test will fail and Fix B will silently regress to
 * the same race the old code had.
 */

const log = [];
let queue = Promise.resolve();
let mutated = false;
let evaluatedErrorMessageAt = null;

// Simulated message object with mutable errorMessage field. agent
// state holds a reference to this; both message_end and agent_end
// dispatchers see the same object.
const message = {
  role: "assistant",
  stopReason: "error",
  errorMessage: "stream_read_error",
};

// Simulated _handleAgentEvent (sync arrow listener registered into
// agent.processEvents). For agent_end, evaluates _isRetryableError
// synchronously; for message_end, just enqueues async work.
const handleAgentEvent = (event) => {
  if (event.type === "agent_end") {
    // _createRetryPromiseForAgentEnd: synchronously checks errorMessage
    evaluatedErrorMessageAt = message.errorMessage;
    log.push(`sync: agent_end evaluated errorMessage="${message.errorMessage}"`);
  }

  // _agentEventQueue.then(() => _processAgentEvent(event))
  queue = queue.then(async () => {
    log.push(`async: _processAgentEvent(${event.type}) starts`);

    // _emitExtensionEvent → extensionRunner.emit awaits all extension handlers.
    // For message_end with stopReason=error, model-fallback Fix B mutates
    // errorMessage here.
    if (event.type === "message_end" && message.stopReason === "error") {
      message.errorMessage = `connection lost — ${message.errorMessage}`;
      mutated = true;
      log.push(`async: model-fallback mutated errorMessage="${message.errorMessage}"`);
    }

    log.push(`async: _processAgentEvent(${event.type}) ends`);
  });
};

// Simulated agent.processEvents — awaits each listener (which sync-returns).
async function processEvents(event) {
  for (const listener of [handleAgentEvent]) {
    await listener(event);
  }
}

// Simulated agent loop emitting message_end then agent_end back to back
// (this mirrors anthropic.js / agent-loop after a stream error).
async function agentLoopAfterError() {
  await processEvents({ type: "message_end" });
  await processEvents({ type: "agent_end" });
  // Drain any remaining queue work to mirror real session lifecycle.
  await queue;
}

await agentLoopAfterError();

let failed = false;
function expect(cond, message) {
  if (!cond) {
    console.log(`  FAIL  ${message}`);
    failed = true;
  } else {
    console.log(`  ok    ${message}`);
  }
}

console.log("model-fallback mutation timing regression");
console.log("--- event log ---");
for (const l of log) console.log("  " + l);
console.log("--- assertions ---");

expect(
  mutated === true,
  "model-fallback mutation actually happened in message_end's _processAgentEvent",
);
expect(
  evaluatedErrorMessageAt !== null,
  "agent_end synchronous evaluation observed errorMessage",
);
expect(
  evaluatedErrorMessageAt &&
    evaluatedErrorMessageAt.startsWith("connection lost — "),
  `agent_end saw mutated errorMessage (got: "${evaluatedErrorMessageAt}")`,
);

// Cross-check ordering explicitly: the mutation log entry must appear
// before the agent_end evaluation log entry.
const mutateIdx = log.findIndex((l) =>
  l.includes("model-fallback mutated"),
);
const agentEndIdx = log.findIndex((l) => l.includes("agent_end evaluated"));
expect(
  mutateIdx >= 0 && agentEndIdx >= 0 && mutateIdx < agentEndIdx,
  `mutation log (idx ${mutateIdx}) precedes agent_end-evaluation log (idx ${agentEndIdx})`,
);

if (failed) {
  console.log("\nFAILED — Fix B mutation timing assumption broken.");
  console.log("If you change Node version or pi-coding-agent dispatcher,");
  console.log("rerun this; failure means model-fallback prefix won't reach");
  console.log("the retry regex evaluator and stream errors will not retry.");
  process.exit(1);
}
console.log("\nall ok — Fix B mutation timing holds.");
