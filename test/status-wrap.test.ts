import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  applyStatusRewrite,
  BRANCH_ICON,
  clearGitDirtyCache,
  clearStatusRewrites,
  clearUsageCache,
  countUntracked,
  DIFF_ICON,
  footerLogPath,
  getCachedGitBranch,
  getCachedGitInfo,
  GIT_DIRTY_TTL_MS,
  GIT_MISS_TTL_MS,
  createFooterSourceFromContext,
  createInstanceOwnership,
  FOLDER_ICON,
  folderNameForFooter,
  getWorktreeStats,
  installWrappedFooter,
  isGitRefreshing,
  isGitStaleAt,
  isWorktreeDirty,
  parseNumstat,
  parsePorcelainBranch,
  porcelainIsDirty,
  readUsageTotals,
  registerStatusRewrite,
  renderWrappedFooter,
  restoreDefaultFooter,
  setCustomGitRunner,
  setGitRenderCallback,
  sortStatusKeys,
  strike,
  triggerGitRefresh,
  unregisterStatusRewrite,
  type FooterTheme,
  type WrappedFooterSource,
} from "../src/status-wrap.ts";

// The mcp status module and its tests live in test/mcp-status.test.ts. The
// only cross-module case here is the footer rendering an arbitrary
// registered rewrite, which needs no mcp import.

const identityTheme: FooterTheme = { fg: (_color: string, text: string) => text };

function makeSource(
  statuses: Record<string, string> = {},
): WrappedFooterSource {
  return {
    getCwd: () => "/home/user/project",
    getSessionName: () => undefined,
    getBranch: () => "main",
    getProviderCount: () => 1,
    getModelId: () => "test-model",
    getModelProvider: () => undefined,
    getThinkingLabel: () => undefined,
    getStatsLeft: () => "↑1.2k 12.3%/200k",
    getStatuses: () => new Map(Object.entries(statuses)),
  };
}

test("statuses pass through untouched without rewrites", () => {
  clearStatusRewrites();
  assert.equal(
    applyStatusRewrite("demo", "raw plugin status"),
    "raw plugin status",
  );
  assert.equal(applyStatusRewrite("demo", undefined), undefined);
});

test("register/unregister adds and removes a rewrite", () => {
  clearStatusRewrites();
  const upper = (raw: string | undefined) => raw?.toUpperCase();
  const off = registerStatusRewrite("demo", upper);
  assert.equal(applyStatusRewrite("demo", "abc"), "ABC");
  off();
  assert.equal(applyStatusRewrite("demo", "abc"), "abc");
  // The explicit unregister path.
  registerStatusRewrite("demo", upper);
  unregisterStatusRewrite("demo", upper);
  assert.equal(applyStatusRewrite("demo", "abc"), "abc");
  clearStatusRewrites();
});

test("rewrites chain in registration order and skips throwers", () => {
  clearStatusRewrites();
  registerStatusRewrite("demo", (raw) => `${raw}-a`);
  registerStatusRewrite("demo", () => {
    throw new Error("broken rewrite");
  });
  registerStatusRewrite("demo", (raw) => `${raw}-b`);
  assert.equal(applyStatusRewrite("demo", "x"), "x-a-b");
  clearStatusRewrites();
});

test("strike wraps in SGR 9 without adding width", () => {
  const struck = strike("1");
  assert.ok(struck.includes("\x1b[9m"));
  assert.ok(struck.includes("\x1b[29m"));
  assert.equal(visibleWidth(struck), 1);
  assert.equal(stripTerminalSequences(struck), "1");
});

test("folderNameForFooter returns just the basename", () => {
  assert.equal(folderNameForFooter("/home/user/project"), "project");
  assert.equal(folderNameForFooter("/home/user/project/"), "project");
  assert.equal(folderNameForFooter("/"), "/");
});

test("FOLDER_ICON is single-cell", () => {
  assert.equal(visibleWidth(FOLDER_ICON), 1);
});

test("BRANCH_ICON is single-cell", () => {
  assert.equal(visibleWidth(BRANCH_ICON), 1);
});

test("porcelainIsDirty treats any output as dirty", () => {
  assert.equal(porcelainIsDirty(""), false);
  assert.equal(porcelainIsDirty("   \n"), false);
  assert.equal(porcelainIsDirty(" M src/a.ts\n"), true);
  assert.equal(porcelainIsDirty("?? new-file\n"), true);
});

test("isWorktreeDirty caches per cwd within TTL", () => {
  clearGitDirtyCache();
  let calls = 0;
  const readers = {
    porcelain: () => {
      calls++;
      return "";
    },
    numstat: () => "",
  };
  const t = Date.now();
  assert.equal(isWorktreeDirty("/x", t, readers), false);
  assert.equal(isWorktreeDirty("/x", t + 1000, readers), false);
  assert.equal(calls, 1);
  assert.equal(isWorktreeDirty("/x", t + GIT_DIRTY_TTL_MS + 1000, readers), false);
  assert.equal(calls, 2);
  assert.equal(isWorktreeDirty(undefined, t, readers), false);
  clearGitDirtyCache();
});

test("branch gets a star when the worktree is dirty", () => {
  clearStatusRewrites();
  clearGitDirtyCache();
  const readers = { porcelain: () => " M src/a.ts", numstat: () => "" };
  const wrappingTheme = {
    fg: (color: string, text: string) => `<${color}>${text}</>`,
  };
  const lines = renderWrappedFooter(80, wrappingTheme, makeSource(), {
    now: 1000,
    readers,
  });
  assert.ok(
    (lines[0] ?? "").includes(`${BRANCH_ICON} main*`),
    `dirty branch must star: ${lines[0]}`,
  );
  assert.ok(
    isWorktreeDirty("/home/user/project", 1000, readers),
    "readers report a dirty worktree",
  );
  clearGitDirtyCache();
});

test("parseNumstat sums lines and skips binaries", () => {
  assert.deepEqual(parseNumstat(""), { added: 0, deleted: 0 });
  assert.deepEqual(parseNumstat("10\t4\tsrc/a.ts\n3\t9\tsrc/b.ts\n"), {
    added: 13,
    deleted: 13,
  });
  assert.deepEqual(parseNumstat("-\t-\tbin/logo.png\n5\t0\tsrc/c.ts\n"), {
    added: 5,
    deleted: 0,
  });
});

test("countUntracked counts ?? entries", () => {
  assert.equal(countUntracked(""), 0);
  assert.equal(countUntracked(" M src/a.ts\n"), 0);
  assert.equal(
    countUntracked(" M src/a.ts\n?? new-one\n?? new-two\n"),
    2,
  );
});

test("diff numbers render after the branch with colors", () => {
  clearStatusRewrites();
  clearGitDirtyCache();
  const cwd = "/home/user/project";
  const readers = {
    porcelain: () => "M  src/a.ts\n?? new-file\n?? other\n",
    numstat: () => "19\t2\tsrc/a.ts\n",
  };
  const stats = getWorktreeStats(cwd, 1000, readers);
  assert.deepEqual(stats, {
    dirty: true,
    added: 19,
    deleted: 2,
    untracked: 2,
  });
  const wrappingTheme = {
    fg: (color: string, text: string) => `<${color}>${text}</>`,
  };
  const lines = renderWrappedFooter(400, wrappingTheme, makeSource(), {
    now: 1000,
    readers,
  });
  const left = lines[0] ?? "";
  assert.ok(left.includes(`${BRANCH_ICON} main*`), `star: ${left}`);
  assert.ok(left.includes(`<success>+19</>`), `added green: ${left}`);
  assert.ok(left.includes(`<error>-2</>`), `deleted red: ${left}`);
  assert.ok(left.includes(`<thinkingMax>~2</>`), `untracked orange: ${left}`);
  assert.ok(left.includes(DIFF_ICON), `diff icon: ${left}`);
  assert.ok(
    left.includes(`<muted>${DIFF_ICON}</>`),
    `diff icon must be dim like secondary text: ${left}`,
  );
  // Order is +added, then -deleted, then ~untracked.
  assert.ok(
    left.indexOf("+19") < left.indexOf("-2") &&
      left.indexOf("-2") < left.indexOf("~2"),
    `order + - ~: ${left}`,
  );
  clearGitDirtyCache();
});

test("clean worktree hides the diff segment", () => {
  clearStatusRewrites();
  clearGitDirtyCache();
  const wrappingTheme = {
    fg: (color: string, text: string) => `<${color}>${text}</>`,
  };
  // The injected readers report a clean worktree, so the test runs no git
  // subprocess.
  const lines = renderWrappedFooter(80, wrappingTheme, makeSource(), {
    now: 0,
    readers: { porcelain: () => "", numstat: () => "" },
  });
  const left = lines[0] ?? "";
  assert.ok(!left.includes(DIFF_ICON), `no diff icon: ${left}`);
  assert.ok(!left.includes("*"), `no star: ${left}`);
  clearGitDirtyCache();
});

test("left line paints folder blue and branch orange", () => {
  clearStatusRewrites();
  const wrappingTheme = {
    fg: (color: string, text: string) => `<${color}>${text}</>`,
  };
  const lines = renderWrappedFooter(80, wrappingTheme, makeSource());
  const left = lines[0] ?? "";
  assert.ok(
    left.includes(`<thinkingLow>${FOLDER_ICON} project</>`),
    `folder must be thinkingLow: ${left}`,
  );
  assert.ok(
    left.includes(`<thinkingMax>${BRANCH_ICON} main</>`),
    `branch must be thinkingMax: ${left}`,
  );
});

test("wrapped footer left shows folder, right shows model", () => {
  clearStatusRewrites();
  const lines = renderWrappedFooter(80, identityTheme, makeSource());
  assert.equal(lines.length, 2);
  const left = stripTerminalSequences(lines[0] ?? "");
  assert.ok(left.includes(`${FOLDER_ICON} project`));
  assert.ok(!left.includes("/home/user"), "full path must be gone");
  const stats = stripTerminalSequences(lines[1] ?? "");
  assert.ok(stats.includes("test-model"));
});

test("wrapped footer survives undefined cwd (half-init ctx)", () => {
  clearStatusRewrites();
  const source = {
    ...makeSource(),
    getCwd: () => undefined,
  } as unknown as WrappedFooterSource;
  const lines = renderWrappedFooter(80, identityTheme, source);
  assert.equal(lines.length, 2);
  const left = stripTerminalSequences(lines[0] ?? "");
  assert.ok(left.includes("?"), "folder falls back to ?");
});

test("wrapped footer never throws: fallback line + log", () => {
  clearStatusRewrites();
  const hostile = {
    getCwd: () => {
      throw new Error("no cwd yet");
    },
    getSessionName: () => undefined,
    getBranch: () => null,
    getProviderCount: () => 0,
    getModelId: () => "m",
    getModelProvider: () => undefined,
    getThinkingLabel: () => undefined,
    getStatsLeft: () => "",
    getStatuses: () => new Map(),
  } as unknown as WrappedFooterSource;
  const lines = renderWrappedFooter(80, identityTheme, hostile);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]?.includes("footer error"));
});

test("wrapped footer rewrites the status line and keeps widths", () => {
  clearStatusRewrites();
  registerStatusRewrite("demo", (raw) => raw?.toUpperCase());
  try {
    const lines = renderWrappedFooter(
      80,
      identityTheme,
      makeSource({
        abc: "other plugin status",
        demo: "long plugin status: 4 servers enabled (1 disabled)",
      }),
    );
    assert.equal(lines.length, 3);
    assert.ok(lines[2]?.includes("LONG PLUGIN STATUS"));
    assert.ok(lines[2]?.includes("other plugin status"));
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <= 80,
        `line too wide: ${JSON.stringify(line)}`,
      );
    }
  } finally {
    clearStatusRewrites();
  }
});

test("sortStatusKeys pins plan-mode first, rest alphabetical", () => {
  assert.deepEqual(
    sortStatusKeys(["mcp", "pi-lens-lsp", "plan-mode", "abc"]),
    ["plan-mode", "abc", "mcp", "pi-lens-lsp"],
  );
  assert.deepEqual(sortStatusKeys(["mcp", "abc"]), ["abc", "mcp"]);
});

test("wrapped footer renders plan-mode status first", () => {
  clearStatusRewrites();
  const lines = renderWrappedFooter(
    400,
    identityTheme,
    makeSource({
      mcp: "MCP",
      "pi-lens-lsp": "LSP",
      "plan-mode": "PLAN",
      abc: "ABC",
    }),
  );
  assert.equal(lines.length, 3);
  const statusLine = stripTerminalSequences(lines[2] ?? "");
  assert.ok(
    statusLine.indexOf("PLAN") < statusLine.indexOf("ABC") &&
      statusLine.indexOf("ABC") < statusLine.indexOf("MCP") &&
      statusLine.indexOf("MCP") < statusLine.indexOf("LSP"),
    `plan first, rest alpha: ${statusLine}`,
  );
});

test("wrapped footer without statuses renders two lines", () => {
  clearStatusRewrites();
  const lines = renderWrappedFooter(80, identityTheme, makeSource());
  assert.equal(lines.length, 2);
  assert.ok(lines[0]?.includes(`${BRANCH_ICON} main`));
  assert.ok(!stripTerminalSequences(lines[0])?.includes("(main)"));
});

test("install/restore toggles the custom footer", () => {
  const calls: unknown[] = [];
  const ctx = {
    cwd: "/home/user/project",
    model: { id: "m", provider: "p" },
    thinkingLevel: "off",
    sessionManager: {
      getCwd: () => "/home/user/project",
      getSessionName: () => undefined,
      getEntries: () => [],
    },
    getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
    ui: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setFooter: (factory: any) => {
        calls.push(factory);
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  installWrappedFooter(ctx);
  assert.equal(calls.length, 1);
  const factory = calls[0] as (tui: unknown, theme: typeof identityTheme, footerData: {
    getGitBranch: () => null;
    getAvailableProviderCount: () => number;
    getExtensionStatuses: () => Map<string, string>;
  }) => { render: (width: number) => string[] };
  const component = factory({}, identityTheme, {
    getGitBranch: () => null,
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () =>
      new Map([["demo", "plugin status"]]),
  });
  clearStatusRewrites();
  registerStatusRewrite("demo", (raw) => raw?.toUpperCase());
  try {
    const lines = component.render(80);
    assert.ok(lines.some((line) => line.includes("PLUGIN STATUS")));
  } finally {
    clearStatusRewrites();
  }

  restoreDefaultFooter(ctx);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], undefined);
});

test("footer source tolerates failing context providers", () => {
  const broken = {
    cwd: "/x",
    sessionManager: {
      getCwd: () => {
        throw new Error("no session");
      },
      getSessionName: () => {
        throw new Error("no session");
      },
      getEntries: () => {
        throw new Error("no session");
      },
    },
    getContextUsage: () => {
      throw new Error("no usage");
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const footerData = {
    getGitBranch: () => {
      throw new Error("no git");
    },
    getAvailableProviderCount: () => {
      throw new Error("no providers");
    },
    getExtensionStatuses: () => {
      throw new Error("no statuses");
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const source = createFooterSourceFromContext(broken, footerData);
  const lines = renderWrappedFooter(60, identityTheme, source);
  assert.ok(lines.length >= 2);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 60);
  }
});

test("instance ownership: last claimant wins, release frees the key", () => {
  const key = "__piUiEnhancedTestOwner";
  const installed = createInstanceOwnership(key);
  const local = createInstanceOwnership(key);
  try {
    installed.claim();
    assert.ok(installed.isOwner());
    // Subsequent claimant takes ownership.
    local.claim();
    assert.ok(!installed.isOwner());
    assert.ok(local.isOwner());
    // Calling claim() repeatedly is idempotent.
    local.claim();
    assert.ok(local.isOwner());
  } finally {
    installed.release();
    local.release();
  }
  assert.ok(!installed.isOwner());
  assert.ok(!local.isOwner());
});

test("ANSI in the stats cell is not duplicated by the dim split", () => {
  clearStatusRewrites();
  clearUsageCache();
  const source = {
    ...makeSource(),
    getStatsLeft: () => "\x1b[31m50.0%/200k\x1b[0m",
  };
  const lines = renderWrappedFooter(80, identityTheme, source);
  const plain = stripTerminalSequences(lines[1] ?? "");
  assert.equal(plain.match(/200k/g)?.length, 1, `duplicated: ${plain}`);
  assert.ok(plain.trimEnd().endsWith("test-model"), plain);
});

test("context percentage is colored at the stock thresholds", () => {
  const wrappingTheme = {
    fg: (color: string, text: string) => `<${color}>${text}</>`,
  };
  const makeCtx = (percent: number | null) =>
    ({
      cwd: "/x",
      model: { id: "m" },
      sessionManager: {
        getCwd: () => "/x",
        getSessionName: () => undefined,
        getEntries: () => [],
      },
      getContextUsage: () => ({ tokens: 1, contextWindow: 1000, percent }),
    }) as any;
  const footerData = {
    getGitBranch: () => null,
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => new Map<string, string>(),
  } as any;
  const stats = (percent: number | null) =>
    createFooterSourceFromContext(makeCtx(percent), footerData).getStatsLeft(
      wrappingTheme,
    );

  assert.ok(stats(95).includes("<error>95.0%/1.0k</>"), stats(95));
  assert.ok(stats(75).includes("<warning>75.0%/1.0k</>"), stats(75));
  const low = stats(10);
  assert.ok(low.includes("10.0%/1.0k"), low);
  assert.ok(!low.includes("<error>") && !low.includes("<warning>"), low);
  assert.ok(stats(null).includes("?/1.0k"), stats(null));
});

test("cache hit rate is computed from the newest assistant usage", () => {
  clearUsageCache();
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: {
          input: 100,
          output: 10,
          cacheRead: 300,
          cacheWrite: 0,
          cost: 0,
        },
      },
    },
  ];
  const totals = readUsageTotals(entries, 1);
  assert.equal(totals.input, 100);
  assert.equal(totals.output, 10);
  assert.equal(totals.cacheRead, 300);
  assert.equal(totals.latestCacheHitRate?.toFixed(1), "75.0");
  clearUsageCache();
});

test("parsePorcelainBranch handles tracking, no-tracking, detached, and initial commits", () => {
  assert.equal(parsePorcelainBranch("## main...origin/main [ahead 1]"), "main");
  assert.equal(parsePorcelainBranch("## feature/xyz...origin/feature/xyz"), "feature/xyz");
  assert.equal(parsePorcelainBranch("## main"), "main");
  assert.equal(parsePorcelainBranch("## main [ahead 2]"), "main");
  assert.equal(parsePorcelainBranch("## HEAD (no branch)"), "HEAD");
  assert.equal(parsePorcelainBranch("## (detached from v1.0.0)"), "HEAD");
  assert.equal(parsePorcelainBranch("## No commits yet on dev"), "dev");
  assert.equal(parsePorcelainBranch("## Initial commit on main"), "main");
  assert.equal(parsePorcelainBranch("not a branch line"), undefined);
});

test("footerLogPath returns a safe per-user path avoiding shared /tmp filename", () => {
  const path = footerLogPath();
  assert.ok(typeof path === "string" && path.length > 0);
  assert.notEqual(path, "/tmp/pi-ui-enhanced-footer.log");
});

test("getCachedGitBranch returns empty string when not loaded without blocking", () => {
  clearGitDirtyCache();
  const branch = getCachedGitBranch("/non-existent-test-path-" + Date.now());
  assert.equal(branch, "");
  clearGitDirtyCache();
});

test("a failed git spawn is cached with the miss backoff and stops spawning git", async () => {
  clearGitDirtyCache();
  const missing = "/not-a-repo-" + Date.now();
  let runnerCalls = 0;
  setCustomGitRunner(async () => {
    runnerCalls++;
    return undefined;
  });
  try {
    // First read triggers one doomed background refresh and returns no branch.
    assert.equal(getCachedGitBranch(missing), "");
    // Let the void-ed refresh finish (it stamps the cache entry in real time).
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stamp = getCachedGitInfo(missing).lastCheck;
    assert.ok(stamp > 0, "the miss entry is cached");
    assert.equal(getCachedGitInfo(missing).missed, true);

    // Past GIT_DIRTY_TTL_MS but within GIT_MISS_TTL_MS: the miss must be
    // served from cache, protecting non-git directories from a spawn loop on
    // every render cycle.
    assert.equal(getCachedGitBranch(missing, stamp + GIT_DIRTY_TTL_MS + 1), "");
    assert.equal(runnerCalls, 1);

    // Past the miss backoff one new attempt is allowed.
    assert.equal(getCachedGitBranch(missing, stamp + GIT_MISS_TTL_MS + 1), "");
    assert.equal(runnerCalls, 2);
  } finally {
    setCustomGitRunner(undefined);
    clearGitDirtyCache();
  }
});

test("a successful git result is stale at the regular TTL, not the miss backoff", () => {
  clearGitDirtyCache();
  const entry = { stats: { dirty: false, added: 0, deleted: 0, untracked: 0 }, branch: "main", lastCheck: 0 };
  assert.equal(isGitStaleAt(entry, false, GIT_DIRTY_TTL_MS - 1), false);
  assert.equal(isGitStaleAt(entry, false, GIT_DIRTY_TTL_MS), true);
  assert.equal(isGitStaleAt(entry, true, 0), true, "cwd change is always stale");
  const miss = { ...entry, branch: undefined, missed: true };
  assert.equal(isGitStaleAt(miss, false, GIT_DIRTY_TTL_MS), false);
  assert.equal(isGitStaleAt(miss, false, GIT_MISS_TTL_MS), true);
  clearGitDirtyCache();
});

test("triggerGitRefresh refreshes in background, guards concurrency, and notifies callback", async () => {
  clearGitDirtyCache();
  let callbackCalls = 0;
  setGitRenderCallback(() => {
    callbackCalls++;
  });

  const testCwd = "/virtual-test-repo";
  let runnerCalls = 0;
  setCustomGitRunner(async (_cwd, args) => {
    runnerCalls++;
    if (args.includes("-b")) {
      return "## feature-branch...origin/feature-branch\n M file1.txt\n?? untracked.txt\n";
    }
    if (args.includes("--numstat")) {
      return "5\t2\tfile1.txt\n";
    }
    return undefined;
  });

  try {
    // Initial fetch
    const p1 = triggerGitRefresh(testCwd);
    assert.ok(isGitRefreshing(testCwd), "should be refreshing");
    // Concurrent call should be ignored by guard
    const p2 = triggerGitRefresh(testCwd);
    await Promise.all([p1, p2]);
    assert.equal(isGitRefreshing(testCwd), false);

    // Cache should now have the resolved info
    const info = getCachedGitInfo(testCwd);
    assert.equal(info.branch, "feature-branch");
    assert.equal(info.stats.dirty, true);
    assert.equal(info.stats.added, 5);
    assert.equal(info.stats.deleted, 2);
    assert.equal(info.stats.untracked, 1);
    assert.equal(callbackCalls, 1);
    assert.equal(runnerCalls, 2);
  } finally {
    setCustomGitRunner(undefined);
    setGitRenderCallback(undefined);
    clearGitDirtyCache();
  }
});
