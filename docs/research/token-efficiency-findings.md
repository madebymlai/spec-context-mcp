# Token Efficiency & Prompt Power: Research Findings

**Date:** 2026-02-06
**Scope:** CLI orchestrator + CLI subagent dispatch (spec-context-mcp)
**Architecture:** MCP server compiles prompts → dispatches CLI subprocesses (claude, codex, opencode, gemini) → parses structured output
**Evidence grading:** [strong] = peer-reviewed + reproduced benchmarks; [medium] = paper + self-reported; [weak] = blog/docs claims
**Techniques found:** 15 validated for CLI orchestrator architecture

---

## P0 — Implement Immediately

---

### new: Observation Masking (Sliding Window)

**What:** Instead of LLM summarization, mask/truncate old environment observations (tool outputs, file contents, command results) while preserving the agent's full action and reasoning history. JetBrains Research showed this halves per-instance cost while matching or exceeding LLM-summarization solve rates on SWE-bench Verified. A hybrid approach (masking + selective summarization) yields an additional 7-11% savings.

**Evidence:** ~50% cost reduction per instance. Matches LLM-summarization solve rate across 5 model configurations on SWE-bench Verified. NeurIPS 2025 DL4Code Workshop. Grade: **[strong]**

**Quality impact:** Quality-neutral. "Simple observation masking is as efficient as LLM summarization" is the paper's core finding.

**Implementation reference:** [JetBrains-Research/the-complexity-trap](https://github.com/JetBrains-Research/the-complexity-trap) — configs in `config/`, notebooks for reproduction. Paper: [arxiv.org/abs/2508.21433](https://arxiv.org/abs/2508.21433)

**Maps to our system:** The existing `HistoryReducer` in `src/core/llm/history-reducer.ts` preserves recent N turns and summarizes the rest. The improvement: apply observation-only masking — keep all agent action/reasoning turns but aggressively truncate old `pairRole === 'result'` messages. The `preserveRecentRawTurns` knob already exists. For CLI dispatch, mask verbose subprocess stdout before the structured `BEGIN_DISPATCH_RESULT` block is extracted.

**Priority: P0** — High savings (50%), strong evidence, directly extends existing code, zero quality risk when tuned.

---

### new: Tool-Result Offloading to Filesystem

**What:** When a tool invocation returns a response exceeding a token threshold (e.g., 20K tokens), write the full response to a temporary file and replace it in context with a file-path reference plus a short preview (~10 lines). The agent can re-read the file if needed. Prevents a single large tool result from consuming the entire context window.

**Evidence:** Prevents catastrophic context blowout. Tool results often comprise 60-80% of context in code-heavy agents. Grade: **[medium]** — production implementations exist (LangChain Deep Agents, Google ADK), no rigorous A/B benchmark.

**Quality impact:** Minor risk if agent needs offloaded details but doesn't re-read. Mitigated by meaningful preview.

**Implementation reference:** [Google ADK context compaction](https://google.github.io/adk-docs/context/compaction/) — `LlmEventSummarizer` with configurable `overlap_size`. [google/adk-python](https://github.com/google/adk-python). [LangChain deep agents blog](https://blog.langchain.com/context-management-for-deepagents/)

**Maps to our system:** Before injecting a tool result into orchestrator context, check its size. If above threshold, write to `.spec/tmp/` and substitute reference + preview. The `HistoryReducer.buildSummary()` already clips tool outcomes to 120 chars (line 64) — this formalizes that into a file-backed approach for the pre-reduction stage.

**Priority: P0** — Prevents worst-case context blowouts, straightforward to implement, low quality risk.

---

### gap: Structured Output Contracts (Tighten)

**What:** Constrain subagent output to strict JSON schema. Eliminates parsing ambiguity, reduces wasted output tokens on prose/explanation. Reduces output token count by 30-60% vs. free-form responses.

**Evidence:** 30-60% output token reduction (practitioner reports comparing structured vs. free-form). [JSONSchemaBench](https://arxiv.org/abs/2501.10868). Grade: **[medium]**

**Quality impact:** Positive for dispatch output parsing — the subagent cannot produce malformed output.

**Implementation reference:** [guidance-ai/jsonschemabench](https://github.com/guidance-ai/jsonschemabench). [Awesome-LLM-Constrained-Decoding](https://github.com/Saibo-creator/Awesome-LLM-Constrained-Decoding)

**Maps to our system:** Already partially implemented — `ImplementerResult` and `ReviewerResult` interfaces with `BEGIN_DISPATCH_RESULT`/`END_DISPATCH_RESULT` delimiters. Tighten by: (1) pushing JSON schema into the dispatch prompt more aggressively via `SchemaRegistry`; (2) using `--output-format json` CLI flags where available; (3) adding explicit "no prose outside the JSON block" instructions to dispatch prompts.

**Priority: P0** — Already partially implemented, incremental improvements are low-risk and high-value.

---

### gap: Provider-Aware Prompt Ordering (Indirect Cache Influence)

**What:** Structure the prompts the orchestrator compiles for CLI subagents so stable content (steering docs, spec content, tool schemas) always comes first and task-specific instructions come last. The subagent receives this as its input. When it forwards the content to its LLM provider, the stable prefix maximizes provider-side KV-cache hits. Common anti-patterns: timestamps, run IDs, or per-dispatch metadata at the start of the prompt.

**Evidence:** Anthropic: 90% input cost reduction on cached prefixes. OpenAI: 50% input cost reduction on automatic prefix matching. llm-d benchmarks: 57x faster response, 2x throughput with cache-aware ordering. Grade: **[strong]** on provider pricing; **[indirect]** on CLI subagent path since the orchestrator influences but doesn't guarantee cache behavior.

**Quality impact:** Quality-neutral. Purely a prompt ordering strategy — same content, different order.

**Implementation reference:** [Anthropic prompt caching docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching). [llm-d KV cache blog](https://llm-d.ai/blog/kvcache-wins-you-can-see). [LMCache tech report](https://lmcache.ai/tech_report.pdf). Already in codebase: `src/core/llm/prompt-prefix-compiler.ts`.

**Maps to our system:** The `PromptPrefixCompiler` already splits stable prefix from dynamic tail with `dynamicTailMessages: 2`. Audit `compile_prompt` to ensure: (1) steering docs and spec content always first, never include per-dispatch dynamic data; (2) task-specific instructions always last. When the subagent receives this and forwards to its provider, a long stable prefix = higher cache hit probability. The savings are indirect — the orchestrator can't guarantee the subagent preserves prompt ordering — but in practice CLI agents (claude, codex) pass system prompts through to the provider.

**Priority: P0** — Zero implementation cost (audit + reorder). Savings are indirect but compound across every dispatch in a spec workflow.

---

## P1 — Near-Term

---

### new: ACON (Agent Context Optimization for Long-Horizon Agents)

**What:** Unified framework compressing both environment observations and interaction histories for 15+ step agents. Uses natural-language "compression guidelines" optimized by analyzing failure cases. Can distill compression strategy into smaller models preserving 95% accuracy.

**Evidence:** 26-54% peak token reduction. 95% accuracy in distilled compressors. Up to 46% performance improvement for smaller LMs. AppWorld, OfficeBench, Multi-objective QA. October 2025. Grade: **[medium]**

**Quality impact:** Quality-neutral to quality-positive. Guidelines are optimized to avoid quality-breaking compression.

**Implementation reference:** Paper: [arxiv.org/abs/2510.00615](https://arxiv.org/abs/2510.00615). No public repo yet.

**Maps to our system:** Directly addresses multi-step dispatch. The `StateProjector` and `StateSnapshotFact` types already provide a factual state abstraction that aligns with ACON's approach. The `ingest_output` action could use learned compression guidelines to decide what to keep vs. compress from each dispatch cycle's results before the next dispatch.

**Priority: P1** — 26-54% savings compound across steps. Requires adapting concepts (no public code).

---

### new: Magentic-One Task Ledger Pattern

**What:** Microsoft's Magentic-One maintains two compact ledgers: a Task Ledger (facts, guesses, plan) and a Progress Ledger (self-reflection on completion status). The Orchestrator consults these instead of full conversation history to decide next actions and what to pass to subagents.

**Evidence:** Competitive with GPT-4o on GAIA, AssistantBench, WebArena. Token savings not separately quantified. Grade: **[medium]** on architecture; **[weak]** on token efficiency specifically.

**Quality impact:** Positive — self-reflection catches errors and stalls.

**Implementation reference:** Part of AutoGen: [microsoft/autogen magentic-one guide](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html)

**Maps to our system:** The spec's `tasks.md` with `[ ]/[-]/[x]` markers is already a progress ledger. `StateSnapshotFact` entries are a task ledger. Gap: the orchestrator may re-read and re-process full spec files on each dispatch rather than working from compact ledger state. Formalize fact/progress extraction to reduce per-dispatch prompt size.

**Priority: P1** — Proven pattern, maps directly to existing spec workflow. Incremental to implement.

---

### new: Agentic Plan Caching

**What:** Extracts reusable plan templates from successful agent trajectories. When a semantically similar task arrives, the cached plan is adapted using a lightweight model instead of invoking the expensive planner from scratch. Uses keyword extraction for matching.

**Evidence:** 50.31% cost reduction, 27.28% latency reduction. 96.61% of optimal performance. NeurIPS 2025, evaluated on 5 diverse agent workloads. Grade: **[strong]**

**Quality impact:** 3.4% performance degradation measured. Acceptable for non-critical tasks.

**Implementation reference:** [arxiv.org/abs/2506.14852](https://arxiv.org/abs/2506.14852). No public GitHub repo.

**Maps to our system:** Many implementation tasks follow similar patterns ("implement a new MCP tool", "add a test file"). A plan cache could store successful dispatch sequences (which CLI agent, what prompt, what structured output) and replay/adapt them. The `RuntimeSnapshotStore` already stores snapshots — extending it with similarity-matched templates is architecturally natural.

**Priority: P1** — Strong evidence, meaningful savings. Non-trivial implementation (similarity matching, template extraction).

---

### new: Selective Tool Provision

**What:** Instead of providing all available MCP tools to the host agent in every call, dynamically select only relevant tools for the current workflow phase. The "Less-is-More" paper shows reducing the tool set via filtering improves both accuracy and token efficiency.

**Evidence:** Up to 70% execution time reduction, 40% power/cost reduction. Improved agentic success rates (not just neutral). DATE 2025. Grade: **[medium]**

**Quality impact:** Positive — fewer tools means less confusion, better tool selection accuracy.

**Implementation reference:** [arxiv.org/abs/2411.15399](https://arxiv.org/abs/2411.15399). Also: [guidance-ai/llguidance](https://github.com/guidance-ai/llguidance)

**Maps to our system:** The MCP server exposes all tools via `src/tools/index.ts` and `src/tools/registry.ts`. Implement selective exposure based on workflow phase: during implementation, only expose `get-implementer-guide`, `dispatch-runtime`, `spec-status`; hide brainstorm/steering tools. The `DispatchRole` and workflow phase can drive filtering. This reduces the tool schema payload in the host agent's context on every turn.

**Priority: P1** — Straightforward via existing tool registry. Reduces host agent prompt size, actually improves quality.

---

### gap: CLI Agent Routing by Task Complexity

**What:** Route tasks to the cheapest CLI agent that can handle them. Simple tasks (test stubs, file moves, doc updates) go to cheaper agents; complex tasks (architectural implementation, multi-file refactors) go to stronger agents. Combines insights from RouteLLM, BudgetMLAgent, and Efficient Agents research.

**Evidence:** RouteLLM: 85% cost reduction on MT-Bench retaining 95% quality. BudgetMLAgent: 94.2% cost reduction ($0.931→$0.054/run). Efficient Agents: 96.7% baseline performance at 43% cost reduction. Grade: **[strong]** on the routing concept; **[medium]** on applicability to CLI agent granularity (research is per-model, not per-CLI-tool).

**Quality impact:** 5% quality degradation at 95th-percentile target (RouteLLM). Cascade failures can compound in multi-step coding.

**Implementation reference:** [lm-sys/RouteLLM](https://github.com/lm-sys/RouteLLM). [arxiv.org/abs/2411.07464](https://arxiv.org/abs/2411.07464) (BudgetMLAgent). [arxiv.org/abs/2508.02694](https://arxiv.org/abs/2508.02694) (Efficient Agents).

**Maps to our system:** The orchestrator dispatches to multiple CLI agents backed by different models at different costs (claude=Sonnet/Opus, codex=GPT-4, gemini=Gemini, opencode=various). `BudgetGuard` already implements cascading with `emergencyModelId` and `allowEmergencyDegrade`. Improvement: make this proactive — add a task-complexity classifier that drives CLI agent selection at `init_run` time.

**Priority: P1** — Infrastructure exists in `BudgetGuard`. Missing piece: task-complexity classifier.

---

### new: Tool-Result Caching for MCP Operations

**What:** Cache results of deterministic MCP tool calls (file reads, spec status lookups, steering doc loads) using content-addressable hashing. Repeated invocations with same inputs return cached results without re-execution.

**Evidence:** MCP documentation recommends caching expensive query results. Savings depend on call frequency. Grade: **[weak]** published; **[strong]** engineering common sense.

**Quality impact:** Quality-neutral with content-hash matching and file-mtime TTL invalidation.

**Implementation reference:** [MCP tools spec](https://modelcontextprotocol.io/specification/2025-06-18/server/tools). Relevant: `src/tools/workflow/steering-loader.ts`.

**Maps to our system:** Tools like `spec-status`, `get-implementer-guide`, `get-reviewer-guide`, `steering-guide` all read files from disk and return text. Adding TTL-based in-memory cache (keyed on file path + mtime) eliminates redundant I/O and — more importantly — reduces token volume sent through MCP to the host agent, since tool results become part of the host agent's context window.

**Priority: P1** — Low effort (simple mtime cache), directly reduces host agent context consumption.

---

### gap: Context Compaction (Pre-Dispatch)

**What:** When context reaches a threshold (60-95% of window), summarize into compact form before dispatching. Key insight from 2025: aggressive early compaction preserves more working memory and improves quality vs. late compaction. CLI agents implement their own compaction internally, but orchestrator-side pre-compaction prevents subagents from losing orchestrator-injected rules during their internal compaction.

**Evidence:** 25-50% typical flow reduction with dispatch-runtime v2. Known issues in CLI agents: "agent loses rules after compaction" (OpenCode #3099), "compaction loses important context" (#4102). Grade: **[medium]**

**Quality impact:** Documented regressions when CLI agents compact internally. Orchestrator-side pre-compaction mitigates this by sending focused, already-compact prompts.

**Implementation reference:** [sst/opencode](https://github.com/sst/opencode). [Anthropic cookbook](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)

**Maps to our system:** The `compile_prompt` action with stable prefix + dynamic tail already does partial pre-compaction. Further: ensure the orchestrator sends the minimum viable context per dispatch so the subagent's context never needs internal compaction. This means the orchestrator does the summarization work (via `HistoryReducer` / observation masking) rather than trusting the subagent to do it.

**Priority: P1** — Partially addressed by dispatch-runtime v2. Key value: prevents subagents from losing orchestrator-injected instructions during their own internal compaction.

---

## P2 — Future / Evaluate Later

---

### new: Zep/Graphiti (Temporal Knowledge Graph Memory)

**What:** Extracts atomic facts and entity relationships from conversations into a temporal knowledge graph. Retrieves only relevant facts for the current query instead of replaying full history. Achieves 90% token reduction (1.8K vs 26K tokens) with 94.8% accuracy on Deep Memory Retrieval.

**Evidence:** 94.8% DMR accuracy (vs. MemGPT 93.4%). +18.5% accuracy on LongMemEval with 90% latency reduction. January 2025. Grade: **[medium]** — strong benchmarks but self-reported by Zep team.

**Quality impact:** Quality-positive on memory retrieval. Temporal awareness prevents stale fact retrieval.

**Implementation reference:** [getzep/graphiti](https://github.com/getzep/graphiti). Paper: [arxiv.org/abs/2501.13956](https://arxiv.org/abs/2501.13956)

**Maps to our system:** `StateSnapshotFact` already provides a factual state abstraction. Graphiti could maintain a knowledge graph of facts across dispatch cycles (what files changed, what tests passed/failed, what design decisions were made). The `get_snapshot` action could be backed by a fact graph instead of flat state. High potential for long-running multi-task sessions.

**Priority: P2** — High savings (90% on long conversations) but adds graph database infrastructure.

---

### new: LLM Cascade with Re-Dispatch (C3PO-Inspired)

**What:** Dispatch to a cheaper CLI agent first. Validate the structured output against spec/tests. If the result is incomplete or fails validation, re-dispatch to a stronger CLI agent. Uses the structured dispatch contract to make the validate-and-escalate decision deterministic.

**Evidence:** C3PO: <20% cost of strongest model with ≤2% accuracy gap across 16 reasoning benchmarks. NeurIPS 2025. Grade: **[strong]** on the cascade concept; **[medium]** on applying it to full CLI subprocess dispatches (each dispatch is a heavyweight operation, not a cheap API call).

**Quality impact:** Bounded 2-10% accuracy gap (configurable). Main risk: two full subprocess invocations on escalation adds latency.

**Implementation reference:** [AntonValk/C3PO-LLM](https://github.com/AntonValk/C3PO-LLM). Paper: [arxiv.org/abs/2511.07396](https://arxiv.org/abs/2511.07396). Also: [automix-llm/automix](https://github.com/automix-llm/automix)

**Maps to our system:** The `ingest_output` action already validates structured results. Extend it with a re-dispatch path: if validation fails or the result is low-quality, re-dispatch to a stronger CLI agent with the original task + the failed attempt as context. The dispatch contract makes this decision deterministic.

**Priority: P2** — Strong concept but each CLI dispatch is heavyweight (full subprocess). Latency cost of re-dispatch may outweigh token savings. Better after P1 routing classifier reduces the need for escalation.

---

### new: DSPy Prompt Template Optimization

**What:** DSPy treats prompts as compiled programs. Optimizers (MIPROv2, GEPA) find minimal, high-quality prompts through systematic search. Can automatically shrink verbose instruction templates while preserving task performance.

**Evidence:** GEPA (July 2025) outperforms human-engineered prompts. Grade: **[strong]** on quality; **[medium]** on token efficiency (savings not always quantified separately).

**Quality impact:** Quality-positive. Optimization explicitly maximizes a quality metric.

**Implementation reference:** [stanfordnlp/dspy](https://github.com/stanfordnlp/dspy). [dspy.ai/learn/optimization/optimizers](https://dspy.ai/learn/optimization/optimizers/)

**Maps to our system:** Optimize the dispatch prompt templates in `PromptTemplateRegistry` — the instructions the orchestrator compiles for CLI subagents. DSPy could find shorter, more effective phrasings for the implementer/reviewer system prompts. Requires setting up a DSPy evaluation pipeline with spec-workflow metrics.

**Priority: P2** — High potential for shrinking dispatch prompt templates. Requires non-trivial evaluation pipeline setup. Best applied to the most frequently dispatched templates first.

---

### gap: Semantic Caching (Exact-Match Only)

**What:** Cache deterministic dispatch results by exact content hash. When the orchestrator would dispatch the same prompt to the same CLI agent, return the cached result. NOT semantic/embedding similarity — only exact-match to avoid correctness risks.

**Evidence:** Up to 100% savings on cache hits. Practical hit rates: 10-40% depending on workload repetitiveness. Grade: **[medium]**

**Quality impact:** Quality-neutral for exact-match. Zero risk of returning wrong cached results.

**Implementation reference:** [zilliztech/GPTCache](https://github.com/zilliztech/GPTCache) (exact-match mode). [BerriAI/litellm](https://github.com/BerriAI/litellm) (exact-match caching).

**Maps to our system:** Limited applicability — dispatch prompts rarely repeat exactly (task IDs, timestamps, state snapshots differ). The main use case: if the orchestrator re-dispatches after a transient failure with the same prompt, skip the dispatch. The `PromptPrefixCompiler` already computes `cacheKey` from prompt content — this could gate dispatch deduplication.

**Priority: P2** — Low hit rate expected for dispatch tasks. Main value is deduplication on retry/re-dispatch.

---

## Implementation Roadmap

### Phase 1 — Immediate (P0, this sprint)

| Action | Files to change | Expected savings |
|--------|----------------|-----------------|
| Observation masking: aggressively truncate old `pairRole === 'result'` messages, keep action history | `src/core/llm/history-reducer.ts` | ~50% context reduction |
| Tool-result size gate: offload >N char results to `.spec/tmp/`, inject reference + preview | `src/tools/workflow/dispatch-runtime.ts` | Prevents blowouts |
| Tighten structured output: add "no prose outside JSON" instructions, use `--output-format json` flags | Dispatch prompt templates, `SchemaRegistry` | 30-60% output reduction |
| Prompt prefix stability: ensure `compile_prompt` produces stable prefix (steering/spec first, task last) across dispatches | `src/core/llm/prompt-prefix-compiler.ts`, dispatch templates | Indirect — maximizes subagent provider cache hits |

**Combined P0 estimate: 50-70% reduction on typical dispatch cycles with zero quality risk.**

### Phase 2 — Near-Term (P1, next sprint)

| Action | Expected savings |
|--------|-----------------|
| Task Ledger / Progress Ledger formalization from spec files | Reduces per-dispatch prompt size |
| Selective tool provision by workflow phase | 40% exec time reduction |
| MCP tool-result caching (mtime-based) | Eliminates redundant host-agent context |
| CLI agent routing with task-complexity classifier | Up to 94% on simple tasks |
| Orchestrator-side pre-compaction before dispatch | Prevents subagent internal compaction losing rules |
| ACON-style compression guidelines for cross-dispatch state | 26-54% across multi-step flows |

### Phase 3 — Future (P2, evaluate)

| Technique | Gate condition |
|-----------|---------------|
| Zep/Graphiti knowledge graph | Long-running sessions with many dispatch cycles |
| C3PO-inspired re-dispatch cascade | Dispatch volume justifies calibration effort |
| DSPy prompt template optimization | High-frequency templates identified |
| Exact-match dispatch deduplication | Retry/re-dispatch patterns observed in telemetry |

---

## Sources

### Papers
- [Observation Masking / Complexity Trap (NeurIPS 2025)](https://arxiv.org/abs/2508.21433)
- [ACON Context Optimization (Oct 2025)](https://arxiv.org/abs/2510.00615)
- [Agentic Plan Caching (NeurIPS 2025)](https://arxiv.org/abs/2506.14852)
- [C3PO Cascading (NeurIPS 2025)](https://arxiv.org/abs/2511.07396)
- [BudgetMLAgent](https://arxiv.org/abs/2411.07464)
- [Efficient Agents](https://arxiv.org/abs/2508.02694)
- [FrugalGPT](https://arxiv.org/abs/2305.05176)
- [RouteLLM (LMSYS)](https://lmsys.org/blog/2024-07-01-routellm/)
- [JSONSchemaBench](https://arxiv.org/abs/2501.10868)
- [Less-is-More Tool Selection (DATE 2025)](https://arxiv.org/abs/2411.15399)
- [Zep Temporal KG](https://arxiv.org/abs/2501.13956)
- [Prompt Compression Survey (NAACL 2025)](https://arxiv.org/abs/2410.12388)

### GitHub Repos
- [JetBrains-Research/the-complexity-trap](https://github.com/JetBrains-Research/the-complexity-trap)
- [lm-sys/RouteLLM](https://github.com/lm-sys/RouteLLM)
- [AntonValk/C3PO-LLM](https://github.com/AntonValk/C3PO-LLM)
- [automix-llm/automix](https://github.com/automix-llm/automix)
- [getzep/graphiti](https://github.com/getzep/graphiti)
- [stanfordnlp/dspy](https://github.com/stanfordnlp/dspy)
- [guidance-ai/jsonschemabench](https://github.com/guidance-ai/jsonschemabench)
- [Saibo-creator/Awesome-LLM-Constrained-Decoding](https://github.com/Saibo-creator/Awesome-LLM-Constrained-Decoding)
- [google/adk-python](https://github.com/google/adk-python)
- [sst/opencode](https://github.com/sst/opencode)

### Provider Docs
- [Anthropic Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [OpenAI Prompt Caching](https://platform.openai.com/docs/guides/prompt-caching)
- [MCP Tools Specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [Google ADK Context Compaction](https://google.github.io/adk-docs/context/compaction/)

### Practitioner Reports
- [LangChain Deep Agents Context Management](https://blog.langchain.com/context-management-for-deepagents/)
- [JetBrains Research Blog](https://blog.jetbrains.com/research/2025/12/efficient-context-management/)
- [llm-d KV Cache Blog](https://llm-d.ai/blog/kvcache-wins-you-can-see)
- [LMCache Tech Report](https://lmcache.ai/tech_report.pdf)
