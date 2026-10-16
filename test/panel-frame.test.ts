import assert from "node:assert/strict";
import test from "node:test";
import {
  Container,
  Spacer,
  Text,
  stripTerminalSequences,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  InteractivePanelBody,
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

class ModelSelectorComponent extends Container {
  constructor() {
    super();
    this.addChild(new DynamicBorder());
    this.addChild(new Text("Model search", 0, 0));
    this.addChild(new SettingsList());
    this.addChild(new DynamicBorder());
  }
}

class SettingsSelectorComponent extends Container {
  constructor() {
    super();
    this.addChild(new DynamicBorder());
    this.addChild(new SettingsList());
    this.addChild(new DynamicBorder());
  }
}

class MouseRecordingComponent {
  events: Array<Record<string, unknown>> = [];
  input: string[] = [];

  render(_width: number): string[] {
    return ["first line", "second line"];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    this.events.push({ ...event });
    return { handled: true, focus: true };
  }

  handleInput(data: string): void {
    this.input.push(data);
  }

  invalidate(): void {}
}

const wrap = (text: string): string => `\u001b[33m${text}\u001b[0m`;

function makeMouseEvent(overrides: Partial<TuiMouseEvent> & Pick<TuiMouseEvent, "type" | "x" | "y">): TuiMouseEvent {
  return {
    button: "left",
    shift: false,
    alt: false,
    ctrl: false,
    screenX: overrides.x,
    screenY: overrides.y,
    width: 40,
    height: 4,
    ...overrides,
  };
}

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

test("the hook frames interactive content with InteractivePanelBody", (t) => {
  withPanels(t, () => {
    const container = new Container();
    container.addChild(new DynamicBorder(wrap));
    container.addChild(new Text("Select a model", 1, 1));
    container.addChild(new SettingsList());
    container.addChild(new DynamicBorder(wrap));

    assert.equal(container.children.length, 3);
    assert.ok(container.children[0] instanceof RoundedPanelBorder);
    assert.ok(container.children[1] instanceof InteractivePanelBody);
    assert.ok(container.children[2] instanceof RoundedPanelBorder);
  });
});

test("the hook frames a nested container between the rules", (t) => {
  withPanels(t, () => {
    const container = new Container();
    const inner = new Container();
    inner.addChild(new Text("output", 1, 0));

    container.addChild(new DynamicBorder(wrap));
    container.addChild(inner);
    container.addChild(new DynamicBorder(wrap));

    assert.equal(container.children.length, 3);
    assert.ok(container.children[0] instanceof RoundedPanelBorder);
    assert.ok(container.children[1] instanceof InteractivePanelBody);
    assert.ok(container.children[2] instanceof RoundedPanelBorder);
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

  // The hook frames only the nearest pair above, leaving earlier components
  // untouched.
  assert.equal(framePanelTail(children), true);
  assert.equal(children.length, 5);
  assert.ok(children[0] instanceof DynamicBorder);
  assert.ok(children[1] instanceof Container);
  assert.ok(children[2] instanceof RoundedPanelBorder);
  assert.ok(children[3] instanceof InteractivePanelBody);
  assert.ok(children[4] instanceof RoundedPanelBorder);
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

test("the hook frames ModelSelectorComponent with an interactive body", (t) => {
  withPanels(t, () => {
    const selector = new ModelSelectorComponent();
    assert.equal(selector.children.length, 3);
    assert.ok(selector.children[0] instanceof RoundedPanelBorder);
    assert.ok(selector.children[1] instanceof InteractivePanelBody);
    assert.ok(selector.children[2] instanceof RoundedPanelBorder);

    const rendered = selector.render(50);
    assert.equal(rendered[0], `╭${"─".repeat(48)}╮`);
    assert.equal(rendered.at(-1), `╰${"─".repeat(48)}╯`);
    for (const line of rendered.slice(1, -1)) {
      assert.equal(line.length, 50);
      assert.ok(line.startsWith("│"));
      assert.ok(line.endsWith("│"));
    }
  });
});

test("the hook frames SettingsSelectorComponent with an interactive body", (t) => {
  withPanels(t, () => {
    const selector = new SettingsSelectorComponent();
    assert.equal(selector.children.length, 3);
    assert.ok(selector.children[0] instanceof RoundedPanelBorder);
    assert.ok(selector.children[1] instanceof InteractivePanelBody);
    assert.ok(selector.children[2] instanceof RoundedPanelBorder);
  });
});

test("the hook frames all dialog and menu components with an interactive body", (t) => {
  withPanels(t, () => {
    // Thinking selector fixture
    const thinking = new Container();
    thinking.addChild(new DynamicBorder());
    thinking.addChild(new Text("Thinking Level", 0, 0));
    thinking.addChild(new SettingsList());
    thinking.addChild(new DynamicBorder());
    assert.ok(thinking.children[0] instanceof RoundedPanelBorder);
    assert.ok(thinking.children[1] instanceof InteractivePanelBody);
    assert.ok(thinking.children[2] instanceof RoundedPanelBorder);

    // Scoped models fixture
    const models = new Container();
    models.addChild(new DynamicBorder());
    models.addChild(new Text("Model Configuration", 0, 0));
    models.addChild(new SettingsList());
    models.addChild(new DynamicBorder());
    assert.ok(models.children[1] instanceof InteractivePanelBody);

    // Bug report editor fixture
    const bugReport = new Container();
    bugReport.addChild(new DynamicBorder());
    bugReport.addChild(new Text("Report a bug", 1, 0));
    bugReport.addChild(new SettingsList());
    bugReport.addChild(new DynamicBorder());
    assert.ok(bugReport.children[1] instanceof InteractivePanelBody);

    // Auth selector fixture
    const auth = new Container();
    auth.addChild(new DynamicBorder());
    auth.addChild(new Text("Select authentication method:", 1, 0));
    auth.addChild(new SettingsList());
    auth.addChild(new DynamicBorder());
    assert.ok(auth.children[1] instanceof InteractivePanelBody);

    // OAuth logout selector fixture
    const logout = new Container();
    logout.addChild(new DynamicBorder());
    logout.addChild(new Text("Select provider to logout:", 1, 0));
    logout.addChild(new SettingsList());
    logout.addChild(new DynamicBorder());
    assert.ok(logout.children[1] instanceof InteractivePanelBody);

    // Session resume selector fixture (starts with Spacer)
    const session = new Container();
    session.addChild(new Spacer(1));
    session.addChild(new DynamicBorder());
    session.addChild(new Text("Resume Session", 1, 0));
    session.addChild(new SettingsList());
    session.addChild(new DynamicBorder());
    assert.ok(session.children[0] instanceof Spacer);
    assert.ok(session.children[1] instanceof RoundedPanelBorder);
    assert.ok(session.children[2] instanceof InteractivePanelBody);
    assert.ok(session.children[3] instanceof RoundedPanelBorder);

    // MCP/Llama frame fixture
    const mcp = new Container();
    mcp.addChild(new DynamicBorder());
    mcp.addChild(new Text("MCP servers", 1, 0));
    mcp.addChild(new SettingsList());
    mcp.addChild(new DynamicBorder());
    assert.ok(mcp.children[1] instanceof InteractivePanelBody);
  });
});

test("InteractivePanelBody translates mouse coordinates and forwards input", () => {
  const target = new MouseRecordingComponent();
  const body = new InteractivePanelBody([new Spacer(2), target]);

  // Click on left border glyph is ignored.
  const borderClick = body.handleMouse(
    makeMouseEvent({ type: "click", button: "left", x: 0, y: 2 }),
  );
  assert.equal(borderClick, undefined);
  assert.equal(target.events.length, 0);

  // Click on content at x=5, y=3: child sits after Spacer(2), so child y=1, inner x=4.
  const contentClick = body.handleMouse(
    makeMouseEvent({ type: "click", button: "left", x: 5, y: 3 }),
  );
  assert.ok(contentClick?.handled);
  assert.equal(target.events.length, 1);
  assert.equal(target.events[0]?.x, 4);
  assert.equal(target.events[0]?.y, 1);
  assert.equal(target.events[0]?.width, 38);
  assert.equal(target.events[0]?.height, 2);

  // Wheel events forward even on border columns.
  const wheelEvent = body.handleMouse(
    makeMouseEvent({ type: "wheel", button: "none", x: 0, y: 2, wheelDelta: -1 }),
  );
  assert.ok(wheelEvent?.handled);
  assert.equal(target.events.length, 2);
  assert.equal(target.events[1]?.x, 0);

  // Input forwards to the child.
  body.handleInput("test-key");
  assert.deepEqual(target.input, ["test-key"]);
});
