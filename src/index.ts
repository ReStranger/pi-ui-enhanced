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
let activeTui: TUI | undefined;
const STATUS_THINKING_WIDTH = 9;

/**
 * Structural view of the stock StatusIndicator (working, retry, compaction,
 * branch summary) that pi embeds into the editor top border. The type is
 * intentionally structural: stock does not re-export StatusIndicator from the
 * package root, so importing it would couple us to an internal dist path.
 */
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
  // super.render() (which just recomputed it) is safe and is the only way to
  // rebuild the top border at the frame width instead of the inner width.
  const offset = (editor as unknown as { scrollOffset?: number }).scrollOffset;

  return typeof offset === "number" ? offset : 0;
}

export class RoundedEditor extends CustomEditor {
  // Named to avoid clashing with CustomEditor's own private
  // `workingStatusIndicator` (which its setWorkingStatusIndicator writes and
  // its renderTopBorder reads — neither is used here since both are
  // overridden).
  private embeddedStatusIndicator: EmbeddedStatusIndicator | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
  ) {
    // embedWorkingStatus makes stock InteractiveMode route its working,
    // compaction, retry, and branch-summary indicators to this editor via
    // setWorkingStatusIndicator instead of a separate status line below.
    super(tui, theme, keybindings, { embedWorkingStatus: true });
    activeTui = tui;
  }

  override setWorkingStatusIndicator(
    indicator: EmbeddedStatusIndicator | undefined,
  ): void {
    this.embeddedStatusIndicator = indicator;
    activeTui?.requestRender();
  }

  // Rounded port of the stock CustomEditor top border: the active status
  // indicator (if any) is embedded into the border, with the scroll overflow
  // label sharing the line when it fits and collapsing to a spinner when it
  // does not. Width accounting mirrors stock, with two extra cells reserved
  // for the ╭/╮ corners.
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
    // The embedded indicator and the scroll label are rebuilt at the full
    // frame width from the fresh scroll offset; lines[0] (rendered by
    // super.render at the inner width) is intentionally discarded.
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
