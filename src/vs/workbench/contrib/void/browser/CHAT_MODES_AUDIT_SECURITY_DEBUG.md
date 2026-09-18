# Special Chat Modes — Audit / Security / Debug (Research + Design Packet)

> The pitch: a row of mode toggles in the chat (next to Chat/Read/Agent/Plan) that flip the agent
> into a specialized, *amplified* investigation posture. Press **Security** and the agent goes hard
> on vulnerabilities, armed with a curated security skill+tool loadout and a fixed methodology.
> Press **Audit** and it runs the deep correctness sweep. Press **Debug** and it runs hypothesis-driven
> root-cause analysis. Each mode = a system prompt + a tool/skill loadout + a workflow + a report format.
> Research-backed, with the exact skills/tools to build each out of. Planning doc — no code here.

---

## 0. The core idea (and why it's strong)

These aren't just "personalities." A mode is a **bundle**:
1. **A system prompt** that sets the posture and the methodology.
2. **A tool + skill loadout** scoped to the job (security scanners, debuggers, the `audit` skill).
3. **A fan-out workflow** (parallel investigators, like the audit you just saw).
4. **A fixed report format** the user trusts.

Two layers, don't conflate them:
- **Claude Code skills** (`.claude/skills/*/SKILL.md`) — what the harness agent uses. The `audit`
  skill already exists; `security` and `debug` skills are drafted below.
- **v3code chat modes** (the product toggle your users press) — wired in `chatModes.ts` +
  `modePickerActionItem.ts`, mapped to behavior in `v3codeChatAgent.ts`. Under the hood a mode
  *loads the matching skill + loadout*. That's the bridge: pressing the button = invoking the skill
  with the right tools and prompt pre-attached.

**The killer demo:** point **Security** and **Audit** at v3code *itself*. The pipeline audit already
found memory poisoning, tool-misuse, and cascading-failure bugs — which are literally OWASP's
**Agentic Top 10 (2026)** categories. So the modes prove themselves on the host editor before a user
ever points them at their own app.

---

## 1. How to wire a new mode into v3code chat (grounded in the code)

From the earlier chat audit, the mode machinery is:
- **`chatModes.ts`** — defines the built-in modes (Ask→"Chat", Edit→"Read", Agent, Plan), each with a
  label + description. New modes register here (`:635-636` is where Ask/Edit were relabeled).
- **`modePickerActionItem.ts`** — the picker UI; `shouldShowBuiltInMode` (`:331-335`) controls which
  modes show when `isV3CodeProduct`. New toggles surface here.
- **`v3codeChatAgent.ts:356-394`** — maps native `ChatModeKind` → internal `ChatMode`
  (`Agent→'agent'`, `Plan→'plan'`, `Edit→'read'`, `Ask→'chat'`). A new mode plugs in here and selects
  its system prompt + tool set + workflow.

**Two ways to ship the toggles:**
- **(A) Full modes** — add `Audit`/`Security`/`Debug` as first-class `ChatMode`s. Cleanest; they show
  in the mode picker like Agent/Plan. More wiring (mode enum, prompt, loadout, picker entry).
- **(B) Action buttons** — a small toolbar of "launch" buttons in the chat input that inject a
  preset prompt + skill into the current Agent-mode turn. Faster to ship; less "modey". Good for a v1.
  Recommendation: **start with (B) to validate, graduate the winners to (A).**

Each mode needs: a **mode-specific system prompt**, a **tool allowlist** (e.g. Security adds scanners,
Debug adds the terminal/test runner, Audit stays read-only), an optional **skill auto-load**, and a
**report template**. The agent loop already supports subagents (`run_subagent`) — the fan-out
workflows below reuse that.

---

## 2. AUDIT mode

**Posture:** read-only deep correctness/reliability sweep. Exactly what produced
`AGENT_PIPELINE_AUDIT.md`. Backed by the `audit` skill (already built).

- **Loadout:** read/search/LSP tools + `run_subagent`. **No edit/terminal/write tools** (read-only).
- **Workflow:** scope → decompose into 3–6 slices → fan out parallel investigators → refute pass on
  criticals → synthesize root causes → write ranked doc + roadmap.
- **Failure-mode lenses:** stalls/pauses, drops/crashes, short-term hallucination, long-term drift
  (configurable per target).
- **Report:** exec summary → root causes → master table by failure mode → P0/P1/P2 roadmap →
  "what's correct".
- **Build-out:** ship the `.claude/skills/audit` skill as the harness backing; the product toggle
  just preloads it + forces read-only. Optionally add static-analysis lenses (complexity, dead-code,
  cyclomatic hotspots) as extra lenses.

---

## 3. SECURITY mode  ⭐ (the headliner)

**Posture:** adversarial. The agent assumes the code is insecure and tries to prove it, mapping every
finding to a recognized taxonomy, then proposes the fix. Two targets: **the user's app** (the main
use case) and **v3code/agent systems** (OWASP Agentic).

### 3.1 What to actually check — "the #1 things vibe coders get wrong"
Research is brutal and consistent: **40–62% of AI-generated code ships with at least one
vulnerability**, and developers *rate AI code as more secure* than hand-written — a false-confidence
gap that means reviews get skipped. The concrete, checkable top offenders:

| Rank | Vuln class | Why it's #1 for vibe coders | How the mode detects/fixes |
|---|---|---|---|
| 1 | **Hardcoded secrets / API keys** | AI treats keys as config strings; ~58% of tested vibe apps had exposed creds | secret-scan (gitleaks/GitGuardian/trufflehog), grep for key patterns, check client bundles; fix → secrets manager + rotation + pre-commit hook |
| 2 | **Broken/missing auth & access control** | AI writes *plausible* auth that doesn't enforce ownership/RBAC; default creds left in | enumerate every endpoint, check authN **and** resource-ownership authZ; fix → centralized middleware, deny-by-default |
| 3 | **Injection (SQLi / XSS / prompt injection)** | string-concat queries, unescaped output (86% of AI code failed XSS defense), unfiltered input into LLM prompts | SAST (Semgrep/Snyk Code) + taint trace from source→sink; fix → parameterized queries/ORM, output encoding, input validation |
| 4 | **Hallucinated / malicious dependencies ("slopsquatting")** | models invent package names at ~5.2%; attackers register them | SCA (Snyk, Socket.dev) + verify every suggested package exists & is reputable before install; allowlist |
| 5 | **Security misconfig** (permissive CORS, missing headers, insecure cookies, debug on) | defaults left wide open | config scan + header check; fix → strict CORS, CSP/HSTS, secure+httpOnly cookies |
| 6 | **Sensitive data exposure** (stack traces, full DB rows, PII in logs) | AI returns whole objects, leaks errors to users | response-DTO review, log scan for PII; fix → field allowlists, generic error pages, PII-stripping logger |

For **agentic systems** (v3code itself, or the user's AI features), add the **OWASP Agentic Top 10
(2026)**: goal hijacking, tool misuse, identity abuse, **memory poisoning**, cascading failures,
rogue agents. (Note: our own `AGENT_PIPELINE_AUDIT.md` RC-5 *is* memory poisoning — eat our own dog
food.)

### 3.2 Workflow (the "agent goes crazy" part)
1. **Recon** — map the app's surfaces: endpoints, auth boundaries, data sinks, dependency manifest,
   config files, secret-bearing files.
2. **Fan out** parallel scanners by category (secrets / auth / injection / deps / config / data-exposure),
   each running its tool + manual reasoning, returning findings with severity + CWE/OWASP id + PoC
   sketch + fix.
3. **Adversarial verify** — for each high/critical, a skeptic agent tries to confirm exploitability
   (default "not exploitable" unless it proves it). Kills false positives, which SAST drowns in.
4. **Prioritize & report** — CVSS-ish severity, grouped by OWASP/CWE, each with a concrete fix diff
   and a re-check command.

### 3.3 Recommended skills/tools to build it out of (curated, rated)
- **Semgrep** — best-in-class open SAST, huge rule library, in the 2025 Gartner MQ for AppSec; rules
  map to OWASP/CWE. *The backbone.* (Semgrep Assistant adds LLM explanations.)
- **Snyk Code / Snyk Open Source** — SAST + SCA (dependency CVEs + license); strong fix advice.
- **Socket.dev** — supply-chain / malicious-package detection — directly counters slopsquatting.
- **gitleaks / trufflehog / GitGuardian** — secret scanning (pick one OSS + the hook).
- **OWASP ASVS** + **OWASP Top 10** + **OWASP Agentic Top 10 (2026)** — the checklists the mode scores
  against. **Microsoft Agent Governance Toolkit** (covers all 10 agentic risks) for the agentic angle.
- **Existing built-ins to reuse:** the harness already ships a **`/security-review`** skill and a
  **`code-review`** skill — Security mode should wrap/extend `/security-review`, not reinvent it.

> Build order: wrap `/security-review` + Semgrep + a secret-scanner first (covers ranks 1–3,5), then
> add Socket.dev (rank 4) and the OWASP-Agentic lens. That's ~80% of real vibe-coder risk.

---

## 4. DEBUG mode

**Posture:** hypothesis-driven root-cause analysis, not "try random fixes". The research consensus:
agent/system failures are hard because trajectories are long, stochastic, and the true cause gets
buried — so you need **structured tracing + a repeatable RCA loop**, pinpointing the *first
unrecoverable step* (Microsoft's AgentRx framing) rather than the symptom.

- **Loadout:** read/search/LSP + **terminal + test runner** (Debug *needs* to run things, unlike
  Audit), plus log/console readers. `run_subagent` for parallel hypothesis testing.
- **Workflow (RCA loop):**
  1. **Reproduce** — establish the exact failing trace / minimal repro; capture observability (logs,
     stack, state).
  2. **Localize** — bisect to the first step where reality diverges from intent (the "critical failure
     step"). For agents, trace the reasoning/tool chain, not just code.
  3. **Hypothesize** — enumerate candidate causes ranked by likelihood.
  4. **Test in parallel** — spawn a subagent per hypothesis to confirm/refute with evidence (instrument,
     add a probe, run the targeted case). Don't guess-and-patch.
  5. **Fix & verify** — apply the minimal fix, re-run the repro, confirm green, check for regressions.
  6. **Report** — root cause, evidence chain, the fix, and a guard (test/assert) so it can't regress.
- **Recommended skills/tools to build it out of:**
  - The existing harness **`verify`** skill (run the app, observe behavior) as the reproduce/verify step.
  - Structured tracing / observability hooks (OpenTelemetry-style) for agent traces; **eval harness**
    for non-deterministic cases.
  - The v3code MCP intelligence tools (`get_call_graph`, `recent_edits`, `get_build_errors`) for fast
    localization — already in the editor.
  - A "critical-failure-step" detector (AgentRx-style) for the agent's own multi-step failures.

---

## 5. Cross-mode design notes
- **Severity & taxonomy are first-class.** Every finding in every mode carries a severity and a
  recognized id (CWE/OWASP for security; failure-mode for audit; root-cause for debug). Builds trust.
- **Adversarial verification is the quality lever** in all three — a refute/confirm pass before a
  finding is reported. This is what separates "impressive" from "noisy".
- **Read-only vs. acting:** Audit = read-only, Security = read-only + scanners (propose fixes, don't
  auto-apply), Debug = may run/edit to repro and fix. Make the loadout enforce it.
- **Report artifacts:** each mode writes a dated doc + a tight chat summary, like the two audits did.
- **Eat-your-own-dogfood demo:** Security/Audit on v3code surfaces the RC-1..RC-5 issues + OWASP
  Agentic mapping — a built-in proof the modes work.

---

## 6. Suggested build sequence
1. **Ship the `audit` skill** (done) → wire an **Audit button** (option B) that preloads it read-only.
2. **Security button** wrapping `/security-review` + Semgrep + a secret-scanner; add the OWASP scorecard
   report. Validate by pointing it at a known-vulnerable sample app.
3. **Debug button** wrapping `verify` + the RCA loop + parallel hypothesis subagents.
4. Promote the winners from buttons (B) to full modes (A) in `chatModes.ts`/`modePickerActionItem.ts`.
5. (Later, per your note) curate the top-rated security/debug skill packs and bundle them per mode.

---

## Sources
**Vibe-coder security risks**
- [Vibe Coding Security: 7 Risks and How to Fix Them — Superblocks](https://www.superblocks.com/blog/vibe-coding-security)
- [Why 62% of AI-Generated Code Ships With Vulnerabilities — OX Security](https://www.ox.security/blog/vibe-coding-security/)
- [Why 53% of AI Code Has Security Holes — Autonoma](https://getautonoma.com/blog/vibe-coding-security-risks)
- [Vibe Coding Security Risks Aren't Like Ordinary Security Risks — IBM](https://www.ibm.com/think/insights/vibe-coding-security-risks)
- [4 most common security risks when vibe coding — Evil Martians](https://evilmartians.com/chronicles/four-most-common-security-risks-when-vibe-coding-your-app)

**Security audit tooling & agentic frameworks**
- [OWASP Top 10 for Agentic Applications 2026 — DeepTeam](https://www.trydeepteam.com/docs/frameworks-owasp-top-10-for-agentic-applications)
- [Microsoft Agent Governance Toolkit (covers OWASP Agentic 10/10)](https://github.com/microsoft/agent-governance-toolkit)
- [Semgrep AI Code Review — Augment Code overview](https://www.augmentcode.com/tools/semgrep-ai-code-review)

**Debugging / RCA methodology**
- [Systematic debugging for AI agents: the AgentRx framework — Microsoft Research](https://www.microsoft.com/en-us/research/blog/systematic-debugging-for-ai-agents-introducing-the-agentrx-framework/)
- [8 Best AI Agent Debugging & Root Cause Analysis Tools — Galileo](https://galileo.ai/blog/best-ai-agent-debugging-root-cause-analysis-tools)
- [Debugging AI in Production: RCA with Observability — DEV](https://dev.to/kuldeep_paul/debugging-ai-in-production-root-cause-analysis-with-observability-2h83)
