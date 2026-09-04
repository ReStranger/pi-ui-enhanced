import { RoundedEditor, setEditorStatusLabel } from "./src/index.ts";
import type { ExtensionAPI } from "./src/index.ts";

export default function roundedInputExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		setEditorStatusLabel({
			modelId: ctx.model?.id,
			thinkingLevel: ctx.thinkingLevel,
		});
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new RoundedEditor(tui, theme, keybindings),
		);
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
