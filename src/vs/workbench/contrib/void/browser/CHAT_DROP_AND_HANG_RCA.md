# RCA — "Chat drops after a tool" & "Agent hangs on Thinking… forever"

> Produced by the `debug` skill (hypothesis-driven root-cause analysis). Read-only; no code changed.
> 2026-06-27. Notable: this RCA **corrected the earlier `AGENT_PIPELINE_AUDIT.md`** — see Symptom A.

---

## Symptom A — "errors out / drops mid-conversation right after a tool, more on Claude"

**Root cause: a no-backoff retry storm in the live agent loop** — *not* the orphaned-`tool_result` 400
the prior audit blamed (that's already fixed).

### Evidence chain
- User-visible error surfaces at `v3codeChatAgent.ts:1222-1224` (`progress("Error: …")` + `return { errorDetails }`).
- Origin: the error branch `v3codeChatAgent.ts:1216-1228` does `retries++` then **`continue` immediately — no delay, no backoff, no `Retry-After`**. `CHAT_RETRIES = 3` (`:124`). A grep for `Retry-After|backoff|429|529` finds nothing in the loop.
- So on a transient Anthropic **529 "Overloaded"** / 429 (most likely on the post-tool call, the largest-context request of the turn), all 3 retries fire back-to-back in <1s and the turn dies with `Error:`. "More on Claude" because Anthropic returns 529 far more than other providers.
- The sibling loop in `chatThreadService.ts:978-987` does it correctly: `await timeout(RETRY_DELAY)`, `RETRY_DELAY = 2500` (`:51`). The live `v3codeChatAgent` loop simply omits the delay.

### Why RC-1 (orphaned tool_result → 400) is NOT the current cause — independently verified
The audit cited `convertToLLMMessageService.ts:311-324/200-214/753-797`; those ranges **no longer hold converter logic**. The three native converters were extracted to `common/llmMessageConverters.ts` and rewritten:
- Assistant turn tracked **by reference** + a **placeholder synthesized** so a `tool_result` never lacks a matching `tool_use` — Anthropic `:197-208`, OpenAI `:98-117`, Gemini paired via `tool_use_id` map `:226-258`.
- The loop pushes the assistant turn **unconditionally even when text-less** (`v3codeChatAgent.ts:1252`) and appends **exactly one balanced** tool message per call (`:1402-1519`).
- Tool identity rides on the `'tool'` message (`llmMessageConverters.ts:20-25`), so even a non-persisted text-less assistant reconstructs correctly on reload; reasoning signatures persist (`chatThreadService.ts:1010`).

→ **`AGENT_PIPELINE_AUDIT.md` RC-1 is stale and should be marked fixed.** (Good demo of the debug skill: it refuted the standing hypothesis with current evidence instead of echoing it.)

### Hypotheses
| H | Claim | Verdict |
|---|---|---|
| H1 | orphaned `tool_result` → Anthropic 400 (audit RC-1) | **REFUTED** in current code (placeholders synthesized) — explains history, not now |
| H2 | no-backoff retry storm on transient 529/429/socket | **CONFIRMED** (`:1216-1228`) |
| H3 | parallel `tool_use`/`tool_result` imbalance → 400 | REFUTED (balanced append `:1402-1519`) |
| H4 | extended-thinking signature loss on reload → 400 | REFUTED (reasoning persists `:1010`) |
| H5 | condensed history leaves a leading `assistant` → "first message must be user" 400 | PARTIAL — real but only on long condensed convos, not "after a tool" |

### Minimal fix (root cause, not symptom)
In `v3codeChatAgent.ts:1216-1228`: (a) **classify** the error — deterministic 4xx (400) is non-retryable, surface immediately; 429/529/5xx/network are retryable; (b) for retryable, `await` bounded **exponential backoff honoring `Retry-After`** before `continue` (mirror `chatThreadService.ts:981`). Requires `onError` to carry a status/retryable flag from the provider channel.
*Why not bump `CHAT_RETRIES`:* retries stay instant (still <1s, still drops) and hammer an already-overloaded endpoint, worsening 529s.

### Regression guard
- Converter invariant test (locks the already-shipped RC-1 fix): `prepareMessages_anthropic_tools` over {text-less assistant, parallel tool calls, reload-without-persisted-assistant} → one `deepStrictEqual` snapshot asserting every `tool_result.tool_use_id` has a matching `tool_use.id`, no orphan.
- Loop test: mocked `_callLLM` returning `{kind:'error', retryable:true}` → assert the loop **waits** between attempts; `retryable:false` → returns immediately without burning all 3 retries.

---

## Symptom B — "stuck on 'Thinking…' forever; only Stop clears it"

**Root cause: no wall-clock / watchdog anywhere in the request or tool path** (confirms pipeline-audit RC-2, still unfixed).

### Evidence chain
- `_callLLM` (`v3codeChatAgent.ts:1558-1766`) returns a Promise that resolves **only** from `onFinalMessage` (`:1709`), `onError` (`:1733`), `onAbort` (`:1739`), or `token.onCancellationRequested` (`:1609-1623`). **No timer is registered.**
- A stalled stream (socket open, no bytes, no final, no error — idle proxy / dead TCP that never RSTs) fires none of those → the Promise never resolves → `await this._callLLM(...)` at `:1204` blocks the step loop forever.
- The "Thinking…/Reviewing results…" shimmer (`:1178-1182`) keeps animating. Cancellation (`:1609-1623` → `done({kind:'abort'})`) is the **only** escape — exactly "only hitting Stop clears it."
- A stall produces no `onError`, so the retry path (`:1216`) is **never entered** — a hang is invisible to the retry logic.

### Hypotheses (all the same root cause: missing wall-clock)
| H | Claim | Verdict |
|---|---|---|
| H1 | `_callLLM` has no timeout → stalled provider hangs the turn | **CONFIRMED** (`:1558-1766`, no timer) |
| H2 | `invokeTool` has no timeout → a hanging tool hangs the turn after the LLM responded; token passed but a tool that ignores it can't be cleared even by Stop | **CONFIRMED** (`:1972`) |
| H3 | retries never increment on a stall | **CONFIRMED corollary** |
| — | same missing-wall-clock pattern in the LM-API provider | **CONFIRMED** (`v3codeLanguageModelProvider.ts:283-336`, generator awaits `new Promise(resolve => wake = resolve)` `:334` with no timeout) |

### Minimal fix (root cause)
One injectable `withTimeout` / idle-watchdog:
- `_callLLM`: race the request against an **idle** wall-clock that resets on each `onText` delta; on expiry abort + `done({kind:'error', message:'LLM request timed out'})` so the **existing retry path** runs (and, with Symptom A's fix, backs off).
- `invokeTool`: race a per-tool wall-clock that fires the cancellation token and resolves a `"Tool error: timed out"` string so the loop continues.
*Why not a UI "auto-stop after N min":* it wouldn't surface a **retryable** error (turn can't self-heal), wouldn't free a wedged tool, and wouldn't cover the LM-API provider path.

### Regression guard
- Inject a fake `llmMessageService` that registers a request and **never** calls any callback → assert `_callLLM` resolves to `{kind:'error'}` within the timeout (doesn't hang) and the loop retries.
- A tool whose promise never resolves → assert the `invokeTool` wrapper yields a "timed out" result within budget.
- Make the timeout an **injectable constructor/option param** (default = real value) per the repo's no-stub testing rule.

### Related call sites (fix together with the same helper)
`_callLLM` (`v3codeChatAgent.ts:1558`), the `invokeTool` wrapper (`:1972`), and `v3codeLanguageModelProvider` `done`/stream (`:283-336`). LSP/semantic bridge tools in `toolsService.ts` share the RC (not re-verified here).

---

## Bottom line
- **Symptom A:** prior RC-1 (orphan-400) is **already fixed** in `common/llmMessageConverters.ts`; the live driver is a **no-backoff, no-`Retry-After` retry storm** burning `CHAT_RETRIES=3` in milliseconds on transient Anthropic 529/429. Add error classification + backoff (the sibling loop already does).
- **Symptom B:** **RC-2 confirmed, unfixed** — no wall-clock in `_callLLM`, `invokeTool`, or the LM-API provider; a stalled socket or hanging tool wedges the turn forever, recoverable only by Stop. One injectable `withTimeout` routed into the existing error path fixes all three.

*Resumable RCA agent ID: `a866fbf266055a937`.*
