export type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

let currentModelId = "pi";
let currentThinkingLevel = "off";
const STATUS_SEPARATOR_RATIO = 0.9;

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

function buildBorderLine(
  width: number,
  left: string,
  right: string,
  borderColor: (text: string) => string,
  label?: string,
): string {
  if (width <= 0) return "";
  if (width === 1) return borderColor(left);

  const innerWidth = Math.max(0, width - 2);
  if (!label) {
    return borderColor(`${left}${"─".repeat(innerWidth)}${right}`);
  }

  const fittedLabel = truncateToWidth(label, innerWidth);
  const remaining = Math.max(0, innerWidth - visibleWidth(fittedLabel));
  const rightFill = Math.min(2, remaining);
  const leftFill = Math.max(0, remaining - rightFill);
  return borderColor(
    `${left}${"─".repeat(leftFill)}${fittedLabel}${"─".repeat(rightFill)}${right}`,
  );
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

  return borderColor(
    `${left}${leftFill}${leftLabel}•${rightLabel}${rightFill}${right}`,
  );
}

function isBaseEditorBorderLine(line: string): boolean {
  const plain = stripTerminalSequences(line);
  return /^─+$/.test(plain) || /^─── [↑↓] \d+ more ─*$/.test(plain);
}

function findBottomBorderIndex(lines: string[]): number {
  for (let index = lines.length - 1; index > 0; index -= 1) {
    if (isBaseEditorBorderLine(lines[index] ?? "")) return index;
  }
  return lines.length - 1;
}

export class RoundedEditor extends CustomEditor {
  render(width: number): string[] {
    const innerWidth = Math.max(0, width - 2);
    const lines = super.render(innerWidth);
    if (lines.length < 2) return lines;

    const borderColor = (text: string) => this.borderColor(text);
    const bottomBorderIndex = findBottomBorderIndex(lines);
    const extra = lines.slice(bottomBorderIndex + 1);

    lines[0] = buildBorderLine(width, "╭", "╮", borderColor);
    lines[bottomBorderIndex] = buildStatusBorderLine(
      width,
      "╰",
      "╯",
      borderColor,
    );

    for (let index = 1; index < bottomBorderIndex; index += 1) {
      lines[index] = buildBoxedContentLine(
        width,
        lines[index] ?? "",
        borderColor,
      );
    }

    return [
      ...lines.slice(0, bottomBorderIndex + 1),
      ...extra.map((line) => ` ${truncateToWidth(line, innerWidth)}`),
    ];
  }
}
