import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  registerStatusRewrite,
  rendersEditorUi,
  type FooterTheme,
  type RewriteHelpers,
} from "./status-wrap.ts";

/**
 * Publishes the MCP footer status in `<icon> mcp <enabled>|<disabled>` format.
 *
 * Server counts come from `pi.getMcpServers()` and tool namespaces from
 * `pi.getAllTools()`. If `pi-mcp-adapter` owns the status key, this module parses
 * its text. Transient statuses like `connecting` pass through unchanged.
 */

export const MCP_STATUS_KEY = "mcp";

/** Namespace prefix core puts on MCP tool definitions: `mcp__<server>`. */
export const MCP_TOOL_PREFIX = "mcp__";

/** Nerd Font plug icon (fa-plug, U+F1E6). */
export const MCP_ICON = "\uF1E6";

export interface McpCounts {
  enabled: number;
  disabled: number;
}

/** Latest counts derived from the registry + tool list; `undefined` before the first event. */
let counts: McpCounts | undefined;

/** Whether we published the status key (guards clearing someone else's status). */
let published = false;

/** What we last wrote to the key, so a refresh can skip unchanged writes. */
let publishedText: string | undefined;

/** Cache counts derived from the registry (subscribe path). */
export function rememberMcpCounts(next: McpCounts | undefined): void {
  counts = next;
}

/** Test helper: drop the cached counts and the published flag. */
export function clearMcpCounts(): void {
  counts = undefined;
  published = false;
  publishedText = undefined;
  clearMcpSettleTimers();
}

/** Cached counts, if any. */
export function currentMcpCounts(): McpCounts | undefined {
  return counts;
}

export function normalizeServerName(name: string): string {
  return name.replace(/-/g, "_").toLowerCase();
}

/**
 * Extracts the MCP server name from a tool definition.
 * Returns `undefined` if the tool does not belong to an MCP server.
 */
function mcpServerNameFromTool(tool: unknown): string | undefined {
  if (typeof tool !== "object" || tool === null) return undefined;
  const record = tool as { name?: unknown; namespace?: { name?: unknown } };
  const namespace = record.namespace?.name;
  if (typeof namespace === "string" && namespace.startsWith(MCP_TOOL_PREFIX)) {
    const server = namespace.slice(MCP_TOOL_PREFIX.length);
    return server.length > 0 ? server : undefined;
  }
  if (typeof record.name !== "string" || !record.name.startsWith(MCP_TOOL_PREFIX)) {
    return undefined;
  }
  const rest = record.name.slice(MCP_TOOL_PREFIX.length);
  const separator = rest.indexOf("__");
  if (separator <= 0) return undefined;
  return rest.slice(0, separator);
}

/** Pure: distinct MCP server names behind a `pi.getAllTools()` list. */
export function toolServerNames(tools: readonly unknown[] | undefined): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const tool of tools ?? []) {
    const server = mcpServerNameFromTool(tool);
    if (server === undefined) continue;
    const key = normalizeServerName(server);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(server);
  }
  return names;
}

/**
 * Computes enabled and disabled server counts from registered servers and tool lists.
 * Deduplicates names across both sources.
 */
export function deriveMcpCounts(
  servers: readonly unknown[] | undefined,
  tools?: readonly unknown[],
): McpCounts {
  let enabled = 0;
  let disabled = 0;
  const known = new Set<string>();
  for (const server of servers ?? []) {
    if (typeof server !== "object" || server === null) continue;
    const record = server as { name?: unknown; config?: unknown };
    if (typeof record.name === "string" && record.name.length > 0) {
      const key = normalizeServerName(record.name);
      if (known.has(key)) continue;
      known.add(key);
    }
    const config = record.config;
    if (
      typeof config === "object" &&
      config !== null &&
      (config as { enabled?: unknown }).enabled === false
    ) {
      disabled += 1;
    } else {
      enabled += 1;
    }
  }
  for (const server of toolServerNames(tools)) {
    const key = normalizeServerName(server);
    if (known.has(key)) continue;
    known.add(key);
    enabled += 1;
  }
  return { enabled, disabled };
}

function readServers(pi: ExtensionAPI): readonly unknown[] | undefined {
  try {
    return pi.getMcpServers();
  } catch {
    // Older pi without the API, or no runtime yet. Treat as no data.
    return undefined;
  }
}

/** Tool list, whose `mcp__<server>` namespaces are the only public trace of `mcp.json` servers. */
function readTools(pi: ExtensionAPI): readonly unknown[] | undefined {
  try {
    return pi.getAllTools();
  } catch {
    return undefined;
  }
}

/** Fallback: parse counts out of the pi-mcp-adapter long status text. */
export function parseMcpStatus(raw: string): McpCounts | undefined {
  const plain = stripTerminalSequences(raw);
  const enabled = plain.match(/(\d+)\s+servers?\s+enabled/);
  if (!enabled?.[1]) return undefined;
  const disabled = plain.match(/\((\d+)\s+disabled\)/);
  return {
    enabled: Number(enabled[1]),
    disabled: disabled?.[1] ? Number(disabled[1]) : 0,
  };
}

function isTransientStatus(plain: string): boolean {
  return /connecting|authenticating/i.test(plain);
}

/** `<icon> mcp 4|1`, accent-colored when a theme is available. `undefined` hides the status, which happens when there are no servers. */
export function formatMcpShort(
  counts: McpCounts,
  theme?: FooterTheme,
): string | undefined {
  if (counts.enabled + counts.disabled <= 0) return undefined;
  const head = `${MCP_ICON} mcp ${counts.enabled}`;
  const text = counts.disabled > 0 ? `${head}|${counts.disabled}` : head;
  return theme ? theme.fg("accent", text) : text;
}

export function rewriteMcpStatus(
  raw: string | undefined,
  helpers?: RewriteHelpers,
): string | undefined {
  if (raw !== undefined && isTransientStatus(stripTerminalSequences(raw))) {
    return raw;
  }
  // The live counts win while any server is configured.
  if (counts && counts.enabled + counts.disabled > 0) {
    const short = formatMcpShort(counts, helpers?.theme);
    if (short !== undefined) return short;
  }
  if (raw === undefined) return undefined;
  const parsed = parseMcpStatus(raw);
  if (parsed) return formatMcpShort(parsed, helpers?.theme);
  return raw;
}

/**
 * Updates the MCP status key in the footer.
 * Only writes when server count is greater than zero, and skips redundant writes.
 */
function publishStatus(ctx: ExtensionContext, force = false): void {
  if (!rendersEditorUi(ctx)) return;
  const text =
    counts && counts.enabled + counts.disabled > 0
      ? formatMcpShort(counts)
      : undefined;
  if (!force && text === publishedText) return;
  if (text === undefined && !published) return;
  try {
    ctx.ui.setStatus(MCP_STATUS_KEY, text);
    published = text !== undefined;
    publishedText = text;
  } catch {
    // No UI surface in this mode, so the footer shows no mcp status.
  }
}

/** Re-read both signals and publish. */
function refreshCounts(pi: ExtensionAPI, ctx: ExtensionContext, force = false): void {
  rememberMcpCounts(deriveMcpCounts(readServers(pi), readTools(pi)));
  publishStatus(ctx, force);
}

/** Delays in milliseconds for retrying server count derivation after session start. */
export const MCP_SETTLE_DELAYS_MS: readonly number[] = [250, 750, 1500, 3000, 6000];

let settleTimers: Array<ReturnType<typeof setTimeout>> = [];

/** Cancel a pending settle schedule (new session, unsubscribe, tests). */
export function clearMcpSettleTimers(): void {
  for (const timer of settleTimers) clearTimeout(timer);
  settleTimers = [];
}

function scheduleSettle(pi: ExtensionAPI, ctx: ExtensionContext): void {
  clearMcpSettleTimers();
  if (!rendersEditorUi(ctx)) return;
  for (const delay of MCP_SETTLE_DELAYS_MS) {
    const timer = setTimeout(() => {
      settleTimers = settleTimers.filter((pending) => pending !== timer);
      try {
        refreshCounts(pi, ctx);
      } catch {
        // `ctx` is captured from the event handler, so this can fire after the
        // session was replaced and the context invalidated. A timer callback
        // has no caller to handle that: it would surface as an uncaught
        // exception and take pi down with it.
      }
    }, delay);
    // A status refresh must never hold the process open, so the timer does not
    // count as a pending handle.
    (timer as { unref?: () => void }).unref?.();
    settleTimers.push(timer);
  }
}

/**
 * Subscribes to MCP server lifecycle events and updates status counts.
 * Returns an unsubscribe callback.
 */
export function subscribeMcpServers(pi: ExtensionAPI): () => void {
  const structural = (_event: unknown, ctx: ExtensionContext): void => {
    refreshCounts(pi, ctx, true);
    scheduleSettle(pi, ctx);
  };
  // Covers servers that connect without an event, such as an OAuth sign-in
  // through `/mcp`.
  const settled = (_event: unknown, ctx: ExtensionContext): void => {
    refreshCounts(pi, ctx);
  };
  const offs: Array<() => void> = [];
  try {
    offs.push(pi.on("session_start", structural));
  } catch {
    // Older pi may not have the event surface, so there is nothing to
    // subscribe to.
  }
  try {
    offs.push(pi.on("mcp_servers_change", structural));
  } catch {
    // Same as above.
  }
  try {
    offs.push(pi.on("agent_settled", settled));
  } catch {
    // Older pi lacks this event, but the settle schedule still covers startup.
  }
  try {
    offs.push(
      pi.on("session_shutdown", () => {
        // Emitted on the *outgoing* runner before it is invalidated, so this
        // instance is still the right one to drop its pending ticks. Anything
        // left over would run against a context that has already gone stale.
        clearMcpSettleTimers();
      }),
    );
  } catch {
    // Older pi without the event — the schedule is short and bounded anyway.
  }
  return () => {
    for (const off of offs) {
      try {
        off();
      } catch {
        // Unsubscribe must never throw.
      }
    }
    clearMcpCounts();
  };
}

/** Register the short format in the generic wrapper. */
export function registerMcpShortStatus(): () => void {
  return registerStatusRewrite(MCP_STATUS_KEY, rewriteMcpStatus);
}
