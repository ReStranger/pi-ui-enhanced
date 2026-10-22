export type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export * from "./status-wrap.ts";
export * from "./panel-frame.ts";
export * from "./mcp-status.ts";
export * from "./lsp-status.ts";
export * from "./dcp-status.ts";

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
let activeTui: TUI | undefined;
const STATUS_THINKING_WIDTH = 9;

/** Interface for status indicators rendered inside the editor top border. */
export type EmbeddedStatusIndicator = {
  renderInBorder(width: number): string;
  renderSpinnerInBorder(width: number): string;
};

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

export function resetEditorWorkingState(): void {
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

function buildRoundedScrollBorder(
  width: number,
  hiddenLineCount: number,
  borderColor: (text: string) => string,
): string {
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
  // SAFETY: reads private renderedAutocompleteHeight from base editor for mouse hit testing.
  const height = (
    editor as unknown as { renderedAutocompleteHeight?: number }
  ).renderedAutocompleteHeight;

  return typeof height === "number" ? height : 0;
}

function getScrollOffset(editor: CustomEditor): number {
  // SAFETY: reads private scrollOffset from base editor to align top border width.
  const offset = (editor as unknown as { scrollOffset?: number }).scrollOffset;

  return typeof offset === "number" ? offset : 0;
}

export class RoundedEditor extends CustomEditor {
  // CustomEditor has its own private `workingStatusIndicator`. This field
  // avoids that name, and neither the base setter nor the base top border
  // matters here because both are overridden.
  private embeddedStatusIndicator: EmbeddedStatusIndicator | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
  ) {
    // embedWorkingStatus makes stock InteractiveMode send its working,
    // compaction, retry, and branch-summary indicators to this editor through
    // setWorkingStatusIndicator instead of a status line below.
    super(tui, theme, keybindings, { embedWorkingStatus: true });
    activeTui = tui;
  }

  override setWorkingStatusIndicator(
    indicator: EmbeddedStatusIndicator | undefined,
  ): void {
    this.embeddedStatusIndicator = indicator;
    activeTui?.requestRender();
  }

  // Renders the rounded top border with status indicator and scroll indicators.
  protected override renderTopBorder(
    width: number,
    hiddenLineCount: number,
  ): string {
    const borderColor = (text: string) => this.borderColor(text);
    if (width <= 0) return "";
    if (width === 1) return borderColor("╭");
    if (width === 2) return borderColor("╭╮");

    const indicator = this.embeddedStatusIndicator;
    if (!indicator) {
      return hiddenLineCount > 0
        ? buildRoundedScrollBorder(width, hiddenLineCount, borderColor)
        : borderColor(`╭${"─".repeat(width - 2)}╮`);
    }

    const reserve = 6;
    let status = indicator.renderInBorder(Math.max(1, width - reserve));
    let statusWidth = visibleWidth(status);
    if (statusWidth === 0) {
      return hiddenLineCount > 0
        ? buildRoundedScrollBorder(width, hiddenLineCount, borderColor)
        : borderColor(`╭${"─".repeat(width - 2)}╮`);
    }

    const overflowLabel =
      hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
    const overflowLabelWidth = overflowLabel
      ? visibleWidth(overflowLabel)
      : 0;
    const overflowStart = Math.floor((width - overflowLabelWidth) / 2);
    const canFitOverflow = (): boolean =>
      overflowLabel !== undefined &&
      overflowLabelWidth + 2 <= width &&
      overflowStart - statusWidth - 5 >= 1 &&
      overflowStart + overflowLabelWidth <= width - 1;

    if (overflowLabel && !canFitOverflow()) {
      status = indicator.renderSpinnerInBorder(width);
      statusWidth = visibleWidth(status);
    }

    if (canFitOverflow()) {
      const fillBefore = overflowStart - statusWidth - 5;
      const fillAfter = width - 1 - overflowStart - overflowLabelWidth;
      return (
        borderColor("╭── ") +
        status +
        borderColor(
          ` ${
            "─".repeat(fillBefore)
          }${overflowLabel}${"─".repeat(fillAfter)}`,
        ) +
        borderColor("╮")
      );
    }

    if (width >= statusWidth + reserve) {
      const fill = width - statusWidth - reserve;
      return (
        borderColor("╭── ") +
        status +
        borderColor(` ${"─".repeat(fill)}`) +
        borderColor("╮")
      );
    }

    status = indicator.renderSpinnerInBorder(width);
    statusWidth = visibleWidth(status);
    if (statusWidth === 0) {
      return borderColor(`╭${"─".repeat(width - 2)}╮`);
    }
    if (statusWidth > width - 2) {
      const fitted = truncateToWidth(status, Math.max(0, width - 2));
      const pad = " ".repeat(
        Math.max(0, width - 2 - visibleWidth(fitted)),
      );
      return borderColor("╭") + fitted + pad + borderColor("╮");
    }
    const prefixWidth = Math.min(2, Math.max(0, width - 2 - statusWidth));
    const restWidth = Math.max(0, width - 2 - prefixWidth - statusWidth);
    return (
      borderColor(`╭${"─".repeat(prefixWidth)}`) +
      status +
      borderColor(`${"─".repeat(restWidth)}╮`)
    );
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
    // The top border is rebuilt at the full frame width from the current scroll
    // offset. lines[0] came from super.render at the inner width, so we drop it.
    const topBorder = this.renderTopBorder(width, getScrollOffset(this));
    const bottomBorderLine = lines[bottomBorderIndex] ?? "";

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

    // The tee occupies the base bottom-border slot, so the suggestion list must
    // still start at renderedVisibleLineCount + 2, the row where base
    // Editor.handleMouse hit-tests it. This frame is one row taller than the
    // base editor renders.
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

  // Offsets mouse event coordinates to account for one-cell border padding.
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return super.handleMouse({
      ...event,
      x: event.x - 1,
      width: Math.max(0, event.width - 2),
    });
  }
}
