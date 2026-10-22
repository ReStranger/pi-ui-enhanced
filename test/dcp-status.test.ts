import assert from "node:assert/strict";
import test from "node:test";
import {
  applyStatusRewrite,
  clearStatusRewrites,
  renderWrappedFooter,
  type WrappedFooterSource,
} from "../src/status-wrap.ts";
import {
  DCP_COLOR,
  DCP_ICON,
  DCP_STATUS_KEY,
  formatDcpShort,
  parseDcpStatus,
  registerDcpShortStatus,
  rewriteDcpStatus,
} from "../src/dcp-status.ts";

const fakeTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</>`,
};

test("parseDcpStatus parses standard pruning status", () => {
  assert.deepEqual(
    parseDcpStatus("DCP · saved ~268 tokens · pruned 4 outputs"),
    { tokens: "~268", count: 4 },
  );
});

test("parseDcpStatus parses singular token and output counts", () => {
  assert.deepEqual(
    parseDcpStatus("DCP · saved ~1 token · pruned 1 output"),
    { tokens: "~1", count: 1 },
  );
});

test("parseDcpStatus parses metric token prefixes (k, M)", () => {
  assert.deepEqual(
    parseDcpStatus("DCP · saved ~12.4k tokens · pruned 10 outputs"),
    { tokens: "~12.4k", count: 10 },
  );
  assert.deepEqual(
    parseDcpStatus("DCP · saved ~1.5M tokens · pruned 25 outputs"),
    { tokens: "~1.5M", count: 25 },
  );
});

test("parseDcpStatus parses bare exact token counts", () => {
  assert.deepEqual(
    parseDcpStatus("DCP · saved 500 tokens · pruned 3 outputs"),
    { tokens: "500", count: 3 },
  );
});

test("parseDcpStatus parses partial statuses (tokens only or pruned only)", () => {
  assert.deepEqual(parseDcpStatus("DCP · saved ~268 tokens"), {
    tokens: "~268",
    count: undefined,
  });
  assert.deepEqual(parseDcpStatus("DCP · pruned 4 outputs"), {
    tokens: undefined,
    count: 4,
  });
});

test("parseDcpStatus ignores ANSI formatting sequences", () => {
  assert.deepEqual(
    parseDcpStatus(
      "\x1b[32mDCP · saved ~268 tokens\x1b[0m · \x1b[33mpruned 4 outputs\x1b[0m",
    ),
    { tokens: "~268", count: 4 },
  );
});

test("parseDcpStatus handles detailed multiline notifications", () => {
  assert.deepEqual(
    parseDcpStatus(
      "DCP · saved ~268 tokens · pruned 4 outputs\nPruned: bash, read",
    ),
    { tokens: "~268", count: 4 },
  );
});

test("parseDcpStatus parses compression notifications", () => {
  assert.deepEqual(
    parseDcpStatus(
      "DCP · compressed ~12.4k tokens · summary ~2.1k · 5 messages",
    ),
    { tokens: "~12.4k", count: 5 },
  );
  assert.deepEqual(
    parseDcpStatus("DCP · compressed ~1 token · summary ~0 · 1 message"),
    { tokens: "~1", count: 1 },
  );
  assert.deepEqual(
    parseDcpStatus(
      "DCP · compressed ~12.4k tokens · summary ~2.1k · 5 messages\nTopic: refactoring",
    ),
    { tokens: "~12.4k", count: 5 },
  );
});

test("parseDcpStatus recognizes already compact formats", () => {
  assert.deepEqual(parseDcpStatus("dcp ~268 (4)"), {
    tokens: "~268",
    count: 4,
  });
  assert.deepEqual(parseDcpStatus("dcp ~268"), {
    tokens: "~268",
    count: undefined,
  });
  assert.deepEqual(parseDcpStatus("✂ dcp ~268 (4)"), {
    tokens: "~268",
    count: 4,
  });
});

test("parseDcpStatus returns undefined for empty, whitespace, or unknown input", () => {
  assert.equal(parseDcpStatus(""), undefined);
  assert.equal(parseDcpStatus("   "), undefined);
  assert.equal(parseDcpStatus("something unrelated"), undefined);
});

test("formatDcpShort formats plain and themed short status", () => {
  assert.equal(
    formatDcpShort({ tokens: "~268", count: 4 }),
    "dcp ~268 (4)",
  );
  assert.equal(
    formatDcpShort({ tokens: "~268", count: 4 }, fakeTheme),
    `<${DCP_COLOR}>dcp ~268 (4)</>`,
  );
});

test("formatDcpShort formats without count when count is zero or undefined", () => {
  assert.equal(
    formatDcpShort({ tokens: "~268", count: 0 }),
    "dcp ~268",
  );
  assert.equal(
    formatDcpShort({ tokens: "~268", count: undefined }),
    "dcp ~268",
  );
});

test("formatDcpShort formats count only when tokens are missing", () => {
  assert.equal(formatDcpShort({ count: 4 }), "dcp (4)");
});

test("formatDcpShort supports custom icon prefix", () => {
  assert.equal(
    formatDcpShort({ tokens: "~268", count: 4 }, undefined, "\uF0C4"),
    "\uF0C4 dcp ~268 (4)",
  );
  assert.equal(
    formatDcpShort({ tokens: "~268", count: 4 }, fakeTheme, "\uF0C4"),
    `<${DCP_COLOR}>\uF0C4 dcp ~268 (4)</>`,
  );
});

test("formatDcpShort returns undefined for zero or empty stats", () => {
  assert.equal(formatDcpShort(undefined), undefined);
  assert.equal(formatDcpShort({ tokens: undefined, count: undefined }), undefined);
  assert.equal(formatDcpShort({ tokens: "0", count: 0 }), undefined);
  assert.equal(formatDcpShort({ tokens: "~0", count: 0 }), undefined);
  assert.equal(formatDcpShort({ tokens: "0", count: undefined }), undefined);
  assert.equal(formatDcpShort({ tokens: undefined, count: 0 }), undefined);
});

test("rewriteDcpStatus rewrites raw pruning status", () => {
  assert.equal(
    rewriteDcpStatus("DCP · saved ~268 tokens · pruned 4 outputs"),
    "dcp ~268 (4)",
  );
  assert.equal(
    rewriteDcpStatus(
      "DCP · saved ~268 tokens · pruned 4 outputs",
      { theme: fakeTheme },
    ),
    `<${DCP_COLOR}>dcp ~268 (4)</>`,
  );
});

test("rewriteDcpStatus rewrites raw compression status", () => {
  assert.equal(
    rewriteDcpStatus(
      "DCP · compressed ~12.4k tokens · summary ~2.1k · 5 messages",
    ),
    "dcp ~12.4k (5)",
  );
});

test("rewriteDcpStatus returns undefined for missing status or zero savings", () => {
  assert.equal(rewriteDcpStatus(undefined), undefined);
  assert.equal(rewriteDcpStatus("DCP · saved 0 tokens · pruned 0 outputs"), undefined);
});

test("rewriteDcpStatus preserves unknown non-empty status as fallback", () => {
  assert.equal(
    rewriteDcpStatus("custom dcp status message"),
    "custom dcp status message",
  );
});

test("registerDcpShortStatus registers and unregisters rewrite on dcp key", () => {
  clearStatusRewrites();
  const unregister = registerDcpShortStatus();
  try {
    assert.equal(
      applyStatusRewrite(
        DCP_STATUS_KEY,
        "DCP · saved ~268 tokens · pruned 4 outputs",
        fakeTheme,
      ),
      `<${DCP_COLOR}>dcp ~268 (4)</>`,
    );
  } finally {
    unregister();
  }
  // After unregistering, raw string passes through untouched.
  assert.equal(
    applyStatusRewrite(
      DCP_STATUS_KEY,
      "DCP · saved ~268 tokens · pruned 4 outputs",
      fakeTheme,
    ),
    "DCP · saved ~268 tokens · pruned 4 outputs",
  );
});

test("wrapped footer renders rewritten dcp status in the footer line", () => {
  clearStatusRewrites();
  const unregister = registerDcpShortStatus();
  try {
    const fakeSource: WrappedFooterSource = {
      getCwd: () => "/test/project",
      getSessionName: () => undefined,
      getBranch: () => null,
      getProviderCount: () => 1,
      getModelId: () => "test-model",
      getModelProvider: () => undefined,
      getThinkingLabel: () => undefined,
      getStatsLeft: () => "10 tokens",
      getStatuses: () =>
        new Map([
          ["dcp", "DCP · saved ~268 tokens · pruned 4 outputs"],
        ]),
    };
    const lines = renderWrappedFooter(80, fakeTheme, fakeSource);
    assert.equal(lines.length, 3);
    assert.ok(lines[2]?.includes(`dcp ~268 (4)`));
  } finally {
    unregister();
  }
});
