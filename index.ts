import {
	RoundedEditor,
	resetEditorWorkingState,
	setEditorStatusLabel,
} from "./src/index.ts";
import type { ExtensionAPI, ExtensionContext } from "./src/index.ts";
import {
  createInstanceOwnership,
  installWrappedFooter,
  rendersEditorUi,
  restoreDefaultFooter,
} from "./src/status-wrap.ts";
import {
  registerMcpShortStatus,
  subscribeMcpServers,
} from "./src/mcp-status.ts";
import { registerLspShortStatus } from "./src/lsp-status.ts";

// When loading with both `pi -e ./local-copy` and an installed package, two
// instances of this module load into the process. Each instance builds its
// own registry. The active owner performs UI writes, while other instances skip them.
let statusWrapReady = false;
const ownership = createInstanceOwnership("__piUiEnhancedOwner");
const disposables: Array<() => void> = [];

// pi fires `session_start` with a `reason` (startup/reload/new/resume/fork)
// for every session replacement after `session_shutdown`, so a single
// `session_start` handler re-installs the footer for /new, /resume, and /fork.

function ensureStatusWrap(pi: ExtensionAPI): void {
	ownership.claim();
	if (statusWrapReady) return;
	statusWrapReady = true;
	disposables.push(registerMcpShortStatus());
	disposables.push(registerLspShortStatus());
	// Track the MCP servers (registry + tool namespaces) and publish the short
	// status from session_start / mcp_servers_change / agent_settled.
	disposables.push(subscribeMcpServers(pi));
}

function disposeAll(): void {
	while (disposables.length > 0) {
		const dispose = disposables.pop();
		try {
			dispose?.();
		} catch {
			// Cleanup must never throw.
		}
	}
	statusWrapReady = false;
}

// Child subagents load extensions without a TUI. `rendersEditorUi` checks
// for an interactive TUI so subagents do not modify editor state.

/** Reinstalls the footer using the current context. */
function refreshWrappedFooter(ctx: ExtensionContext): void {
	if (!rendersEditorUi(ctx) || !ownership.isOwner()) return;
	installWrappedFooter(ctx);
}

export default function roundedInputExtension(pi: ExtensionAPI): void {
	ensureStatusWrap(pi);
	pi.on("session_start", (_event, ctx) => {
		ensureStatusWrap(pi);
		if (!rendersEditorUi(ctx) || !ownership.isOwner()) return;
		resetEditorWorkingState();
		installWrappedFooter(ctx);
		setEditorStatusLabel({
			modelId: ctx.model?.id,
			thinkingLevel: ctx.thinkingLevel,
		});
		// InteractiveMode sends working, compaction, and retry indicators to the
		// editor top border when embedWorkingStatus is enabled.
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			// Do not set border color here. Core overwrites border color during
			// rebindCurrentSession after this factory returns.
			return new RoundedEditor(tui, theme, keybindings);
		});
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!rendersEditorUi(ctx) || !ownership.isOwner()) return;
		setEditorStatusLabel({
			modelId: ctx.model?.id,
			thinkingLevel: ctx.thinkingLevel,
		});
		refreshWrappedFooter(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		// Headless subagents share this module instance (per-cwd registry) and
		// emit their own `session_shutdown`; only the interactive owner of the
		// TUI may drop the shared subscriptions and footer here, otherwise the
		// parent terminal loses its MCP/LSP footer until the next restart.
		// Session replacement (new/resume/fork) re-fires `session_start`
		// afterwards, which re-registers everything.
		if (!rendersEditorUi(ctx) || !ownership.isOwner()) return;
		resetEditorWorkingState();
		try {
			ctx.ui.setEditorComponent(undefined);
		} catch {
			// SAFETY: Best-effort editor teardown during shutdown.
		}
		restoreDefaultFooter(ctx);
		ownership.release();
		disposeAll();
	});

	pi.on("model_select", (event, ctx) => {
		if (!rendersEditorUi(ctx) || !ownership.isOwner()) return;
		setEditorStatusLabel({
			modelId: event.model.id,
			thinkingLevel: ctx.thinkingLevel,
		});
		refreshWrappedFooter(ctx);
	});

	pi.on("thinking_level_select", (event, ctx) => {
		if (!rendersEditorUi(ctx) || !ownership.isOwner()) return;
		setEditorStatusLabel({
			modelId: ctx.model?.id,
			thinkingLevel: event.level,
		});
		refreshWrappedFooter(ctx);
	});
}
