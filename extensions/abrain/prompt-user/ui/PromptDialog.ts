/**
 * `<PromptDialog>` TUI component (ADR 0022 P2 §D2).
 *
 * Wizard-style sequential question UI rendered as an overlay via
 * `ctx.ui.custom(factory, { overlay: true })`. Each question takes the
 * full overlay; user answers it, presses Enter, dialog advances to the
 * next question. Esc cancels the entire dialog (resolves with
 * `outcome: "cancel"`).
 *
 * Variants:
 *   - `question`            (this ADR's main path; LLM-driven)
 *   - `vault_release`       (P3 will route authorizeVaultRelease here)
 *   - `bash_output_release` (P3 will route authorizeVaultBashOutput here)
 *
 * The variant only affects the visual chrome (border color hint /
 * title prefix); the answer collection logic is identical so all three
 * variants converge on the same `RawDialogResult` shape.
 *
 * P0 UX notes:
 *   - `single`: SelectList — Enter advances, Esc cancels.
 *   - `multi`:  SelectList in P0 — user picks one best match.
 *               `answers[id]` is `[chosen.label]` (length 1). Real
 *               multi-select toggle (space to flip, separate Submit
 *               row) is on the P3 backlog (ADR 0022 §4.5).
 *   - `text`:   Input — Enter submits, Esc cancels.
 *   - `secret`: MaskedInput (custom Component below) — Enter submits,
 *               Esc cancels. Raw never leaves this file; the buffer is
 *               cleared on `dispose`.
 *
 * Sub-pi: this file should NEVER be reached in sub-pi (handler guard
 * runs first). But as defense-in-depth, the masked-input buffer is
 * still wiped on dispose so that even an unexpected re-entry doesn't
 * leave plaintext sitting in component state.
 */

import type { PromptUserParams, PromptUserQuestion } from "../types";
import type { RawDialogResult } from "../service";

// We deliberately use the pi-tui runtime by string import inside the
// factory so smoke tests can dependency-inject the pi-tui surface. The
// production caller (`buildDialog` in index.ts wire-up) passes a real
// `{ Box, Container, Text, Input, SelectList, DynamicBorder }` bag.

export interface PiTuiBag {
  Container: new () => PiTuiContainer;
  Text: new (text: string, paddingX?: number, paddingY?: number) => PiTuiComponent;
  Input: new () => PiTuiInput;
  SelectList: new (
    items: Array<{ value: string; label: string; description?: string }>,
    maxVisible: number,
    theme: SelectListTheme,
  ) => PiTuiSelectList;
  DynamicBorder: new (paint: (s: string) => string) => PiTuiComponent;
}

interface SelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

export interface PiTuiComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate?(): void;
}

export interface PiTuiContainer extends PiTuiComponent {
  children: PiTuiComponent[];
  addChild(child: PiTuiComponent): void;
  clear(): void;
}

interface PiTuiInput extends PiTuiComponent {
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  focused: boolean;
  getValue(): string;
  setValue(value: string): void;
}

interface PiTuiSelectList extends PiTuiComponent {
  onSelect?: (item: { value: string; label: string }) => void;
  onCancel?: () => void;
}

export interface ThemeBag {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface TuiRuntime {
  requestRender(): void;
}

export interface BuildDialogArgs {
  params: PromptUserParams;
  variant: "question" | "vault_release" | "bash_output_release";
  tui: TuiRuntime;
  theme: ThemeBag;
  pitui: PiTuiBag;
  onDone: (result: RawDialogResult | null) => void;
}

/**
 * Custom masked input component. Maintains a single string buffer
 * (`buffer`) and renders one `•` per character. Wipes the buffer on
 * dispose / Esc / Enter-submit so memory residue is minimized.
 *
 * Why we don't reuse pi-tui Input: Input has no mask mode and exposes
 * `getValue()` publicly — convenient but increases the surface where a
 * stray log statement could echo raw secret. A purpose-built component
 * keeps the buffer scoped to this class.
 */
class MaskedInput implements PiTuiComponent {
  private buffer = "";
  focused = false;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;

  render(_width: number): string[] {
    const masked = "•".repeat(this.buffer.length);
    const cursor = this.focused ? "▏" : "";
    return [`  ${masked}${cursor}`];
  }

  handleInput(data: string): void {
    if (!data) return;
    // Enter
    if (data === "\r" || data === "\n") {
      const v = this.buffer;
      this.wipe();
      this.onSubmit?.(v);
      return;
    }
    // Escape
    if (data === "\x1b") {
      this.wipe();
      this.onEscape?.();
      return;
    }
    // Backspace / DEL
    if (data === "\x7f" || data === "\b") {
      if (this.buffer.length > 0) {
        this.buffer = this.buffer.slice(0, -1);
      }
      return;
    }
    // Filter control chars except above
    if (data.length === 1 && data.charCodeAt(0) < 0x20) return;
    // Append printable (or paste payload)
    this.buffer += data;
  }

  invalidate(): void { /* no-op; PromptDialog calls tui.requestRender */ }

  /** Explicit teardown — called on submit / escape / dispose so the
   * raw secret does not linger in this object reference. */
  wipe(): void {
    // Overwriting with same-length string then clearing helps the V8
    // GC drop the old buffer sooner. Not a hard guarantee, but cheap.
    this.buffer = "\0".repeat(this.buffer.length);
    this.buffer = "";
  }
}

/**
 * Build the PromptDialog component tree. Returns the root container
 * that `ctx.ui.custom`'s factory will hand back to pi-tui for rendering.
 *
 * The returned root is also the input router: when pi-tui delivers
 * `handleInput(data)` to the overlay, we forward it to the current
 * question's body component (SelectList / Input / MaskedInput).
 */
export function buildPromptDialog(args: BuildDialogArgs): PiTuiContainer {
  const { params, variant, tui, theme, pitui, onDone } = args;
  const root = new pitui.Container();

  // Color hint by variant — vault variants use a "warning" tinted
  // border so users perceive the elevated-trust nature immediately.
  const accentColor =
    variant === "question" ? "accent" :
    variant === "vault_release" ? "warning" :
    "warning";
  const paint = (s: string) => theme.fg(accentColor, s);

  // Mutable wizard state.
  let questionIndex = 0;
  const answers: Record<string, string[]> = {};
  const rawSecrets: Record<string, string> = {};
  // Track the active body so handleInput routes correctly.
  let activeBody: PiTuiComponent | null = null;
  // Track masked inputs so we can wipe them on dispose.
  const maskedInputs: MaskedInput[] = [];

  const finish = (outcome: "submit" | "cancel"): void => {
    // Wipe all masked-input buffers on the way out so cancel doesn't
    // leave secrets lying around in component state either.
    for (const m of maskedInputs) m.wipe();
    onDone({ outcome, answers, rawSecrets: outcome === "submit" ? rawSecrets : {} });
  };

  const buildForQuestion = (q: PromptUserQuestion): PiTuiComponent => {
    if (q.type === "single" || q.type === "multi") {
      const options = q.options ?? [];
      const items = options.map((opt) => ({
        value: opt.label,        // INV-D: redacted label is also the answer canonical form
        label: opt.recommended ? `★ ${opt.label}` : opt.label,
        description: opt.description,
      }));
      // Always append "Other (specify)" so user has a free-text escape.
      const OTHER_VALUE = "__pu_other__";
      items.push({ value: OTHER_VALUE, label: "Other (specify)", description: "Type a custom answer" });

      const selectList = new pitui.SelectList(items, Math.min(items.length, 10), {
        selectedPrefix: (t) => theme.fg(accentColor, t),
        selectedText: (t) => theme.fg(accentColor, t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      selectList.onSelect = (item) => {
        if (item.value === OTHER_VALUE) {
          // Swap body to an Input for free text.
          const input = new pitui.Input();
          input.focused = true;
          input.onSubmit = (val) => {
            answers[q.id] = [val];
            advance();
          };
          input.onEscape = () => finish("cancel");
          swapBody(input);
          return;
        }
        answers[q.id] = [item.value];
        advance();
      };
      selectList.onCancel = () => finish("cancel");
      return selectList;
    }
    if (q.type === "text") {
      const input = new pitui.Input();
      input.focused = true;
      input.onSubmit = (val) => {
        if (!val) {
          // Empty submit ≈ cancel — match Codex/Claude Code semantics:
          // pressing Enter on empty input rejects the question.
          finish("cancel");
          return;
        }
        answers[q.id] = [val];
        advance();
      };
      input.onEscape = () => finish("cancel");
      return input;
    }
    // secret
    const masked = new MaskedInput();
    masked.focused = true;
    masked.onSubmit = (val) => {
      // INV-C: stash the raw temporarily so service can compute
      // lengthBucket, then service.ts wipes it via rawSecrets reassign.
      rawSecrets[q.id] = val;
      // answers[id] is filled later by service.ts with the redacted
      // placeholder; here we set a sentinel so UI stops asking.
      answers[q.id] = ["[secret submitted]"];
      advance();
    };
    masked.onEscape = () => finish("cancel");
    maskedInputs.push(masked);
    return masked;
  };

  const swapBody = (next: PiTuiComponent): void => {
    activeBody = next;
    rebuildLayout();
    tui.requestRender();
  };

  const advance = (): void => {
    questionIndex += 1;
    if (questionIndex >= params.questions.length) {
      finish("submit");
      return;
    }
    activeBody = buildForQuestion(params.questions[questionIndex]);
    rebuildLayout();
    tui.requestRender();
  };

  const titlePrefix =
    variant === "question" ? "❓ Question" :
    variant === "vault_release" ? "🔒 Vault Release" :
    "🔒 Vault Bash Output";

  const rebuildLayout = (): void => {
    root.clear();
    root.addChild(new pitui.DynamicBorder(paint));
    root.addChild(
      new pitui.Text(theme.fg(accentColor, theme.bold(titlePrefix)), 1, 0),
    );
    root.addChild(new pitui.Text(theme.fg("muted", params.reason), 1, 0));
    root.addChild(new pitui.Text("", 0, 0));
    const q = params.questions[questionIndex];
    const progress = params.questions.length > 1
      ? ` (${questionIndex + 1}/${params.questions.length})`
      : "";
    root.addChild(
      new pitui.Text(
        theme.bold(`${q.header}${progress}`),
        1,
        0,
      ),
    );
    root.addChild(new pitui.Text(q.question, 1, 0));
    root.addChild(new pitui.Text("", 0, 0));
    if (activeBody) root.addChild(activeBody);
    root.addChild(new pitui.Text("", 0, 0));
    const hint = (q.type === "single" || q.type === "multi")
      ? "↑↓ navigate • enter select • esc cancel"
      : q.type === "text"
        ? "enter submit • esc cancel"
        : "enter submit (masked) • esc cancel";
    root.addChild(new pitui.Text(theme.fg("dim", hint), 1, 0));
    root.addChild(new pitui.DynamicBorder(paint));
  };

  // Initial layout.
  activeBody = buildForQuestion(params.questions[0]);
  rebuildLayout();

  // Wire root.handleInput so pi-tui forwards keystrokes to whichever
  // body we currently have. Container.handleInput is not defined
  // out-of-the-box; we mutate the root to route input.
  (root as PiTuiContainer & { handleInput?: (data: string) => void }).handleInput = (data: string) => {
    activeBody?.handleInput?.(data);
    tui.requestRender();
  };

  return root;
}

/**
 * Service-layer adapter: returns a `buildDialog` function shaped to
 * service.ts's `PromptDialogDeps` contract. The pi-tui surface is
 * supplied at activation time (from `extensions/abrain/index.ts` doing
 * `require("@earendil-works/pi-tui")`).
 */
export function makeBuildDialog(pitui: PiTuiBag): (
  args: {
    params: PromptUserParams;
    variant: "question" | "vault_release" | "bash_output_release";
    onDone: (result: RawDialogResult | null) => void;
    tui: unknown;
    theme: unknown;
    keybindings: unknown;
  },
) => unknown {
  return (a) =>
    buildPromptDialog({
      params: a.params,
      variant: a.variant,
      tui: a.tui as TuiRuntime,
      theme: a.theme as ThemeBag,
      pitui,
      onDone: a.onDone,
    });
}
