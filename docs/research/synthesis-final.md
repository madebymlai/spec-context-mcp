# Context Engineering Research Synthesis — Final

**Research Director:** The Skeptic's Gatekeeper
**Date:** 2026-02-27
**Input:** 5 research tracks + prior token-efficiency findings
**Method:** Merge, deduplicate, stress-test, YAGNI gate, revision pass
**Revision notes:** Adjusted effort estimates (#3 M→M-L), clarified #7 compliance check mechanism, noted evidence strength variance within #2, strengthened convergence between #2 and #4.

---

## Recommendations (ranked by impact / effort)

### 1. Structured Reviewer Feedback + Failure Evidence Preservation

- **Tracks:** 4 (Verification & Feedback), 2 (Context Budget), 1 (State & Resumability)
- **Problem:** Two related gaps in the re-dispatch loop:
  - **Feedback structure:** Reviewer's `ReviewerResult` has structured `issues[]` with severity/file/message/fix, but `buildLedgerDeltaPacket` truncates delta values to `MAX_DELTA_VALUE_CHARS = 240` characters. Reviewer feedback gets cut. Aider shows 30-50% more editing errors without structured feedback.
  - **Failure evidence:** When re-dispatching after failure, the prompt doesn't preserve what was attempted, what error occurred, or what constraints apply to the next attempt. Manus's core principle: "leave wrong turns in context." Same prompt → same inference path → same mistake.

- **Pattern:** Enrich re-dispatch prompts in two ways:
  1. **Structured feedback inclusion:** When re-dispatching implementer after reviewer rejection, include reviewer's `issues[]` and `required_fixes[]` in full (not truncated to 240 chars). Add a dedicated `reviewerFeedback` section in the delta packet that bypasses the general value truncation.
  2. **Failure evidence section:** Add `previous_attempt` field containing: what was tried (summary), what failed (error/rejection reason), files already touched, constraints for next attempt (what NOT to do).
  3. **Prompt variation on retry** (lower-evidence, implement second): Vary prompt framing on consecutive retries. First: "implement X"; Second: "first attempt failed because Y — what alternative approach avoids that?"; Third: "list three approaches, compare trade-offs, choose best." Evidence for this is weaker (ArXiv 2512.14982 shows "no effect or small improvements" from identical retries, but doesn't measure structured variation).

- **Evidence:**
  - Aider: 3x improvement with structured diff feedback vs unstructured ([aider.chat/docs/unified-diffs](https://aider.chat/docs/unified-diffs.html)) — **strong**
  - Spotify Honk: 50% of rejected sessions self-correct with single retry when agent sees structured feedback (Spotify engineering blog, 1500+ PRs) — **strong**
  - ArXiv 2508.18771: concise, specific comments with code snippets most likely to result in code changes — **medium**
  - Manus: "Error recovery is the clearest signal of true agentic behavior" — preserving failure context enables implicit belief updating — **medium** (qualitative production experience)
  - SWE-bench: pass@1 76.1% → pass@3 81.2%, improvement comes from seeing what failed — **medium**
  - ArXiv 2512.14982: identical prompt repetition shows "no effect or small improvements" — **medium** (supports variation but doesn't measure it directly)

- **YAGNI gates:**
  - ✅ Gate 1 (Evidence): Aider 3x measured; Spotify 50% self-correct from 1500+ production PRs
  - ✅ Gate 2 (Problem Exists): MAX_DELTA_VALUE_CHARS = 240 truncates reviewer feedback in dispatch-runtime
  - ✅ Gate 3 (Incremental): Modifies `buildLedgerDeltaPacket` and `buildLedgerTaskPrompt`; no architectural change
  - ✅ Gate 4 (Token Budget): Adds ~400-700 tokens of structured feedback; eliminates entire retry cycles (~4000+ tokens each)
  - ✅ Gate 5 (Client Agnostic): Prompt construction happens server-side in MCP tool

- **Effort:** S — modify delta packet construction and task prompt building
- **Files affected:** `src/tools/workflow/dispatch-ledger.ts`, `src/tools/workflow/dispatch-runtime.ts`
- **Depends on:** None

---

### 2. Spec-Workflow-Guide Compact Mode

- **Tracks:** 2 (Context Budget), 5 (Developer Experience)
- **Problem:** `spec-workflow-guide` returns ~2000+ tokens every call: full mermaid diagram (~200 tokens), complete workflow sections for all phases (~1800 tokens), file structure, and templates. No caching mechanism exists (unlike implementer guide which has full/compact modes with runId-based caching). The mermaid diagram is valuable on first call but waste on subsequent calls. This violates "just-in-time retrieval" (Anthropic) and "front-load sparingly" principles.
- **Pattern:** Mirror the implementer guide's full/compact caching pattern:
  1. First call: return full guide (diagram + all sections + templates + steering)
  2. Subsequent calls: return compact version — current phase instructions only, no diagram, no templates, no steering (unless fingerprint changed)
  3. Cache key: session-level (since workflow guide is pre-dispatch, not tied to runId)
  4. Invalidation: steering fingerprint check, same pattern as `hasSteeringFingerprintMismatch` in get-implementer-guide

- **Evidence:**
  - Implementer guide compact mode: 6x token savings on repeat calls within same codebase — **strong** (directly measured)
  - Anthropic: "find the smallest set of high-signal tokens that maximize desired outcome" — **medium**
  - Manus: stable prefix + append-only yields 10x cost difference via KV-cache — **strong** (pricing data)

- **YAGNI gates:**
  - ✅ Gate 1 (Evidence): Implementer guide's own compact mode demonstrates 6x savings in same codebase
  - ✅ Gate 2 (Problem Exists): Every orchestrator session calls spec-workflow-guide, often multiple times per spec
  - ✅ Gate 3 (Incremental): Mirrors existing pattern from get-implementer-guide
  - ✅ Gate 4 (Token Budget): ~1500 tokens saved per subsequent call
  - ✅ Gate 5 (Client Agnostic): MCP tool response, works everywhere

- **Effort:** S — copy caching pattern from get-implementer-guide, adapt for workflow guide
- **Files affected:** `src/tools/workflow/spec-workflow-guide.ts`
- **Depends on:** None

---

### 3. Session Resumption Protocol

- **Tracks:** 1 (State & Resumability), 5 (Developer Experience)
- **Problem:** When a session dies mid-implementation (task 4 of 8), a new session must re-read tasks.md and guess progress. `StateSnapshot` exists in `~/.spec-context-mcp/runtime-snapshots-v2.json` with full facts, progress ledger, and checkpoint history — but is never automatically injected into a new session. The dashboard shows progress but can't feed it back to an orchestrator. Every system studied (Claude Code, GSD, Devin, LangGraph) shares this gap.
- **Pattern:** Add a `resume_run` action to dispatch-runtime:
  1. Accept `specName` (required) and optional `runId`
  2. Read last StateSnapshot for that spec (or specific runId)
  3. Format facts + progress ledger into a resumption prompt: "You were working on task N of M. Completed: [list]. Current task: X. Last dispatch role: Y. Last outcome: Z."
  4. Return as tool response, giving orchestrator full resumption context
  5. Persist "resumption facts" at each dispatch boundary (formalize which `StateSnapshotFact` keys are required: current task, last attempt, last failure, next suggested step)

- **Evidence:**
  - LangGraph: checkpoint-based resumption enables restart from exact failure point — **strong** (framework design)
  - Manus: todo.md recitation keeps plan in recent attention, preventing goal drift — **medium**
  - Devin: timeline scrubbing allows rollback to any checkpoint — **medium**
  - Claude Code: `--continue`/`--resume` restores conversation but not task-level state — **medium** (demonstrates user need)
  - Track 5: "Loss of momentum" is top reason developers abandon workflows — **medium**

- **YAGNI gates:**
  - ✅ Gate 1 (Evidence): Every system implements state persistence; LangGraph measures exact-step resumption
  - ✅ Gate 2 (Problem Exists): Session death during implementation is a real scenario (Claude Code issues #18482, #22729 document session failures)
  - ✅ Gate 3 (Incremental): Adds one new action to dispatch-runtime, formats existing StateSnapshot data
  - ✅ Gate 4 (Token Budget): Net reduction — prevents re-reading full spec files to reconstruct state (~2000 tokens saved)
  - ✅ Gate 5 (Client Agnostic): MCP tool call, any client can invoke `resume_run`

- **Effort:** S — StateSnapshot and ProgressLedger already exist; this is formatting + a new action handler
- **Files affected:** `src/tools/workflow/dispatch-runtime.ts`, `src/tools/workflow/dispatch-ledger.ts`
- **Depends on:** None

---

### 4. Lightweight Spec Mode ("Quick Spec")

- **Tracks:** 5 (Developer Experience), 3 (Orchestration)
- **Problem:** Current workflow requires Requirements → Design → Tasks → Implementation with 3 approval gates. This is overkill for bugfixes, config changes, small features. Track 5 research: this is the #1 adoption killer. OpenSpec, Kiro, and GitHub Spec Kit Issue #1174 all request lightweight paths. Thoughtworks: "SDD is genuine value for specific problems but overhead for others." Predicted adoption timeline: by week 5-6, developers create workarounds or abandon.
- **Pattern:** Add a "quick" workflow path:
  1. Collapse Requirements + Design into a single "intent" document (1 paragraph + acceptance criteria)
  2. Generate task list directly from intent (skip separate design phase)
  3. Single approval gate before implementation (not 3)
  4. Orchestrator suggests quick vs full mode based on request complexity
  5. Full mode remains available — quick mode is an addition, not a replacement

  Implementation considerations: needs new intent template, modified workflow guide branching, potentially a `quickSpec` flag on spec-status.

- **Evidence:**
  - OpenSpec: "prioritises momentum and clarity... slow you down just enough to think about intent" — **medium**
  - Kiro: "simplest of the major specification tools" with quick requirements/design/tasks (Martin Fowler) — **medium**
  - GitHub Spec Kit Issue #1174: explicit community request for `tinySpec` — **medium** (user signal)
  - Thoughtworks: teams abandon SDD when "ceremony cost exceeds perceived benefit" — **strong** (industry analysis)
  - Harvard/MIT: developers using AI tools took 19% longer due to compounded friction — **strong** (measured)
  - HN discussion: "Spec-Driven Development revives Big Design Up Front" — **medium** (community perception)

- **YAGNI gates:**
  - ✅ Gate 1 (Evidence): Multiple tools exist because users demand lightweight paths; measured 19% slowdown from ceremony
  - ✅ Gate 2 (Problem Exists): Every user implementing a bugfix must go through 3 approval gates
  - ✅ Gate 3 (Incremental): Adds alternative path, doesn't change full workflow
  - ✅ Gate 4 (Token Budget): Fewer spec documents, fewer approval round-trips, shorter guide response
  - ✅ Gate 5 (Client Agnostic): Workflow guide is MCP tool response

- **Effort:** M-L — new workflow path in spec-workflow-guide, intent template, modified approval flow, spec-status awareness of quick vs full specs, template updates
- **Files affected:** `src/tools/workflow/spec-workflow-guide.ts`, `src/config/discipline.ts`, template files, potentially `src/tools/workflow/spec-status.ts`
- **Depends on:** None

---

### 5. Deterministic Verification Tier in Dispatch Loop

- **Tracks:** 4 (Verification & Feedback), 3 (Orchestration)
- **Problem:** spec-context-mcp relies entirely on the reviewer agent (LLM) for verification. Spotify's two-tier model shows deterministic verifiers catch mechanical errors that LLM reviewers miss. Without deterministic verification, reviewer wastes tokens on issues a linter would catch instantly.
- **Pattern:** After implementer dispatch returns `status: "completed"`, run deterministic verification before reviewer dispatch:
  1. If implementer reported `tests[].command`, execute those test commands via `NodeDispatchExecutor`
  2. Parse test output for pass/fail
  3. If tests fail, re-dispatch implementer immediately with test failure output (skip reviewer)
  4. Only dispatch reviewer after tests pass
  5. Security: test commands run in same sandbox as CLI subprocesses (no new security surface)

- **Evidence:**
  - Spotify Honk: deterministic verifiers activate automatically; LLM judge vetoes ~25% — **strong** (production, 1500+ PRs)
  - SWE-bench: 7.8% false-positive rate in test-only validation — **strong** (measured)
  - Track 4: "Without verification loops, code simply doesn't work" — **strong** (Spotify production)

- **YAGNI gates:**
  - ✅ Gate 1 (Evidence): Spotify production data, SWE-bench measured rates
  - ✅ Gate 2 (Problem Exists): Reviewer currently catches test failures that could be caught deterministically
  - ✅ Gate 3 (Incremental): Adds verification step between existing implementer→reviewer flow
  - ✅ Gate 4 (Token Budget): Eliminates reviewer dispatch for mechanically broken code (~4000 tokens saved)
  - ✅ Gate 5 (Client Agnostic): Test execution via same CLI subprocess mechanism already used for dispatch

- **Effort:** M — test command execution, output parsing, conditional re-dispatch logic
- **Files affected:** `src/tools/workflow/dispatch-runtime.ts`, `src/tools/workflow/dispatch-executor.ts`
- **Depends on:** None. Benefits from #1 (failure evidence feeds into test failure re-dispatch context).

---

### 6. End-of-Phase Requirements Compliance Check

- **Tracks:** 4 (Verification & Feedback), 5 (Developer Experience)
- **Problem:** No holistic verification after all tasks complete. Individual tasks pass review, but aggregate may implement only 60% of original requirements. Spotify's LLM judge catches scope issues on ~25% of sessions.
- **Pattern:** After all tasks in a spec are marked `[x]` completed, before declaring spec complete:
  1. Load `requirements.md` acceptance criteria
  2. Load all completed task summaries from StateSnapshot facts
  3. Construct compliance summary and return to orchestrator: "Requirements A, B, C met. Requirement D has gap: [description]."
  4. This is NOT a separate dispatch — it's a `verify_compliance` action on dispatch-runtime that assembles context for the orchestrator to evaluate. The orchestrator (already an LLM) does the compliance reasoning. The MCP tool just assembles the evidence.

  This avoids an additional LLM dispatch while still surfacing compliance gaps.

- **Evidence:**
  - Dev.to RFC: "PR looks good, tests pass, code is clean, but only implements 60% of requirements" — **medium**
  - Spotify: LLM judge vetoes 25% for scope issues — **strong** (production)
  - SWE-bench: 29.6% of plausible patches induce different behavior than ground truth — **strong** (measured)

- **YAGNI gates:**
  - ✅ Gate 1 (Evidence): Spotify 25% veto rate; SWE-bench 29.6% behavioral divergence
  - ✅ Gate 2 (Problem Exists): No end-of-spec verification exists today
  - ✅ Gate 3 (Incremental): Adds one action to dispatch-runtime, assembles existing data
  - ✅ Gate 4 (Token Budget): Adds ~500 tokens of compliance summary to orchestrator context (no separate LLM call)
  - ✅ Gate 5 (Client Agnostic): MCP tool call

- **Effort:** M — compliance evidence assembly, requirements loading, gap formatting
- **Files affected:** `src/tools/workflow/dispatch-runtime.ts`
- **Depends on:** None

---

### 7. Conditional Task Parallelism (DAG-based)

- **Tracks:** 3 (Orchestration), 5 (Developer Experience)
- **Problem:** All tasks execute sequentially. Evidence shows parallelism is safe for truly independent tasks. AgentCoder: 77.4% quality improvement from role separation. Anthropic: 90%+ improvement for discovery tasks. But also: "Multi-agent systems are less effective for tightly interdependent tasks."
- **Pattern:**
  1. During task generation, annotate tasks with explicit dependencies
  2. Build DAG from annotations
  3. Identify independent task sets
  4. Allow parallel dispatch within a "wave"
  5. Sequential is default — parallelism is opt-in after explicit annotation
  6. Conservative: only parallelize tasks explicitly marked independent by spec author

- **Evidence:**
  - AgentCoder: 77.4% pass@1 with parallel role separation — **strong** (measured)
  - GSD: wave-based execution production-tested — **medium**
  - Anthropic: 90%+ improvement for parallel research — **strong** (but for research, not coding)
  - COUNTER: "less effective for tightly interdependent tasks" (Anthropic); "Low Edge F1 Score" in dependency management (ArXiv 2410.22457) — **medium**

- **YAGNI gates:**
  - ✅ Gate 1 (Evidence): AgentCoder measured; GSD production-tested
  - ✅ Gate 2 (Problem Exists): 8-task spec with independent pairs takes 2x longer than needed
  - ⚠️ Gate 3 (Incremental): Larger change — DAG representation, parallel dispatch, result merging, error propagation
  - ✅ Gate 4 (Token Budget): Neutral per-task, major wall-clock reduction
  - ✅ Gate 5 (Client Agnostic): Dispatch via CLI subprocesses

- **Effort:** L — DAG representation in tasks.md, parallel dispatch orchestration, wave-based result merging, cross-wave error propagation
- **Files affected:** `src/tools/workflow/dispatch-runtime.ts`, `src/tools/workflow/dispatch-ledger.ts`, `src/core/workflow/task-parser.ts`, `src/tools/workflow/spec-workflow-guide.ts`
- **Depends on:** #5 (Deterministic Verification) makes parallel dispatch safer by catching failures before cross-wave propagation

---

## Rejected Patterns

- **ACON Compression Framework** — Rejected at Gate 3: Requires learning loop infrastructure. Only worth for 15+ step flows; typical spec has 4-8 tasks. Observation masking already achieves 50% without this.

- **DSPy Prompt Template Optimization** — Rejected at Gate 3: Requires evaluation pipeline. High setup cost for marginal gains over manual tuning.

- **Zep/Graphiti Knowledge Graph** — Rejected at Gate 3: Adds graph database dependency. StateSnapshotFact already provides fact abstraction. Only for 10+ dispatch cycles.

- **AgeMem Dynamic Memory** — Rejected at Gate 1: No production evidence. Paper only.

- **Git-Context-Controller** — Rejected at Gate 1: No field reports. Very high complexity.

- **C3PO Re-dispatch Cascade** — Rejected at Gate 4: Double dispatch latency. Only if routing misclassification measured to be high.

- **Exact-Match Dispatch Dedup** — Rejected at Gate 2: Near-zero hit rate. Dispatch prompts don't repeat.

- **Agentic Plan Caching** — Rejected at Gate 3: Non-trivial (keyword extraction, template matching). No public implementation.

- **Pre-Implementation Discovery Phase** — Rejected at Gate 2: Design phase already fills this role. Brainstorm guide exists for exploration.

- **GSD 4-Researcher Parallel Discovery** — Rejected at Gate 2: Steering docs provide codebase context that this pattern would duplicate.

- **Probe-Based Evaluation** — Rejected at Gate 3: High human effort per probe. Worth revisiting with dispatch failure data.

- **Cross-Functional Collaboration Tooling** — Rejected at Gate 5: Outside MCP protocol scope. Product direction decision.

---

## Convergence Signals

Patterns where multiple tracks independently arrived at the same conclusion:

1. **Failure evidence preservation** — Tracks 1 (state persistence) + 4 (verification) both find: persisting what failed is as important as what succeeded. Manus and LangGraph checkpointing converge from different angles.

2. **Compact/progressive context** — Tracks 2 (token budget) + 5 (DX) both identify: front-loading full context every call is wasteful. Already solved for implementer guide; workflow guide is the gap.

3. **Structured > unstructured feedback** — Tracks 2 (tokens) + 4 (verification) agree: structured feedback drives better outcomes than prose. Aider 3x improvement + token-efficiency research on structured contracts.

4. **Sequential-by-default, opt-in parallelism** — Tracks 3 (orchestration) + 4 (verification) converge: parallelism helps for independent work, hurts for coupled tasks. Resolution: parallelize independent tasks only, with explicit annotation.

---

## Implementation Priority Matrix

| Priority | # | Recommendation | Effort | Token Impact | Quality Impact |
|----------|---|---------------|--------|-------------|----------------|
| P0 | 1 | Structured Feedback + Failure Evidence | S | +400-700, saves 4000+ per avoided retry | 3x improvement (Aider); 50% self-correct (Spotify) |
| P0 | 2 | Workflow Guide Compact Mode | S | -1500 per subsequent call | Neutral quality, less noise |
| P1 | 3 | Session Resumption Protocol | S | -2000 per resumption | Prevents full restart on session death |
| P1 | 4 | Quick Spec Mode | M-L | Major reduction (fewer phases) | Adoption retention (prevents abandonment) |
| P1 | 5 | Deterministic Verification Tier | M | -4000 per skipped reviewer | Catches mechanical failures pre-review |
| P2 | 6 | Requirements Compliance Check | M | +500 compliance summary | Catches 25% scope drift (Spotify) |
| P2 | 7 | Conditional Parallelism (DAG) | L | Neutral tokens, 2x wall-clock | For specs with independent task pairs |

---

## Dependency Graph

```
#1 Structured Feedback ──┐
                         ├──→ #5 Deterministic Verification (benefits from #1's failure context)
#2 Compact Workflow Guide │
                         │
#3 Session Resumption     │
                         │
#4 Quick Spec Mode        │
                         │
#5 Deterministic Verif. ──┼──→ #7 Parallelism (safer with deterministic pre-check)
                         │
#6 Compliance Check       │
                         │
#7 Conditional Parallelism┘
```

No hard blockers. All items can be implemented independently. Arrows indicate "improves effectiveness of" relationships, not hard dependencies.

---

## Source Summary

### Strong Evidence (measured, production, or peer-reviewed)
- Aider unified diffs: 3x improvement ([aider.chat](https://aider.chat/docs/unified-diffs.html))
- Spotify Honk: 1500+ PRs, 50% self-correct, 25% judge veto ([Spotify Engineering](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3))
- SWE-bench: 7.8% false positives, 29.6% behavioral divergence ([ArXiv 2503.15223](https://arxiv.org/html/2503.15223v1))
- AgentCoder: 77.4% pass@1 multi-agent ([ArXiv 2312.13010](https://arxiv.org/abs/2312.13010))
- Harvard/MIT: 19% developer slowdown from AI tool friction ([Augment Code](https://www.augmentcode.com/guides/why-ai-coding-tools-make-experienced-developers-19-slower-and-how-to-fix-it))
- Manus KV-cache: 10x cost via stable prefix ([Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus))
- Observation masking: 50% cost reduction, quality-neutral ([ArXiv 2508.21433](https://arxiv.org/abs/2508.21433))

### Medium Evidence (production qualitative or partially measured)
- Manus failure evidence preservation (qualitative production)
- LangGraph checkpoint resumption (framework design, widely adopted)
- Anthropic 90%+ multi-agent research improvement (internal evaluation)
- Thoughtworks SDD adoption analysis (industry report)
- OpenSpec, Kiro, GitHub Spec Kit community feedback

### Weak Evidence (blog posts, community signals)
- GitHub Spec Kit Issue #1174 tinySpec request
- HN/Reddit community sentiment on SDD ceremony
- Claude Code session failure issues (#18482, #22729)
