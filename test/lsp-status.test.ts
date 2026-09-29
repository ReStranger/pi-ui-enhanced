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

// Fake theme: wraps in <color>…</> so tests can assert the color key used.
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

test("parseLspStatus maps inactive/✗ to zero", () => {
  assert.deepEqual(parseLspStatus("LSP Inactive"), { active: 0, failed: 0 });
  assert.deepEqual(parseLspStatus("LSP ✗"), { active: 0, failed: 0 });
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
