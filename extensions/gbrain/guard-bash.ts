/**
 * guard-bash — intercept main-session bash tool calls to block gbrain write CLI.
 *
 * Part of pi-stack ADR 0003 Guard 1: the main session must never write to gbrain
 * directly. Any gbrain put/delete/update/import/sources-mutation is blocked.
 * Also blocks direct PostgreSQL connection attempts (psql INSERT/UPDATE into pages).
 *
 * Approach: argv-level parse, not regex match on raw command string.
 * Splits on pipe (|), &&, ||, ;, subshell ($(...)), backticks,
 * then extracts basename and subcommands for each token.
 */

import type { ToolCallEvent } from "@mariozechner/pi-coding-agent";

// ── gbrain write subcommands ──────────────────────────────────

const GBRAIN_WRITE_SUBCOMMANDS = new Set([
  "put", "put-page", "delete", "update", "import",
  "migrate", "restore",
]);

const GBRAIN_SOURCE_MUTATIONS = new Set(["add", "remove", "update"]);

// ── command tokenizer ─────────────────────────────────────────

/**
 * Split a shell command string into individual command tokens.
 * Handles: |, &&, ||, ;, $(...), `...`, <(...), >(...)
 * Does NOT expand variables or resolve paths — that's a shell responsibility.
 * Returns an array of argv arrays, one per logical command.
 */
function tokenizeCommands(raw: string): string[][] {
  const commands: string[][] = [];
  let current = "";
  let i = 0;
  let depth = 0;
  const separators = new Set(["|", "&", ";"]);

  while (i < raw.length) {
    const ch = raw[i];

    // Handle quoted strings — skip content
    if (ch === "'") {
      const start = i;
      i++;
      while (i < raw.length && raw[i] !== "'") i++;
      current += raw.slice(start, i + 1);
      i++;
      continue;
    }
    if (ch === '"') {
      const start = i;
      i++;
      while (i < raw.length) {
        if (raw[i] === "\\") { i += 2; continue; }
        if (raw[i] === '"') break;
        i++;
      }
      current += raw.slice(start, i + 1);
      i++;
      continue;
    }

    // Track subshell depth
    if (ch === "(" && raw[i - 1] !== "$") depth++;
    if (ch === ")" && depth > 0) depth--;

    // Backtick subshell
    if (ch === "`") {
      const start = i;
      i++;
      while (i < raw.length && raw[i] !== "`") {
        if (raw[i] === "\\") i += 2;
        else i++;
      }
      // Extract content inside backticks as a sub-command
      const inner = raw.slice(start + 1, i);
      commands.push(...tokenizeCommands(inner));
      i++;
      continue;
    }

    // $(...) subshell
    if (ch === "$" && raw[i + 1] === "(") {
      const start = i + 2;
      i += 2;
      let sdepth = 1;
      while (i < raw.length && sdepth > 0) {
        if (raw[i] === "(") sdepth++;
        if (raw[i] === ")") sdepth--;
        i++;
      }
      // Extract content inside $(...) as a sub-command
      const inner = raw.slice(start, i - 1);
      commands.push(...tokenizeCommands(inner));
      continue;
    }

    // Process substitution <(...) or >(...)
    if ((ch === "<" || ch === ">") && raw[i + 1] === "(") {
      const start = i + 2;
      i += 2;
      let sdepth = 1;
      while (i < raw.length && sdepth > 0) {
        if (raw[i] === "(") sdepth++;
        if (raw[i] === ")") sdepth--;
        i++;
      }
      const inner = raw.slice(start, i - 1);
      commands.push(...tokenizeCommands(inner));
      continue;
    }

    // Command separators (only at depth 0)
    if (depth === 0) {
      if (ch === "|") {
        if (raw[i + 1] === "|") { i += 2; } // ||
        else { i++; }
        flushCommand();
        continue;
      }
      if (ch === "&" && raw[i + 1] === "&") {
        i += 2;
        flushCommand();
        continue;
      }
      if (ch === ";") {
        i++;
        flushCommand();
        continue;
      }
    }

    current += ch;
    i++;
  }
  flushCommand();
  return commands;

  function flushCommand() {
    const trimmed = current.trim();
    if (trimmed) {
      commands.push(splitArgv(trimmed));
    }
    current = "";
  }
}

/** Split a single command string into argv tokens. */
function splitArgv(cmd: string): string[] {
  const argv: string[] = [];
  let current = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;

  while (i < cmd.length) {
    const ch = cmd[i];

    if (inSingle) {
      if (ch === "'") { inSingle = false; i++; continue; }
      current += ch;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") { current += cmd.slice(i, i + 2); i += 2; continue; }
      if (ch === '"') { inDouble = false; i++; continue; }
      current += ch;
      i++;
      continue;
    }

    if (ch === "'") { inSingle = true; i++; continue; }
    if (ch === '"') { inDouble = true; i++; continue; }
    if (ch === " " || ch === "\t") {
      if (current) { argv.push(current); current = ""; }
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current) argv.push(current);
  return argv;
}

// ── detection ─────────────────────────────────────────────────

export interface BashGuardResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Check if a bash command attempts to write to gbrain.
 */
export function checkBashCommand(command: string): BashGuardResult {
  const commands = tokenizeCommands(command);

  for (const argv of commands) {
    if (argv.length === 0) continue;

    // Check for eval / bash -c / sh -c — recurse into their string arguments
    const basename = stripPath(argv[0]);
    if (basename === "eval" && argv.length > 1) {
      // eval takes a string that is itself a command
      const inner = argv.slice(1).join(" ");
      const result = checkBashCommand(inner);
      if (result.blocked) return result;
      continue;
    }
    if ((basename === "bash" || basename === "sh") && argv.includes("-c")) {
      const cIdx = argv.indexOf("-c");
      if (cIdx + 1 < argv.length) {
        const inner = argv[cIdx + 1];
        const result = checkBashCommand(inner);
        if (result.blocked) return result;
      }
      continue;
    }

    // Check for gbrain command
    if (basename === "gbrain" || basename === "gbrain.exe") {
      if (argv.length < 2) continue;
      const sub = argv[1];
      if (GBRAIN_WRITE_SUBCOMMANDS.has(sub)) {
        return { blocked: true, reason: `gbrain ${sub} is blocked in main session. Memory writes go through sediment.` };
      }
      if (sub === "sources" && argv.length > 2) {
        const subsub = argv[2];
        if (GBRAIN_SOURCE_MUTATIONS.has(subsub)) {
          return { blocked: true, reason: `gbrain sources ${subsub} is blocked in main session.` };
        }
      }
    }

    // Check for psql direct INSERT/UPDATE into pages table
    if (basename === "psql" || basename === "pgcli") {
      const full = argv.join(" ");
      if (/INSERT\s+INTO\s+pages/i.test(full) || /UPDATE\s+pages\s+SET/i.test(full)) {
        return { blocked: true, reason: "Direct database writes to gbrain pages are blocked. Use sediment." };
      }
    }
  }

  return { blocked: false };
}

/** Get basename from a path. */
function stripPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}
