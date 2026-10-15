import assert from "node:assert/strict";
import test from "node:test";
import {
  Container,
  Spacer,
  Text,
  stripTerminalSequences,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  PanelBody,
  RoundedPanelBorder,
  framePanelTail,
  installRoundedPanels,
  isRuleComponent,
  isStaticPanelContent,
  uninstallRoundedPanels,
} from "../src/panel-frame.ts";

/** Stand-in for core's `DynamicBorder`; the hook matches it by class name. */
class DynamicBorder {
  color?: (text: string) => string;

  constructor(color?: (text: string) => string) {
    this.color = color;
  }

  render(width: number): string[] {
    const rule = "─".repeat(Math.max(1, width));
    return [this.color ? this.color(rule) : rule];
  }

  invalidate(): void {}
}

/** Content that appears in dialogs, never in a chat notice. */
class SettingsList {
  render(width: number): string[] {
    return ["x".repeat(width)];
  }

  invalidate(): void {}
}

const wrap = (text: string): string => `\u001b[33m${text}\u001b[0m`;

/** Installs the hook for one test and removes it afterwards. */
function withPanels(t: { after(fn: () => void): void }, fn: () => void): void {
  uninstallRoundedPanels();
  installRoundedPanels();
  t.after(() => {
    uninstallRoundedPanels();
  });
  fn();
}

function makePackageUpdatePanel(): Container {
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(new DynamicBorder(wrap));
  container.addChild(new Text("Package Updates Available", 1, 1));
  container.addChild(new DynamicBorder(wrap));
  return container;
}

test("the hook reframes a notice panel when its closing rule arrives", (t) => {
  withPanels(t, () => {
    const container = makePackageUpdatePanel();

    assert.equal(container.children.length, 4);
    assert.ok(container.children[0] instanceof Spacer);
    assert.ok(container.children[1] instanceof RoundedPanelBorder);
    assert.ok(container.children[2] instanceof PanelBody);
    assert.ok(container.children[3] instanceof RoundedPanelBorder);
  });
});

test("the frame keeps the notice width, color and text", (t) => {
  withPanels(t, () => {
    const container = makePackageUpdatePanel();

    for (const width of [2, 3, 8, 40, 121]) {
      // Line 0 is core's own leading Spacer, which renders as "".
      const [spacerLine, ...frame] = container.render(width);
      assert.equal(spacerLine, "");
      assert.deepEqual(
        frame.map((line) => visibleWidth(line)),
        frame.map(() => width),
        `width=${width}`,
      );

      const plain = frame.map((line) => stripTerminalSequences(line));
      assert.equal(plain[0], `╭${"─".repeat(width - 2)}╮`);
      assert.equal(plain.at(-1), `╰${"─".repeat(width - 2)}╯`);
      for (const line of plain.slice(1, -1)) {
        assert.ok(line.startsWith("│"), `width=${width} line=${line}`);
        assert.ok(line.endsWith("│"), `width=${width} line=${line}`);
      }
    }

    const rendered = container.render(40);
    assert.equal(rendered[1], wrap(`╭${"─".repeat(38)}╮`));
    assert.equal(rendered.at(-1), wrap(`╰${"─".repeat(38)}╯`));
    assert.match(rendered.join("\n"), /Package Updates Available/);
  });
});

test("every content line is exactly `width` wide", () => {
  const body = new PanelBody([
    new Text("first", 1, 0),
    new Spacer(1),
    new Text("", 1, 0),
  ]);

  for (const width of [0, 1, 2, 3, 12, 47]) {
    for (const line of body.render(width)) {
      assert.equal(visibleWidth(line), width, `width=${width}`);
    }
  }
  assert.deepEqual(body.render(0), []);
  assert.ok(body.render(1).every((line) => line === "│"));
});

test("rounded separators degrade on tiny widths", () => {
  const top = new RoundedPanelBorder("top");
  const bottom = new RoundedPanelBorder("bottom");

  assert.deepEqual(top.render(0), [""]);
  assert.deepEqual(top.render(1), ["╭"]);
  assert.deepEqual(top.render(2), ["╭╮"]);
  assert.deepEqual(top.render(5), ["╭───╮"]);
  assert.deepEqual(bottom.render(0), [""]);
  assert.deepEqual(bottom.render(1), ["╰"]);
  assert.deepEqual(bottom.render(2), ["╰╯"]);
  assert.deepEqual(bottom.render(5), ["╰───╯"]);
});

test("the hook leaves interactive or nested content alone", (t) => {
  withPanels(t, () => {
    const container = new Container();
    container.addChild(new DynamicBorder(wrap));
    container.addChild(new Text("Select a model", 1, 1));
    container.addChild(new SettingsList());
    container.addChild(new DynamicBorder(wrap));

    assert.ok(container.children.every((child) => !(child instanceof PanelBody)));
    assert.ok(container.children.every((child) => !(child instanceof RoundedPanelBorder)));
    assert.ok(container.children[0] instanceof DynamicBorder);
    assert.ok(container.children.at(-1) instanceof DynamicBorder);
  });
});

test("the hook skips a nested container between the rules", (t) => {
  withPanels(t, () => {
    const container = new Container();
    const inner = new Container();
    inner.addChild(new Text("output", 1, 0));

    container.addChild(new DynamicBorder(wrap));
    container.addChild(inner);
    container.addChild(new DynamicBorder(wrap));

    assert.ok(container.children[1] instanceof Container);
    assert.equal(container.children.length, 3);
  });
});

test("only the closing rule triggers the frame", () => {
  // The fixtures stand in for core's components; the hook only calls
  // `render` and `invalidate`.
  const children: Component[] = [
    new Spacer(1),
    new DynamicBorder(),
    new Text("notice", 1, 0),
  ];

  assert.equal(framePanelTail(children), false);
  children.push(new DynamicBorder());
  assert.equal(framePanelTail(children), true);
  assert.equal(children.length, 4);
  // A later separator must not wrap the frame a second time.
  assert.equal(framePanelTail(children), false);
});

test("the scan stops at the nearest separator above", () => {
  const children: Component[] = [
    new DynamicBorder(),
    new Container(),
    new DynamicBorder(),
    new SettingsList(),
    new DynamicBorder(),
  ];

  // The nearest pair above holds non-static content, so the hook leaves it
  // alone.
  assert.equal(framePanelTail(children), false);
  assert.equal(children.length, 5);
});

test("install and uninstall are idempotent", () => {
  uninstallRoundedPanels();
  assert.equal(installRoundedPanels(), true);
  assert.equal(installRoundedPanels(), false);

  const framed = new Container();
  framed.addChild(new DynamicBorder());
  framed.addChild(new Text("notice", 1, 0));
  framed.addChild(new DynamicBorder());
  assert.ok(framed.children[0] instanceof RoundedPanelBorder);

  assert.equal(uninstallRoundedPanels(), true);
  assert.equal(uninstallRoundedPanels(), false);

  const untouched = new Container();
  untouched.addChild(new DynamicBorder());
  untouched.addChild(new Text("notice", 1, 0));
  untouched.addChild(new DynamicBorder());
  assert.ok(untouched.children[0] instanceof DynamicBorder);
});

test("separators and content are matched by class name", () => {
  assert.equal(isRuleComponent(new DynamicBorder()), true);
  assert.equal(isRuleComponent(new Text("─")), false);
  assert.equal(isRuleComponent(undefined), false);
  assert.equal(isStaticPanelContent(new Text("x")), true);
  assert.equal(isStaticPanelContent(new Spacer(1)), true);
  assert.equal(isStaticPanelContent(new SettingsList()), false);
  assert.equal(isStaticPanelContent(new Container()), false);
});
