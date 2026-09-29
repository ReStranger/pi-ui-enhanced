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
 * Short `mcp` status: `<icon> mcp 4|1` (the `|N` suffix appears only when
 * N > 0).
 *
 * Since pi 0.99 MCP support is built in (`~/.pi/agent/mcp.json`,
 * `.pi/mcp.json`, `pi mcp add`, `/mcp` manager) and the built-in extension
 * publishes **no** footer status at all. This module therefore provides the
 * status itself:
 *
 *  1. counts are derived from two public signals and pushed via
 *     `ctx.ui.setStatus`, so the stock footer (and our wrapped footer) pick the
 *     key up:
 *     - `pi.getMcpServers()` — the registry of servers *extensions*
 *       registered with `pi.registerMcpServer()`. This is also the only place
 *       `enabled: false` is visible, so it feeds the `|N` suffix;
 *     - `pi.getAllTools()` — the tool list. Servers from `mcp.json` never
 *       reach the registry (core's mcp extension keeps them in a private list,
 *       `extensions/mcp/index.ts`), but a connected one registers its tools
 *       under the `mcp__<server>` namespace, so the namespace names recover
 *       exactly those servers;
 *  2. if the third-party `pi-mcp-adapter` package is installed instead, it
 *     owns the `mcp` key and we fall back to parsing its long status text
 *     (`"N servers enabled (D disabled)"`), like before the switch.
 *
 * Transient states (`connecting…`, `Authenticating…`) pass through untouched.
 *
 * KNOWN LIMITATION (both signals are all the public API offers): the number is
 * *connected* servers. A configured server that never finished its handshake
 * (an HTTP server waiting for `/mcp` OAuth) contributes no tools, so it stays
 * invisible until it connects. Per-server connection state is internal to the
 * built-in extension, and the `mcp.json` files themselves are not exposed.
 *
 * Connections are established *after* `session_start` (core defers the client
 * load by one event-loop turn), so a refresh also runs on a short settle
 * schedule and after every turn; `publishStatus` writes only when the text
 * actually changes, so those extra refreshes cost nothing.
 */

export const MCP_STATUS_KEY = "mcp";

/** Namespace prefix core puts on MCP tool definitions: `mcp__<server>`. */
export const MCP_TOOL_PREFIX = "mcp__";

/**
 * Nerd Font icon for the short status (fa-plug). Written as an escape because
 * literal PUA glyphs do not survive chat transport. Replace with your own
 * single-cell glyph, e.g. `export const MCP_ICON = "\uF1E6";`.
 */
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

/**
 * Server name behind one tool definition, or `undefined` when the tool is not
 * an MCP tool. The `namespace.name` (`mcp__<server>`) is authoritative; the
 * `mcp__<server>__<tool>` name is only a fallback for definitions without a
 * namespace, and it cuts the server at the first `__` (a server name that
 * itself contains `__` can then collapse into another server's bucket).
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
    if (server === undefined || seen.has(server)) continue;
    seen.add(server);
    names.push(server);
  }
  return names;
}

/**
 * Pure: split servers into enabled/disabled by their `enabled` flag, then add
 * the servers that are only visible through their tools (`mcp.json` servers,
 * which never enter the registry). A server already in the registry is not
 * counted twice.
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
      known.add(record.name);
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
    if (known.has(server)) continue;
    known.add(server);
    enabled += 1;
  }
  return { enabled, disabled };
}

function readServers(pi: ExtensionAPI): readonly unknown[] | undefined {
  try {
    return pi.getMcpServers();
  } catch {
    // Older pi without the API, or no runtime yet — treat as "no data".
    return undefined;
  }
}

/** Tool list; the `mcp__<server>` namespaces are the only public trace of `mcp.json` servers. */
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

/** `<icon> mcp 4|1` — accent-colored when a theme is available; `undefined` hides (zero servers). */
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
  // Live built-in counts win while any server is configured.
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
 * Push the current counts into the stock footer statuses. Only writes when a
 * server is configured, so an installed pi-mcp-adapter (which replaces the
 * built-in MCP support and owns the `mcp` key) is never clobbered; our own
 * key is cleared explicitly once we have published before.
 *
 * `force` rewrites an unchanged value. Structural events use it because core
 * wipes every extension status in `resetExtensionUI()` before rebinding, so
 * our own `publishedText` may still claim the key is set; the settle ticks and
 * the per-turn refresh skip the write when nothing changed.
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
    // No UI surface in this mode; the footer just shows no mcp status.
  }
}

/** Re-read both signals and publish. */
function refreshCounts(pi: ExtensionAPI, ctx: ExtensionContext, force = false): void {
  rememberMcpCounts(deriveMcpCounts(readServers(pi), readTools(pi)));
  publishStatus(ctx, force);
}

/**
 * Re-derive delays (ms) after a structural event: core's mcp extension
 * connects servers a tick or more after `session_start`, so the tool list — and
 * with it the count — fills in later. Short and bounded on purpose: the
 * per-turn refresh in `subscribeMcpServers` is what keeps the count honest
 * afterwards (an OAuth sign-in through `/mcp` connects a server with no event).
 */
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
      refreshCounts(pi, ctx);
    }, delay);
    // A status refresh must never hold the process open.
    (timer as { unref?: () => void }).unref?.();
    settleTimers.push(timer);
  }
}

/**
 * Track the MCP servers (registry + tool namespaces) and publish the short
 * status. Call once per process (from `ensureStatusWrap`). Returns an
 * unsubscribe function.
 */
export function subscribeMcpServers(pi: ExtensionAPI): () => void {
  const structural = (_event: unknown, ctx: ExtensionContext): void => {
    refreshCounts(pi, ctx, true);
    scheduleSettle(pi, ctx);
  };
  // Cheap safety net for servers that connect without an event (`/mcp` OAuth).
  const settled = (_event: unknown, ctx: ExtensionContext): void => {
    refreshCounts(pi, ctx);
  };
  const offs: Array<() => void> = [];
  try {
    offs.push(pi.on("session_start", structural));
  } catch {
    // Event surface missing — nothing to subscribe to.
  }
  try {
    offs.push(pi.on("mcp_servers_change", structural));
  } catch {
    // Ditto.
  }
  try {
    offs.push(pi.on("agent_settled", settled));
  } catch {
    // Older pi without the event — the settle schedule still covers startup.
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
