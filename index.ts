import {
	RoundedEditor,
	applyLiveThinkingBorderColor,
	getCurrentThinkingLevel,
	resetEditorWorkingState,
	setEditorStatusLabel,
	setEditorWorking,
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
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new RoundedEditor(tui, theme, keybindings, ctx.ui.theme);
			// Core seeds new editors with a possibly stale
			// defaultEditor.borderColor snapshot (frozen while a custom editor
			// is active). Re-sync it live so the frame matches the spinner.
			// Read the level from module state at instantiation time, not from
			// the session_start ctx snapshot, so a level change between
			// session_start and editor creation cannot leave a stale color.
			applyLiveThinkingBorderColor(editor, ctx.ui.theme, getCurrentThinkingLevel());
			return editor;
		});
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!rendersEditorUi(ctx)) return;
		setEditorWorking(true);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!rendersEditorUi(ctx)) return;
		setEditorWorking(false);
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
