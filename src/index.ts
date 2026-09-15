export type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  CustomEditor,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
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
const STATUS_SEPARATOR_RATIO = 0.9;
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

export function setEditorStatusLabel(state: {
  modelId?: string;
  thinkingLevel?: string;
}): void {
  if (typeof state.modelId === "string") {
    currentModelId = state.modelId.trim() || "pi";
  }
  if (typeof state.thinkingLevel === "string") {
    currentThinkingLevel = state.thinkingLevel.trim() || "off";
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
  const leftWidth = Math.min(
    Math.max(0, innerWidth - 1),
    Math.floor(innerWidth * STATUS_SEPARATOR_RATIO),
  );
  const rightWidth = Math.max(0, innerWidth - leftWidth - 1);
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
  theme: Pick<Theme, "fg">,
): string {
  const spinner = theme.fg(
    "accent",
    WORKING_SPINNER_FRAMES[spinnerIndex] ?? "•",
  );
  const message = theme.fg("muted", WORKING_MESSAGE);
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

export class RoundedEditor extends CustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly statusTheme: Pick<Theme, "fg">,
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
    const separator = hasAutocomplete
      ? [buildStatusBorderLine(width, "├", "┤", borderColor)]
      : [];
    const topBorderLine = lines[0] ?? "";
    let topBorder = buildBorderFromBaseLine(
      width,
      "╭",
      "╮",
      topBorderLine,
      borderColor,
    );
    const bottomBorderLine = lines[bottomBorderIndex] ?? "";
    let bottomBorder = buildStatusBorderLine(width, "╰", "╯", borderColor);

    if (isWorking && !hasBorderMetadata(topBorderLine)) {
      topBorder = buildWorkingBorderLine(
        width,
        "╭",
        "╮",
        borderColor,
        this.statusTheme,
      );
    }

    if (hasAutocomplete || hasBorderMetadata(bottomBorderLine)) {
      bottomBorder = buildBorderFromBaseLine(
        width,
        "╰",
        "╯",
        bottomBorderLine,
        borderColor,
      );
    }

    return [
      topBorder,
      ...lines
        .slice(1, bottomBorderIndex)
        .map((line) => buildBoxedContentLine(width, line ?? "", borderColor)),
      ...separator,
      ...extra.map((line) =>
        buildBoxedContentLine(width, line ?? "", borderColor),
      ),
      bottomBorder,
    ];
  }
}
