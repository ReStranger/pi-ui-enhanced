import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  registerStatusRewrite,
  type FooterTheme,
  type RewriteHelpers,
} from "./status-wrap.ts";

/**
 * Formats @pi-vault/pi-dcp status as `dcp <saved> (<pruned>)`.
 * Returns `undefined` when savings and pruned counts are zero or absent.
 */

export const DCP_STATUS_KEY = "dcp";

/** Theme color slot for the DCP status label. */
export const DCP_COLOR: ThemeColor = "success";

/**
 * Icon prepended to the DCP status label. Default is empty ("") per user preference,
 * but can be configured (e.g. "\uF0C4" for scissors).
 */
export const DCP_ICON = "";

export interface DcpStatusInfo {
  tokens?: string;
  count?: number;
}

/**
 * Parses raw status output from @pi-vault/pi-dcp or compatible extensions.
 * Handles pruning ("DCP · saved ~268 tokens · pruned 4 outputs"),
 * compression ("DCP · compressed ~12.4k tokens · summary ~2.1k · 5 messages"),
 * and already compacted forms ("dcp ~268 (4)").
 */
export function parseDcpStatus(raw: string): DcpStatusInfo | undefined {
  const plain = stripTerminalSequences(raw).trim();
  if (!plain) return undefined;

  // Pruning format: "DCP · saved ~268 tokens · pruned 4 outputs"
  const savedMatch = plain.match(/saved\s+(~?[\d.]+[kM]?)\s+tokens?/i);
  const prunedMatch = plain.match(/pruned\s+(\d+)\s+outputs?/i);
  if (savedMatch || prunedMatch) {
    const tokens = savedMatch?.[1];
    const count = prunedMatch ? Number(prunedMatch[1]) : undefined;
    return { tokens, count };
  }

  // Compression format: "DCP · compressed ~12.4k tokens · summary ~2.1k · 5 messages"
  const compressedMatch = plain.match(/compressed\s+(~?[\d.]+[kM]?)\s+tokens?/i);
  const messagesMatch = plain.match(/(\d+)\s+messages?/i);
  if (compressedMatch || messagesMatch) {
    const tokens = compressedMatch?.[1];
    const count = messagesMatch ? Number(messagesMatch[1]) : undefined;
    return { tokens, count };
  }

  // Already compact format: "dcp ~268 (4)" or "dcp ~268" or "✂ dcp ~268 (4)"
  const compactMatch = plain.match(/(?:^|\s)dcp\s+(~?[\d.]+[kM]?)(?:\s*\((\d+)\))?/i);
  if (compactMatch) {
    const tokens = compactMatch[1];
    const count = compactMatch[2] ? Number(compactMatch[2]) : undefined;
    return { tokens, count };
  }

  return undefined;
}

function isZeroCount(count: number | undefined): boolean {
  return count === undefined || count <= 0;
}

function isZeroTokens(tokens: string | undefined): boolean {
  return !tokens || tokens === "0" || tokens === "~0";
}

function buildDcpBody(
  tokens: string | undefined,
  count: number | undefined,
): string | undefined {
  const hasTokens = !isZeroTokens(tokens);
  const hasCount = !isZeroCount(count);

  if (hasTokens && hasCount) return `${tokens} (${count})`;
  if (hasTokens) return tokens;
  if (hasCount) return `(${count})`;
  return undefined;
}

/**
 * Formats parsed DCP status as `dcp <saved> (<pruned>)` (or with icon prefix if non-empty).
 * Returns `undefined` when tokens and counts are zero or missing.
 */
export function formatDcpShort(
  info: DcpStatusInfo | undefined,
  theme?: FooterTheme,
  icon: string = DCP_ICON,
): string | undefined {
  if (!info) return undefined;
  const body = buildDcpBody(info.tokens, info.count);
  if (!body) return undefined;

  const prefix = icon ? `${icon} ` : "";
  const text = `${prefix}dcp ${body}`;
  return theme ? theme.fg(DCP_COLOR, text) : text;
}

/**
 * Rewrites a raw DCP status string to the short format.
 * Returns `undefined` if raw is undefined or if savings are zero.
 * Passes unrecognized non-empty statuses through unchanged.
 */
export function rewriteDcpStatus(
  raw: string | undefined,
  helpers?: RewriteHelpers,
): string | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseDcpStatus(raw);
  if (!parsed) return raw;
  return formatDcpShort(parsed, helpers?.theme);
}

/** Register the short format in the generic wrapper. */
export function registerDcpShortStatus(): () => void {
  return registerStatusRewrite(DCP_STATUS_KEY, rewriteDcpStatus);
}
