import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  applyStatusRewrite,
  clearStatusRewrites,
  createFooterSourceFromContext,
  renderWrappedFooter,
  type FooterTheme,
} from "../src/status-wrap.ts";
import {
  clearMcpCounts,
  currentMcpCounts,
  deriveMcpCounts,
  formatMcpShort,
  MCP_ICON,
  MCP_SETTLE_DELAYS_MS,
  MCP_STATUS_KEY,
  MCP_TOOL_PREFIX,
  parseMcpStatus,
  registerMcpShortStatus,
  rememberMcpCounts,
  rewriteMcpStatus,
  subscribeMcpServers,
  toolServerNames,
} from "../src/mcp-status.ts";

const identityTheme: FooterTheme = { fg: (_color: string, text: string) => text };

/** Minimal fake of pi's ExtensionAPI surface used by subscribeMcpServers. */
function makeFakePi(options?: {
  servers?: unknown[];
  tools?: unknown[] | (() => unknown[]);
  getMcpServersThrows?: boolean;
  getAllToolsThrows?: boolean;
}): {
  pi: any;
  handlerFor(event: string): ((event: unknown, ctx: any) => void) | undefined;
  emit(event: string, ctx?: unknown): void;
} {
  const handlers = new Map<
    string,
    (event: unknown, ctx: unknown) => void
  >();
  const offs: Array<() => void> = [];
  const pi = {
    getMcpServers: () => {
      if (options?.getMcpServersThrows) {
        throw new Error("no runtime");
      }
      return options?.servers ?? [
        { name: "a", config: { command: "npx" } },
        { name: "b", config: { url: "https://x" } },
      ];
    },
    getAllTools: () => {
      if (options?.getAllToolsThrows) {
        throw new Error("no runtime");
      }
      return typeof options?.tools === "function" ? options.tools() : options?.tools ?? [];
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      handlers.set(event, handler);
      const off = () => handlers.delete(event);
      offs.push(off);
      return off;
    },
  };
  return {
    pi,
    handlerFor: (event) => handlers.get(event),
    emit: (event, ctx) => handlers.get(event)?.(undefined, ctx),
  };
}

/** Fake ExtensionContext with a recording ui.setStatus. */
function makeFakeCtx(options?: { hasUI?: boolean }): { ctx: any; calls: Array<[string, string | undefined]> } {
  const calls: Array<[string, string | undefined]> = [];
  const ctx = {
    cwd: "/x",
    mode: "tui",
    hasUI: options?.hasUI ?? true,
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        calls.push([key, text]);
      },
    },
  };
  return { ctx, calls };
}

test("MCP icon is single-cell", () => {
  assert.equal(visibleWidth(MCP_ICON), 1);
});

test("deriveMcpCounts splits enabled/disabled and tolerates garbage", () => {
  assert.deepEqual(
    deriveMcpCounts([
      { name: "a", config: { command: "npx" } },
      { name: "b", config: { enabled: false } },
      { name: "c", config: { enabled: false, url: "https://y" } },
      "garbage",
      null,
      42,
    ]),
    { enabled: 1, disabled: 2 },
  );
  assert.deepEqual(deriveMcpCounts(undefined), { enabled: 0, disabled: 0 });
});

test("toolServerNames reads namespaces, falls back to the name, and dedupes", () => {
  assert.deepEqual(
    toolServerNames([
      { name: "mcp__mcp-nixos__nix", namespace: { name: "mcp__mcp-nixos" } },
      { name: "mcp__mcp-nixos__search", namespace: { name: "mcp__mcp-nixos" } },
      // No namespace: cut at the first `__`.
      { name: "mcp__sentry__whoami" },
      // Not MCP.
      { name: "read" },
      { name: "mcp__weird" },
      { name: "mcp____tool" },
      { name: 42 },
      null,
    ]),
    ["mcp-nixos", "sentry"],
  );
  assert.deepEqual(toolServerNames(undefined), []);
  assert.deepEqual(toolServerNames([{ namespace: { name: MCP_TOOL_PREFIX } }]), []);
});

test("deriveMcpCounts adds tool-only servers without double counting", () => {
  // `a` is in the registry; `mcp-nixos` only exists as a tool namespace
  // (mcp.json servers never reach the registry).
  assert.deepEqual(
    deriveMcpCounts(
      [{ name: "a", config: { command: "npx" } }],
      [
        { name: "mcp__a__one", namespace: { name: "mcp__a" } },
        { name: "mcp__mcp-nixos__nix", namespace: { name: "mcp__mcp-nixos" } },
        { name: "mcp__mcp-nixos__search", namespace: { name: "mcp__mcp-nixos" } },
      ],
    ),
    { enabled: 2, disabled: 0 },
  );
  // A disabled registered server keeps its `|N` slot and is not re-counted
  // through its (hidden but still registered) tools.
  assert.deepEqual(
    deriveMcpCounts([{ name: "off", config: { enabled: false } }], [
      { name: "mcp__off__tool", namespace: { name: "mcp__off" } },
    ]),
    { enabled: 0, disabled: 1 },
  );
  // A failing getAllTools() must not lose the registry counts.
  assert.deepEqual(
    deriveMcpCounts([{ name: "a", config: {} }], undefined),
    { enabled: 1, disabled: 0 },
  );
});

test("parseMcpStatus still reads the pi-mcp-adapter long format", () => {
  assert.deepEqual(
    parseMcpStatus("🔌 MCP: 4 servers enabled (2 connected) (1 disabled)"),
    { enabled: 4, disabled: 1 },
  );
  assert.deepEqual(parseMcpStatus("MCP: 1 server enabled"), {
    enabled: 1,
    disabled: 0,
  });
  assert.deepEqual(parseMcpStatus("🔌 MCP: 3 servers enabled (3 connected)"), {
    enabled: 3,
    disabled: 0,
  });
  assert.equal(parseMcpStatus("connecting to foo..."), undefined);
});

test("formatMcpShort renders `icon mcp 4|1` and hides zero", () => {
  assert.equal(
    formatMcpShort({ enabled: 4, disabled: 1 }),
    `${MCP_ICON} mcp 4|1`,
  );
  assert.equal(formatMcpShort({ enabled: 3, disabled: 0 }), `${MCP_ICON} mcp 3`);
  assert.equal(formatMcpShort({ enabled: 0, disabled: 0 }), undefined);
});

test("formatMcpShort paints accent when a theme is passed", () => {
  const accentTheme = {
    fg: (color: string, text: string) => `<${color}>${text}</>`,
  };
  assert.equal(
    formatMcpShort({ enabled: 4, disabled: 1 }, accentTheme),
    `<accent>${MCP_ICON} mcp 4|1</>`,
  );
});

test("the wrapped footer shortens the mcp line and keeps its widths", () => {
  clearStatusRewrites();
  clearMcpCounts();
  registerMcpShortStatus();
  try {
    const lines = renderWrappedFooter(
      80,
      identityTheme,
      createFooterSourceFromContext(
        {
          cwd: "/home/user/project",
          sessionManager: {
            getCwd: () => "/home/user/project",
            getSessionName: () => undefined,
            getEntries: () => [],
          },
          getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent: 1 }),
        } as never,
        {
          getGitBranch: () => "main",
          getAvailableProviderCount: () => 1,
          getExtensionStatuses: () =>
            new Map([
              ["abc", "other plugin status"],
              [
                MCP_STATUS_KEY,
                "🔌 MCP: 4 servers enabled (2 connected) (1 disabled)",
              ],
            ]),
        } as never,
      ),
    );
    assert.equal(lines.length, 3);
    assert.ok(lines[2]?.includes("mcp 4|"));
    assert.ok(!lines[2]?.includes("servers enabled"));
    assert.ok(lines[2]?.includes("other plugin status"));
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <= 80,
        `line too wide: ${JSON.stringify(line)}`,
      );
    }
  } finally {
    clearStatusRewrites();
    clearMcpCounts();
  }
});

test("rewriteMcpStatus prefers live counts over the parse fallback", () => {
  clearMcpCounts();
  try {
    rememberMcpCounts({ enabled: 2, disabled: 0 });
    assert.equal(
      rewriteMcpStatus("something unexpected", { theme: identityTheme }),
      formatMcpShort({ enabled: 2, disabled: 0 }, identityTheme),
    );
    // Zero live counts fall back to the raw text (adapter-owned key).
    rememberMcpCounts({ enabled: 0, disabled: 0 });
    assert.equal(
      rewriteMcpStatus("🔌 MCP: 4 servers enabled"),
      formatMcpShort({ enabled: 4, disabled: 0 }),
    );
    // With no counts at all the parse fallback applies.
    clearMcpCounts();
    assert.equal(
      rewriteMcpStatus("🔌 MCP: 4 servers enabled (1 disabled)"),
      formatMcpShort({ enabled: 4, disabled: 1 }),
    );
  } finally {
    clearMcpCounts();
  }
});

test("rewriteMcpStatus passes transient states through", () => {
  clearMcpCounts();
  assert.equal(
    rewriteMcpStatus("connecting to chrome-devtools…"),
    "connecting to chrome-devtools…",
  );
  assert.equal(rewriteMcpStatus(undefined), undefined);
});

test("registry rewrites the mcp key with the short format", () => {
  clearStatusRewrites();
  clearMcpCounts();
  const unregister = registerMcpShortStatus();
  try {
    assert.equal(
      applyStatusRewrite(
        MCP_STATUS_KEY,
        "🔌 MCP: 4 servers enabled (2 connected) (1 disabled)",
        identityTheme,
      ),
      `${MCP_ICON} mcp 4|1`,
    );
    assert.equal(applyStatusRewrite(MCP_STATUS_KEY, undefined), undefined);
  } finally {
    unregister();
    clearStatusRewrites();
  }
});

test("subscribeMcpServers reads servers on session_start and publishes the status", () => {
  clearMcpCounts();
  const fake = makeFakePi();
  const { ctx, calls } = makeFakeCtx();
  const off = subscribeMcpServers(fake.pi as any);
  try {
    fake.emit("session_start", ctx);
    assert.deepEqual(currentMcpCounts(), { enabled: 2, disabled: 0 });
    assert.deepEqual(calls, [[MCP_STATUS_KEY, formatMcpShort({ enabled: 2, disabled: 0 })]]);
  } finally {
    off();
  }
});

test("subscribeMcpServers updates on mcp_servers_change", () => {
  clearMcpCounts();
  const fake = makeFakePi();
  const { ctx, calls } = makeFakeCtx();
  const off = subscribeMcpServers(fake.pi as any);
  try {
    fake.emit("session_start", ctx);
    fake.emit("mcp_servers_change", ctx);
    // The registry is read again on every event.
    assert.ok(calls.length >= 2);
    assert.deepEqual(calls.at(-1), [MCP_STATUS_KEY, formatMcpShort({ enabled: 2, disabled: 0 })]);
  } finally {
    off();
    clearMcpCounts();
  }
});

test("subscribeMcpServers clears its own published status but never clobbers a foreign key", () => {
  clearMcpCounts();
  // First run: servers exist, we publish.
  const fake = makeFakePi();
  const { ctx, calls } = makeFakeCtx();
  const off = subscribeMcpServers(fake.pi as any);
  try {
    fake.emit("session_start", ctx);
    assert.ok(calls.some(([key, text]) => key === MCP_STATUS_KEY && text !== undefined));

    // Second run with no servers: our own key gets cleared (published = true).
    off();
    clearMcpCounts();
    const emptyFake = makeFakePi({ servers: [] });
    const empty = makeFakeCtx();
    const offEmpty = subscribeMcpServers(emptyFake.pi as any);
    emptyFake.emit("session_start", empty.ctx);
    offEmpty();
    assert.deepEqual(
      empty.calls.filter(([key]) => key === MCP_STATUS_KEY),
      [],
      "zero servers must not publish a status",
    );
  } finally {
    off();
    clearMcpCounts();
  }
});

test("subscribeMcpServers survives a throwing getMcpServers", () => {
  clearMcpCounts();
  const fake = makeFakePi({ getMcpServersThrows: true });
  const { ctx, calls } = makeFakeCtx();
  const off = subscribeMcpServers(fake.pi as any);
  try {
    assert.doesNotThrow(() => fake.emit("session_start", ctx));
    assert.deepEqual(calls, []);
  } finally {
    off();
    clearMcpCounts();
  }
});

test("subscribeMcpServers survives a throwing getAllTools", () => {
  clearMcpCounts();
  const fake = makeFakePi({ getAllToolsThrows: true });
  const { ctx, calls } = makeFakeCtx();
  const off = subscribeMcpServers(fake.pi as any);
  try {
    assert.doesNotThrow(() => fake.emit("session_start", ctx));
    // The registry half still publishes.
    assert.deepEqual(calls, [[MCP_STATUS_KEY, formatMcpShort({ enabled: 2, disabled: 0 })]]);
  } finally {
    off();
    clearMcpCounts();
  }
});

test("mcp.json servers appear through their tool namespaces", () => {
  clearMcpCounts();
  const fake = makeFakePi({
    servers: [],
    tools: [{ name: "mcp__mcp-nixos__nix", namespace: { name: "mcp__mcp-nixos" } }],
  });
  const { ctx, calls } = makeFakeCtx();
  const off = subscribeMcpServers(fake.pi as any);
  try {
    fake.emit("session_start", ctx);
    assert.deepEqual(calls, [[MCP_STATUS_KEY, formatMcpShort({ enabled: 1, disabled: 0 })]]);
  } finally {
    off();
    clearMcpCounts();
  }
});

test("the settle schedule picks up servers that connect after session_start", (t) => {
  clearMcpCounts();
  let tools: unknown[] = [];
  const fake = makeFakePi({ servers: [], tools: () => tools });
  const { ctx, calls } = makeFakeCtx();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const off = subscribeMcpServers(fake.pi as any);
  try {
    // Nothing configured yet: no status, so no write.
    fake.emit("session_start", ctx);
    assert.deepEqual(calls, []);
    // Core connects the mcp.json servers a tick later.
    tools = [{ name: "mcp__mcp-nixos__nix", namespace: { name: "mcp__mcp-nixos" } }];
    t.mock.timers.tick((MCP_SETTLE_DELAYS_MS.at(-1) ?? 0) + 1);
    assert.deepEqual(calls, [[MCP_STATUS_KEY, formatMcpShort({ enabled: 1, disabled: 0 })]]);
    // Unchanged counts must not write again.
    t.mock.timers.tick((MCP_SETTLE_DELAYS_MS.at(-1) ?? 0) + 1);
    assert.equal(calls.length, 1);
  } finally {
    off();
    t.mock.timers.reset();
  }
});

test("agent_settled refreshes the count for servers that connect silently", () => {
  clearMcpCounts();
  let tools: unknown[] = [];
  const fake = makeFakePi({ servers: [], tools: () => tools });
  const { ctx, calls } = makeFakeCtx();
  const off = subscribeMcpServers(fake.pi as any);
  try {
    fake.emit("session_start", ctx);
    assert.deepEqual(calls, []);
    // `/mcp` OAuth finished: tools appear with no extension event.
    tools = [{ name: "mcp__sentry__whoami", namespace: { name: "mcp__sentry" } }];
    fake.emit("agent_settled", ctx);
    assert.deepEqual(calls, [[MCP_STATUS_KEY, formatMcpShort({ enabled: 1, disabled: 0 })]]);
    // A structural event re-writes the same value (core wipes statuses on
    // rebind, so our own "already published" flag cannot be trusted there).
    fake.emit("session_start", ctx);
    assert.equal(calls.length, 2);
  } finally {
    off();
    clearMcpCounts();
  }
});

test("subscribeMcpServers skips UI writes for headless contexts", () => {
  clearMcpCounts();
  const fake = makeFakePi();
  const { ctx, calls } = makeFakeCtx({ hasUI: false });
  const off = subscribeMcpServers(fake.pi as any);
  try {
    fake.emit("session_start", ctx);
    assert.deepEqual(calls, []);
    assert.deepEqual(currentMcpCounts(), { enabled: 2, disabled: 0 });
  } finally {
    off();
    clearMcpCounts();
  }
});

test("subscribeMcpServers unsubscribe removes handlers and drops counts", () => {
  clearMcpCounts();
  const fake = makeFakePi();
  const { ctx } = makeFakeCtx();
  const off = subscribeMcpServers(fake.pi as any);
  off();
  assert.equal(fake.handlerFor("session_start"), undefined);
  assert.equal(fake.handlerFor("mcp_servers_change"), undefined);
  assert.equal(fake.handlerFor("agent_settled"), undefined);
  assert.equal(currentMcpCounts(), undefined);
  // Emission after unsubscribe is a no-op.
  assert.doesNotThrow(() => fake.emit("session_start", ctx));
});

test("counts stay readable through currentMcpCounts", () => {
  clearMcpCounts();
  rememberMcpCounts(deriveMcpCounts([{ name: "a", config: {} }]));
  assert.deepEqual(currentMcpCounts(), { enabled: 1, disabled: 0 });
  clearMcpCounts();
  assert.equal(currentMcpCounts(), undefined);
});
