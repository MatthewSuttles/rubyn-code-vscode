# Rubyn Code

**Ruby & Rails agentic coding assistant — right in your editor.**

Refactor controllers, generate idiomatic RSpec, catch N+1 queries, review PRs, and build entire features — all context-aware with your schema, routes, and specs.

<!-- TODO: GIF — Rubyn Code chat panel in action, refactoring a controller -->

## Quick Start

1. **Install the gem**
   ```bash
   gem install rubyn-code
   rubyn-code --setup
   ```

2. **Install this extension** from the VS Code Marketplace

3. **Open a Rails project** and press `Cmd+Shift+R` to start coding with Rubyn

That's it. Rubyn activates automatically when it detects Ruby files or a Gemfile.

## Features

### Chat Panel

Converse with an agentic assistant that reads your codebase, writes code, runs specs, and learns from every session. Streaming responses show progress in real time.

<!-- TODO: Screenshot — Chat panel with streaming response -->

### Inline Diffs

Code changes appear as reviewable inline diffs. Accept or reject each change before it hits your files.

<!-- TODO: Screenshot — Inline diff in the editor -->

### Context-Aware Refactoring

Select code and run **Refactor Selection** (`Cmd+Shift+E`). Rubyn automatically pulls in related models, routes, specs, and services to produce informed refactors.

<!-- TODO: GIF — Selecting code and running refactor -->

### Spec Generation

Run **Generate Specs** on any file. Rubyn reads the implementation, checks existing factories, and writes thorough RSpec coverage with edge cases.

<!-- TODO: Screenshot — Generated spec file -->

### PR Review

Run **Review PR** to diff your branch against `main` (or any base branch). Get severity-rated feedback: critical issues, warnings, suggestions, and nitpicks.

<!-- TODO: Screenshot — PR review output -->

### Explain Code

Select unfamiliar code and run **Explain Code** for a plain-language breakdown of what it does, why, and any patterns or issues to watch for.

### Status Bar

See the agent's current state (idle, thinking, executing) and running session cost at a glance.

### Tool Approval Flow

Every tool call (file read, file write, shell command) requires your approval before executing. Or enable **YOLO mode** to auto-approve everything for uninterrupted flow.

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| Open Chat | `Cmd+Shift+R` | Focus the Rubyn Code chat panel |
| Refactor Selection | `Cmd+Shift+E` | Refactor selected code with best practices |
| Generate Specs | Command Palette | Write RSpec specs for the active file |
| Explain Code | Command Palette | Explain what the selected code does |
| Review PR | Command Palette | Code review against a base branch |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `rubyn-code.provider` | `"anthropic"` | Active LLM provider (`anthropic` or `openai`) |
| `rubyn-code.model` | `"claude-opus-4-6"` | Model for completions |
| `rubyn-code.sessionBudget` | `5.00` | Max dollar budget per session |
| `rubyn-code.dailyBudget` | `10.00` | Max daily spend across all sessions |
| `rubyn-code.maxIterations` | `200` | Max agent loop iterations per prompt |
| `rubyn-code.contextThreshold` | `80000` | Token count before context compaction |
| `rubyn-code.yoloMode` | `false` | Auto-approve all tool calls |
| `rubyn-code.executablePath` | `"rubyn-code"` | Path to the CLI executable |

You can also click the model selector in the status bar to switch between **Auto** (task-based routing) and a specific model.

## Supported Editors

This extension works in both **VS Code** and **Cursor**.

- **VS Code** — install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=rubyn.rubyn-code)
- **Cursor** — install from [Open VSX](https://open-vsx.org/extension/rubyn/rubyn-code), or install the `.vsix` file manually

## Requirements

- **Ruby 4.0+**
- **`rubyn-code` gem** installed and authenticated (`gem install rubyn-code`)
- **VS Code 1.98+** or **Cursor**
- A valid authentication method (macOS Keychain via prior CLI login, `ANTHROPIC_API_KEY` env var, or `~/.rubyn-code/tokens.yml`)

## Development

### Prerequisites

- Node.js 18+ (`nvm use 18` if you use nvm)
- npm

### Build

```bash
git clone https://github.com/MatthewSuttles/rubyn-code-vscode.git
cd rubyn-code-vscode
npm install
npm run build
```

### Install locally

Build produces a `dist/` folder. To install the extension from source:

```bash
# Package into a .vsix file (requires Node 20+)
npx @vscode/vsce package

# Install in VS Code
code --install-extension rubyn-code-*.vsix

# Install in Cursor
cursor --install-extension rubyn-code-*.vsix
```

### Development mode

```bash
npm run watch
```

Then press `F5` in VS Code to launch the Extension Development Host with the latest changes.

### Run tests

```bash
npm test
```

### Publish

```bash
# VS Code Marketplace
npx @vscode/vsce publish

# OpenVSX (Cursor, Gitpod, Theia)
npx @vscode/vsce package
npx ovsx publish rubyn-code-*.vsix -p <OPENVSX_TOKEN>
```

## Full Documentation

For comprehensive docs — configuration details, troubleshooting, YOLO mode guide, and development setup — see the [full extension documentation](docs/vscode-extension.md).

## Related

- [rubyn-code](https://github.com/MatthewSuttles/rubyn-code) — The CLI gem that powers this extension

## License

MIT License — see [LICENSE](LICENSE) for details.
