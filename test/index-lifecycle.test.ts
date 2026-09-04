import assert from "node:assert/strict";
import test from "node:test";

// The lifecycle behaviour under test lives in `index.ts`, which imports the
// rounded editor (a TUI component). Importing the extension registers handlers
// on the fake `pi` passed in.
import extension from "../index.ts";
import { applyStatusRewrite } from "../src/status-wrap.ts";
import { LSP_STATUS_KEY } from "../src/lsp-status.ts";

type Handler = (event: unknown, ctx: unknown) => void;

function fakePi() {
  const handlers: Record<string, Handler[]> = {};
  const pi = {
    on(event: string, cb: Handler) {
      (handlers[event] ??= []).push(cb);
      return () => {};
    },
    getMcpServers() {
      return [];
    },
    getAllTools() {
      return [];
    },
  };
  return { pi: pi as never, handlers };
}

function fakeContext(mode: "tui" | "print", hasUI: boolean) {
  return {
    mode,
    hasUI,
    ui: {
      setStatus() {},
      setEditorComponent() {},
      setFooter() {},
      requestRender() {},
    },
  };
}

test("headless session_shutdown leaves shared status rewrites registered", () => {
  const { pi, handlers } = fakePi();
  extension(pi as never);

  const shutdowns = handlers.session_shutdown ?? [];
  assert.ok(shutdowns.length > 0, "session_shutdown handlers registered");

  for (const handler of shutdowns) {
    handler({}, fakeContext("print", false));
  }

  const raw = "LSP Active: foo, bar";
  const rewritten = applyStatusRewrite(LSP_STATUS_KEY, raw, undefined);
  assert.notEqual(rewritten, raw, "rewrite should still be active after headless shutdown");
  assert.match(rewritten ?? "", /lsp 2/i);
});

test("interactive owner session_shutdown disposes shared status rewrites", () => {
  const { pi, handlers } = fakePi();
  extension(pi as never);

  const shutdowns = handlers.session_shutdown ?? [];
  assert.ok(shutdowns.length > 0, "session_shutdown handlers registered");

  for (const handler of shutdowns) {
    handler({}, fakeContext("tui", true));
  }

  const raw = "LSP Active: foo, bar";
  const rewritten = applyStatusRewrite(LSP_STATUS_KEY, raw, undefined);
  assert.equal(rewritten, raw, "rewrite should be removed after interactive shutdown");
});
