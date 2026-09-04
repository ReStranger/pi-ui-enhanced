import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  registerStatusRewrite,
  type FooterTheme,
  type RewriteHelpers,
} from "./status-wrap.ts";

/**
 * Formats pi-lens LSP status as `<icon> lsp <active>|<failed>`.
 * Returns `undefined` when both active and failed counts are zero.
 */

export const LSP_STATUS_KEY = "pi-lens-lsp";

/** Theme color slot for the LSP status label. */
export const LSP_COLOR: ThemeColor = "thinkingLow";

/** Nerd Font wrench icon (fa-wrench, U+F0AD). */
export const LSP_ICON = "\uF0AD";

export interface LspCounts {
  active: number;
  failed: number;
}

/** Counts the server ids in one `LSP <Kind>: a, b` segment. */
function countIds(segment: string | undefined): number {
  if (!segment) return 0;
  return segment
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

/**
 * Reads the active and failed counts out of the long status text.
 * Compact glyphs are only counted next to the `LSP` marker (the pi-lens compact
 * format), so decorative check marks elsewhere in the status text never
 * inflate the counts.
 */
export function parseLspStatus(raw: string): LspCounts {
  const plain = stripTerminalSequences(raw);

  let active = 0;
  const activeMatch = plain.match(/LSP\s*Active:\s*([^·\n]+)/i);
  if (activeMatch) {
    active = countIds(activeMatch[1]);
  } else if (/LSP\s*✓/i.test(plain)) {
    // Count only the ✓ that directly follows an `LSP` token.
    const compactMatches = plain.match(/LSP\s*✓/gi);
    active = compactMatches ? compactMatches.length : 1;
  }

  let failed = 0;
  const failedMatch = plain.match(/LSP\s*(?:Failed|Error):\s*([^·\n]+)/i);
  if (failedMatch) {
    failed = countIds(failedMatch[1]);
  } else if (/LSP\s*✗/i.test(plain)) {
    // Count only the ✗ that directly follows an `LSP` token.
    const compactMatches = plain.match(/LSP\s*✗/gi);
    failed = compactMatches ? compactMatches.length : 1;
  }

  return { active, failed };
}

/** `<icon> lsp 2|1`, painted with LSP_COLOR when a theme is available. */
export function formatLspShort(
  counts: LspCounts,
  theme: FooterTheme | undefined,
): string | undefined {
  if (counts.active + counts.failed <= 0) return undefined;
  const head = `${LSP_ICON} lsp ${counts.active}`;
  const text =
    counts.failed > 0 ? `${head}|${counts.failed}` : head;
  return theme ? theme.fg(LSP_COLOR, text) : text;
}

export function rewriteLspStatus(
  raw: string | undefined,
  helpers?: RewriteHelpers,
): string | undefined {
  if (raw === undefined) return undefined;
  return formatLspShort(parseLspStatus(raw), helpers?.theme);
}

/** Register the short format in the generic wrapper. */
export function registerLspShortStatus(): () => void {
  return registerStatusRewrite(LSP_STATUS_KEY, rewriteLspStatus);
}
