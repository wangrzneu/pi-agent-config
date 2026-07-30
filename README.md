# pi-agent-config

English | [简体中文](README.zh-CN.md)

A personally maintained collection of configurations, extensions, and workflows for Pi Coding Agent.

## Contents

- `extensions/plan-mode/`: read-only planning mode
- `extensions/markdown-viewer/`: open and render local Markdown files in the Pi TUI
- `extensions/work-status/`: show the current task and work type in the Pi TUI
- `extensions/btw/`: ask temporary side questions without changing the main conversation
- `skills/pi-workflow/`: concise default working guidelines
- `prompts/`: on-demand prompts for review, debugging, and architecture tasks
- `docs/`: reference documentation for code exploration, external projects, and security boundaries
- `settings.example.json`: example project-level Pi package configuration

## Prerequisites

Node.js 22.19.0 or later is required. Install Pi:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Verify the environment:

```bash
node --version
pi --version
```

## Installation

### Global installation

Install once to make the package available to all projects:

```bash
pi install git:github.com/wangrzneu/pi-agent-config
```

### Project installation

Run this in the target project directory. The configuration is written to `.pi/settings.json`:

```bash
pi install -l git:github.com/wangrzneu/pi-agent-config
```

You can also merge the contents of `settings.example.json` into the project's `.pi/settings.json`.

### Local directory

When developing or using a local checkout, install the Mermaid rendering dependency first:

```bash
cd /absolute/path/to/pi-agent-config
npm install
pi install -l /absolute/path/to/pi-agent-config
```

Temporarily load the entire package for the current run only:

```bash
pi -e /absolute/path/to/pi-agent-config
```

## Verification

```bash
pi list
pi
```

After Pi starts, use `/plan` to toggle planning mode.

Use `/btw <question>` for a temporary, context-aware side question. It uses the current model and
conversation, with isolated read-only `read`, `grep`, `find`, and `ls` tools when file inspection is
needed. Neither the question, answer, nor tool results are added to the main session.
Each invocation produces one answer; run another `/btw <question>` for a new side question. Run
`/btw` without a question to reopen the latest answer. The answer view supports scrolling, history
navigation, copying with `c`, clearing with `x`, and closing with `q`, `Esc`, `Enter`, or `Space`.

While the agent is running, the footer shows a compact summary of the current task and its type:
Design, Plan, Implement, Test, Review, Fix, or Explore. The selected model performs one short
classification request with extended thinking disabled, while the working message shows the
active tool detail. Invalid, failed, or timed-out classifications are omitted without a fallback
status. Classification results are not added to the session or main model context.

Use `/md <path>` or `/markdown <path>` to open a local `.md` or `.markdown` file:

```text
/md README.md
/md "docs/design notes.md"
```

The viewer supports the arrow keys and `j`/`k` for scrolling, `PageUp`/`PageDown` for paging,
`g`/`G` to jump to the beginning or end, and `q` or `Esc` to close. Additional features:

- Press `/` to search the document, then use `n`/`N` to jump to the next or previous result.
- Press `d` to open directory navigation, which lists directories and Markdown files only.
- Press `l` or `o` to open the link list. Local Markdown links open inside the viewer; other links open with the system handler.
- Automatically render PNG, JPEG, GIF, and WebP images from local files, HTTP(S), and data URLs. Image details are shown when the terminal does not support an image protocol.
- Render `mermaid` code blocks locally as Unicode diagrams without using a remote rendering service.
- Press `r` to refresh manually; the viewer also refreshes automatically when the file changes.

Each document can render up to 32 images, with a maximum size of 8 MiB per image and an 8-second
timeout for remote image requests. Remote images generate network requests; do not use the viewer
to open documents containing untrusted tracking images.

Run the repository regression tests with:

```bash
npm test
```

## Updating and Removing

```bash
pi update --extensions
pi update git:github.com/wangrzneu/pi-agent-config
pi remove git:github.com/wangrzneu/pi-agent-config
```

For a project-level installation, add `-l` when removing:

```bash
pi remove -l git:github.com/wangrzneu/pi-agent-config
```

## Token Usage

- Only the concise `skills/pi-workflow/SKILL.md` is loaded by default.
- Templates in `prompts/` are loaded on demand for relevant tasks.
- Files in `docs/` are reference material and should not be added to every task's context automatically.
- Plan mode injects its model reminder only once when the mode is entered; tool interceptors continuously enforce the read-only restrictions.
- Work status uses one short, no-reasoning model request for each uncached task. It consumes a small number of tokens but does not add the result to the session context.
- Each `/btw` question uses a separate model loop with a small output and tool-call budget. Read-only tool results stay ephemeral and the exchange is not stored in the session.
- The Markdown viewer, directory navigation, search, images, and Mermaid rendering are processed only inside the TUI extension and do not add content to the model context.

## Design Principles

1. Planning is read-only by default.
2. Put hard constraints in extension tool interceptors, and behavior preferences in skills or on-demand prompts.
3. Keep detailed workflows in documentation to avoid increasing the default context.
4. Keep the configuration portable and independent of any single model or provider.

## Security

Plan mode is a safeguard against accidental changes, not a security sandbox. Pi packages and
extensions can execute arbitrary code. Review the source before installation, and use a container
or a dedicated low-privilege user when working with real credentials, production code, or
untrusted projects. See [`docs/security.md`](docs/security.md) for details.
