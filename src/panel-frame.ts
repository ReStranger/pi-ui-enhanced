import {
  Container,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

/**
 * Rounds the info panels core prints into the chat (`Package Updates
 * Available`, new-version notices, the changelog block).
 *
 * Core frames those panels with two `DynamicBorder` separators:
 *
 *   Spacer
 *   DynamicBorder   "─".repeat(width)
 *   ThemedText / Spacer / Markdown
 *   DynamicBorder
 *
 * The prototype patch below replaces that pair with the same ╭─╮ / ╰─╯ frame
 * the editor uses, so the notices match the input box.
 */

/** Paints a border glyph in the separator's color. */
export type BorderPainter = (text: string) => string;

/** Fallback painter for separators that carry no color. */
const noPaint: BorderPainter = (text) => text;

/** Class names core uses for the panel separators and their content. */
const RULE_CLASS_NAME = "DynamicBorder";
const STATIC_CONTENT_CLASS_NAMES = new Set([
  "Text",
  "ThemedText",
  "TruncatedText",
  "Spacer",
  "Markdown",
]);

/**
 * A notice panel holds a few children at most, so the backward walk gives up
 * after this many and never matches a separator higher up the transcript.
 */
const MAX_PANEL_SCAN = 32;

type ComponentShape = {
  constructor?: { name?: string };
  render?: unknown;
  color?: unknown;
};

function classNameOf(candidate: unknown): string {
  if (!candidate || typeof candidate !== "object") return "";
  return (candidate as ComponentShape).constructor?.name ?? "";
}

/** Horizontal separator created by core's `DynamicBorder`. */
export function isRuleComponent(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object") return false;
  if (classNameOf(candidate) !== RULE_CLASS_NAME) return false;
  return typeof (candidate as ComponentShape).render === "function";
}

/**
 * Returns true for the components core prints inside a notice. Interactive
 * components such as Input, SelectList, or Loader, and nested ones such as
 * Container or Image, mark a dialog or a tool panel, so the hook leaves those
 * alone.
 */
export function isStaticPanelContent(candidate: unknown): boolean {
  return STATIC_CONTENT_CLASS_NAMES.has(classNameOf(candidate));
}

/** Reads the color function core stored on the separator. */
function paintOf(candidate: unknown): BorderPainter {
  const color = (candidate as ComponentShape | undefined)?.color;
  return typeof color === "function" ? (color as BorderPainter) : noPaint;
}

/** `╭───╮` / `╰───╯` line of a panel frame. */
export class RoundedPanelBorder implements Component {
  private readonly kind: "top" | "bottom";
  private readonly paint: BorderPainter;

  constructor(kind: "top" | "bottom", paint: BorderPainter = noPaint) {
    this.kind = kind;
    this.paint = paint;
  }

  render(width: number): string[] {
    return [this.buildLine(width)];
  }

  invalidate(): void {
    // No cached state.
  }

  private buildLine(width: number): string {
    if (width <= 0) return "";
    const left = this.kind === "top" ? "╭" : "╰";
    const right = this.kind === "top" ? "╮" : "╯";
    if (width === 1) return this.paint(left);
    if (width === 2) return this.paint(`${left}${right}`);
    return this.paint(`${left}${"─".repeat(width - 2)}${right}`);
  }
}

/** Panel content with `│` on both sides. */
export class PanelBody implements Component {
  private readonly children: Component[];
  private readonly paint: BorderPainter;

  constructor(children: Component[], paint: BorderPainter = noPaint) {
    this.children = children;
    this.paint = paint;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const innerWidth = Math.max(0, width - 2);
    const lines: string[] = [];
    for (const child of this.children) {
      for (const line of child.render(innerWidth) ?? []) {
        lines.push(this.buildContentLine(width, line));
      }
    }
    return lines;
  }

  invalidate(): void {
    for (const child of this.children) {
      child.invalidate?.();
    }
  }

  /** Adds the side borders and pads the line to the inner width. */
  private buildContentLine(width: number, content: string): string {
    if (width <= 0) return "";
    if (width === 1) return this.paint("│");
    const innerWidth = Math.max(0, width - 2);
    const truncated = truncateToWidth(content, innerWidth);
    const padding = " ".repeat(
      Math.max(0, innerWidth - visibleWidth(truncated)),
    );
    return `${this.paint("│")}${truncated}${padding}${this.paint("│")}`;
  }
}

/**
 * Replaces a trailing `<rule> ...static content... <rule>` with a rounded
 * frame. Returns `true` when the separators were replaced.
 */
export function framePanelTail(children: Component[]): boolean {
  const bottomIndex = children.length - 1;
  if (bottomIndex < 0 || !isRuleComponent(children[bottomIndex])) return false;

  const scanFloor = Math.max(0, bottomIndex - MAX_PANEL_SCAN);
  let topIndex = -1;
  for (let index = bottomIndex - 1; index >= scanFloor; index -= 1) {
    if (isRuleComponent(children[index])) {
      topIndex = index;
      break;
    }
  }
  if (topIndex < 0) return false;

  const body = children.slice(topIndex + 1, bottomIndex);
  if (!body.every(isStaticPanelContent)) return false;

  const paint = paintOf(children[bottomIndex]);
  children.splice(
    topIndex,
    bottomIndex - topIndex + 1,
    new RoundedPanelBorder("top", paint),
    new PanelBody(body, paint),
    new RoundedPanelBorder("bottom", paint),
  );
  return true;
}

/**
 * The patch goes on `Container.prototype.addChild` rather than on core's
 * `InteractiveMode` methods: core and extensions share one
 * `@earendil-works/pi-tui` module instance, but core's own package resolves to
 * a different copy than extensions get, so a prototype patch on the latter
 * would miss the real class. `TuiBase extends Container`, so this covers the
 * renderer too.
 */
type PatchedPrototype = {
  addChild: (component: Component) => void;
  [INSTALLED_MARKER]?: true;
  [ORIGINAL_MARKER]?: (component: Component) => void;
};

// `Symbol.for` stops a second copy of this extension from patching twice.
const INSTALLED_MARKER = Symbol.for("pi-ui-enhanced.rounded-panels");
const ORIGINAL_MARKER = Symbol.for("pi-ui-enhanced.rounded-panels.original");

function patchTarget(): PatchedPrototype {
  // SAFETY: the marker symbols are set on this prototype and `addChild` is a
  // real method there; TS has no symbol-keyed view of it.
  return Container.prototype as unknown as PatchedPrototype;
}

/** Installs the hook. Returns `false` when it is already installed. */
export function installRoundedPanels(): boolean {
  const prototype = patchTarget();
  if (prototype[INSTALLED_MARKER]) return false;
  const original = prototype.addChild;
  if (typeof original !== "function") return false;

  prototype.addChild = function addChild(this: Container, component: Component): void {
    original.call(this, component);
    if (!isRuleComponent(component)) return;
    try {
      framePanelTail(this.children);
    } catch {
      // Framing is cosmetic, so a failure must not break chat rendering.
    }
  };
  prototype[ORIGINAL_MARKER] = original;
  prototype[INSTALLED_MARKER] = true;
  return true;
}

/** Restores core's `addChild`; already framed panels keep their frame. */
export function uninstallRoundedPanels(): boolean {
  const prototype = patchTarget();
  const original = prototype[ORIGINAL_MARKER];
  if (!prototype[INSTALLED_MARKER] || typeof original !== "function") {
    return false;
  }
  prototype.addChild = original;
  delete prototype[INSTALLED_MARKER];
  delete prototype[ORIGINAL_MARKER];
  return true;
}
