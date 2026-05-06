/**
 * guard-path — intercept write/edit/bash tool calls to block modifications
 * to gbrain routing markers and memory cache files.
 *
 * Part of pi-stack ADR 0003 Guard 2: the main session must not write to:
 *   - .gbrain-source / .gbrain-scratch / .gbrain-config (routing markers)
 *   - .gbrain-cache/ (sediment.log, pending.jsonl, markdown/*.md)
 *   - ~/.gbrain/ (brain config directory)
 *
 * Uses realpath resolution to prevent symlink bypass attacks.
 */

import type { ToolCallEvent } from "@mariozechner/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

// ── protected patterns ────────────────────────────────────────

const PROTECTED_PATTERNS = [
  /(^|\/)\.gbrain-source($|\/)/,
  /(^|\/)\.gbrain-scratch($|\/)/,
  /(^|\/)\.gbrain-config($|\/)/,
  /(^|\/)\.gbrain-cache\//,
  /\/\.gbrain\//,
];

// ── detection ─────────────────────────────────────────────────

export interface PathGuardResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Check if a path is protected. Tries realpath resolution first,
 * falls back to the raw path if the file doesn't exist yet.
 */
export function isProtectedPath(inputPath: string, cwd?: string): boolean {
  const full = cwd ? resolve(cwd, inputPath) : resolve(inputPath);

  // Try realpath (follows symlinks) — if the file exists
  let resolved = full;
  try {
    if (existsSync(full)) {
      resolved = realpathSync(full);
    }
  } catch {
    // File doesn't exist or no permission — use raw path
  }

  return PROTECTED_PATTERNS.some((p) => p.test(resolved));
}

/**
 * Check a tool_call event for path modifications.
 * Handles write tool (input.path), edit tool (input.path), and bash tool
 * (command contains redirects or writes to protected paths).
 */
export function checkPathEvent(
  event: ToolCallEvent,
  cwd?: string,
): PathGuardResult {
  // Handle write / edit tools — check input.path
  if (event.toolName === "write" || event.toolName === "edit") {
    const path = (event.input as any)?.path;
    if (path && isProtectedPath(String(path), cwd)) {
      return {
        blocked: true,
        reason: `Cannot ${event.toolName} to ${path}: this path is part of gbrain memory infrastructure and is protected from LLM modifications.`,
      };
    }
  }

  // Handle bash tool — check for redirects to protected paths
  if (event.toolName === "bash") {
    const command = String((event.input as any)?.command ?? "");
    // Check for > or >> redirect targets
    const redirectMatch = command.match(/(?:^|\s)(?:[12]?>>?)\s*(\S+)/g);
    if (redirectMatch) {
      for (const m of redirectMatch) {
        const target = m.replace(/^\s*(?:[12]?>>?)\s*/, "");
        if (target && isProtectedPath(target, cwd)) {
          return {
            blocked: true,
            reason: `Cannot redirect output to ${target}: this path is part of gbrain memory infrastructure and is protected.`,
          };
        }
      }
    }
  }

  return { blocked: false };
}
