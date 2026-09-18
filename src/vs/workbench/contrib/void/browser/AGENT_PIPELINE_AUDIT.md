# V3Code Agent Pipeline — Deep Correctness Audit

> What's served to the agent, how the agent loops through code, how state/streaming holds up, and how memory feeds back — hunted specifically for: **agent pauses/stalls**, **chat drops**, **short-term hallucination** (bad context in one turn), and **long-term hallucination** (drift/poisoning across turns).
> Audited 2026-06-27. Five independent deep dives across `convertToLLMMessageService.ts`, `v3codeChatAgent.ts`, `chatThreadService.ts`, `toolsService.ts`/`terminalToolService.ts`, and the memory stack.

---

## 0. Executive summary

You were right — there are major issues, and they're concentrated. ~35 defects found; they collapse into **5 cross-cutting root causes**. Fixing the top 3 fixes most of the felt symptoms.

**The single most important finding:** two independent audits (message assembly + thread state) found the *same* bug from opposite ends — **the conversation history sent to the LLM is malformed whenever the assistant turn is a tool call with empty text** (which native function-calling models produce constantly). On Anthropic this throws a hard 400 → **the chat drops mid-conversation**. On OpenAI/Gemini the tool result is **silently dropped** → the model never sees what a tool returned → **hallucinates the outcome or re-runs it**. This one bug family explains a large share of both your "chat drops" and your "hallucination" reports. (RC-1 below.)

After that: **nothing in the pipeline has a timeout** (RC-2 → hangs/pauses), and **tools routinely report false success / silently truncate** (RC-3/RC-4 → hallucination). Memory served stale-as-fact is the dominant long-term driver (RC-5).

---

## 1. Root causes (ranked by blast radius)

### RC-1 — Malformed message array on tool-call turns  ⚠️ CRITICAL · drops + hallucination
The history → LLM converters pair each tool result with the *preceding* message by array index, and the assistant turn is only persisted when it has non-empty text/reasoning. Three compounding failures:

- **Text-less tool calls** (the *normal* case for native function-calling) → no assistant message persisted (`chatThreadService.ts:1009` `shouldPersistAssistantTurn`), so history is `…user/tool_result, [no assistant], tool`. Then:
  - **Anthropic** emits an orphaned `tool_result` with no matching `tool_use` (`convertToLLMMessageService.ts:311-324`) → **HTTP 400, whole turn fails, chat drops.**
  - **OpenAI** silently `continue`s past the tool message (`:200-214`) → **tool result never reaches the model → hallucinated/re-run outcome.**
  - **Gemini** mislabels every result with a single shared `latestToolName` (`:753-797`) and drops unmatched ones.
- **Parallel tool calls** (the agent explicitly emits N consecutive `tool` messages after one assistant, `v3codeChatAgent.ts:1390-1519`) → only the first gets attached; the rest become orphaned `tool_result`s (`:306-325`) → same 400 / drop.
- **Mid-stream abort** earlier in history → OpenAI index drift (`:200-222` H5) drops *all* subsequent tool pairs.

> Fix: track the assistant message **by reference**, aggregate consecutive tool messages onto it, and skip orphan `tool_result`s symmetrically across all three converters. Persist a placeholder assistant turn (the existing `LLM_EMPTY_TEXT_PLACEHOLDER`) for text-less tool calls. **This is the highest-leverage fix in the entire codebase.**

### RC-2 — No timeouts anywhere  ⚠️ CRITICAL · pauses/hangs
Every long await in the pipeline can black-hole into a permanent "Thinking…" spinner with no error and no recovery but manual Stop:
- LLM call has no timeout/watchdog (`v3codeChatAgent.ts:1576-1766` `_callLLM`; same in `v3codeLanguageModelProvider.ts:283-321`). A stalled provider socket hangs the turn forever; `retries` never increments because no error is surfaced.
- Tool execution has no timeout (`v3codeChatAgent.ts:1972` `invokeTool`). A hanging MCP tool / never-exiting command wedges the loop even after Stop.
- LSP/semantic/context-bridge tools have no wall-clock (`toolsService.ts:840-853, 1303-1351`).
- Non-vision image-describe pre-step (`v3codeChatAgent.ts:1114-1156`) and nested subagents (`:1972`, no depth cap) propagate the same hang to the parent.

> Fix: a single `withTimeout` wrapper on `_callLLM`, `invokeTool`, and the LSP-bridge tools, surfacing a real error into the retry path. Add a subagent recursion-depth cap.

### RC-3 — Tools report false success  ⚠️ HIGH · short-term hallucination
The model is told an operation worked when it didn't, so it builds on a false premise:
- Terminal coerces an unknown exit code to **0 = success** (`toolsService.ts:438, 1642`); a failing build/test whose code wasn't parsed reads as passing. Mirror image: completed commands reported "did not finish" when shell integration is absent (`:432-435, 1646`, M10).
- `edit_file` exact-match path edits the **first** of a non-unique block with no uniqueness check (`searchReplaceOnString.ts:31-34`) and reports success → wrong-location edit.
- `search_in_file` returns the literal string `<Error getting string of result>` for any file not already open in an editor (`toolsService.ts:1580-1588` re-fetches an uninitialized model) → a matching search looks like an error.
- False "No lint errors found" — 1000ms diagnostics wait (`:975-979`) and the `noDiagnosticsReported` path (`shadowWorkspaceService.ts:106-115`) report clean before the TS server has analyzed.
- `launch_subagent` reports `status: 'completed'` the instant it launches (`:1542, 1907`) → model assumes background work is done.
- Concurrent edits to the same URI both snapshot pre-edit content (`:1048-1098`, M3) → lost update, both report success → model's mental model of the file diverges (also long-term).

### RC-4 — Silent truncation presented as complete  ⚠️ HIGH · short-term hallucination
Content is cut without telling the model, which treats the fragment as the whole:
- **Worst:** unrecognized / small-window models default to `contextWindow=4096, reserved=4096` → trim budget computes to `total-5000` chars and the budget can go **negative**; the whole conversation is chopped to **120-char stubs + "..."** with no marker (`convertToLLMMessageService.ts:632-664`; defaults `modelCapabilities.ts:254`). Hits custom OpenAI-compatible / Ollama / LM-Studio / any new model name.
- Recent large tool results / assistant turns get the same 120-char gutting (10× weight, `:602, 646-664`) even on big models when the tail overflows.
- Terminal output reduced to the **last 120 lines** after a head/tail char cut (`terminalToolService.ts:521-526` + `toolsService.ts:255,274`); an error printed early is gone, clean tail looks like success.
- Search tools build queries with no `maxResults` and no "more results" indicator (`:907-945, 1269-1301`) → "no other usages" hallucination.

> The well-behaved paths (`capText`, `fitContextBlocks`) *do* announce truncation — mirror that everywhere.

### RC-5 — Memory served stale-as-fact  ⚠️ CRITICAL · long-term hallucination
The dominant cross-session drift driver:
- Stale invalidation only fires for the **agent's own** edits to `symbol` facts (`memoryDatabase.ts:651-658, 1238`). Files changed by the user / `git pull` / branch switch never invalidate; `decision`/`quirk`/`file_state` facts are **never** staleness-checked at all. The injected block carries **no timestamp/age/caveat** (`convertToLLMMessageService.ts:1083-1109`), unlike `<active_plan>` which does warn. → "`Foo.bar()` does X" survives the rewrite/rename of `Foo.bar` forever.
- MCP **`forget` doesn't forget** — it deletes the note but never calls `memoryService.forget(factId)` (`toolsService.ts:1145-1148`), so the SQLite fact keeps injecting. You cannot evict a known-wrong memory via the agent.
- Confidence inflation: unverified `ai_inferred` captures auto-promote and climb to confidence 1.0 on repetition (`memoryDatabase.ts:567`); a verify makes them **evergreen / never-decay** (`temporalDecay.ts:32`) even after the code changes.
- Contradictions keyed on `(kind, subject)` — a changed decision gets a new title → new subject → **both old and new injected** as fact (`memoryDatabase.ts:531-565` + `convertToLLMMessageService.ts:1101`).
- Candidate set pre-truncated `ORDER BY ts_last DESC LIMIT 300` *before* salience (`memoryDatabase.ts:1146`) → durable/evergreen facts that haven't been touched recently are **never scored, silently dropped** once a workspace has >300 facts.

---

## 2. Master findings table (by failure mode)

Severity: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low. RC = root cause above.

### A. Chat drops (response fails / vanishes / corrupts)
| Sev | Finding | Where | RC |
|---|---|---|---|
| 🔴 | Orphaned `tool_result` → Anthropic 400, turn fails | `convertToLLMMessageService.ts:311-324`; `chatThreadService.ts:1009` | RC-1 |
| 🔴 | Parallel tool calls → orphaned results (Anthropic/Gemini) | `convert…:306-325, 753-797` | RC-1 |
| 🟠 | Mid-stream error retry re-streams full text into same bubble (garbled/duplicated) | `v3codeChatAgent.ts:1216-1228, 1667` | — |
| 🟠 | Empty `fullText` after streamed text → false "empty response" termination | `v3codeChatAgent.ts:1268-1277, 1713` | — |
| 🟠 | `editUserMessage…` truncates history without aborting in-flight stream → interleaved/dup messages | `chatThreadService.ts:1537-1563` | RC-7 |
| 🟡 | In-progress streamed text never persisted → reload/crash mid-stream loses the response | `chatThreadService.ts:935-957` | — |
| 🟡 | Partial/truncated tool-call XML silently dropped → premature stop | `v3codeChatAgent.ts:1698-1707` | — |
| 🟡 | `deleteThread` doesn't abort stream; last-thread delete throws in `getCurrentThread` | `chatThreadService.ts:1886-1896, 1839` | — |

### B. Agent pauses / hangs (spinner forever)
| Sev | Finding | Where | RC |
|---|---|---|---|
| 🔴 | `_callLLM` has no timeout → stalled provider hangs forever | `v3codeChatAgent.ts:1576-1766`; `v3codeLanguageModelProvider.ts:283-321` | RC-2 |
| 🔴 | `invokeTool` has no timeout → hanging MCP/terminal tool wedges loop | `v3codeChatAgent.ts:1972` | RC-2 |
| 🟠 | Steer follow-up queued during `awaiting_user`, then tool rejected → message stranded forever | `chatThreadService.ts:1461-1464, 589-606` | RC-7 |
| 🟡 | LSP/semantic/context-bridge tools no wall-clock | `toolsService.ts:840-853, 1303-1351` | RC-2 |
| 🟡 | Nested subagent: no depth cap, stalls propagate to blocked parent | `v3codeChatAgent.ts:1972, 366` | RC-2 |
| 🟡 | `npm install`/`npx` killed at 8s inactivity despite prompt promising a longer window | `terminalToolService.ts:466-477`; `prompts.ts:311` | RC-3 |
| 🟡 | No-progress (edit↔read) loop runs to 200 steps before stopping | `v3codeChatAgent.ts:1367, 1550` | — |
| 🟡 | `_setState` resets foreground `whenMounted` on every background-thread write → focus/scroll await hangs | `chatThreadService.ts:482-530` | — |
| ⚪ | Tool approval gate has no auto-deny/timeout | `v3codeToolAdapters.ts:396-402` | RC-2 |

### C. Short-term hallucination (wrong context within a turn)
| Sev | Finding | Where | RC |
|---|---|---|---|
| 🔴 | Unrecognized/small-window model → whole conversation chopped to 120-char stubs, budget can go negative, no marker | `convertToLLMMessageService.ts:632-664`; `modelCapabilities.ts:254` | RC-4 |
| 🟠 | XML tool re-serialization performs **no escaping** → file content with `<`/`>`/`</tag>` corrupts transcript (you flagged this) | `prompts.ts:883-889`; `convert…:363` | RC-6 |
| 🟠 | `autoContext` injects **indexed (stale)** code with authoritative line numbers, no staleness caveat | `convert…:1322-1331` | RC-5 |
| 🟠 | Terminal exit code coerced to 0 = success | `toolsService.ts:438, 1642` | RC-3 |
| 🟠 | `edit_file` edits first of non-unique block, reports success | `searchReplaceOnString.ts:31-34` | RC-3 |
| 🟠 | `search_in_file` returns `<Error…>` for files not open | `toolsService.ts:1580-1588` | RC-3 |
| 🟠 | Terminal output reduced to last 120 lines; early errors dropped | `terminalToolService.ts:521-526`; `toolsService.ts:255,274` | RC-4 |
| 🟠 | OpenAI converter index drift after one orphaned tool drops all later pairs | `convert…:200-222` | RC-1 |
| 🟡 | False "No lint errors found" (1s wait / no-diagnostics path) | `toolsService.ts:975-979`; `shadowWorkspaceService.ts:106-115` | RC-3 |
| 🟡 | Search tools silently capped, no "more" indicator | `toolsService.ts:907-945, 1269-1301` | RC-4 |
| 🟡 | char/4 token estimate under-counts code → real-window overflow → provider truncation/error | `convert…:63, 633` | RC-4 |
| 🟡 | `launch_subagent` reports `completed` on launch | `toolsService.ts:1542, 1907` | RC-3 |
| 🟡 | whitespace-insensitive edit fallback matches wrong region / reindents | `searchReplaceOnString.ts:36-46` | RC-3 |
| ⚪ | Non-vision describe bakes possibly-wrong transcription then deletes image | `v3codeVisionDescribe.ts:301-311` | RC-4 |

### D. Long-term hallucination (drift/poisoning across turns)
| Sev | Finding | Where | RC |
|---|---|---|---|
| 🔴 | Stale memory served as fact; invalidation only on agent diffs; no age/caveat | `memoryDatabase.ts:651-658, 1238`; `convert…:1083-1109` | RC-5 |
| 🔴 | MCP `forget` leaves SQLite fact live → forgotten memory resurrects | `toolsService.ts:1145-1148` | RC-5 |
| 🟠 | Confidence inflation + unverified auto-capture + evergreen-on-verify → poisoning | `memoryDatabase.ts:567, 1224-1309`; `temporalDecay.ts:32` | RC-5 |
| 🟠 | Contradictory decisions (different subjects) both persist & inject | `memoryDatabase.ts:531-565`; `convert…:1101` | RC-5 |
| 🟠 | `LIMIT 300 ORDER BY ts_last` pre-truncates candidates → durable facts silently dropped | `memoryDatabase.ts:1146` | RC-5 |
| 🟠 | Text-less tool turn → OpenAI silently drops tool result from history → model invents outcome | `convert…:200-214`; `chatThreadService.ts:1009` | RC-1 |
| 🟡 | Concurrent same-file edits → lost update, both report success → file model diverges | `toolsService.ts:1048-1098` | RC-3 |
| 🟡 | No memory eviction; unbounded tombstone/vector/shadow growth; deep_recall drops oldest days | `memoryDatabase.ts:560, 935-960` | RC-5 |
| 🟡 | `matchesActive` substring+basename mis-gates relevance (wrong boosts / decisions stuck at baseline) | `salience.ts:52-61`; `convert…:1700` | RC-5 |
| 🟡 | Empty-symbolFacts fallback injects raw unranked `listNotes()` incl. deleted files | `convert…:1118-1136` | RC-5 |
| 🟡 | `rewrite_file` returns whole file as diff → unbounded context growth | `toolsService.ts:1056, 1616` | RC-4 |

### E. Cancellation / abort doesn't take (cross-cuts B+drops)
| Sev | Finding | Where |
|---|---|---|
| 🟠 | Tool batch from final message runs (files mutate) **after** Stop | `v3codeChatAgent.ts:1165, 1381` |
| 🟠 | MCP tool abort is a no-op; on completion it flips rejected→success and resumes the loop | `chatThreadService.ts:772, 808, 1030` |

---

## 3. Remediation roadmap (do in this order)

**P0 — stops drops & hangs (ship first):**
1. **RC-1:** rewrite the three native converters to track the assistant by reference + aggregate consecutive tool messages + skip orphan results symmetrically; persist a placeholder assistant turn for text-less tool calls. *Kills the dominant drop + a major hallucination source.*
2. **RC-2:** add `withTimeout` to `_callLLM`, `invokeTool`, and LSP-bridge tools, routing timeouts into the existing retry/error path; add subagent depth cap.
3. **Abort correctness (E):** re-check the cancellation token after `_callLLM` returns `final` (before tool dispatch); give MCP tools a real interruptor and re-check stream state before flipping a rejected tool to success.

**P1 — stops false-success & silent-truncation hallucination:**
4. **RC-3:** stop coercing unknown exit codes to 0; enforce edit uniqueness on the exact-match path; render `search_in_file` from bytes already read; lengthen/await real diagnostics before "no lint errors".
5. **RC-4:** make the 120-char final-trim announce truncation and never go below a real floor; give unrecognized models a sane default window (not 4096/4096); preserve terminal head+tail with an elision marker; add a "more results" indicator to search.
6. **RC-6:** XML-escape (or CDATA/fence) tool params and tool-result bodies — the issue you already flagged.

**P2 — stops long-term drift:**
7. **RC-5a:** add age/timestamp + "may be stale, verify against the file" caveat to the memory injection block (mirror `<active_plan>`); invalidate symbol facts on *any* file change (watcher), not just agent diffs.
8. **RC-5b:** make MCP `forget` actually call `memoryService.forget(factId)`; add eviction/compaction.
9. **RC-5c:** move the `LIMIT 300` truncation to *after* salience scoring; fix `matchesActive` (drop bare-basename matching; give decisions a path-independent relevance signal); require verification before a capture can become evergreen/high-confidence.

**P3 — polish:** mid-stream retry should clear/replace already-rendered text + add backoff (429 `Retry-After`); persist in-progress streamed text; remap index-keyed thread state on truncate/edit; fix disposable hygiene (`chatThreadService.ts:340-354`).

---

## 4. Things that are actually correct (so we don't "fix" them)
- Thread routing is safe: `_runChatAgent` captures `threadId` and never writes via `currentThreadId`, so switching threads mid-stream lands output in the right (background) thread.
- `<active_plan>` and `<ACTIVE_SUBSYSTEM_SYMBOLS>` read from disk and DO warn about staleness — the model to copy for memory injection.
- Rejected tool promises are awaited/caught and surfaced as text (don't hang the loop on a *thrown* error — only on a *hanging* one).
- Terminal `resPromise` always resolves via a wall-clock net (commands can't hang *forever* — but 8s inactivity is too aggressive for installs).
- `find_text` line math (`+1` on 0-based ranges) is correct.
- The loop's spiral/inspection/failure/soft-continue guards are well-built and bounded — the *healthiest* part of the system.

---

*Agent IDs (resumable for deeper drill-down): context `a00af84da1ea35fb9` · loop `a7e04def895443d96` · memory `a53e6cc4a7ddde71a` · thread `afd55ceaf3ad39b06` · tools `ae4f6710febd8d00d`.*
