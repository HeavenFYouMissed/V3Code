<p align="center">
  <img src="void_icons/v3-wordmark.svg" alt="V3Code" width="180">
</p>

<h1 align="center">V3Code</h1>

<p align="center">
  <strong>A source-available AI code editor and VS Code fork with persistent memory, local semantic indexing, native agents, and multi-model workflows.</strong>
</p>

<p align="center">
  <a href="https://v3code.dev/download">Download V3Code</a> ·
  <a href="https://docs.v3code.dev">Documentation</a> ·
  <a href="CONTRIBUTING.md">Contribute</a> ·
  <a href="LICENSING.md">Licensing</a>
</p>

V3Code is a free-to-download Cursor alternative for developers who want AI tools
inside a complete desktop editor, not scattered across separate extensions and
browser tabs. It builds on [Code - OSS](https://github.com/microsoft/vscode) and
[Void Editor](https://github.com/voideditor/void), then adds V3Code's own agent,
memory, indexing, browser, debugging, and provider systems.

This repository is meant to be useful both as a product and as a serious base for
people studying or contributing to an AI-focused VS Code fork. V3Code is
source-available rather than uniformly Open Source; read [Licensing](#licensing)
before redistributing it or building a competing product.

## What makes V3Code different

- **Memory that survives the chat.** V3Code keeps persistent workspace memory and
  searchable conversation history so useful project context is not trapped in one
  session.
- **Local codebase intelligence.** Lexical and vector search feed a local semantic
  index that agents can use to retrieve relevant code instead of relying only on
  the files currently open.
- **Agents are part of the editor.** Use the native V3Code agent or run compatible
  Agent Client Protocol agents in editor chats, with the workspace, diffs, and
  review flow close at hand.
- **Choose the model setup that fits the work.** Connect supported hosted
  providers, API-key providers, subscription-backed agents, or supported local
  model servers. Availability and authentication vary by provider.
- **Tools beyond text generation.** V3Code includes integrated browser tools,
  optional consent-gated desktop automation, and a dedicated debugging mode with
  runtime evidence collection.
- **A real VS Code workbench.** Editing, extensions, terminals, source control,
  debugging, and familiar keyboard workflows remain at the center of the product.

Memory and code indexing can run locally. Cloud models, cloud indexing, external
agents, and browser-backed services send relevant context to the services you
choose to enable. Computer use also requires the native helper and operating-system
permission.

## Download

Get the current signed desktop build and platform-specific install instructions at
[v3code.dev/download](https://v3code.dev/download). Setup guides for models,
agents, indexing, debugging, and troubleshooting live at
[docs.v3code.dev](https://docs.v3code.dev).

## Build from source

V3Code currently uses Node 22. Start with the version in `.nvmrc`:

```bash
nvm use
npm ci
npm run buildreact
npm run compile
```

Run the development build:

```bash
./scripts/code.sh
```

On Windows, use `scripts\code.bat`.

The repository is large. A clean compile proves that the source builds; it does not
prove every desktop workflow or platform package. Pull requests should include
focused tests and the runtime checks relevant to the change.

## Find your way around

| Area | Source |
| --- | --- |
| V3Code chat, memory, indexing, providers, and product UI | `src/vs/workbench/contrib/void/` |
| Native chat and agent-session integration | `src/vs/workbench/contrib/chat/` |
| Agent Client Protocol host | `src/vs/platform/agentHost/` |
| Integrated browser | `src/vs/workbench/contrib/browserView/` |
| Optional computer use | `src/vs/workbench/contrib/computerUse/` |

Some optional agent integrations resolve vendor packages under their own terms.
Read [NOTICE.txt](NOTICE.txt) before building or redistributing packages.

## Contributing

Bug reports, focused fixes, tests, documentation, and well-scoped features are
welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Visible interface changes
should include a screenshot or short recording, and every pull request should say
exactly what was tested.

Contributions require recorded acceptance of the
[Contributor License Agreement](CLA.md) before merge.

V3Code has been developed with AI-assisted tools. Maintainers remain responsible
for product decisions, review, testing, attribution, and what gets merged.

## Licensing

This is a mixed-license repository:

- Code - OSS portions remain MIT licensed.
- Void Editor portions remain Apache-2.0 licensed.
- Some V3Code components deliberately use MIT or Apache-2.0.
- KandD-owned V3Code product work is source-available under Business Source
  License 1.1 and changes to Apache-2.0 four years after each version's first
  public release.

Read [LICENSING.md](LICENSING.md), [LICENSE-V3CODE.txt](LICENSE-V3CODE.txt),
[LICENSE.txt](LICENSE.txt), and [NOTICE.txt](NOTICE.txt) for the actual scope.

V3Code is not uniformly Open Source while BSL-covered code is before its Change
Date. The source can be read, modified, redistributed, and used under the terms
that apply to each component. Offering the BSL-covered work as a competing
production editor, IDE, or AI coding assistant requires a separate commercial
license before the applicable Change Date.
