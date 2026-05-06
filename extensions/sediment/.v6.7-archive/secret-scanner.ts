/**
 * secret-scanner — detect secrets in agent_end context before they reach
 * voter prompts, audit logs, or pending queue.
 *
 * Part of pi-stack ADR 0004 § secret scan.
 * Used both pre-voter (redact before dispatch) and pre-write (block gbrain put).
 */

// ── deny-list ──────────────────────────────────────────────────

interface SecretPattern {
  name: string;
  pattern: RegExp;
  replace: (match: string) => string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: "openai_api_key",
    pattern: /sk-[A-Za-z0-9_-]{20,}/g,
    replace: (m) => `[REDACTED:openai_key:${hash8(m)}]`,
  },
  {
    name: "slack_token",
    pattern: /xox[bpr]-[A-Za-z0-9-]+/g,
    replace: (m) => `[REDACTED:slack_token:${hash8(m)}]`,
  },
  {
    name: "google_api_key",
    pattern: /AIza[A-Za-z0-9_-]{30,}/g,
    replace: (m) => `[REDACTED:google_key:${hash8(m)}]`,
  },
  {
    name: "github_pat",
    pattern: /ghp_[A-Za-z0-9]{36,}/g,
    replace: (m) => `[REDACTED:github_pat:${hash8(m)}]`,
  },
  {
    name: "gitlab_pat",
    pattern: /glpat-[A-Za-z0-9_-]{20,}/g,
    replace: (m) => `[REDACTED:gitlab_pat:${hash8(m)}]`,
  },
  {
    name: "private_key_pem",
    pattern: /-----BEGIN\s+PRIVATE\s+KEY-----/gi,
    replace: (_m) => `[REDACTED:private_key_pem]`,
  },
  {
    name: "postgres_credential",
    pattern: /postgres:\/\/[^@]+@/gi,
    replace: (m) => {
      const before = m.slice(0, 12); // postgres://
      return `${before}[REDACTED:pg_cred:${hash8(m)}]@`;
    },
  },
  {
    name: "jwt_token",
    pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}/g,
    replace: (m) => `[REDACTED:jwt:${hash8(m)}]`,
  },
];

// ── helpers ────────────────────────────────────────────────────

function hash8(input: string): string {
  // Simple hash for audit log tracking (not cryptographic — just for
  // correlating a redacted value with its original without storing it)
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).slice(0, 8).padStart(8, "0");
}

// ── scanner ────────────────────────────────────────────────────

export interface SecretScanResult {
  passed: boolean;
  redacted: string;
  hits: number;
  patterns: string[];
  contentHash?: string;
}

/**
 * Scan text for secrets and redact them.
 * Returns the redacted text, hit count, and matched pattern names.
 */
export function scanAndRedact(text: string): SecretScanResult {
  let result = text;
  let hits = 0;
  const matchedPatterns: string[] = [];

  for (const sp of SECRET_PATTERNS) {
    // Reset lastIndex since we reuse the regex
    sp.pattern.lastIndex = 0;
    let match;
    while ((match = sp.pattern.exec(result)) !== null) {
      hits++;
      if (!matchedPatterns.includes(sp.name)) {
        matchedPatterns.push(sp.name);
      }
      // We can't just replace in place while iterating with exec,
      // so track and replace after the loop
    }
    // Replace all matches at once
    sp.pattern.lastIndex = 0;
    result = result.replace(sp.pattern, sp.replace);
  }

  return {
    passed: hits === 0,
    redacted: result,
    hits,
    patterns: matchedPatterns,
  };
}

/**
 * Quick check — does text contain any secrets? (fast path, no redaction)
 */
export function hasSecrets(text: string): boolean {
  for (const sp of SECRET_PATTERNS) {
    sp.pattern.lastIndex = 0;
    if (sp.pattern.test(text)) return true;
  }
  return false;
}
