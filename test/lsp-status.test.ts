import assert from "node:assert/strict";
import test from "node:test";
import {
  applyStatusRewrite,
  clearStatusRewrites,
  registerStatusRewrite,
} from "../src/status-wrap.ts";
import {
  formatLspShort,
  LSP_ICON,
  LSP_STATUS_KEY,
  parseLspStatus,
  registerLspShortStatus,
  rewriteLspStatus,
} from "../src/lsp-status.ts";

// Wraps in <color>…</> so assertions can read the color key.
const fakeTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</>`,
};

test("parseLspStatus counts active ids", () => {
  assert.deepEqual(parseLspStatus("LSP Active: typescript, python"), {
    active: 2,
    failed: 0,
  });
});

test("parseLspStatus counts both parts of a joined status", () => {
  assert.deepEqual(
    parseLspStatus("LSP Active: typescript · LSP Failed: rust, go"),
    { active: 1, failed: 2 },
  );
});

test("parseLspStatus ignores ANSI wrapping from pi-lens theme colors", () => {
  assert.deepEqual(
    parseLspStatus(
      "\x1b[32mLSP Active: ts\x1b[0m · \x1b[31mLSP Failed: x\x1b[0m",
    ),
    { active: 1, failed: 1 },
  );
});

test("parseLspStatus maps compact ✓ to a single active server", () => {
  assert.deepEqual(parseLspStatus("LSP ✓"), { active: 1, failed: 0 });
});

test("parseLspStatus parses only failed verbose", () => {
  assert.deepEqual(parseLspStatus("LSP Failed: rust-analyzer"), {
    active: 0,
    failed: 1,
  });
});

test("parseLspStatus parses multiple failed verbose", () => {
  assert.deepEqual(parseLspStatus("LSP Failed: rust, pyright"), {
    active: 0,
    failed: 2,
  });
});

test("parseLspStatus parses both active and failed verbose", () => {
  assert.deepEqual(
    parseLspStatus("LSP Active: tsserver · LSP Failed: pyright"),
    { active: 1, failed: 1 },
  );
});

test("parseLspStatus maps compact failed only to failed count", () => {
  assert.deepEqual(parseLspStatus("LSP ✗"), { active: 0, failed: 1 });
});

test("parseLspStatus parses compact both active and failed", () => {
  assert.deepEqual(parseLspStatus("LSP ✓ · LSP ✗"), { active: 1, failed: 1 });
});

test("parseLspStatus ignores decorative check crosses outside the LSP marker", () => {
  // A pi-lens theme or another plugin puts ✓/✗ glyphs in the same status line
  // far from the `LSP` token; they must not inflate the counts.
  assert.deepEqual(
    parseLspStatus("lint ✓ · LSP ✓ · tests ✗"),
    { active: 1, failed: 0 },
  );
  assert.deepEqual(
    parseLspStatus("lint ✓ · tests ✗ · LSP ✗"),
    { active: 0, failed: 1 },
  );
});

test("parseLspStatus counts every compact LSP marker", () => {
  assert.deepEqual(
    parseLspStatus("LSP ✓ · LSP ✓ · LSP ✗"),
    { active: 2, failed: 1 },
  );
});

test("parseLspStatus maps inactive to zero", () => {
  assert.deepEqual(parseLspStatus("LSP Inactive"), { active: 0, failed: 0 });
});

test("parseLspStatus handles empty string and whitespace", () => {
  assert.deepEqual(parseLspStatus(""), { active: 0, failed: 0 });
  assert.deepEqual(parseLspStatus("   "), { active: 0, failed: 0 });
});

test("parseLspStatus handles empty id lists and unknown formats", () => {
  assert.deepEqual(parseLspStatus("LSP Active: "), { active: 0, failed: 0 });
  assert.deepEqual(parseLspStatus("LSP Unknown status"), { active: 0, failed: 0 });
});

test("parseLspStatus parses reversed order of joined status", () => {
  assert.deepEqual(
    parseLspStatus("LSP Failed: rust · LSP Active: ts"),
    { active: 1, failed: 1 },
  );
});

test("parseLspStatus parses LSP Error prefix as failed", () => {
  assert.deepEqual(
    parseLspStatus("LSP Error: gopls"),
    { active: 0, failed: 1 },
  );
});

test("formatLspShort hides zero/zero", () => {
  assert.equal(
    formatLspShort({ active: 0, failed: 0 }, fakeTheme),
    undefined,
  );
});

test("formatLspShort paints themed blue and omits |0", () => {
  assert.equal(
    formatLspShort({ active: 2, failed: 0 }, fakeTheme),
    `<thinkingLow>${LSP_ICON} lsp 2</>`,
  );
});

test("formatLspShort appends |failed when nonzero", () => {
  assert.equal(
    formatLspShort({ active: 2, failed: 1 }, fakeTheme),
    `<thinkingLow>${LSP_ICON} lsp 2|1</>`,
  );
});

test("formatLspShort formats failed only", () => {
  assert.equal(
    formatLspShort({ active: 0, failed: 1 }, fakeTheme),
    `<thinkingLow>${LSP_ICON} lsp 0|1</>`,
  );
  assert.equal(
    formatLspShort({ active: 0, failed: 1 }, undefined),
    `${LSP_ICON} lsp 0|1`,
  );
  assert.equal(
    formatLspShort({ active: 0, failed: 2 }, fakeTheme),
    `<thinkingLow>${LSP_ICON} lsp 0|2</>`,
  );
});

test("formatLspShort falls back to plain text without a theme", () => {
  assert.equal(
    formatLspShort({ active: 3, failed: 0 }, undefined),
    `${LSP_ICON} lsp 3`,
  );
});

test("registry rewrites the pi-lens key with the theme color", () => {
  clearStatusRewrites();
  const unregister = registerLspShortStatus();
  try {
    assert.equal(
      applyStatusRewrite(
        LSP_STATUS_KEY,
        "LSP Active: typescript, python",
        fakeTheme,
      ),
      `<thinkingLow>${LSP_ICON} lsp 2</>`,
    );
    assert.equal(
      applyStatusRewrite(LSP_STATUS_KEY, "LSP Inactive", fakeTheme),
      undefined,
    );
  } finally {
    unregister();
  }
});

test("rewriteLspStatus returns undefined for a missing status", () => {
  assert.equal(rewriteLspStatus(undefined, { theme: fakeTheme }), undefined);
});

test("one-arg rewrites still work through the registry", () => {
  clearStatusRewrites();
  const unregister = registerStatusRewrite("other", (raw) => raw);
  try {
    assert.equal(
      applyStatusRewrite("other", "LSP Active: a", fakeTheme),
      "LSP Active: a",
    );
  } finally {
    unregister();
  }
});
