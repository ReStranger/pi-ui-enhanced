import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  registerStatusRewrite,
  type FooterTheme,
  type RewriteHelpers,
} from "./status-wrap.ts";

/**
 * Short `pi-lens-lsp` status: `<icon> lsp 2|1`, painted `accent` (blue on the
 * stylix theme) instead of pi-lens' green/red per-part colors.
 *
 * Raw text from pi-lens (`updateLspStatus`):
 * - `"LSP Active: ts, python · LSP Failed: foo"` (theme-colored parts);
 * - compact flag variant: `"LSP ✓"` / `"LSP ✗"`;
 * - idle: `"LSP Inactive"` (dimmed).
 *
 * Instead of the per-server list we render just the counter, mirroring the
 * short MCP format (`active`, plus `|failed` when nonzero). Zero/zero hides
 * the status, like the MCP short form.
 */

export const LSP_STATUS_KEY = "pi-lens-lsp";

/**
 * Theme token for the short status. NOT `accent`: in the stylix theme the
 * palette name `blue` is mapped to pink (`vars.blue: #f17ac6`), so `accent`
 * renders pink. `thinkingLow` resolves to the visually-blue slot instead
 * (stylix `cyan` → #7aaaff; stock dark #5f87af; stock light `blue`).
 * One-line change if you ever want another themed color.
 */
export const LSP_COLOR: ThemeColor = "thinkingLow";

/**
 * Nerd Font icon for the short status. The glyph from chat did not survive
 * transport, so this defaults to fa-wrench (U+F0AD, one cell in NF builds).
 * Replace with your own single-cell glyph, e.g.:
 *   export const LSP_ICON = "<paste your icon here>";
 */
export const LSP_ICON = "\uF0AD";

export interface LspCounts {
  active: number;
  failed: number;
}

/** Count comma-separated server ids in one `LSP <Kind>: a, b` segment. */
function countIds(segment: string | undefined): number {
  if (!segment) return 0;
  return segment
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

/** Parse counts out of the long status text. */
export function parseLspStatus(raw: string): LspCounts {
  const plain = stripTerminalSequences(raw);
  const active = plain.match(/LSP\s+Active:\s*([^·]*)/i);
  if (active) {
    return {
      active: countIds(active[1]),
      failed: countIds(plain.match(/LSP\s+Failed:\s*([^·]*)/i)?.[1]),
    };
  }
  // Compact flag variant (`lens-compact-lsp-status`): no ids to count.
  if (/LSP\s*✓/.test(plain)) return { active: 1, failed: 0 };
  return { active: 0, failed: 0 };
}

/** `<icon> lsp 2|1` — themed blue (see LSP_COLOR) when a theme is available. */
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
