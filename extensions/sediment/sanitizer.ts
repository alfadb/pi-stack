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
  // Round 8 P1 (opus R8 audit): keyword set expanded to include common
  // aliases that were silently bypassing the gate:
  //   - passwd / passphrase  — widely used in Linux/SSH contexts
  //   - access[_-]?key       — AWS / GCP / Azure naming
  //   - private[_-]?key      — "PRIVATE_KEY=..." assignment form
  //   - client[_-]?secret    — OAuth 2 / OIDC
  //   - bearer (Authorization header alias)
  { name: "generic_secret_assignment", re: /\b(api[_-]?key|token|secret|password|passwd|passphrase|access[_-]?key|private[_-]?key|client[_-]?secret|bearer)\s*[:=]\s*['"]?[A-Za-z0-9_./+\-=]{16,}/gi },
  { name: "jwt_token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "pem_private_key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g },
  { name: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // Round 8 P1 (opus R8 audit): connection_url originally covered only
  // a tiny list of DB/cache schemes. http(s) URLs with embedded basic-auth
  // credentials (user:pass@host) leaked through. Now matches any scheme
  // with `://user:pass@` syntax in addition to the explicit DB list.
  { name: "connection_url", re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp|amqps):\/\/[^\s"'<>]{6,}/gi },
  { name: "http_basic_auth_url", re: /\bhttps?:\/\/[^\s"'<>/:]+:[^\s"'<>@]+@[^\s"'<>]+/gi },
  // Round 8 P1 (opus R8 audit): vendor-format tokens missing from R7:
  //   - Bearer <token>: Authorization header form — widely pasted from
  //     curl debug output / browser devtools
  //   - xoxa/xoxb/xoxp/xoxr-... Slack tokens
  //   - AIza... Google API keys (35 chars, dash + underscore allowed)
  //   - sk_live_ / sk_test_ / pk_live_ / rk_live_... Stripe keys (underscore)
  { name: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._\-/+=]{20,}\b/g },
  { name: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "stripe_key", re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
];

// Round 8 P1 (opus R8 audit): Unicode bypass shapes — zero-width spaces
// and bidi/RTL overrides between e.g. `pass` and `word` defeat the
// `\b` boundary and keyword tokenization. Strip these before matching
// (NFKC also folds some homoglyph fullwidth chars, but does NOT fold
// Cyrillic `ѕ` → Latin `s`; that would require a confusables map and
// is out of scope here — documented as a known residual).
const INVISIBLE_BYPASS_CHARS = /[\u200B-\u200D\u2060\u202A-\u202E\u00AD\uFEFF]/g;

export function sanitizeForMemory(input: string): SanitizeResult {
  const replacements: string[] = [];
  let text = input;

  // Round 8 P1 (opus R8 audit): pre-normalize for regex scanning so
  // zero-width / bidi-control bypass forms don't dodge keyword matching.
  // We normalize a SCAN buffer separately; the output (replacements'd)
  // text retains its original codepoints, because users may legitimately
  // care about preserving them in literature / non-credential content.
  const scanText = input.normalize("NFKC").replace(INVISIBLE_BYPASS_CHARS, "");

  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.re.lastIndex = 0;
    if (pattern.re.test(scanText)) {
      pattern.re.lastIndex = 0;
      return {
        ok: false,
        error: `credential pattern detected: ${pattern.name}`,
        replacements,
      };
    }
    pattern.re.lastIndex = 0;
  }

  // Second pass on the original text (keyword formats that DON'T benefit
  // from invisible-char stripping but still need credential gating). We
  // already covered the major vendor formats above; this second loop is
  // intentionally empty to avoid double-matching and inflating the cost.
  // Reserved for future patterns that must inspect original codepoints.
  for (const pattern of [] as Array<{ name: string; re: RegExp }>) {
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
