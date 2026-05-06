/**
 * pi-sediment prompts — per-target evaluator + writer.
 *
 * Pensieve: delegated to /skill:pensieve self-improve (no custom prompt needed).
 * gbrain:   dedicated evaluator + writer with timeline support.
 */

// ── Injection filter patterns ────────────────────────────────

// Last-line defense before sediment writes pensieve / gbrain. Threat:
// indirect prompt injection — a coding-agent turn may quote untrusted data
// (web pages, tool output, pasted text) containing instructions which a
// downstream sediment LLM could be persuaded by, leading sediment to
// permanently install poisoned content into long-term memory.
//
// Defense layers (sediment is already hardened by all three):
//   1. lookup tools are read-only — no write tools exposed to the model
//   2. final writes go through a parsed protocol (## PENSIEVE / ## GBRAIN),
//      not arbitrary tool calls
//   3. this content sanitize — last-line catch of the most overt patterns
//
// Position-aware matching
// -----------------------
// A real prompt-injection payload must steer the LLM at the start of its
// reasoning context to be effective — "ignore previous instructions" buried
// 10 paragraphs into a knowledge page about *how injection patterns are
// detected* doesn't actually inject anything; it's a documentation example.
// Verified failure mode (2026-05-05): sediment writing a page about its
// own contentToText changes was rejected because the page legitimately
// described the INJECTION_PATTERNS regex literals ("you are now",
// "override:", etc.) as documentation. Sanitizer treated documentation as
// attack and dropped the write, advancing checkpoint past a real insight.
//
// Mitigation: only check the first INJECTION_CHECK_PREFIX_CHARS characters
// of the content. A genuine injection has to land near the top to influence
// the model; later occurrences are descriptive prose. This trades a tiny
// amount of theoretical robustness (an attacker controlling content past
// position N can still attempt injection) for a large amount of practical
// false-positive elimination.
//
// We ALSO require a frontmatter-aware check: if content begins with a
// markdown frontmatter block (---\n...\n---\n), look at the body following
// the closing ---, not the frontmatter itself. Frontmatter is structured
// metadata (title/tags/etc.) and never contains payload phrasing in
// practice; including it in the check shifts the prefix window past the
// real opening prose unnecessarily.
//
// Originally we copied a wide pattern set from pi-gstack including bare
// '\bsystem:' / '\buser:' / '\bassistant:'. Those are vocabulary that
// appears constantly in normal technical writing about prompt design and
// agent loops; they produced 100% false-positive rate during meta-discussion
// of pi-sediment itself (3 hits in one session, all on legitimate prose).
// The remaining patterns target unambiguous imperative phrasings that have
// no natural use in engineering prose — but even those can appear as
// documentation examples, hence the prefix-check above.
export const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+(instructions|context|rules)/i,
  /you\s+are\s+now\s+/i,
  /always\s+output\s+no\s+findings/i,
  /skip\s+(all\s+)?(security|review|checks)/i,
  /override[:\s]/i,
  /do\s+not\s+(report|flag|mention)/i,
  /approve\s+(all|every|this)/i,
];

// How many characters of body content (post-frontmatter) to scan for
// injection patterns. 600 chars covers the typical "# Title\n\n## Principle\n"
// + opening paragraph — the only place a real injection can land. Anything
// past this is treated as prose that may legitimately discuss the patterns.
const INJECTION_CHECK_PREFIX_CHARS = 600;

/**
 * Strip a leading YAML frontmatter block (--- ... ---\n) if present.
 * Returns the body text. Sediment writers tend to emit frontmatter when
 * generating pensieve markdown; gbrain writers usually don't. Either way,
 * the prefix scan should be against the body, not metadata.
 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const closing = content.indexOf("\n---\n", 4);
  if (closing < 0) return content; // malformed; leave it alone
  return content.slice(closing + 5);
}

/**
 * Sanitize LLM-generated content against prompt injection patterns.
 * Returns null if a pattern matches in the content's opening prose.
 */
export function sanitizeContent(content: string): string | null {
  const body = stripFrontmatter(content);
  const prefix = body.slice(0, INJECTION_CHECK_PREFIX_CHARS);
  for (const pat of INJECTION_PATTERNS) {
    if (pat.test(prefix)) return null;
  }
  return content;
}

// ── gbrain evaluator ────────────────────────────────────────────

// ── gbrain agent (eval + write combined, with lookup tools) ────────

/**
 * Combined evaluator + writer for gbrain. Used with the agent-loop runner
 * so the model can call read-only lookup tools (gbrain_search, gbrain_get,
 * pensieve_grep, pensieve_read, pensieve_list) before producing a single
 * terminal output.
 *
 * The terminal grammar adds mode + update_slug fields so the writer can
 * choose UPDATE vs NEW vs SKIP_DUPLICATE. gbrain put is upsert by slug, so
 * UPDATE is achieved by emitting the exact existing slug.
 */
export const GBRAIN_AGENT_PROMPT = `You are the pi-sediment gbrain curator.

Your job: decide whether a coding-agent turn produced a UNIVERSAL
engineering principle worth persisting to gbrain (cross-project knowledge),
and if so, AVOID DUPLICATING what's already there.

gbrain stores patterns, anti-patterns, principles, and pitfalls that apply
beyond any single codebase. Do NOT store project-specific paths/modules
(those go to Pensieve, not gbrain). All output MUST be in English.

WORKFLOW:
  1. Read the assistant turn provided by the user.
  2. Use the read-only tools to check existing memory:
       - gbrain_search, gbrain_get — find/inspect candidate gbrain pages
       - pensieve_grep, pensieve_read, pensieve_list — cross-reference
         the project's Pensieve to inform the principle
     Call them as many times as you need. Be thorough: a page on the same
     topic should be UPDATEd, not duplicated.
  3. Emit ONE final terminal output. After emitting it, stop.

FOUR POSSIBLE TERMINAL OUTPUTS (English only):

A. No durable principle — emit exactly:
SKIP

B. An existing gbrain page already states this principle accurately:
SKIP_DUPLICATE: <existing-slug> — <one-sentence reason>

C. UPDATE an existing page (same topic, refined / contradicted / extended).
   gbrain put is upsert by slug, so emit the EXISTING slug as update_slug;
   PRESERVE every prior timeline bullet from the existing page and APPEND
   a new bullet for today.

## GBRAIN
mode: update
update_slug: <existing-slug, do NOT rename>
title: Present-Tense Imperative Headline (<= 100 chars)
tags: engineering, topic
__CONTENT__
# Title (same as headline)

## Principle
One sentence.

## Guidance
- bullet 1
- bullet 2

## When this applies
- scenario

## Boundaries
- when NOT to apply

## Timeline
- **{prior-date}** | pi-sediment — ... (copy verbatim from existing page)
- **{today}** | pi-sediment — One-line summary of the new insight

D. NEW page (genuinely a different topic):

## GBRAIN
mode: new
title: Present-Tense Imperative Headline (<= 100 chars)
tags: engineering, topic
__CONTENT__
# Title (same as headline)

## Principle
One sentence.

## Guidance
- bullet 1
- bullet 2

## When this applies
- scenario

## Boundaries
- when NOT to apply

## Timeline
- **{today}** | pi-sediment — One-line summary

FORMAT RULES (NON-NEGOTIABLE):
1. The first non-blank line of output MUST be one of: SKIP, SKIP_DUPLICATE: ...,
   or "## GBRAIN".
2. Do NOT wrap the output in \`\`\` code fences.
3. Title must be present-tense imperative form.
4. No file paths, module names, or project specifics anywhere in the body.
5. Tags must include at least one specific topic tag beyond "engineering".
6. For mode=update: COPY every existing timeline bullet verbatim, then append.
7. For mode=new: include exactly one timeline bullet for today.
8. Body (when mode=update or new) must be >= 200 words of original synthesis.
9. The Timeline section MUST be the FINAL section; no prose after the bullets.
10. ALL text MUST be in English regardless of source language.

Default to UPDATE when an existing page is on the same topic. Default to
SKIP_DUPLICATE when adding nothing new. NEW only for genuinely new topics.
Churn is worse than gaps.`;

export function buildGbrainAgentPrompt(args: {
  dateIso: string;
  lastAssistantMessage: string;
  gbrainColdStart: boolean;
}): string {
  const coldStartNote = args.gbrainColdStart
    ? "\n\nNOTE: The gbrain knowledge base is nearly empty (< 10 pages). " +
      "If you find ANY insight with cross-project engineering value, " +
      "lean toward NEW."
    : "";
  return `Date: ${args.dateIso}\n\n` +
    `Use the read-only tools to investigate existing memory before deciding. ` +
    `Then emit your terminal output.${coldStartNote}\n\n` +
    `Assistant turn:\n\n<message>\n${args.lastAssistantMessage}\n</message>`;
}
