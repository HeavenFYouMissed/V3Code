<p align="center"><img width="800" height="400" alt="hero-emblem" src="https://github.com/user-attachments/assets/245d574a-8a62-4a89-9733-b476d16c2892" />
</p>

<h1 align="center">V3Code</h1>

<p align="center"><img width="915" height="619" alt="V3Code editor" src="https://github.com/user-attachments/assets/a9da0941-8467-4127-8204-727a37bbfa96" />
</p>
<p align="center"><img width="893" height="592" alt="V3Code agents" src="https://github.com/user-attachments/assets/57c2dc2c-feb5-4dae-9334-8e451c70a6b9" />
</p>
<p align="center"><img width="921" height="858" alt="Screenshot 2026-09-18 at 3 07 22 PM" src="https://github.com/user-attachments/assets/7fb81604-aa15-4ebb-811d-9faa84fbb615" />

	
</p>
<p align="center">
  <strong>The most capable AI code editor available. Free. Source-available. No data collection. No subscription required.</strong>
</p>

<p align="center">
  <a href="https://v3code.dev/download">Download</a> ·
  <a href="https://docs.v3code.dev">Docs</a> ·
  <a href="CONTRIBUTING.md">Contribute</a> ·
  <a href="LICENSING.md">Licensing</a> ·
  <a href="https://x.com/v3code_editor">𝕏</a>
</p>

---

V3Code is a free Cursor alternative built on [Code - OSS](https://github.com/microsoft/vscode) and [Void Editor](https://github.com/voideditor/void). Everything other editors charge $20–40/month for and up, V3Code does with your own API keys for pennies. No telemetry. No data collection. No vendor lock-in.

One developer. 1 year 14 hour days +. 5,000+ users. 80% on SWE-bench Verified with DeepSeek Flash at $0.02 per run.

[Full documentation for every feature →](https://docs.v3code.dev)

---

## What V3Code can do

Most AI editors give you a chat and autocomplete. V3Code gives you an entire platform.

### Agents and AI

- ** choose 40+ agents in one editor.** V3Code's native agent, Claude, Codex, GitHub Copilot, and Grok Build — all running in the same workspace through the Agent Client Protocol. Switch between them mid-task.
- ** openai key backed voice agent that can control the editor, it has a hidden backed chat agent that controls and feeds memory and search for the voice agents capabiltys and the voice agent can directly control your chat thread and building projects and updates.. A little like jarvis.. 
- **Use your existing AI subscriptions.** Already paying for Claude Pro or ChatGPT? Use those plans directly in V3Code through ACP and thru the v3code agent loop separatly. No separate API key needed. No double-paying.
- **Any model via BYOK.** Bring your own API keys for OpenAI, Anthropic, DeepSeek, Mistral, Groq, local models — whatever you want. Switch mid-conversation. V3Code tracks token usage and cost.
- **Give any agent memory and indexing via MCP.** Every connected agent gets access to V3Code's memory system and semantic index through the Model Context Protocol. External agents become smarter inside V3Code than they are anywhere else, access to the editors capabilitys no other editor would dare give you.

### Turbo Draft

Hit Shift+Tab or Shift+Tab+Q for deep multifile, The entire file gets rewritten as a diff you tab through. It reads the compiler, pulls related code from across your project, validates the draft, and hands you accept/reject on every change. One keystroke. Two cents on DeepSeek or the agent you choose.

"Draft this file, thinking harder" uses extended reasoning. "Draft across the files that call it" propagates changes through your dependency chain. Nothing saves until you approve it.

### Browser and computer use

- **Full built-in browser.** Browse, test, inspect, clone and automate, the agent can navigate the browser with full automation, also you can manually edit html and your website by hand in the browser to save credits vs asking the agent for every tiny change — without leaving the editor.
- **Computer use.** V3Code can see your screen, click, type, and navigate applications with consent-gated desktop automation. The AI can operate your actual tools, not just generate text about them.
- **Web app testing.** Point the browser at localhost and let the agent test your running app live. Click through flows, fill forms, verify behavior.

### Security

- **Cyber Protection.** Security scanner that builds a code-property graph and flags injection, XSS, SSRF, path traversal, prototype pollution, weak crypto, and more. Scan journal tracks new, fixed, and open findings across runs.
- **No data collection.** V3Code does not collect, store, or transmit your code, conversations, or usage data. Zero telemetry. Your code stays on your machine. Period.

### Debugging

- **Debug mode.** Not "suggest a fix." Reproduces the bug, proves the root cause with runtime evidence, makes the smallest possible fix, and verifies it passes. Evidence-based debugging with a bounded tool surface.

### Memory and context

- **Memory that survives everything.** Extensive multilayer Persistent workspace memory, searchable conversation history, cross-session recall. Your project context is never lost between chats. The AI remembers what you told it last week and across your chats.. very deep feature..
- **Project instructions and AGENTS.md.** Define project-level rules, conventions, and context that every agent session inherits automatically.

### The editor itself

- **It's still VS Code.** Extensions, terminals, source control, debugging, keyboard shortcuts, themes, settings sync. Everything you know works exactly how you expect.
- **Modes.** Chat, Read, Plan, Debug, Multitask, Agent — each mode changes what tools the agent has access to, not just its personality.
- **Subagents and parallel work.** Spawn read-only research workers that investigate in the background while you keep coding.
- **Skills.** Reusable instruction sets the agent can invoke for specialized tasks.
- **Worktrees and isolated changes.** Branch-level isolation for agent work that shouldn't touch your main tree.

---

## Beast — dual-engine retrieval

This is not a vector store bolted onto a chat window. Beast is a hybrid retrieval engine with the same simular architecture Google/ antigravity built idk how we landed on a simular system but we did, and its running locally on your machine.

**Dual embedding models.** Potion Code builds the fast 256-dimensional first pass so your codebase is searchable immediately. Qwen3-Embedding then backfills with higher-quality 1024-dimensional embeddings in the background. Both are searchable during the upgrade. Two models, two perspectives — structural and semantic — on every query.

**Seven retrieval signals fused into one ranking.** Tree-sitter structural chunks, exact phrase matching, IDF-weighted lexical search, dual vector embeddings, Beast's native Rust BM25 with trigram search, LSP-resolved dependency graph edges, and recent-edit history. All combined through weighted Reciprocal Rank Fusion with adaptive score thresholds.

**Why this matters:** This retrieval layer is why a $0.02 model hits 80% on SWE-bench. The model doesn't discover your codebase from scratch — Beast hands it the exact right context before it writes a single line. The reason cheap models produce expensive results.

Indexes 500 files in under a few seconds 10,000 files in less then a minute and can run up to and over 100k files without breaking a sweat. Runs locally. Survives restarts. Degrades gracefully if a model or sidecar is unavailable.

---

## Numbers

| | |
|---|---|
| **SWE-bench Verified** | 80% (DeepSeek Flash) |
| **Cost per SWE-bench run** | $0.02 |
| **Memory at idle** | ~820 MB |
| **Codebase index (500 files)** | < 10 seconds |
| **Users** | 5,000+ |
| **Agents** | ? extensive (V3Code, Claude, Codex, Copilot, Grok)++++ |
| **Data collected** | None |
| **Price** | Free |

---

##Extra Features - extensive.. too many to list on the readme -- +++

## Get started

1. Download from [v3code.dev/download](https://v3code.dev/download)
2. Open a project
3. Connect a model — API key, existing subscription, or local
4. Start building

Guides for every feature at [docs.v3code.dev](https://docs.v3code.dev) — including modes, plan mode, skills, project instructions, subagents, permissions, worktrees, chats, debug mode, cyber protection, quick edit, turbo draft, design mode, context bridge, memory, semantic index, theming, models, connected plans, token wallet, BYOK, web builder, live previews, the browser, MCP, extensions, ACP agents, billing, API keys, and privacy.

---

## How it's built

V3Code was built by one developer over A year — [Daniel Castellani](https://github.com/HeavenFYouMissed) at [KandD Labs](https://kanddlabs.com). AI tools were used extensively Autocomplete --( Cursor- agent forgetting mid task pushed me to start this project, Claude, Codex, and V3Code itself over the last 3-4 months). The architecture, product direction, and every shipped decision are human-directed and every line of code is read before i use it and understood. Ai Writes code faster i was able to ship a vscode fork solo on hot-pockets and Monster late nights and persistence and feedback from users and now friends on x @v3code_editor and anyone can contact me on x or support v3code.

### Core systems

| Component | What it does |
|---|---|
| **Beast** | Dual-engine hybrid retrieval — Qwen + Potion Code embeddings, lexical search, BM25, dependency graph, seven fused signals |
| **Context Bridge** | LSP-backed tools that feed agents real compiler data — types, signatures, diagnostics — not guesses |
| **Turbo Draft** | Whole-file rewrite engine with compiler truth, multi-file diff propagation, and per-change accept/reject |
| **ACP Host** | Agent Client Protocol — runs Claude, Codex, Copilot, and Grok with shared workspace context |
| **Memory** | Persistent workspace memory, searchable history, cross-session recall, compaction checkpoints |
| **MCP Bridge** | Exposes V3Code's memory and indexing to any connected agent via Model Context Protocol |

### Find your way around

| Area | Path |
|---|---|
| Chat, memory, indexing, providers, product UI | `src/vs/workbench/contrib/void/` |
| Native chat and agent sessions | `src/vs/workbench/contrib/chat/` |
| Agent Client Protocol host | `src/vs/platform/agentHost/` |
| Integrated browser | `src/vs/workbench/contrib/browserView/` |
| Computer use | `src/vs/workbench/contrib/computerUse/` |

---

## Build from source

Node 22. Start with `.nvmrc`:

```bash
nvm use
npm ci
npm run buildreact
npm run compile
./scripts/code.sh        # macOS / Linux
scripts\code.bat          # Windows
```

---

## Contributing

Bug reports, focused fixes, tests, docs, and well-scoped features are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first.

All contributors sign a [CLA](CLA.md) on their first pull request. Interface changes need a screenshot or recording. Every PR says what was tested.

 Maintainers are responsible for what gets merged.

---

## Licensing

Mixed-license repository:

| Code | License |
|---|---|
| Code - OSS | MIT |
| Void Editor | Apache-2.0 |
| Select V3Code components | MIT or Apache-2.0 |
| V3Code product code (KandD Labs) | BSL 1.1 → Apache-2.0 after 4 years |

**What this means:** Use V3Code for anything — personal, commercial, internal, learning, contributing. The one restriction: don't redistribute it as a competing code editor without a commercial license.

Read [LICENSING.md](LICENSING.md), [LICENSE-V3CODE.txt](LICENSE-V3CODE.txt), [LICENSE.txt](LICENSE.txt), and [NOTICE.txt](NOTICE.txt) for the full picture.

V3Code, the V3 logo, and associated branding are trademarks of KandD Labs LLC.

---

<p align="center">
  <a href="https://v3code.dev">v3code.dev</a> · <a href="https://docs.v3code.dev">docs</a> · <a href="https://x.com/v3code_editor">@v3code_editor</a>
</p>

<p align="center">
  <strong>Built by <a href="https://github.com/HeavenFYouMissed">Daniel Castellani</a> at <a href="https://kanddlabs.com">KandD Labs LLC</a></strong>
  <br>
  <em>"Building things that probably shouldn't be possible yet."</em>
</p>
