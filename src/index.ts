export type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  CustomEditor,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
} from "@earendil-works/pi-tui";

let currentModelId = "pi";
let currentThinkingLevel = "off";
let isWorking = false;
let spinnerIndex = 0;
let spinnerTimer: ReturnType<typeof setInterval> | undefined;
let activeTui: TUI | undefined;
const STATUS_THINKING_WIDTH = 9;
const WORKING_MESSAGE = "Working";
const BORDER_MIN_GAP = 3;
const WORKING_SPINNER_INTERVAL_MS = 80;
const WORKING_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

// Blank/missing levels display as "off"; unknown non-blank names are kept
// verbatim so the status border shows whatever the session reported.
function normalizeThinkingLevelLabel(level: string): string {
  return level.trim() || "off";
}

export function setEditorStatusLabel(state: {
  modelId?: string;
  thinkingLevel?: string;
}): void {
  if (typeof state.modelId === "string") {
    currentModelId = state.modelId.trim() || "pi";
  }
  if (typeof state.thinkingLevel === "string") {
    currentThinkingLevel = normalizeThinkingLevelLabel(state.thinkingLevel);
  }
}

function stopWorkingSpinner(): void {
  if (!spinnerTimer) return;

  clearInterval(spinnerTimer);
  spinnerTimer = undefined;
}

export function setEditorWorking(working: boolean): void {
  const wasWorking = isWorking;
  isWorking = working;

  if (!working) {
    spinnerIndex = 0;
    stopWorkingSpinner();
    activeTui?.requestRender();
    return;
  }

  if (!wasWorking) {
    spinnerIndex = 0;
  }

  // Nothing to animate until a rounded editor is mounted. Without this guard a
  // subagent-triggered start could spin a timer for a session that never gets
  // an editor of its own.
  if (!activeTui) return;

  if (!spinnerTimer) {
    spinnerTimer = setInterval(() => {
      spinnerIndex = (spinnerIndex + 1) % WORKING_SPINNER_FRAMES.length;
      activeTui?.requestRender();
    }, WORKING_SPINNER_INTERVAL_MS);
    // The timer only drives renders, so it must never hold the process open on
    // its own if it outlives the session that started it.
    unrefTimer(spinnerTimer);
  }

  activeTui.requestRender();
}

export function resetEditorWorkingState(): void {
  isWorking = false;
  spinnerIndex = 0;
  stopWorkingSpinner();
  activeTui = undefined;
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  // SAFETY: timeouts are plain numbers under the DOM typings and Timeout
  // objects under Node's; only the latter can be detached from the event
  // loop, so the optional call is safe under either typing.
  (timer as unknown as { unref?: () => void }).unref?.();
}

function buildBoxedContentLine(
  width: number,
  content: string,
  borderColor: (text: string) => string,
): string {
  if (width <= 0) return "";
  if (width === 1) return borderColor("│");

  const innerWidth = Math.max(0, width - 2);
  const truncated = truncateToWidth(content, innerWidth);
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
  return `${borderColor("│")}${truncated}${padding}${borderColor("│")}`;
}

function buildStatusBorderLine(
  width: number,
  left: string,
  right: string,
  borderColor: (text: string) => string,
): string {
  if (width <= 0) return "";
  if (width === 1) return borderColor(left);
  if (width === 2) return borderColor(`${left}${right}`);

  const innerWidth = Math.max(0, width - 2);
  const rightWidth = Math.min(
    Math.max(0, innerWidth - 1),
    STATUS_THINKING_WIDTH,
  );
  const leftWidth = Math.max(0, innerWidth - rightWidth - 1);
  const leftLabel = truncateToWidth(` ${currentModelId} `, leftWidth, "");
  const rightLabel = truncateToWidth(
    ` ${currentThinkingLevel} `,
    rightWidth,
    "",
  );
  const leftFill = "─".repeat(Math.max(0, leftWidth - visibleWidth(leftLabel)));
  const rightFill = "─".repeat(
    Math.max(0, rightWidth - visibleWidth(rightLabel)),
  );

  const leftSegment = `${left}${leftFill}${leftLabel}`;
  const middleSegment = `•${rightLabel}${rightFill}`;
  return (
    borderColor(leftSegment) + borderColor(middleSegment) + borderColor(right)
  );
}

function fitBorderLine(
  width: number,
  left: string,
  right: string,
  leftText: string,
  rightText: string,
  borderColor: (text: string) => string,
  fillColor: (text: string) => string = borderColor,
): string {
  if (width <= 0) return "";
  if (width === 1) return borderColor(left);
  if (width === 2) return borderColor(`${left}${right}`);

  const fixedWidth = 2;
  let fittedLeft = leftText;
  let fittedRight = rightText;

  while (
    fixedWidth +
      visibleWidth(fittedLeft) +
      visibleWidth(fittedRight) +
      BORDER_MIN_GAP >
      width &&
    visibleWidth(fittedRight) > 0
  ) {
    fittedRight = truncateToWidth(
      fittedRight,
      Math.max(0, visibleWidth(fittedRight) - 1),
      "",
    );
  }

  while (
    fixedWidth +
      visibleWidth(fittedLeft) +
      visibleWidth(fittedRight) +
      BORDER_MIN_GAP >
      width &&
    visibleWidth(fittedLeft) > 0
  ) {
    fittedLeft = truncateToWidth(
      fittedLeft,
      Math.max(0, visibleWidth(fittedLeft) - 1),
      "",
    );
  }

  const gapWidth = Math.max(
    0,
    width - fixedWidth - visibleWidth(fittedLeft) - visibleWidth(fittedRight),
  );

  return (
    borderColor(left) +
    fittedLeft +
    fillColor("─".repeat(gapWidth)) +
    fittedRight +
    borderColor(right)
  );
}

function buildWorkingBorderLine(
  width: number,
  left: string,
  right: string,
  borderColor: (text: string) => string,
): string {
  const spinner = borderColor(WORKING_SPINNER_FRAMES[spinnerIndex] ?? "•");
  const message = borderColor(WORKING_MESSAGE);
  const leadingGap = borderColor("─");

  return fitBorderLine(
    width,
    left,
    right,
    `${leadingGap} ${spinner} ${message} `,
    "",
    borderColor,
  );
}

function buildRoundedScrollBorder(
  width: number,
  hiddenLineCount: number,
  borderColor: (text: string) => string,
): string {
  if (width <= 0) return "";
  if (width === 1) return borderColor("╭");
  if (width === 2) return borderColor("╭╮");

  const label = ` ↑ ${hiddenLineCount} more `;
  const innerWidth = Math.max(0, width - 2);
  const fitted = truncateToWidth(label, innerWidth, "");
  const leftFill = Math.max(
    0,
    Math.floor((innerWidth - visibleWidth(fitted)) / 2),
  );
  const rightFill = Math.max(0, innerWidth - visibleWidth(fitted) - leftFill);
  return borderColor(
    `╭${"─".repeat(leftFill)}${fitted}${"─".repeat(rightFill)}╮`,
  );
}

function buildBorderFromBaseLine(
  width: number,
  left: string,
  right: string,
  content: string,
  borderColor: (text: string) => string,
): string {
  if (width <= 0) return "";
  if (width === 1) return borderColor(left);
  if (width === 2) return borderColor(`${left}${right}`);

  const innerWidth = Math.max(0, width - 2);
  const plain = stripTerminalSequences(content);
  const truncated = truncateToWidth(plain, innerWidth);
  const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
  return borderColor(`${left}${truncated}${fill}${right}`);
}

function buildPlainBorderLine(
  width: number,
  left: string,
  right: string,
  borderColor: (text: string) => string,
): string {
  return buildBorderFromBaseLine(width, left, right, "", borderColor);
}

function isPlainBorderLine(line: string): boolean {
  const plain = stripTerminalSequences(line);
  // An empty line is what a zero-width frame renders; leaving it classified as
  // metadata would push that frame down the "keep the base border" branch.
  return plain.length === 0 || /^─+$/.test(plain);
}

function hasBorderMetadata(line: string): boolean {
  return !isPlainBorderLine(line);
}

function getRenderedAutocompleteHeight(editor: CustomEditor): number {
  // SAFETY: the runtime editor instance is the pi TUI Editor subclass, which
  // records how many rows it appended for the autocomplete block in a private
  // `renderedAutocompleteHeight` field. TypeScript hides that field from us,
  // but reading it is safe and is the only way to stay in sync with the rows
  // Editor.handleMouse hit-tests: rendering the list a second time here both
  // cost an extra render per frame and measured it on a width the base editor
  // never uses for its own layout.
  const height = (
    editor as unknown as { renderedAutocompleteHeight?: number }
  ).renderedAutocompleteHeight;

  return typeof height === "number" ? height : 0;
}

function getScrollOffset(editor: CustomEditor): number {
  // SAFETY: the runtime editor instance is the pi TUI Editor subclass, which
  // keeps the first hidden line index in a private `scrollOffset` field.
  // TypeScript hides that field from us, but reading it right after
  // super.render() (which just recomputed it) is safe and matches the hidden
  // count the base editor used for its own top border.
  const offset = (editor as unknown as { scrollOffset?: number }).scrollOffset;

  return typeof offset === "number" ? offset : 0;
}

export class RoundedEditor extends CustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
  ) {
    super(tui, theme, keybindings);
    activeTui = tui;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(0, width - 2);
    const lines = super.render(innerWidth);
    if (lines.length < 2) return lines;

    const borderColor = (text: string) => this.borderColor(text);
    const autocompleteLineCount = getRenderedAutocompleteHeight(this);
    const bottomBorderIndex = Math.max(
      1,
      Math.min(lines.length - 1, lines.length - autocompleteLineCount - 1),
    );
    const extra = lines.slice(bottomBorderIndex + 1);
    const hasAutocomplete = autocompleteLineCount > 0;
    const topBorderLine = lines[0] ?? "";
    // A scrolled editor centers its overflow label at the frame width instead
    // of re-wrapping the base border text rendered at the inner width.
    const hiddenLineCount = getScrollOffset(this);
    let topBorder = hiddenLineCount > 0
      ? buildRoundedScrollBorder(width, hiddenLineCount, borderColor)
      : buildBorderFromBaseLine(width, "╭", "╮", topBorderLine, borderColor);
    const bottomBorderLine = lines[bottomBorderIndex] ?? "";

    if (isWorking && !hasBorderMetadata(topBorderLine)) {
      topBorder = buildWorkingBorderLine(width, "╭", "╮", borderColor);
    }

    const content = lines
      .slice(1, bottomBorderIndex)
      .map((line) => buildBoxedContentLine(width, line ?? "", borderColor));
    const suggestions = extra.map((line) =>
      buildBoxedContentLine(width, line ?? "", borderColor),
    );

    if (!hasAutocomplete) {
      const bottomBorder = hasBorderMetadata(bottomBorderLine)
        ? buildBorderFromBaseLine(
            width,
            "╰",
            "╯",
            bottomBorderLine,
            borderColor,
          )
        : buildStatusBorderLine(width, "╰", "╯", borderColor);
      return [topBorder, ...content, bottomBorder];
    }

    // The tee sits in the base bottom-border slot, so the list must keep
    // starting at renderedVisibleLineCount + 2, where base Editor.handleMouse
    // hit-tests it. This frame is one row taller than the base editor.
    const tee = hasBorderMetadata(bottomBorderLine)
      ? buildBorderFromBaseLine(
          width,
          "├",
          "┤",
          bottomBorderLine,
          borderColor,
        )
      : buildStatusBorderLine(width, "├", "┤", borderColor);

    return [
      topBorder,
      ...content,
      tee,
      ...suggestions,
      buildPlainBorderLine(width, "╰", "╯", borderColor),
    ];
  }

  // The frame shifts every base-editor column one cell right (the left border)
  // and narrows the content by both border columns, but Editor.handleMouse maps
  // a raw event straight onto its own columns. Undo both before delegating, so
  // autocomplete clicks and click-to-place-cursor land on the cell the user
  // actually pointed at instead of one column off.
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return super.handleMouse({
      ...event,
      x: event.x - 1,
      width: Math.max(0, event.width - 2),
    });
  }
}
