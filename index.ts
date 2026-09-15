import {
	RoundedEditor,
	resetEditorWorkingState,
	setEditorStatusLabel,
	setEditorWorking,
} from "./src/index.ts";
import type { ExtensionAPI } from "./src/index.ts";

export default function roundedInputExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		resetEditorWorkingState();
		setEditorStatusLabel({
			modelId: ctx.model?.id,
			thinkingLevel: ctx.thinkingLevel,
		});
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new RoundedEditor(tui, theme, keybindings, ctx.ui.theme),
		);
	});

	pi.on("agent_start", () => {
		setEditorWorking(true);
	});

	pi.on("agent_settled", () => {
		setEditorWorking(false);
	});

	pi.on("session_shutdown", () => {
		resetEditorWorkingState();
	});

	pi.on("model_select", (event, ctx) => {
		setEditorStatusLabel({
			modelId: event.model?.id,
			thinkingLevel: ctx.thinkingLevel,
		});
	});

	pi.on("thinking_level_select", (event, ctx) => {
		setEditorStatusLabel({
			modelId: ctx.model?.id,
			thinkingLevel: event.level,
		});
	});
}
