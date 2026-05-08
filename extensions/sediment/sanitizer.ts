import * as os from "node:os";

export interface SanitizeResult {
  ok: boolean;
  text?: string;
  error?: string;
  replacements: string[];
}

const CREDENTIAL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "openai_api_key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "anthropic_api_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "github_token", re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { name: "generic_secret_assignment", re: /\b(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_./+\-=]{16,}/gi },
];

export function sanitizeForMemory(input: string): SanitizeResult {
  const replacements: string[] = [];
  let text = input;

  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.re.test(text)) {
      return {
        ok: false,
        error: `credential pattern detected: ${pattern.name}`,
        replacements,
      };
    }
  }

  const home = os.homedir();
  if (home && text.includes(home)) {
    text = text.split(home).join("$HOME");
    replacements.push("home_path");
  }

  const ipRe = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  if (ipRe.test(text)) {
    text = text.replace(ipRe, "[HOST]");
    replacements.push("ip_address");
  }

  const emailRe = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  if (emailRe.test(text)) {
    text = text.replace(emailRe, "[EMAIL]");
    replacements.push("email");
  }

  return { ok: true, text, replacements };
}
