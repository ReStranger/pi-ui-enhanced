# pi-ui-enhanced

Terminal interface extension for the [pi coding agent](https://github.com/earendil-works/pi).

`pi-ui-enhanced` replaces the default editor frame and footer in `pi`. It adds rounded border characters to the input editor and adds Git, MCP, LSP, and token metrics to the footer.

## Features

### Rounded editor

- Draws rounded border characters (`╭`, `╮`, `╰`, `╯`) around the input editor.
- Shows the active model name and thinking level in the top border.
- Shows status indicators (spinner, retry count, compaction notice) in the border.
- Preserves scroll indicators (`↑`, `↓`), mouse hit tests, and autocomplete menus.

### Rounded panels and dialogs

- Frames pi's startup and info panels (`Package Updates Available`, new-version notices, `/changelog`, `/hotkeys`) and interactive menus (`/model`, `/settings`, `/thinking`, `/scoped-models`, `/bug`, `/login`, `/logout`, `/resume`, `/mcp`, `/llama`) with the same `╭─╮` / `╰─╯` border as the editor.
- Keeps the color of the separator it replaces and re-wraps the content, so every line still fits the terminal width.
- Delegates keyboard and mouse events inside selectors, so search inputs, list navigation, and clicks keep working.

### Status line footer

- Shows the current directory and Git branch.
- Marks dirty worktrees with `*`, diff line counts (`+added`, `-deleted`), and untracked file counts.
- Displays the active model name on the right edge.
- Shows MCP server counts, updating on server connect, disconnect, or tool changes.
- Shortens `pi-lens` LSP status messages to compact counts for active and failed servers.
- Shows context token usage, window fill percentage, cache hit rates, and total cost.
- Places `plan-mode` status first and sorts other statuses alphabetically.

## Requirements

- Node.js 22 or newer
- `@earendil-works/pi-coding-agent` 1.1.0 or newer
- `@earendil-works/pi-tui` 1.1.0 or newer

## Installation and usage

### Run via CLI

Run the extension directly without modifying stored settings:

```bash
pi -e npm:pi-ui-enhanced
```

For a local checkout:

```bash
pi -e ./pi-ui-enhanced
```

### Configuration file

Add `pi-ui-enhanced` to `settings.json` (user settings at `~/.pi/agent/settings.json` or project settings at `.pi/settings.json`).

As an extension:

```json
{
  "extensions": [
    "npm:pi-ui-enhanced"
  ]
}
```

As a package:

```json
{
  "packages": [
    "npm:pi-ui-enhanced"
  ]
}
```

For a local path:

```json
{
  "extensions": [
    "./path/to/pi-ui-enhanced"
  ]
}
```

## Development

Clone the repository and install dependencies:

```bash
git clone https://github.com/restranger/pi-ui-enhanced.git
cd pi-ui-enhanced
npm install
```

### Scripts

- `npm test` runs the unit tests through `node --test`.
- `npm run typecheck` checks types through `tsc --noEmit` (there is no emitted build; `pi` loads the TypeScript sources directly).

## Package contents

Run `npm pack --dry-run` to inspect files before publishing.

The published archive contains `src/`, `index.ts`, `README.md`, `LICENSE`, and `package.json`. Tests and local `.pi/` or `.freebuff/` directories are excluded.

## License

[MIT](LICENSE)
