# Context Engineering Research Synthesis v1

**Research Director:** The Skeptic's Gatekeeper
**Date:** 2026-02-27
**Input:** 5 research tracks + prior token-efficiency findings
**Method:** Merge, deduplicate, stress-test, YAGNI gate

---

## Recommendations (ranked by impact / effort)

### 1. Session Resumption Protocol

- **Tracks:** 1 (State & Resumability), 5 (Developer Experience)
- **Problem:** When a session dies mid-implementation (task 4 of 8), a new session must re-read tasks.md and guess progress. StateSnapshot exists in `~/.spec-context-mcp/runtime-snapshots-v2.json` but is never automatically injected into a new session. The dashboard shows progress but can't feed it back to an orchestrator. Every system studied (Claude Code, GSD, Devin, LangGraph) shares this gap — no production system auto-injects persisted state into new sessions.
- **Pattern:** Add a `resume_run` action to dispatch-runtime that:
  1. Reads the last StateSnapshot for a given specName
  2. Formats facts + progress ledger into a resumption prompt template: "You were working on task N of M. Last completed: X. Last attempt: Y. Next suggested step: Z."
  3. Returns this as the tool response, giving the orchestrator full context

  Additionally, persist "resumption facts" at each dispatch boundary: current task, last step attempted, last failure reason, suggested next step. These already exist as `StateSnapshotFact` entries — just formalize which keys are required for resumption.

- **Evidence:**
  - LangGraph's checkpoint-based resumption enables restart from exact failure point (LangGraph docs)
  - Manus's todo.md recitation keeps plan in recent attention, preventing goal drift (Manus blog)
  - Devin's timeline scrubbing allows rollback to any checkpoint (Devin docs)
  - Claude Code's `--continue`/`--resume` restores full conversation but not task-level state
  - Track 5: "Loss of momentum" is a top reason developers abandon workflows — fast resumption preserves momentum

- **YAGNI gates:**
  - ✅ Gate 1 (Evidence): Every system studied implements some form of state persistence; LangGraph measures exact-step resumption
  - ✅ Gate 2 (Problem Exists): Real scenario — developer's Claude Code session dies at task 4 of 8, new session starts from scratch
  - ✅ Gate 3 (Incremental): Adds one new action to dispatch-runtime, formats existing StateSnapshot data
  - ✅ Gate 4 (Token Budget): Net reduction — prevents orchestrator from re-reading full spec files to reconstruct state (~2000 tokens saved per resumption)
  - ✅ Gate 5 (Client Agnostic): Works via MCP tool call, any client can invoke `resume_run`

- **Effort:** S — StateSnapshot and ProgressLedger already exist; this is formatting + a new action handler
- **Files affected:** `src/tools/workflow/dispatch-runtime.ts`, `src/tools/workflow/dispatch-ledger.ts`
- **Depends on:** None

---

### 2. Structured Reviewer Feedback Schema

- **Tracks:** 4 (Verification & Feedback), 2 (Context Budget)
- **Problem:** Reviewer feedback back to implementer is unstructured natural language. Same failure → re-dispatch with same prompt → same mistake. Aider shows 30-50% more editing errors without structured feedback. Concise, specific comments with code snippets are most likely to result in code changes (ArXiv 2508.18771). Currently, `ReviewerResult` has structured `issues[]` with severity/file/message/fix, but this structure may not be fully preserved when constructing the implementer re-dispatch prompt.
- **Pattern:** When re-dispatching implementer after reviewer rejection:
  1. Include reviewer's `issues[]` array verbatim in the implementer's delta packet
  2. Include reviewer's `required_fixes[]` as explicit checklist
  3. Add `previous_attempt_summary` field: what was tried, why it failed
  4. Add `constraints` field: what NOT to do (prevents widening scope)
  5. Vary the prompt framing on retry: first attempt = "implement X"; second attempt = "analyze why first attempt failed, what alternative approach avoids that?"; third attempt = "list three approaches, compare, choose best"

- **Evidence:**
  - Aider: 3x improvement with structured diff feedback vs unstructured (aider.chat/docs/unified-diffs)
  - ArXiv 2508.18771: concise, specific comments with code snippets most effective
  - Anthropic/Google: repeating identical prompt shows "no effect or small improvements" (ArXiv 2512.14982)
  - Spotify Honk: 50% of rejected sessions self-correct with single retry when feedback is structured (Spotify engineering blog)

- **YAGNI gates:**
  - ✅ Gate 1 (Evidence): Aider's 3x improvement is measured; Spotify's 50% self-correct rate is production data from 1500+ PRs
  - ✅ Gate 2 (Problem Exists): dispatch-runtime's `buildLedgerTaskPrompt` constructs re-dispatch prompts; reviewer issues exist but prompt variation doesn't
  - ✅ Gate 3 (Incremental): Modifies prompt construction in dispatch-runtime, no architectural change
  - ✅ Gate 4 (Token Budget): Adds ~200 tokens of structured feedback but eliminates entire retry cycles — net massive reduction
  - ✅ Gate 5 (Client Agnostic): Prompt construction happens server-side in MCP tool

- **Effort:** S — modify `buildLedgerTaskPrompt` and `buildLedgerDeltaPacket` to include reviewer issues + prompt variation logic
- **Files affected:** `src/tools/workflow/dispatch-ledger.ts`, `src/tools/workflow/dispatch-runtime.ts`
- **Depends on:** None

---

### 3. Lightweight Spec Mode ("Quick Spec")

- **Tracks:** 5 (Developer Experience), 3 (Orchestration)
- **Problem:** Current workflow requires Requirements → Design → Tasks → Implementation with 3 approval gates before any code is written. This is overkill for bugfixes, config changes, small features. Track 5 research finds this is the #1 adoption killer: "ceremony exceeds benefit = abandonment." OpenSpec, Kiro, and GitHub Spec Kit Issue #1174 all converge on need for lightweight paths. Thoughtworks: "SDD is genuine value for specific problems but overhead for others." Predicted adoption timeline: by week 5-6, developers create workarounds or abandon the tool.
- **Pattern:** Add a "quick" discipline mode (or modify workflow guide) that:
  1. Collapses Requirements + Design into a single brief "intent" document (1 paragraph + acceptance criteria)
  2. Generates task list directly from intent (skip design phase)
  3. Single approval gate before implementation (not 3)
  4. Auto-selects based on estimated complexity: simple tasks → quick mode; complex tasks → full mode

  The `HeuristicComplexityClassifier` already classifies tasks as simple/complex — extend to classify the *spec* request itself at workflow-guide time.

- **Evidence:**
  - OpenSpec: "prioritises momentum and clarity... designed to slow you down just enough to think about intent" (darrenonthe.net)
  - Kiro: "the simplest of the major specification tools" with quick requirements/design/tasks (Martin Fowler)
  - GitHub Spec Kit Issue #1174: explicit community request for `tinySpec` lightweight workflow
  - Thoughtworks: teams abandon SDD when "ceremony cost exceeds perceived benefit"
  - Harvard/MIT: developers using AI tools took 19% longer due to compounded friction (Augment Code)
  - Marmelab: "Spec-Driven Development revives Big Design Up Front" criticism on HN

- **YAGNI gates:**
  - ✅ Gate 1 (Evidence): Multiple tools (OpenSpec, Kiro) exist because users demand lightweight paths; GitHub Spec Kit has open issue requesting it
  - ✅ Gate 2 (Problem Exists): spec-context-mcp has exactly one workflow with 3 gates — every user implementing a bugfix hits this
  - ✅ Gate 3 (Incremental): Adds alternative path in spec-workflow-guide, doesn't change full workflow
  - ✅ Gate 4 (Token Budget): Reduces tokens — fewer spec documents, fewer approval round-trips, shorter workflow guide response
  - ✅ Gate 5 (Client Agnostic): Workflow guide is an MCP tool response; works everywhere

- **Effort:** M — new workflow path in spec-workflow-guide, intent template, modified approval flow
- **Files affected:** `src/tools/workflow/spec-workflow-guide.ts`, `src/config/discipline.ts`, possibly new template file
- **Depends on:** None

---

### 4. Failure Evidence Preservation in Re-dispatch Context

- **Tracks:** 4 (Verification & Feedback), 1 (State & Resumability)
- **Problem:** When implementer is re-dispatched after failure, the re-dispatch prompt may not include the full failure context. Manus's core principle: "leave wrong turns in context" — error recovery is the clearest indicator of agentic behavior. Currently, `TaskLedger` tracks `reviewerIssues`, `blockers`, `requiredFixes`, but the delta packet sent to the next dispatch may truncate or omit this context. Failed code, test output, and the reasoning behind the failure are lost.
- **Pattern:** Formalize failure evidence as a required section in re-dispatch prompts:
  1. What was attempted (code summary or diff reference)
  2. What error occurred (test output, reviewer feedback, lint errors)
  3. Why that approach won't work (constraints for next attempt)
  4. What files were touched (prevent agent from re-exploring)

  Implement by enriching `buildLedgerDeltaPacket` to include failure evidence fields when `TaskLedger.reviewerAssessment === 'needs_changes'` or implementer status was `failed`/`blocked`.

- **Evidence:**
  - Manus: "Error recovery is the clearest signal of true agentic behavior" — preserving failure context enables implicit belief updating (Manus blog)
  - SWE-bench: 76.1% pass@1 but 81.2% pass@3 — the delta comes from seeing what failed (SWE-bench Verified)
  - Context poisoning: incorrect info entering context compounds errors; but *failure* info entering context *prevents* repeating errors (Galileo blog)
  - Spotify Honk: agent "able to course correct half the time" with single retry — but only when it sees what went wrong

- **YAGNI gates:**
  - ✅ Gate 1 (Evidence): Manus production experience; Spotify's 50% self-correct rate; SWE-bench pass@3 improvement
  - ✅ Gate 2 (Problem Exists): dispatch-runtime's delta packet has MAX_DELTA_VALUE_CHARS = 240 — reviewer feedback can be truncated
  - ✅ Gate 3 (Incremental): Enriches existing delta packet construction, no new systems
  - ✅ Gate 4 (Token Budget): Adds ~300-500 tokens of failure evidence but prevents entire wasted dispatch cycles (~4000+ tokens each)
  - ✅ Gate 5 (Client Agnostic): Delta packet is assembled server-side

- **Effort:** S — modify `buildLedgerDeltaPacket` to include failure evidence fields
- **Files affected:** `src/tools/workflow/dispatch-ledger.ts`, `src/tools/workflow/dispatch-runtime.ts`
- **Depends on:** Pairs well with #2 (Structured Reviewer Feedback) but independent

---

### 5. Spec-Workflow-Guide Compact Mode

- **Tracks:** 2 (Context Budget), 5 (Developer Experience)
- **Problem:** `spec-workflow-guide` returns ~2000+ tokens every call: full mermaid diagram, complete workflow sections, file structure, templates. No caching mechanism exists (unlike implementer guide which has full/compact modes). The mermaid diagram alone is ~200 tokens of visual representation that's valuable on first call but pure waste on subsequent calls. This violates the "just-in-time retrieval" principle (Anthropic) and the "front-load sparingly" principle.
- **Pattern:** Mirror the implementer guide's full/compact caching pattern:
  1. First call returns full guide (diagram + all sections + templates)
  2. Subsequent calls return compact version: current phase instructions only, no diagram, no templates
  3. Cache by session/conversation (not runId since workflow guide is pre-dispatch)
  4. Include `steeringFingerprint` check to invalidate cache if steering docs change

- **Evidence:**
  - Track 2: implementer guide compact mode achieves 6x token savings on repeat calls
  - Anthropic: "find the smallest set of high-signal tokens that maximize desired outcome"
  - Manus: stable prefix + append-only pattern yields 10x cost difference via KV-cache (0.30 vs 3.00 USD/MTok)
  - Factory.ai: probe-based evaluation shows agents can continue with compressed context if critical facts preserved

- **YAGNI gates:**
  - ✅ Gate 1 (Evidence): Implementer guide's own compact mode demonstrates 6x savings in same codebase
  - ✅ Gate 2 (Problem Exists): Every orchestrator session calls spec-workflow-guide, often multiple times
  - ✅ Gate 3 (Incremental): Mirrors existing pattern from get-implementer-guide
  - ✅ Gate 4 (Token Budget): ~1500 tokens saved per subsequent call
  - ✅ Gate 5 (Client Agnostic): MCP tool response, works everywhere

- **Effort:** S — copy pattern from get-implementer-guide, adapt for workflow guide
- **Files affected:** `src/tools/workflow/spec-workflow-guide.ts`
- **Depends on:** None

---

### 6. Deterministic Verification Tier in Dispatch Loop

- **Tracks:** 4 (Verification & Feedback), 3 (Orchestration)
- **Problem:** spec-context-mcp relies entirely on the reviewer agent (LLM) for verification. Spotify's two-tier model shows deterministic verifiers (lint, type-check, test execution) catch mechanical errors that LLM reviewers miss. Without deterministic verification, the reviewer wastes tokens on issues a linter would catch instantly. SWE-bench shows 7.8% of "correct" patches actually fail developer test suites — LLM review alone is insufficient.
- **Pattern:** After implementer dispatch returns `status: "completed"`, run deterministic verifiers before reviewer dispatch:
  1. If implementer reported `tests[].command`, execute those test commands
  2. Parse test output for pass/fail
  3. If tests fail, re-dispatch implementer immediately with test failure output (skip reviewer entirely)
  4. Only dispatch reviewer after tests pass

  This adds a fast, cheap verification step between implementer and reviewer, catching mechanical failures before burning reviewer tokens.

- **Evidence:**
  - Spotify Honk: deterministic verifiers activate automatically based on codebase structure; LLM judge vetoes ~25% of sessions (Spotify engineering)
  - SWE-bench: 7.8% false-positive rate in test-only validation shows need for multi-tier (ArXiv 2503.15223)
  - AgentCoder: separating code from test generation improved quality 8-20% (ArXiv 2312.13010)
  - Track 4: "Without verification loops, code simply doesn't work" (Spotify)

- **YAGNI gates:**
  - ✅ Gate 1 (Evidence): Spotify production data (1500+ PRs), AgentCoder measured improvement
  - ✅ Gate 2 (Problem Exists): Currently reviewer catches test failures that could be caught deterministically
  - ✅ Gate 3 (Incremental): Adds verification step between existing implementer→reviewer flow
  - ✅ Gate 4 (Token Budget): Eliminates reviewer dispatch for mechanically broken code (~4000 tokens per skipped reviewer call)
  - ⚠️ Gate 5 (Client Agnostic): Requires executing shell commands from MCP server — works but needs sandbox consideration

- **Effort:** M — needs test command execution in dispatch-runtime, output parsing, conditional re-dispatch logic
- **Files affected:** `src/tools/workflow/dispatch-runtime.ts`, `src/tools/workflow/dispatch-executor.ts`
- **Depends on:** None, but benefits from #2 and #4

---

### 7. End-of-Phase Requirements Compliance Check

- **Tracks:** 4 (Verification & Feedback), 5 (Developer Experience)
- **Problem:** No end-of-phase holistic verification against requirements. Agent implements tasks one by one, each passes review, but the aggregate may only implement 60% of original requirements (RFC discussion on dev.to). Spotify's LLM judge catches scope creep on ~25% of sessions. Currently, the orchestrator marks tasks complete individually but never checks "did all tasks together satisfy the spec requirements?"
- **Pattern:** After all tasks in a spec are marked `[x]` completed:
  1. Load `requirements.md` and `design.md`
  2. Load list of all completed task summaries from StateSnapshot facts
  3. Construct a compliance prompt: "Given these requirements and this design, do the completed tasks fully satisfy the spec? List any gaps."
  4. Return compliance result to orchestrator before declaring spec complete

  This can be a new `verify_compliance` action on dispatch-runtime or a post-implementation step in the workflow guide.

- **Evidence:**
  - RFC on dev.to: "PR looks good, tests pass, code is clean, but it only implements 60% of what was requested"
  - Spotify: LLM judge vetoes 25% of sessions for scope issues (engineering blog)
  - SWE-bench: 29.6% of plausible patches induce different behavior than ground truth (ArXiv 2503.15223)
  - Track 4: "Requirements compliance checking is missing in most loops"

- **YAGNI gates:**
  - ✅ Gate 1 (Evidence): Spotify's 25% veto rate shows scope drift is common; SWE-bench 29.6% behavioral divergence
  - ✅ Gate 2 (Problem Exists): No end-of-spec verification exists today — orchestrator just advances through tasks
  - ✅ Gate 3 (Incremental): Adds one verification step at end of workflow, doesn't change task-level flow
  - ⚠️ Gate 4 (Token Budget): Adds one LLM call (~2000 tokens) but catches incomplete implementations that would require rework
  - ✅ Gate 5 (Client Agnostic): MCP tool call, works everywhere

- **Effort:** M — needs compliance prompt construction, requirements loading, gap analysis logic
- **Files affected:** `src/tools/workflow/dispatch-runtime.ts`, `src/tools/workflow/spec-workflow-guide.ts`
- **Depends on:** None

---

### 8. Conditional Task Parallelism (DAG-based)

- **Tracks:** 3 (Orchestration), 5 (Developer Experience)
- **Problem:** All tasks execute sequentially (ONE TASK AT A TIME enforced). Evidence shows parallelism is safe and beneficial for truly independent tasks. AgentCoder showed 77.4% quality improvement from role separation. Anthropic's multi-agent research showed 90%+ improvement for discovery tasks. However, Anthropic also warns: "Multi-agent systems are less effective for tightly interdependent tasks such as coding."
- **Pattern:**
  1. During task generation, annotate tasks with explicit dependencies (task 3 depends on task 1, task 4 depends on task 2, etc.)
  2. Build DAG from dependency annotations
  3. Identify independent task sets (tasks with no shared dependencies)
  4. Allow parallel dispatch of independent tasks within a "wave"
  5. Maintain sequential default — parallelism is opt-in after explicit DAG annotation

  Start conservative: only parallelize tasks explicitly marked independent by the task author. Don't auto-detect independence.

- **Evidence:**
  - AgentCoder: 77.4% pass@1 with parallel role separation (ArXiv 2312.13010)
  - GSD: wave-based execution with fresh context per task prevents degradation (GSD docs)
  - Anthropic: 90%+ improvement for parallel research/discovery tasks (Anthropic engineering blog)
  - Claude Code: 10+ parallel subagents documented in production (Dev Community)
  - COUNTER-EVIDENCE: "Multi-agent systems are less effective for tightly interdependent tasks" (Anthropic); "Low Edge F1 Score" in dependency management (ArXiv 2410.22457)

- **YAGNI gates:**
  - ✅ Gate 1 (Evidence): AgentCoder 77.4% measured improvement; GSD production-tested wave pattern
  - ✅ Gate 2 (Problem Exists): 8-task spec with 3 independent pairs takes 2x longer than necessary
  - ⚠️ Gate 3 (Incremental): Requires DAG representation in tasks.md, parallel dispatch logic, result merging — larger change
  - ✅ Gate 4 (Token Budget): Neutral per-task, but reduces wall-clock time significantly
  - ✅ Gate 5 (Client Agnostic): Dispatch happens server-side via CLI subprocesses

- **Effort:** L — DAG representation, parallel dispatch orchestration, result merging, error propagation across waves
- **Files affected:** `src/tools/workflow/dispatch-runtime.ts`, `src/tools/workflow/dispatch-ledger.ts`, `src/core/workflow/task-parser.ts`, `src/tools/workflow/spec-workflow-guide.ts`
- **Depends on:** #6 (Deterministic Verification) makes parallel dispatch safer

---

## Rejected Patterns

- **ACON Compression Framework** — Rejected at Gate 3: Requires learning loop infrastructure (failure case collection, LLM-driven guideline optimization, iterative refinement). Only worth it for 15+ step workflows; our typical spec has 4-8 tasks. Observation masking (already in prior research) achieves 50% reduction without this complexity.

- **DSPy Prompt Template Optimization** — Rejected at Gate 3: Requires building DSPy evaluation pipeline with spec-workflow metrics. High setup cost for marginal gains over manually-tuned prompts. Revisit only if dispatch prompt templates are identified as a bottleneck.

- **Zep/Graphiti Knowledge Graph** — Rejected at Gate 3: Adds graph database infrastructure dependency. StateSnapshotFact already provides factual state abstraction. Only justified for sessions exceeding 10+ dispatch cycles, which is rare.

- **AgeMem Dynamic Memory** — Rejected at Gate 1: No production evidence. Research paper only. Unproven pattern with high implementation complexity.

- **Git-Context-Controller (GCC)** — Rejected at Gate 1: No production evidence beyond paper. SOTA claims but no field reports. Very high implementation complexity.

- **C3PO Re-dispatch Cascade** — Rejected at Gate 4: Each dispatch is a heavyweight CLI subprocess invocation. Two full dispatches on escalation doubles latency. Only justified if routing misclassification rate is high, which we don't yet measure.

- **Exact-Match Dispatch Deduplication** — Rejected at Gate 2: Dispatch prompts rarely repeat exactly. Hit rate would be near zero. Only value: dedup on retry after transient CLI failures, which is a niche case.

- **Agentic Plan Caching** — Rejected at Gate 3: Requires keyword extraction, template matching, adaptation logic. Non-trivial implementation for speculative savings. No public code. Revisit after measuring dispatch-level patterns.

- **Pre-Implementation Discovery Phase** — Rejected at Gate 2: spec-context-mcp's Design phase already fills this role (exploratory architecture thinking, codebase analysis). Adding a separate discovery phase duplicates the Design phase. If discovery is needed, it belongs in the brainstorm or design phase, not as a separate pre-implementation step.

- **Full Parallel Multi-Agent Discovery (GSD 4-researcher pattern)** — Rejected at Gate 2: This solves for large-scale codebase exploration before implementation. spec-context-mcp's design phase + steering docs already provide codebase context. The 4-researcher pattern is designed for codebases without pre-existing architecture documentation — our steering docs serve this purpose.

- **Probe-Based Evaluation (Factory.ai)** — Rejected at Gate 3: Requires designing domain-specific probes for each verification scenario. High human effort to create and maintain probes. Worth revisiting when we have enough dispatch data to identify common failure patterns that probes could catch.

- **Cross-Functional Collaboration Tooling** — Rejected at Gate 5: Enabling product managers to participate via non-code interfaces requires UI/UX work outside MCP protocol scope. Dashboard already provides some visibility. This is a product direction decision, not a context engineering pattern.

---

## Convergence Signals

Patterns where multiple tracks independently arrived at the same conclusion:

1. **Failure evidence preservation** — Tracks 1, 4 both emphasize: persisting what failed is as important as persisting what succeeded. Manus (Track 4) and LangGraph checkpointing (Track 1) converge on this from different angles.

2. **Compact/progressive context** — Tracks 2, 5 both identify: front-loading full context on every call is wasteful. Implementer guide already has full/compact; workflow guide needs it. Track 5's "quick mode" demand also reflects context progressive disclosure.

3. **Structured over unstructured feedback** — Tracks 2, 4 both find: structured feedback (JSON with explicit fields) drives better outcomes than prose. Aider's diff-based feedback (Track 4) and the token-efficiency research on structured output contracts (Track 2) agree.

4. **Sequential-by-default with opt-in parallelism** — Tracks 3, 4 converge: parallelism helps for independent work but hurts for coupled tasks. Anthropic warns against parallel coding tasks; AgentCoder shows parallel *roles* help. Resolution: parallelize independent tasks, not dependent ones.

---

## Implementation Priority Matrix

| Priority | Recommendation | Effort | Token Impact | Quality Impact |
|----------|---------------|--------|-------------|----------------|
| P0 | #2 Structured Reviewer Feedback | S | +200, -4000+ per avoided retry | 3x improvement (Aider data) |
| P0 | #4 Failure Evidence Preservation | S | +300-500, -4000+ per avoided retry | 50% self-correct (Spotify data) |
| P0 | #5 Workflow Guide Compact Mode | S | -1500 per subsequent call | Neutral (same info, less noise) |
| P1 | #1 Session Resumption Protocol | S | -2000 per resumption | Prevents session death → restart |
| P1 | #3 Quick Spec Mode | M | Major reduction (fewer phases) | Adoption retention |
| P1 | #6 Deterministic Verification Tier | M | -4000 per skipped reviewer | Catches mechanical failures |
| P2 | #7 Requirements Compliance Check | M | +2000 but catches 25% scope drift | Prevents incomplete specs |
| P2 | #8 Conditional Parallelism | L | Neutral per-task, 2x wall-clock | For specs with independent tasks |
