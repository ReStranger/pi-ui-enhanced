import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  visibleWidth,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
  RoundedEditor,
  type EmbeddedStatusIndicator,
  resetEditorWorkingState,
  setEditorStatusLabel,
} from "../src/index.ts";

/** Private base-Editor fields the frame math relies on. */
type EditorInternals = {
  autocompleteState: unknown;
  autocompleteList: unknown;
  renderedVisibleLineCount: number;
  renderedAutocompleteHeight: number;
};

type FakeAutocompleteList = {
  render(width: number): string[];
  handleMouse?(event: TuiMouseEvent): { handled: boolean } | undefined;
};

function makeEditor() {
  resetEditorWorkingState();

  const renderRequests: number[] = [];
  // The base editor only needs `terminal.rows` and `requestRender` to render.
  const tui = {
    terminal: { rows: 24 },
    requestRender() {
      renderRequests.push(1);
    },
  } as unknown as TUI;
  const theme = {
    borderColor: (text: string) => text,
    selectList: {},
  } as unknown as EditorTheme;
  const editor = new RoundedEditor(tui, theme, {} as KeybindingsManager);

  return {
    editor,
    internals: editor as unknown as EditorInternals,
    renderRequests,
  };
}

/** Minimal stand-in for the stock StatusIndicator. */
function makeIndicator(text: string): EmbeddedStatusIndicator {
  return {
    renderInBorder: () => text,
    renderSpinnerInBorder: () => "⠦",
  };
}

function showAutocomplete(
  internals: EditorInternals,
  list: FakeAutocompleteList,
): void {
  internals.autocompleteList = list;
  internals.autocompleteState = "force";
}

test("every frame line is exactly the requested width", () => {
  const { editor } = makeEditor();
  editor.setText("hello");

  for (const width of [0, 1, 2, 3, 8, 20, 41, 120]) {
    for (const line of editor.render(width)) {
      assert.equal(
        visibleWidth(line),
        width,
        `width=${width} line=${JSON.stringify(line)}`,
      );
    }
  }
});

test("the frame never changes the editor's height", () => {
  // The host stacks the editor, the widgets and the footer into one live
  // region, so growing the frame would shift everything below it.
  resetEditorWorkingState();
  const tui = {
    terminal: { rows: 24 },
    requestRender() {},
  } as unknown as TUI;
  const theme = {
    borderColor: (text: string) => text,
    selectList: {},
  } as unknown as EditorTheme;

  for (const width of [40, 80, 120]) {
    const base = new Editor(tui, theme);
    const rounded = new RoundedEditor(tui, theme, {} as KeybindingsManager);

    assert.equal(rounded.render(width).length, base.render(width).length);

    base.setText("hello");
    rounded.setText("hello");
    assert.equal(rounded.render(width).length, base.render(width).length);
  }
});

test("narrow frames and wrapped text stay within the width", () => {
  const { editor } = makeEditor();
  editor.setText("a\nbb\nccc\ndddd");

  for (const width of [2, 5, 12]) {
    for (const line of editor.render(width)) {
      assert.equal(
        visibleWidth(line),
        width,
        `width=${width} line=${JSON.stringify(line)}`,
      );
    }
  }
});

test("scroll indicators survive and keep the frame width", () => {
  const { editor } = makeEditor();
  editor.setText(
    Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"),
  );

  const lines = editor.render(30);

  assert.ok(
    lines.some((line) => line.includes("↑")),
    "expected the top border to carry the scroll indicator",
  );
  for (const line of lines) {
    assert.equal(visibleWidth(line), 30);
  }
});

test("the status border carries the model and the thinking level", () => {
  const { editor } = makeEditor();
  editor.setText("hi");
  setEditorStatusLabel({ modelId: "pi-lens", thinkingLevel: "high" });

  const lines = editor.render(60);
  const bottom = lines[lines.length - 1] ?? "";

  assert.match(bottom, /pi-lens/);
  assert.match(bottom, /high/);
  assert.ok(bottom.startsWith("╰"), `unexpected bottom border: ${bottom}`);
  assert.ok(bottom.endsWith("╯"), `unexpected bottom border: ${bottom}`);
  assert.equal(visibleWidth(bottom), 60);
});

test("a stock working indicator is embedded into the top border", () => {
  const { editor } = makeEditor();
  editor.setText("hi");
  editor.setWorkingStatusIndicator(makeIndicator("⠦ Working"));

  const top = editor.render(40)[0] ?? "";
  assert.match(top, /Working/);
  assert.ok(top.startsWith("╭"), `unexpected top border: ${top}`);
  assert.ok(top.endsWith("╮"), `unexpected top border: ${top}`);
  assert.equal(visibleWidth(top), 40);

  editor.setWorkingStatusIndicator(undefined);
  const cleared = editor.render(40)[0] ?? "";
  assert.doesNotMatch(cleared, /Working/);
  assert.equal(visibleWidth(cleared), 40);
});

test("a stock compaction indicator is embedded into the top border", () => {
  const { editor } = makeEditor();
  editor.setText("hi");
  editor.setWorkingStatusIndicator(
    makeIndicator("⠦ Compacting context... (escape to cancel)"),
  );

  const top = editor.render(60)[0] ?? "";
  assert.match(top, /Compacting/);
  assert.ok(top.startsWith("╭"), `unexpected top border: ${top}`);
  assert.ok(top.endsWith("╮"), `unexpected top border: ${top}`);
  assert.equal(visibleWidth(top), 60);
});

test("an embedded indicator does not clobber a scroll indicator", () => {
  const { editor } = makeEditor();
  editor.setText(
    Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"),
  );
  editor.setWorkingStatusIndicator(makeIndicator("⠦ Working"));

  const top = editor.render(40)[0] ?? "";
  assert.match(top, /↑/);
  assert.doesNotMatch(top, /Working/);
  assert.equal(visibleWidth(top), 40);
});

test("embedded indicators keep every frame line at the requested width", () => {
  const { editor } = makeEditor();
  editor.setText("hi");
  editor.setWorkingStatusIndicator(makeIndicator("⠦ Working"));

  for (const width of [8, 20, 40, 120]) {
    for (const line of editor.render(width)) {
      assert.equal(
        visibleWidth(line),
        width,
        `width=${width} line=${JSON.stringify(line)}`,
      );
    }
  }
});

test("setting the indicator requests a render", () => {
  const { editor, renderRequests } = makeEditor();
  editor.render(30);
  renderRequests.length = 0;

  editor.setWorkingStatusIndicator(makeIndicator("⠦ Working"));
  assert.equal(renderRequests.length, 1);

  editor.setWorkingStatusIndicator(undefined);
  assert.equal(renderRequests.length, 2);
});

test("autocomplete rows stay where base handleMouse hit-tests them", () => {
  const { editor, internals } = makeEditor();
  editor.setText("hello");

  let renderCount = 0;
  showAutocomplete(internals, {
    render() {
      renderCount += 1;
      return ["item-a", "item-b"];
    },
  });

  const width = 40;
  const lines = editor.render(width);
  const visible = internals.renderedVisibleLineCount;
  const height = internals.renderedAutocompleteHeight;

  assert.equal(height, 2, "the base editor reports the rows it appended");
  assert.equal(renderCount, 1, "the list must be rendered once per frame");
  assert.equal(lines.length, visible + height + 3);
  assert.match(lines[visible + 2] ?? "", /item-a/);
  assert.equal(lines[lines.length - 1], `╰${"─".repeat(width - 2)}╯`);

  for (const line of lines) {
    assert.equal(visibleWidth(line), width);
  }
});

test("clicks on autocomplete rows are mapped back onto the frame content", () => {
  const { editor, internals } = makeEditor();
  editor.setText("hello");

  const seen: TuiMouseEvent[] = [];
  showAutocomplete(internals, {
    render: () => ["item-a"],
    handleMouse(event) {
      seen.push(event);
      return { handled: true };
    },
  });
  editor.render(40);

  const startRow = internals.renderedVisibleLineCount + 2;
  const result = editor.handleMouse({
    type: "click",
    button: "left",
    x: 5,
    y: startRow,
    width: 40,
    height: 4,
    screenX: 5,
    screenY: startRow,
  } as TuiMouseEvent);

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.y, 0);
  assert.equal(seen[0]?.x, 4, "the left border column must be removed from x");
  assert.equal(
    seen[0]?.width,
    38,
    "the list is rendered two columns narrower than the frame",
  );
  assert.deepEqual(result, { handled: true, focus: true });
});


