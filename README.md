# pi-ui-enhanced

TUI extension for the [pi coding agent](https://github.com/earendil-works/pi).

## Requirements

- Node.js 22 or newer
- `@earendil-works/pi-coding-agent` 1.1.0 or newer
- `@earendil-works/pi-tui` 1.1.0 or newer

## Installation

Run the extension directly without modifying stored settings:

```bash
pi install https://github.com/ReStranger/pi-ui-enhanced.git
```

## Integration with third-party plugins in the footer UI:

- built-in MCP
- [`npm:pi-lens`](https://pi.dev/packages/pi-lens)
- [`npm:@pi-vault/pi-dcp`](https://pi.dev/packages/@pi-vault/pi-dcp)

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

## License

[MIT](LICENSE)
