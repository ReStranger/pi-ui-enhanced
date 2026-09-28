export type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  CustomEditor,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";

// ThinkingLevel lives in @earendil-works/pi-agent-core, which is not a direct
// dependency here (only nested inside pi-coding-agent) and is not re-exported
// by pi-coding-agent, so derive it from Theme.getThinkingBorderColor to stay
// in sync with the core type without adding a dependency.
type ThinkingLevel = Parameters<Theme["getThinkingBorderColor"]>[0];
import {
  stripTerminalSequences,
  truncateToWidth,
  type EditorTheme,
  type TUI,
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

// Blank/missing levels display as "off"; unknown non-blank names are
// preserved for the status label and narrowed separately for theme lookup.
function normalizeThinkingLevelLabel(level: string): string {
  return level.trim() || "off";
}

export function getCurrentThinkingLevel(): string {
  return currentThinkingLevel;
}

export function setEditorStatusLabel(state: {
  modelId?: string;
  thinkingLevel?: ThinkingLevel | string;
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

  if (!spinnerTimer) {
    spinnerTimer = setInterval(() => {
      spinnerIndex = (spinnerIndex + 1) % WORKING_SPINNER_FRAMES.length;
      activeTui?.requestRender();
    }, WORKING_SPINNER_INTERVAL_MS);
  }

  activeTui?.requestRender();
}

export function resetEditorWorkingState(): void {
  isWorking = false;
  spinnerIndex = 0;
  stopWorkingSpinner();
  activeTui = undefined;
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
  return /^─+$/.test(stripTerminalSequences(line));
}

function hasBorderMetadata(line: string): boolean {
  return !isPlainBorderLine(line);
}

function getAutocompleteLineCount(editor: CustomEditor, width: number): number {
  if (!editor.isShowingAutocomplete()) return 0;

  // SAFETY: the runtime editor instance is the pi TUI Editor subclass, which
  // carries a private `autocompleteList` field. TypeScript hides that field
  // from us, but reading it here is safe and lets us match the base editor's
  // rendered autocomplete line count exactly.
  const autocompleteList = (
    editor as unknown as {
      autocompleteList?: { render(renderWidth: number): string[] };
    }
  ).autocompleteList;

  return autocompleteList?.render(width).length ?? 0;
}

// Narrow an arbitrary level string to a known ThinkingLevel for
// Theme.getThinkingBorderColor. Unknown values fall back to "off",
// mirroring the core default branch, so callers never smuggle an
// unchecked string through the ThinkingLevel cast.
function toKnownThinkingLevel(
  level: ThinkingLevel | string | undefined,
): ThinkingLevel {
  switch (typeof level === "string" ? level.trim().toLowerCase() : "off") {
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    case "off":
    default:
      return "off";
  }
}

// Core seeds every freshly installed custom editor with
// defaultEditor.borderColor — a snapshot that freezes while a custom editor
// is active, because updateEditorBorderColor only writes to the displayed
// editor. After a reload/resume/fork/new session that snapshot is stale, so
// the frame renders in an old color while the spinner tint resolves live
// from the current thinking level. Overwrite it here with a live closure so
// the border matches the current level from the start; later core updates
// (level/model/bash/branch changes) keep working as usual.
export function applyLiveThinkingBorderColor(
  editor: CustomEditor,
  theme: Theme,
  thinkingLevel: ThinkingLevel | string | undefined,
): void {
  let color: (text: string) => string;
  try {
    color = theme.getThinkingBorderColor(toKnownThinkingLevel(thinkingLevel));
    // getThinkingBorderColor is lazy: it returns a closure over theme.fg(),
    // which throws on unknown tokens only when invoked. Probe it now so a
    // custom theme missing newer thinking tokens keeps the host snapshot
    // instead of crashing render() later.
    color("");
  } catch {
    // Keep the borderColor snapshot provided by the host.
    return;
  }
  editor.borderColor = color;
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
    const autocompleteLineCount = getAutocompleteLineCount(this, innerWidth);
    const bottomBorderIndex = Math.max(
      1,
      Math.min(lines.length - 1, lines.length - autocompleteLineCount - 1),
    );
    const extra = lines.slice(bottomBorderIndex + 1);
    const hasAutocomplete = autocompleteLineCount > 0;
    const topBorderLine = lines[0] ?? "";
    let topBorder = buildBorderFromBaseLine(
      width,
      "╭",
      "╮",
      topBorderLine,
      borderColor,
    );
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
}
