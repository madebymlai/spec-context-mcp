# Token Efficiency & Prompt Power: Research Findings

**Date:** 2026-02-06
**Scope:** CLI orchestrator + CLI subagent dispatch (spec-context-mcp)
**Architecture:** MCP server compiles prompts → dispatches CLI subprocesses (claude, codex, opencode, gemini) → parses structured output
**Evidence grading:** [strong] = peer-reviewed + reproduced benchmarks; [medium] = paper + self-reported; [weak] = blog/docs claims

## 5 Independent Dimensions of Savings

| # | Dimension | What it reduces | Additive? |
|---|-----------|----------------|-----------|
| 1 | Shrink accumulated context | Orchestrator context that grows between dispatches | Independent |
| 2 | Shrink dispatch prompts | Prompt payload assembled per dispatch | Independent |
| 3 | Shrink subagent output | Tokens the subagent emits back | Independent |
| 4 | Route to cheaper agents | Cost per token (same tokens, lower price) | Independent |
| 5 | Avoid calls entirely | Eliminate dispatches and tool calls | Independent |

These compound multiplicatively. Within each dimension, techniques have diminishing returns.

---

## Dimension 1: Shrink Accumulated Context

**The problem:** The orchestrator's context grows across dispatch cycles as tool results, subprocess output, and state accumulate. This is the single largest token consumer.

### Start here: Observation Masking (Sliding Window) — P0 [OK]

**What:** Mask/truncate old environment observations (tool outputs, file contents, subprocess stdout) while preserving the agent's full action and reasoning history. JetBrains Research showed this halves per-instance cost while matching LLM-summarization solve rates on SWE-bench Verified.

**Evidence:** ~50% cost reduction per instance. Quality-neutral across 5 model configurations. NeurIPS 2025 DL4Code Workshop. Grade: **[strong]**

**Implementation reference:** [JetBrains-Research/the-complexity-trap](https://github.com/JetBrains-Research/the-complexity-trap). Paper: [arxiv.org/abs/2508.21433](https://arxiv.org/abs/2508.21433)

**Maps to our system:** Refine `HistoryReducer` in `src/core/llm/history-reducer.ts` to apply observation-only masking — keep all agent action/reasoning turns but aggressively truncate old `pairRole === 'result'` messages. The `preserveRecentRawTurns` knob already exists. For CLI dispatch, mask verbose subprocess stdout before the structured `BEGIN_DISPATCH_RESULT` block is extracted.

### Then evaluate: Tool-Result Offloading to Filesystem — P0 [OK]

**What:** When a tool result exceeds a size threshold (e.g., 20K chars), write it to a temporary file and replace in context with a file-path reference plus a short preview (~10 lines). Prevents a single large result from consuming the entire context window.

**Evidence:** Prevents catastrophic context blowout. Tool results often comprise 60-80% of context. Grade: **[medium]** — production implementations exist (LangChain Deep Agents, Google ADK).

**Implementation reference:** [Google ADK context compaction](https://google.github.io/adk-docs/context/compaction/). [google/adk-python](https://github.com/google/adk-python). [LangChain deep agents blog](https://blog.langchain.com/context-management-for-deepagents/)

**Maps to our system:** Before injecting a tool result into orchestrator context, check its size. If above threshold, write to `.spec/tmp/` and substitute reference + preview. Complements observation masking — offloading handles the size problem at ingestion time; masking handles it across dispatch cycles.

**Relationship to observation masking:** These are complementary, not competing. Offloading gates large results at the point of entry. Masking handles the long tail of accumulated normal-sized results. Implement both — offloading first (prevents blowouts), masking second (steady-state compression).

### Later if needed: ACON Compression Guidelines — P1

**What:** A framework that optimizes natural-language "compression guidelines" by analyzing failure cases where compressed context led to errors. Can distill the strategy into smaller models preserving 95% accuracy. Subsumes observation masking with a more sophisticated, learned selection strategy.

**Evidence:** 26-54% peak token reduction. 95% accuracy in distilled compressors. October 2025. Grade: **[medium]** — no public code yet.

**Implementation reference:** Paper: [arxiv.org/abs/2510.00615](https://arxiv.org/abs/2510.00615).

**Maps to our system:** The `StateProjector` and `StateSnapshotFact` types align with ACON's factual state abstraction. The `ingest_output` action could use learned compression guidelines. Only worth pursuing if observation masking + offloading prove insufficient — ACON adds complexity for marginal gains on top of the simpler techniques.

**Relationship to observation masking:** ACON subsumes observation masking. If you implement ACON fully, observation masking becomes redundant. Start with masking (simple, proven, free); graduate to ACON only if the orchestrator handles long-horizon tasks (15+ dispatch cycles) where masking alone loses important context.

### Later if needed: Context Compaction (Pre-Dispatch) — P1 [OK]

**What:** Summarize orchestrator context into compact form before dispatching to subagent. Key insight: aggressive early compaction preserves more working memory than late compaction. Prevents subagents from losing orchestrator-injected rules during their own internal compaction.

**Evidence:** 25-50% typical flow reduction. Known issues when CLI agents compact internally: "agent loses rules after compaction" (OpenCode #3099). Grade: **[medium]**

**Implementation reference:** [sst/opencode](https://github.com/sst/opencode).

**Maps to our system:** The `compile_prompt` action already does partial pre-compaction via stable prefix + dynamic tail. The key value is defensive: ensure the orchestrator sends minimum viable context so subagents never trigger their own internal compaction, which may lose orchestrator instructions.

**Relationship to observation masking:** Pre-dispatch compaction is the umbrella; observation masking is the specific technique within it. If masking + offloading keep the dispatch prompt small enough that subagents don't trigger internal compaction, explicit pre-compaction adds nothing.

### Dimension 1 summary

**Implement:** Observation masking (P0) + tool-result offloading (P0).
**Evaluate later:** ACON (if 15+ step flows need smarter compression), pre-dispatch compaction (if subagents still trigger internal compaction despite masking).
**Expected savings:** ~50% context reduction from masking, blowout prevention from offloading. ACON/compaction add marginal gains on top.

---

## Dimension 2: Shrink Dispatch Prompts

**The problem:** Each dispatch compiles a prompt containing steering docs, spec content, tool schemas, and task instructions. Much of this is redundant across dispatches or unnecessarily verbose.

### Start here: Provider-Aware Prompt Ordering — P0 [OK]

**What:** Structure compiled prompts so stable content (steering docs, spec content) always comes first and task-specific instructions come last. The subagent forwards this to its LLM provider, where a stable prefix maximizes provider-side KV-cache hits. Not a size reduction — a reordering that makes every other technique more effective.

**Evidence:** Anthropic: 90% input cost reduction on cached prefixes. OpenAI: 50% automatic prefix discount. Grade: **[strong]** on provider pricing; **[indirect]** on CLI subagent path.

**Implementation reference:** [Anthropic prompt caching docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching). [llm-d KV cache blog](https://llm-d.ai/blog/kvcache-wins-you-can-see). Already in codebase: `src/core/llm/prompt-prefix-compiler.ts`.

**Maps to our system:** Audit `compile_prompt` to ensure: (1) steering docs and spec content always first, no per-dispatch dynamic data (timestamps, run IDs) in the prefix; (2) task-specific instructions always last. The `PromptPrefixCompiler` with `stablePrefixHash`/`dynamicTailHash` split is the right pattern. Zero implementation cost — just an ordering audit.

### Then: Magentic-One Task Ledger Pattern — P1 [OK]

**What:** Maintain two compact ledgers — Task Ledger (facts, decisions, plan) and Progress Ledger (completion status per task) — instead of replaying full spec files on each dispatch. The orchestrator consults these ledgers to assemble focused dispatch prompts.

**Evidence:** Competitive with GPT-4o on GAIA, AssistantBench, WebArena. Token savings not separately quantified. Grade: **[medium]** on architecture; **[weak]** on token efficiency.

**Implementation reference:** Part of AutoGen: [microsoft/autogen magentic-one](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html)

**Maps to our system:** The spec's `tasks.md` with `[ ]/[-]/[x]` markers is already a progress ledger. `StateSnapshotFact` entries are a task ledger. Gap: the orchestrator re-reads full spec files on each dispatch. Formalize fact/progress extraction so dispatches work from compact ledger state, not raw file content.

### Then: Selective Tool Provision — P1 [OK]

**What:** Expose only relevant MCP tools for the current workflow phase instead of all tools on every call. Fewer tool schemas = smaller host agent prompt. The "Less-is-More" paper shows this also improves accuracy.

**Evidence:** Up to 70% execution time reduction, 40% power/cost reduction. Improved success rates. DATE 2025. Grade: **[medium]**

**Implementation reference:** [arxiv.org/abs/2411.15399](https://arxiv.org/abs/2411.15399). [guidance-ai/llguidance](https://github.com/guidance-ai/llguidance)

**Maps to our system:** The MCP server exposes all tools via `src/tools/index.ts` and `src/tools/registry.ts`. Filter by workflow phase: during implementation, expose only `get-implementer-guide`, `dispatch-runtime`, `spec-status`; hide brainstorm/steering tools. The `DispatchRole` and workflow phase drive filtering.

### Dimension 2 summary

**Implement:** Prompt ordering audit (P0, zero cost) → ledger pattern (P1, reduces spec content in prompts) → selective tools (P1, reduces tool schema payload).
**These are additive within the dimension** — they shrink different portions of the dispatch prompt (ordering affects cache behavior, ledger reduces spec content, tool provision reduces schema payload).
**Expected savings:** Prompt ordering is indirect (cache multiplier). Ledger + selective tools combined could cut dispatch prompt size 30-50% by eliminating redundant spec content and unused tool schemas.

---

## Dimension 3: Shrink Subagent Output

**The problem:** CLI subagents emit verbose output — prose explanations, reasoning traces, formatting — on top of the structured result the orchestrator actually needs.

### Start here: Structured Output Contracts (Tighten) — P0 [OK]

**What:** Constrain subagent output to strict JSON schema. Eliminates wasted output tokens on prose/explanation. The subagent emits only the structured `BEGIN_DISPATCH_RESULT`...`END_DISPATCH_RESULT` block with no surrounding prose.

**Evidence:** 30-60% output token reduction vs. free-form. Grade: **[medium]**

**Implementation reference:** [guidance-ai/jsonschemabench](https://github.com/guidance-ai/jsonschemabench). [JSONSchemaBench paper](https://arxiv.org/abs/2501.10868). [Awesome-LLM-Constrained-Decoding](https://github.com/Saibo-creator/Awesome-LLM-Constrained-Decoding)

**Maps to our system:** Already partially implemented — `ImplementerResult` and `ReviewerResult` interfaces with delimiters. Tighten by: (1) pushing JSON schema into dispatch prompt more aggressively via `SchemaRegistry`; (2) using `--output-format json` CLI flags where available; (3) adding explicit "no prose outside the JSON block" instructions to dispatch prompts.

### Later if needed: DSPy Prompt Template Optimization — P2

**What:** DSPy optimizers (MIPROv2, GEPA) can automatically find shorter, more effective instruction phrasings for the implementer/reviewer system prompts. This indirectly reduces subagent output by giving crisper instructions that elicit more focused responses.

**Evidence:** GEPA (July 2025) outperforms human-engineered prompts. Grade: **[strong]** on quality; **[medium]** on token efficiency.

**Implementation reference:** [stanfordnlp/dspy](https://github.com/stanfordnlp/dspy). [dspy.ai/learn/optimization/optimizers](https://dspy.ai/learn/optimization/optimizers/)

**Maps to our system:** Optimize dispatch prompt templates in `PromptTemplateRegistry`. Requires DSPy evaluation pipeline with spec-workflow metrics. High setup cost.

### Dimension 3 summary

**Implement:** Tighten structured output contracts (P0).
**Evaluate later:** DSPy template optimization (P2, high setup cost for incremental gains).
**Expected savings:** 30-60% output token reduction from tighter contracts. This is fully additive to all other dimensions since it reduces a different token pool (subagent output vs. orchestrator context/prompts).

---

## Dimension 4: Route to Cheaper Agents

**The problem:** The orchestrator dispatches all tasks to the same CLI agent regardless of complexity. Simple tasks (test stubs, file moves, doc updates) don't need expensive models.

### Start here: CLI Agent Routing by Task Complexity — P1

**What:** Route tasks to the cheapest CLI agent that can handle them. Simple tasks go to cheaper agents (codex, opencode with smaller models); complex tasks go to stronger agents (claude with Opus/Sonnet). Uses task-complexity classification at dispatch time.

**Evidence:** RouteLLM: 85% cost reduction retaining 95% quality. BudgetMLAgent: 94.2% cost reduction. Efficient Agents: 96.7% performance at 43% cost reduction. Grade: **[strong]** on the routing concept; **[medium]** on CLI agent granularity.

**Implementation reference:** [lm-sys/RouteLLM](https://github.com/lm-sys/RouteLLM). [arxiv.org/abs/2411.07464](https://arxiv.org/abs/2411.07464). [arxiv.org/abs/2508.02694](https://arxiv.org/abs/2508.02694).

**Maps to our system:** `BudgetGuard` already implements cascading with `emergencyModelId` and `allowEmergencyDegrade`. Improvement: make proactive — add a task-complexity classifier at `init_run` that drives CLI agent selection based on task description, file count, and estimated scope.

### Later if needed: C3PO-Inspired Re-Dispatch Cascade — P2

**What:** Dispatch to a cheaper CLI agent first. Validate structured output against spec/tests. If it fails, re-dispatch to a stronger agent with the original task + failed attempt as context.

**Evidence:** C3PO: <20% cost with ≤2% accuracy gap. NeurIPS 2025. Grade: **[strong]** on concept; **[medium]** on CLI dispatch (each dispatch is heavyweight).

**Implementation reference:** [AntonValk/C3PO-LLM](https://github.com/AntonValk/C3PO-LLM). [arxiv.org/abs/2511.07396](https://arxiv.org/abs/2511.07396).

**Maps to our system:** `ingest_output` already validates structured results. Extend with a re-dispatch path on validation failure. Main risk: two full subprocess invocations doubles latency on escalation.

**Relationship to routing:** These are sequential, not competing. Routing (P1) reduces the need for cascading by getting the agent selection right the first time. Cascading (P2) is the safety net when routing gets it wrong. Implement routing first; add cascading only if routing misclassifies often enough to justify the re-dispatch overhead.

### Dimension 4 summary

**Implement:** Task-complexity classifier for CLI agent routing (P1).
**Evaluate later:** Re-dispatch cascade (P2, only if routing misclassifies often).
**Expected savings:** Up to 85-94% cost reduction on simple tasks routed to cheaper agents. Fully additive to all other dimensions — reduces cost per token, not token count.

---

## Dimension 5: Avoid Calls Entirely

**The problem:** The orchestrator makes redundant dispatches and MCP tool calls that could be skipped.

### Start here: Tool-Result Caching for MCP Operations — P1

**What:** Cache results of deterministic MCP tool calls (file reads, spec status, steering doc loads) using content-addressable hashing (file path + mtime). Repeated invocations return cached results.

**Evidence:** MCP spec recommends caching. Grade: **[weak]** published; **[strong]** engineering common sense.

**Implementation reference:** [MCP tools spec](https://modelcontextprotocol.io/specification/2025-06-18/server/tools). Relevant: `src/tools/workflow/steering-loader.ts`.

**Maps to our system:** Tools like `spec-status`, `get-implementer-guide`, `get-reviewer-guide` all read files from disk. Add TTL-based in-memory cache keyed on file path + mtime. Reduces token volume sent through MCP to the host agent.

### Then: Agentic Plan Caching — P1

**What:** Cache successful dispatch sequences as reusable plan templates. When a semantically similar task arrives, adapt the cached plan using a lightweight model instead of running the full dispatch from scratch.

**Evidence:** 50.31% cost reduction, 27.28% latency reduction. 96.61% of optimal performance. NeurIPS 2025. Grade: **[strong]**

**Implementation reference:** [arxiv.org/abs/2506.14852](https://arxiv.org/abs/2506.14852). No public GitHub repo.

**Maps to our system:** Many tasks follow similar patterns. The `RuntimeSnapshotStore` already stores snapshots — extend with similarity-matched templates. Non-trivial implementation (keyword extraction, template matching, adaptation).

### Later if needed: Exact-Match Dispatch Deduplication — P2

**What:** If the orchestrator would dispatch the same prompt to the same CLI agent (e.g., retry after transient failure), return the cached result. Exact content hash only — no semantic matching.

**Evidence:** Up to 100% on hits, but low hit rate expected for dispatch tasks. Grade: **[medium]**

**Implementation reference:** [zilliztech/GPTCache](https://github.com/zilliztech/GPTCache) (exact-match mode). `PromptPrefixCompiler` already computes `cacheKey`.

**Maps to our system:** Limited — dispatch prompts rarely repeat exactly. Main value: deduplication on retry/re-dispatch after transient failures.

### Later if needed: Zep/Graphiti Knowledge Graph — P2

**What:** Temporal knowledge graph that extracts facts from dispatch results and retrieves only relevant facts per dispatch instead of replaying full history. 90% token reduction on long conversations.

**Evidence:** 94.8% accuracy, 90% latency reduction. Grade: **[medium]** — self-reported by Zep team.

**Implementation reference:** [getzep/graphiti](https://github.com/getzep/graphiti). [arxiv.org/abs/2501.13956](https://arxiv.org/abs/2501.13956)

**Maps to our system:** `StateSnapshotFact` already provides a factual state abstraction. High potential for long-running multi-task sessions. Adds graph database infrastructure.

**Relationship to other techniques:** Zep/Graphiti is also a Dimension 1 technique (shrinks accumulated context via fact extraction). It spans dimensions — it both avoids redundant lookups and compresses state. Only worth evaluating when sessions regularly exceed 10+ dispatch cycles.

### Dimension 5 summary

**Implement:** MCP tool-result caching (P1, low effort) → plan caching (P1, high impact but non-trivial).
**Evaluate later:** Exact-match dedup (P2, low hit rate), Zep/Graphiti (P2, heavy infrastructure).
**Expected savings:** Tool-result caching eliminates redundant MCP calls. Plan caching can skip entire dispatches (50% cost reduction). Fully additive to all other dimensions.

---

## Implementation Roadmap

### Phase 1 — This Sprint (P0)

| Dimension | Action | Files | Savings |
|-----------|--------|-------|---------|
| 1 - Context | Observation masking: truncate old `pairRole === 'result'` messages | `src/core/llm/history-reducer.ts` | ~50% context |
| 1 - Context | Tool-result size gate: offload large results to `.spec/tmp/` | `src/tools/workflow/dispatch-runtime.ts` | Prevents blowouts |
| 2 - Prompts | Audit `compile_prompt` prefix stability: steering first, task last | `src/core/llm/prompt-prefix-compiler.ts` | Indirect cache multiplier |
| 3 - Output | Tighten structured output: "no prose outside JSON", `--output-format json` | Dispatch templates, `SchemaRegistry` | 30-60% output |

**Combined P0 estimate: 50-70% reduction across context + output with zero quality risk.**

### Phase 2 — Next Sprint (P1)

| Dimension | Action | Savings |
|-----------|--------|---------|
| 2 - Prompts | Task Ledger / Progress Ledger formalization from spec files | Reduces per-dispatch prompt |
| 2 - Prompts | Selective tool provision by workflow phase | Reduces tool schema payload |
| 4 - Routing | Task-complexity classifier for CLI agent selection | Up to 94% cost on simple tasks |
| 5 - Avoidance | MCP tool-result caching (mtime-based) | Eliminates redundant calls |
| 5 - Avoidance | Agentic plan caching for similar task patterns | 50% cost on cached patterns |

### Phase 3 — Evaluate Later (P2)

| Dimension | Technique | Gate condition |
|-----------|-----------|---------------|
| 1 - Context | ACON compression guidelines | 15+ step flows where masking loses context |
| 3 - Output | DSPy prompt template optimization | High-frequency templates identified |
| 4 - Routing | C3PO re-dispatch cascade | Routing misclassifies often enough |
| 5 - Avoidance | Exact-match dispatch dedup | Retry patterns observed in telemetry |
| 1+5 | Zep/Graphiti knowledge graph | Sessions with 10+ dispatch cycles |

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
