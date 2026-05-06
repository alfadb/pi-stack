/**
 * marker-scanner — checks agent_end context for prompt injection markers.
 *
 * Part of pi-stack ADR 0004 § prompt-injection defense, Layer 2.
 * Scans ONLY the untrusted content block (inside <UNTRUSTED_AGENT_END_CONTEXT>),
 * not the vote prompt preamble.
 *
 * Uses NFKC normalization to detect Unicode homoglyph attacks.
 * Case-insensitive matching.
 */

// ── markers ────────────────────────────────────────────────────

const MARKERS: RegExp[] = [
  // Role hijack
  /ignore\s+(previous|all\s+above)/i,
  /system:/i, /developer:/i,
  /<\|im_start\|>system/i, /<\|system\|>/i,
  // Anthropic RLHF format
  /\n\nHuman:/i, /^Human:/im,
  /\n\nAssistant:/i, /^Assistant:/im,
  // Llama format
  /\[INST\]/i, /<<SYS>>/i, /\[\/INST\]/i,
  // Voter/Writer override
  /voter\s+override/i,
  /memory\s+writer\s+override/i,
  // Fake field values
  /tier[:=]\s*maxim/i,
  /scope[:=]\s*cross-project/i,
  /confidence[:=]\s*(10|nine|ten)/i,
  // JSON inline injection
  /"tier"\s*:\s*"maxim"/i,
  /"scope"\s*:\s*"cross-project"/i,
  /"confidence"\s*:\s*10/i,
  // Tag escape (with optional backslash prefix)
  /\\*<\/?\s*UNTRUSTED_AGENT_END_CONTEXT/i,
  // Unicode homoglyphs (NFKC-normalized)
  /[oо]verride/i,   // Cyrillic о
  /[iі]gnore\s+(previous|all)/i,  // Cyrillic і
];

// ── scanner ────────────────────────────────────────────────────

export interface MarkerScanResult {
  injectionSuspected: boolean;
  matchedMarkers: string[];
}

/**
 * Scan untrusted content for prompt injection markers.
 *
 * IMPORTANT: Only scans content inside <UNTRUSTED_AGENT_END_CONTEXT> tags.
 * The vote prompt preamble contains legitimate instances of "system:" etc.
 */
export function scanMarkers(untrustedContent: string): MarkerScanResult {
  const normalized = untrustedContent.normalize("NFKC");
  const matched: string[] = [];

  for (const marker of MARKERS) {
    if (marker.test(normalized)) {
      // Extract a readable label from the regex source
      const src = marker.source;
      matched.push(src.length > 40 ? src.slice(0, 40) + "..." : src);
    }
  }

  return {
    // Require at least 2 markers to trigger injection alert
    // (avoids false positives from single legitimate mentions like "system: Linux")
    injectionSuspected: matched.length >= 2,
    matchedMarkers: matched,
  };
}

/**
 * Extract the untrusted content block from a vote prompt or agent_end context.
 */
export function extractUntrustedBlock(text: string): string {
  const match = text.match(
    /<UNTRUSTED_AGENT_END_CONTEXT>([\s\S]*?)<\/UNTRUSTED_AGENT_END_CONTEXT>/i,
  );
  return match ? match[1] : text; // fallback: scan entire text if no tag found
}
