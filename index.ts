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

// One-time process setup for the status wrapper (registry + bus snapshot).
// Double-load guard: `pi -e ./local-copy` runs alongside the installed
// package (two module instances). CLI `-e` paths load after discovery, so
// the last-loaded instance claims ownership and stale copies skip UI writes.
// Every UI write below is gated on `ownership.isOwner()` so only that copy
// touches the editor/footer (each instance has its own module registry, so
// duplicating the rewrites is harmless).
let statusWrapReady = false;
const ownership = createInstanceOwnership("__piUiEnhancedOwner");

function ensureStatusWrap(pi: ExtensionAPI): void {
	ownership.claim();
	if (statusWrapReady) return;
	statusWrapReady = true;
	registerMcpShortStatus();
	registerLspShortStatus();
	// Track the MCP servers (registry + tool namespaces) and publish the short
	// status from session_start / mcp_servers_change / agent_settled.
	subscribeMcpServers(pi);
}

// Subagent children load these extensions too and, through the per-cwd module
// registry, share this module instance — so their events would write the same
// editor state mirror. They are headless (mode "print", no UI context); the
// predicate lives in status-wrap so the MCP subscription can reuse it.

/** (Re)install the wrapped footer so it closes over the freshest `ctx`. */
function refreshWrappedFooter(ctx: ExtensionContext): void {
	if (!rendersEditorUi(ctx) || !ownership.isOwner()) return;
	installWrappedFooter(ctx);
}

export default function roundedInputExtension(pi: ExtensionAPI): void {
	ensureStatusWrap(pi);
	pi.on("session_start", (_event, ctx) => {
		if (!rendersEditorUi(ctx) || !ownership.isOwner()) return;
		resetEditorWorkingState();
		installWrappedFooter(ctx);
		setEditorStatusLabel({
			modelId: ctx.model?.id,
			thinkingLevel: ctx.thinkingLevel,
		});
		// No setWorkingVisible(false) here: with embedWorkingStatus the stock
		// InteractiveMode routes its working/compaction/retry indicators into
		// the editor top border itself, so the separate status line below the
		// editor must stay visible as the fallback surface.
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			// No border color is seeded here: core assigns a possibly stale
			// defaultEditor.borderColor snapshot right after this factory
			// returns, then re-applies the live thinking-level color at the end
			// of rebindCurrentSession (updateEditorBorderColor). Anything set
			// here would be overwritten by the second step.
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
		if (!rendersEditorUi(ctx) || !ownership.isOwner()) return;
		resetEditorWorkingState();
		restoreDefaultFooter(ctx);
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
