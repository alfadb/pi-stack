import * as os from "node:os";

export interface SanitizeResult {
  ok: boolean;
  text?: string;
  error?: string;
  replacements: string[];
}

// Patterns are checked in order. The list deliberately mixes hard
// vendor formats (sk-..., AKIA..., gh*_, eyJ.eyJ.<sig>) with shape-based
// heuristics (PEM blocks, secret-looking assignments, scheme://creds).
//
// Each match aborts the whole sanitize call (see sanitizeForMemory:
// `return { ok: false, ... }`) — there is no "replace and continue" for
// credentials. This is by design: if the LLM extractor fed us anything
// resembling a credential we want a hard reject, not a partial scrub
// that hides the problem.
//
// ADR 0016 retained sensitive-info hard gate:
//   - jwt_token       defends against `eyJ...` access/id tokens leaking
//                     from headers / debug dumps.
//   - pem_private_key catches the `-----BEGIN ... PRIVATE KEY-----`
//                     header. The body is intentionally NOT matched —
//                     header alone is sufficient to fail-closed and
//                     keeps the regex engine cheap.
//   - aws_access_key  AKIA / ASIA + 16 uppercase alphanumerics. The
//                     companion secret key is shape-only (40 chars) so
//                     we don't try to detect it independently — but the
//                     access-key ID is enough signal to reject.
//   - connection_url  scheme://user:pass@host or scheme://...token...
//                     for common DB/cache schemes. `sqlite://` is
//                     intentionally excluded (local file paths are not
//                     credentials and would false-positive constantly).
const CREDENTIAL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "openai_api_key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "anthropic_api_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "github_token", re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { name: "generic_secret_assignment", re: /\b(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_./+\-=]{16,}/gi },
  { name: "jwt_token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "pem_private_key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g },
  { name: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "connection_url", re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp|amqps):\/\/[^\s"'<>]{6,}/gi },
];

export function sanitizeForMemory(input: string): SanitizeResult {
  const replacements: string[] = [];
  let text = input;

  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.re.lastIndex = 0;
    if (pattern.re.test(text)) {
      pattern.re.lastIndex = 0;
      return {
        ok: false,
        error: `credential pattern detected: ${pattern.name}`,
        replacements,
      };
    }
    pattern.re.lastIndex = 0;
  }

  const home = os.homedir();
  if (home && text.includes(home)) {
    text = text.split(home).join("$HOME");
    replacements.push("home_path");
  }

  const ipRe = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  ipRe.lastIndex = 0;
  if (ipRe.test(text)) {
    ipRe.lastIndex = 0;
    text = text.replace(ipRe, "[HOST]");
    replacements.push("ip_address");
  }

  const emailRe = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  emailRe.lastIndex = 0;
  if (emailRe.test(text)) {
    emailRe.lastIndex = 0;
    text = text.replace(emailRe, "[EMAIL]");
    replacements.push("email");
  }

  return { ok: true, text, replacements };
}
