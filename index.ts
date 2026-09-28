import {
	RoundedEditor,
	resetEditorWorkingState,
	setEditorStatusLabel,
} from "./src/index.ts";
import type { ExtensionAPI, ExtensionContext } from "./src/index.ts";

// Subagent children load these extensions too and, through the per-cwd module
// registry, share this module instance — so their events would write the same
// editor state mirror. They are headless (mode "print", no UI context).
function rendersEditorUi(ctx: Pick<ExtensionContext, "mode" | "hasUI">): boolean {
	return ctx.mode === "tui" && ctx.hasUI === true;
}

export default function roundedInputExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!rendersEditorUi(ctx)) return;
		resetEditorWorkingState();
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
		if (!rendersEditorUi(ctx)) return;
		setEditorStatusLabel({
			modelId: ctx.model?.id,
			thinkingLevel: ctx.thinkingLevel,
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!rendersEditorUi(ctx)) return;
		resetEditorWorkingState();
	});

	pi.on("model_select", (event, ctx) => {
		if (!rendersEditorUi(ctx)) return;
		setEditorStatusLabel({
			modelId: event.model.id,
			thinkingLevel: ctx.thinkingLevel,
		});
	});

	pi.on("thinking_level_select", (event, ctx) => {
		if (!rendersEditorUi(ctx)) return;
		setEditorStatusLabel({
			modelId: ctx.model?.id,
			thinkingLevel: event.level,
		});
	});
}
