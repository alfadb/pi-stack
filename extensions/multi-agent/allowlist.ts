/**
 * allowlist — enforce tool access policy for sub-agent dispatch.
 *
 * Part of pi-stack ADR 0009 § 子代理工具安全边界.
 *
 * Default policy:
 *   - No tools by default (tools="" or undefined → [])
 *   - "readonly" alias → read, grep, find, ls, gbrain_search, gbrain_get, gbrain_query
 *   - vision, imagine → allowed
 *   - bash, edit, write → BLOCKED unless PI_MULTI_AGENT_ALLOW_MUTATING=1
 *   - multi_dispatch itself → BLOCKED (no nested dispatch)
 *   - unknown tools → BLOCKED
 */

// ── tool categories ────────────────────────────────────────────

const READONLY_TOOLS = new Set([
  "read", "grep", "find", "ls",
  "gbrain_search", "gbrain_get", "gbrain_query",
]);

const VISION_TOOLS = new Set(["vision", "imagine"]);

const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);

const BLOCKED_TOOLS = new Set([
  "multi_dispatch",    // no nested dispatch
  "dispatch_agent",    // no nested dispatch
  "dispatch_agents",   // no nested dispatch
]);

// ── validation ─────────────────────────────────────────────────

export interface AllowlistResult {
  allowed: string[];
  blocked: string[];
  warnings: string[];
}

/**
 * Parse and validate a tools CSV string for a sub-agent task.
 */
export function validateToolAllowlist(
  toolsStr: string | undefined,
  model: string,
): AllowlistResult {
  const warnings: string[] = [];

  // Handle "readonly" alias
  if (toolsStr === "readonly" || toolsStr === "readonly,") {
    return {
      allowed: [...READONLY_TOOLS],
      blocked: [],
      warnings: ["tools='readonly' expanded to read,grep,find,ls,gbrain_search,gbrain_get,gbrain_query"],
    };
  }

  // Empty or undefined → no tools
  if (!toolsStr || toolsStr.trim() === "") {
    return { allowed: [], blocked: [], warnings };
  }

  const requested = toolsStr
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const allowed: string[] = [];
  const blocked: string[] = [];

  for (const tool of requested) {
    // Explicitly blocked
    if (BLOCKED_TOOLS.has(tool)) {
      blocked.push(tool);
      warnings.push(`Tool "${tool}" is blocked: nested dispatch not allowed`);
      continue;
    }

    // Readonly tools — always allowed
    if (READONLY_TOOLS.has(tool)) {
      allowed.push(tool);
      continue;
    }

    // Vision tools — allowed
    if (VISION_TOOLS.has(tool)) {
      allowed.push(tool);
      continue;
    }

    // Mutating tools — blocked by default
    if (MUTATING_TOOLS.has(tool)) {
      if (process.env.PI_MULTI_AGENT_ALLOW_MUTATING === "1") {
        allowed.push(tool);
        warnings.push(`Tool "${tool}" allowed because PI_MULTI_AGENT_ALLOW_MUTATING=1 (use with caution)`);
      } else {
        blocked.push(tool);
        warnings.push(`Tool "${tool}" blocked: mutating tools require PI_MULTI_AGENT_ALLOW_MUTATING=1`);
      }
      continue;
    }

    // Unknown tool — blocked
    blocked.push(tool);
    warnings.push(`Tool "${tool}" blocked: not in the sub-agent tool allowlist`);
  }

  return { allowed, blocked, warnings };
}

/**
 * Check if a sub-agent should be completely denied based on its tool access.
 */
export function isEscalationAttempt(result: AllowlistResult): boolean {
  return result.blocked.length > 0 && result.allowed.length === 0;
}

/**
 * Format allowlist violations for user feedback.
 */
export function formatAllowlistReport(result: AllowlistResult): string {
  const parts: string[] = [];

  if (result.allowed.length > 0) {
    parts.push(`Allowed: ${result.allowed.join(", ")}`);
  }
  if (result.blocked.length > 0) {
    parts.push(`Blocked: ${result.blocked.join(", ")}`);
  }
  if (result.warnings.length > 0) {
    parts.push(result.warnings.join("; "));
  }

  return parts.join("\n");
}
