# Token Efficiency & Prompt Power: Research Findings

**Date:** 2026-02-06
**Scope:** CLI-dispatch + MCP orchestration (spec-context-mcp)
**Evidence grading:** [strong] = peer-reviewed + reproduced benchmarks; [medium] = paper + self-reported; [weak] = blog/docs claims
**Techniques found:** 24 (12 tagged `new:`, remainder `gap:`)

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

### gap: Provider-Native Prompt Caching (Parity)

**What:** Anthropic, OpenAI, and Google cache KV-state for prompt prefixes server-side. Anthropic uses explicit `cache_control` breakpoints (5min default, 1hr extended TTL); cache reads cost 10% of normal input price. OpenAI does automatic prefix matching at 50% discount for prompts >1024 tokens. When the orchestrator compiles prompts for CLI subagents via `compile_prompt`, the text becomes part of what the subagent sends to its provider. Stable prompt prefixes = provider cache hits on the subagent's API calls.

**Evidence:** Anthropic: 90% input cost reduction, 85% latency reduction on cached prefixes. OpenAI: 50% input cost reduction. Grade: **[strong]** — official provider documentation with pricing.

**Quality impact:** Quality-neutral. Caching is exact-match; output is identical.

**Implementation reference:** [Anthropic prompt caching docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching). [Anthropic cookbook](https://github.com/anthropics/anthropic-cookbook/blob/main/misc/prompt_caching.ipynb). Already in codebase: `src/core/llm/prompt-prefix-compiler.ts`.

**Maps to our system:** The orchestrator controls the prompt text passed to CLI subagents (claude, codex, opencode, gemini). That text becomes the subagent's system prompt / initial context. If `compile_prompt` places steering docs, spec content, and tool schemas first (stable prefix) and task-specific instructions last (dynamic tail), the subagent's provider-side cache hits on every subsequent dispatch with the same spec. The `PromptPrefixCompiler` with `stablePrefixHash`/`dynamicTailHash` split is the right pattern — complete integration across all dispatch paths.

**Priority: P0** — Partially implemented. The orchestrator indirectly controls subagent provider cache hit rates through prompt ordering. Zero quality risk.

---

### new: KV-Cache-Aware Prompt Design

**What:** Structure prompts so stable, reusable content (system instructions, tool definitions, steering docs) comes first and dynamic content (task query, user context) comes last. This maximizes the prefix length that hits provider cache. Common anti-patterns: timestamps, request IDs, or per-task metadata at the start of system prompts, which break cache entirely.

**Evidence:** llm-d benchmarks: 57x faster response times, 2x throughput with KV-cache-aware routing. LMCache: 15x higher throughput with prefix caching. Grade: **[strong]** for self-hosted; **[medium]** for API-based.

**Quality impact:** Quality-neutral. Purely a prompt ordering strategy.

**Implementation reference:** [llm-d KV cache blog](https://llm-d.ai/blog/kvcache-wins-you-can-see). [LMCache tech report](https://lmcache.ai/tech_report.pdf). [Red Hat article](https://developers.redhat.com/articles/2025/10/07/master-kv-cache-aware-routing-llm-d-efficient-ai-inference)

**Maps to our system:** Audit prompt construction in `compile_prompt` and all dispatch paths. The `PromptPrefixCompiler` already splits stable prefix from dynamic tail with `dynamicTailMessages: 2`. Ensure: (1) steering docs and spec content are always first, never include per-dispatch dynamic data (timestamps, run IDs); (2) tool schemas are static and placed early; (3) task-specific instructions are always the final messages. When the subagent receives this prompt, its provider sees a long stable prefix = cache hit. Compounds multiplicatively with provider caching above.

**Priority: P0** — Zero implementation cost (audit + reorder), multiplies the effect of provider caching on subagent API calls.

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

**What:** Constrain agent output to strict JSON schema. Eliminates parsing ambiguity, reduces wasted output tokens on prose/explanation. Combined with constrained decoding (where supported), reduces output token count by 30-60% vs. free-form responses.

**Evidence:** 30-60% output token reduction (practitioner reports comparing structured vs. free-form). [JSONSchemaBench](https://arxiv.org/abs/2501.10868). Grade: **[medium]**

**Quality impact:** Mixed on general tasks (over-constraining can reduce accuracy). Positive for structured extraction tasks (dispatch output parsing), since the model cannot produce malformed output.

**Implementation reference:** [guidance-ai/jsonschemabench](https://github.com/guidance-ai/jsonschemabench). [Awesome-LLM-Constrained-Decoding](https://github.com/Saibo-creator/Awesome-LLM-Constrained-Decoding)

**Maps to our system:** Already partially implemented — `ImplementerResult` and `ReviewerResult` interfaces with `BEGIN_DISPATCH_RESULT`/`END_DISPATCH_RESULT` delimiters. Tighten by: (1) pushing JSON schema into system prompt more aggressively via `SchemaRegistry`; (2) using `--output-format json` CLI flags where available; (3) adding explicit "no prose outside the JSON block" instructions.

**Priority: P0** — Already partially implemented, incremental improvements are low-risk and high-value.

---

## P1 — Near-Term

---

### gap: LLMLingua-2 (Token Classification Compression)

**What:** Treats prompt compression as token classification using a BERT-level encoder (XLM-RoBERTa) fine-tuned on GPT-4-distilled data. Task-agnostic, 3-6x faster than LLMLingua-1. Compression ratios of 2-5x on general text, up to 14x on chain-of-thought prompts.

**Evidence:** 95-98% accuracy retention at 2-5x compression. 14x on GSM8K CoT with similar performance. ACL 2024. Grade: **[strong]**

**Quality impact:** Minor performance gap vs. full-length prompt. No catastrophic degradation across MeetingBank, LongBench, ZeroSCROLLS.

**Implementation reference:** [microsoft/LLMLingua](https://github.com/microsoft/LLMLingua) — `llmlingua/prompt_compressor.py`. Model: `microsoft/llmlingua-2-xlm-roberta-large-meetingbank`. Integrated into LangChain and LlamaIndex. Paper: [arxiv.org/abs/2403.12968](https://arxiv.org/abs/2403.12968)

**Maps to our system:** Compress the dynamic tail content in `compile_prompt` before dispatch. The compression model runs locally (XLM-RoBERTa, ~550M params). Risk: compressed text may confuse agents expecting verbatim instructions. Must measure on actual spec-context prompts before enabling broadly.

**Priority: P1** — High savings (2-5x), strong evidence. Requires local model infra and validation on real prompts.

---

### gap: LongLLMLingua (Long-Context Compression)

**What:** Extension of LLMLingua for 10k+ token scenarios. Uses question-conditioned perplexity to score document relevance, reorders documents to fight "lost in the middle" effect, applies token-level compression. Achieves 94% cost reduction while *improving* answer quality.

**Evidence:** +21.4% performance on NaturalQuestions with 4x fewer tokens. 1.4-2.6x latency speedup. +5.4 points on MuSiQue multi-hop QA. ACL 2024. Grade: **[strong]**

**Quality impact:** Quality-positive. Document reordering actively improves retrieval accuracy.

**Implementation reference:** [microsoft/LLMLingua](https://github.com/microsoft/LLMLingua). Paper: [arxiv.org/abs/2310.06839](https://arxiv.org/abs/2310.06839)

**Maps to our system:** When assembling context from multiple spec files (requirements.md, design.md, tasks.md, steering docs) for `get-implementer-guide` and `get-reviewer-guide`, LongLLMLingua could compress + reorder. Same local model infra as LLMLingua-2.

**Priority: P1** — Directly addresses multi-document assembly. Quality improvement is a bonus.

---

### new: ACON (Agent Context Optimization for Long-Horizon Agents)

**What:** Unified framework compressing both environment observations and interaction histories for 15+ step agents. Uses natural-language "compression guidelines" optimized by analyzing failure cases. Can distill compression strategy into smaller models preserving 95% accuracy.

**Evidence:** 26-54% peak token reduction. 95% accuracy in distilled compressors. Up to 46% performance improvement for smaller LMs. AppWorld, OfficeBench, Multi-objective QA. October 2025. Grade: **[medium]**

**Quality impact:** Quality-neutral to quality-positive. Guidelines are optimized to avoid quality-breaking compression.

**Implementation reference:** Paper: [arxiv.org/abs/2510.00615](https://arxiv.org/abs/2510.00615). No public repo yet.

**Maps to our system:** Directly addresses multi-step agent dispatch. The `StateProjector` and `StateSnapshotFact` types already provide a factual state abstraction that aligns with ACON's approach. The `ingest_output` action could use learned compression guidelines to decide what to keep vs. compress from each dispatch cycle.

**Priority: P1** — 26-54% savings compound across steps. Requires adapting concepts (no public code).

---

### new: Magentic-One Task Ledger Pattern

**What:** Microsoft's Magentic-One maintains two compact ledgers: a Task Ledger (facts, guesses, plan) and a Progress Ledger (self-reflection on completion status). The Orchestrator consults these instead of full conversation history to decide next actions.

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

**Maps to our system:** Many implementation tasks follow similar patterns ("implement a new MCP tool", "add a test file"). A plan cache could store successful dispatch sequences and replay/adapt them. The `RuntimeSnapshotStore` already stores snapshots — extending it with similarity-matched templates is architecturally natural.

**Priority: P1** — Strong evidence, meaningful savings. Non-trivial implementation (similarity matching, template extraction).

---

### new: Selective Tool Provision

**What:** Instead of providing all available MCP tools to the LLM in every call, dynamically select only relevant tools for each task. The "Less-is-More" paper shows reducing the tool set via similarity-based filtering improves both accuracy and token efficiency.

**Evidence:** Up to 70% execution time reduction, 40% power/cost reduction. Improved agentic success rates (not just neutral). DATE 2025. Grade: **[medium]**

**Quality impact:** Positive — fewer tools means less confusion, better tool selection accuracy.

**Implementation reference:** [arxiv.org/abs/2411.15399](https://arxiv.org/abs/2411.15399). Also: [guidance-ai/llguidance](https://github.com/guidance-ai/llguidance)

**Maps to our system:** The MCP server exposes all tools via `src/tools/index.ts` and `src/tools/registry.ts`. Implement selective exposure based on workflow phase: during implementation, only expose `get-implementer-guide`, `dispatch-runtime`, `spec-status`; hide brainstorm/steering tools. The `DispatchRole` and workflow phase can drive filtering.

**Priority: P1** — Straightforward via existing tool registry. Reduces prompt size, actually improves quality.

---

### gap: Model Cascading (Proactive Routing)

**What:** Route most agent calls to a cheap/fast model and escalate to expensive model only on failure or low confidence. BudgetMLAgent demonstrated 94.2% cost reduction using Gemini base + GPT-4 fallback.

**Evidence:** BudgetMLAgent: 94.2% cost reduction ($0.931→$0.054/run). Efficient Agents: 96.7% baseline performance at 43% cost reduction. Grade: **[medium]** — domain-specific (ML automation), generalization uncertain.

**Quality impact:** Quality-neutral or improved in tested domain. Cascade failures can compound in multi-step coding.

**Implementation reference:** [arxiv.org/abs/2411.07464](https://arxiv.org/abs/2411.07464) (BudgetMLAgent). [arxiv.org/abs/2508.02694](https://arxiv.org/abs/2508.02694) (Efficient Agents).

**Maps to our system:** The orchestrator dispatches to multiple CLI agents (claude, codex, opencode, gemini) which use different underlying models at different costs. `BudgetGuard` already implements cascading with `emergencyModelId` and `allowEmergencyDegrade`. Improvement: make this proactive — route simple tasks (test gen, file moves, docs) to cheaper CLI agents by default, reserve expensive agents for complex implementation and review. Extend `DispatchRole` with a task-complexity classifier that drives CLI agent selection.

**Priority: P1** — Infrastructure exists. Missing piece: task-complexity classifier for proactive CLI agent routing.

---

### new: Tool-Result Caching for MCP Operations

**What:** Cache results of deterministic MCP tool calls (file reads, spec status lookups, steering doc loads) using content-addressable hashing. Repeated invocations with same inputs return cached results.

**Evidence:** MCP documentation recommends caching expensive query results. Savings depend on call frequency. Grade: **[weak]** published; **[strong]** engineering common sense.

**Quality impact:** Quality-neutral with content-hash matching and file-mtime TTL invalidation.

**Implementation reference:** [MCP tools spec](https://modelcontextprotocol.io/specification/2025-06-18/server/tools). Relevant: `src/tools/workflow/steering-loader.ts`.

**Maps to our system:** Tools like `spec-status`, `get-implementer-guide`, `get-reviewer-guide`, `steering-guide` all read files from disk. Adding TTL-based in-memory cache (keyed on file path + mtime) eliminates redundant I/O and — more importantly — reduces token volume sent through MCP to the host agent.

**Priority: P1** — Low effort (simple mtime cache), directly reduces host agent context consumption.

---

---

### gap: RouteLLM-Style CLI Agent Routing

**What:** RouteLLM routes requests between strong (expensive) and weak (cheap) models based on query difficulty using trained routers (matrix factorization, BERT classifier). Configurable threshold controls cost-quality tradeoff. The same principle applies to choosing which CLI agent to dispatch for a given task.

**Evidence:** 85% cost reduction on MT-Bench, 45% on MMLU, 35% on GSM8K retaining 95% of GPT-4 performance. Matrix factorization router: 95% quality with only 26% of requests to strong model (~48% cost reduction). Grade: **[strong]** — published benchmarks, LMSYS.

**Quality impact:** 5% quality degradation at 95th-percentile target. Configurable threshold.

**Implementation reference:** [lm-sys/RouteLLM](https://github.com/lm-sys/RouteLLM). [RouterBench](https://github.com/withmartian/routerbench)

**Maps to our system:** The orchestrator dispatches to multiple CLI agents backed by different models (claude=Sonnet/Opus, codex=GPT-4, gemini=Gemini, opencode=various). A RouteLLM-style classifier could score task complexity and route simple tasks (doc updates, test stubs, file moves) to cheaper CLI agents, reserving expensive ones for complex implementation. Integrate into the `init_run` action where CLI agent selection happens.

**Priority: P1** — Meaningful savings (45-85%). Requires calibrating a classifier on spec-workflow task patterns.

---

### gap: Context Compaction (Pre-Dispatch)

**What:** When context reaches a threshold (60-95% of window), summarize into compact form. Claude Code triggers at ~60-65% now. Key insight: aggressive early compaction preserves more working memory and improves quality vs. late compaction.

**Evidence:** 25-50% typical flow reduction with dispatch-runtime v2. Known issues: "agent loses rules after compaction" (OpenCode #3099), "compaction loses important context" (#4102). Grade: **[medium]**

**Quality impact:** Documented regressions. Rules/instructions can be lost. Requires careful preservation of system prompts.

**Implementation reference:** [sst/opencode](https://github.com/sst/opencode). [Anthropic cookbook](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)

**Maps to our system:** CLI agents already implement their own compaction. The orchestrator's role: minimize the need by sending focused, pre-compressed prompts. The `compile_prompt` action with stable prefix + dynamic tail already does this. Further: pre-compact context before dispatch rather than relying on CLI agent built-in compaction which may lose orchestrator-injected rules.

**Priority: P1** — Partially addressed by dispatch-runtime v2. Incremental gains from orchestrator-side pre-compaction.

---

## P2 — Future / Evaluate Later

---

### new: Zep/Graphiti (Temporal Knowledge Graph Memory)

**What:** Extracts atomic facts and entity relationships from conversations into a temporal knowledge graph. Retrieves only relevant facts for the current query instead of replaying full history. Achieves 90% token reduction (1.8K vs 26K tokens) with 94.8% accuracy on Deep Memory Retrieval, outperforming MemGPT.

**Evidence:** 94.8% DMR accuracy (vs. MemGPT 93.4%). +18.5% accuracy on LongMemEval with 90% latency reduction. January 2025. Grade: **[medium]** — strong benchmarks but self-reported by Zep team.

**Quality impact:** Quality-positive on memory retrieval. Temporal awareness prevents stale fact retrieval.

**Implementation reference:** [getzep/graphiti](https://github.com/getzep/graphiti). Paper: [arxiv.org/abs/2501.13956](https://arxiv.org/abs/2501.13956)

**Maps to our system:** `StateSnapshotFact` already provides a factual state abstraction. Graphiti could maintain a knowledge graph of facts across dispatch cycles. The `get_snapshot` action could be backed by a fact graph. High potential for long-running sessions.

**Priority: P2** — High savings (90% on long conversations) but adds graph database infrastructure.

---

### new: TokenSkip (Chain-of-Thought Compression)

**What:** Fine-tunes LLMs to selectively skip less important tokens during reasoning. Produces compressed CoT retaining math expressions and key logical steps while dropping filler. Controllable compression ratios via special tokens.

**Evidence:** 40% reasoning token reduction (313→181 on GSM8K for Qwen2.5-14B). <0.4% performance drop. EMNLP 2025. Grade: **[strong]**

**Quality impact:** <0.4% on math benchmarks. Not tested on code generation.

**Implementation reference:** [hemingkx/TokenSkip](https://github.com/hemingkx/TokenSkip) — LoRA fine-tuning (0.2% of parameters, ~2.5h on two 3090s).

**Maps to our system:** Not directly actionable — requires model control. Only relevant if self-hosting or if providers expose "compressed reasoning" as a parameter.

**Priority: P2** — Strong research but architecturally mismatched for CLI dispatch.

---

### gap: Semantic Caching (GPTCache)

**What:** Converts queries to embeddings and uses vector similarity to return cached responses for semantically equivalent prompts. Captures paraphrased/near-duplicate requests.

**Evidence:** Up to 68.8% API call reduction. 97% accuracy on hits. 31% of LLM queries in production exhibit semantic similarity. Cache misses add 2.5x latency. Grade: **[medium]**

**Quality impact:** Risk of returning stale/wrong responses. For code review, semantic caching is risky — subtle prompt differences need different outputs.

**Implementation reference:** [zilliztech/GPTCache](https://github.com/zilliztech/GPTCache). Paper: [arxiv.org/abs/2411.05276](https://arxiv.org/abs/2411.05276)

**Maps to our system:** Not recommended for dispatch tasks (correctness-sensitive — each task needs specific output). Narrow use case: caching repeated MCP tool responses where inputs are identical. Better served by exact-match tool-result caching (see P1) and provider-native prompt caching.

**Priority: P2** — High risk of incorrect cached results for dispatch tasks. Exact-match caching is safer.

---

### new: LLM Cascade with Formal Guarantees (C3PO)

**What:** Uses conformal prediction to provide formal guarantees that cost stays within budget while bounding accuracy loss. Tries cheap model first, escalates when confidence is low.

**Evidence:** <20% cost of strongest model with ≤2% accuracy gap across 16 reasoning benchmarks (GSM8K, MATH-500, BigBench-Hard, AIME). NeurIPS 2025. Grade: **[strong]**

**Quality impact:** Bounded 2-10% accuracy gap (user-configurable).

**Implementation reference:** [AntonValk/C3PO-LLM](https://github.com/AntonValk/C3PO-LLM). Paper: [arxiv.org/abs/2511.07396](https://arxiv.org/abs/2511.07396). Also: [automix-llm/automix](https://github.com/automix-llm/automix)

**Maps to our system:** For CLI dispatch, try a cheaper agent first (e.g., codex for simple tasks), verify the structured output against spec/tests, escalate to a stronger agent (claude) if the result is incomplete or fails tests. The `ingest_output` action already validates structured results — extend it with a re-dispatch path on failure. Adds latency (two sequential dispatches on escalation).

**Priority: P2** — Strong evidence but adds dispatch complexity. Better after simpler techniques (observation masking, prompt ordering) are maximized.

---

### new: Router-R1 (RL-Trained Multi-Round Routing)

**What:** Trains a small LLM via reinforcement learning to dynamically select which model to invoke at each step of multi-round reasoning. Uses cost reward + accuracy reward. Generalizes to unseen models.

**Evidence:** Outperforms direct, CoT, SFT, RAG baselines on 7 QA benchmarks. NeurIPS 2025. Grade: **[medium]** — strong academic results, no production evidence.

**Quality impact:** Improves over single-model baselines on knowledge-intensive tasks.

**Implementation reference:** [ulab-uiuc/Router-R1](https://github.com/ulab-uiuc/Router-R1). Paper: [arxiv.org/abs/2506.09033](https://arxiv.org/abs/2506.09033)

**Maps to our system:** Architecturally mismatched — routing decision in this system is coarse-grained (which CLI tool to invoke), not per-token. Would only add value for direct multi-turn LLM orchestration.

**Priority: P2** — Academically strong, architecturally mismatched for CLI dispatch.

---

### new: Selective Context (Self-Information Filtering)

**What:** Uses a small LM to compute self-information (surprisal) per token, prunes highly predictable tokens. Achieves ~2x compression.

**Evidence:** 50% context cost reduction, 36% memory reduction. BERTScore drop of 0.023. EMNLP 2023. Grade: **[medium]**

**Quality impact:** Minor regression (BERTScore -0.023). Risky for precise instructions.

**Implementation reference:** [liyucheng09/Selective_Context](https://github.com/liyucheng09/Selective_Context). Paper: [arxiv.org/abs/2310.06201](https://arxiv.org/abs/2310.06201)

**Maps to our system:** Simpler than LLMLingua. Could be a fast first-pass filter on verbose tool outputs before re-injection.

**Priority: P2** — Superseded by LLMLingua-2 for most use cases.

---

### new: QUITO (Query-Guided Attention Compression)

**What:** Uses self-attention of a 0.5B Transformer to score context tokens by relevance to the current query/task. Three filtering methods: top-k, threshold, budget-constrained.

**Evidence:** Outperforms baselines on NaturalQuestions and ASQA. Uses 0.5B model (vs. 7-13B competitors). CCIR 2024. Grade: **[medium]**

**Quality impact:** Better than non-query-aware methods on QA. Potential regression when "irrelevant" context matters.

**Implementation reference:** [Wenshansilvia/attention_compressor](https://github.com/Wenshansilvia/attention_compressor). Paper: [arxiv.org/abs/2408.00274](https://arxiv.org/abs/2408.00274)

**Maps to our system:** When dispatching a specific task, QUITO could compress supporting context (design docs, code) relative to that task description. Natural fit for `init_run` which pairs task with context. 0.5B requirement is lightweight.

**Priority: P2** — Promising but narrower evidence. Good candidate for future evaluation.

---

### new: DSPy Prompt Optimization + BootstrapFinetune

**What:** DSPy treats prompts as compiled programs. Optimizers (MIPROv2, GEPA) find minimal, high-quality prompts through systematic search. BootstrapFinetune distills prompted pipelines into fine-tuned weights on smaller models.

**Evidence:** 770M T5 via DSPy achieved 39% HotPotQA EM vs. 26% for hand-prompted Llama2-7B. GEPA (July 2025) outperforms human-engineered prompts. Grade: **[strong]** on quality; **[medium]** on token efficiency.

**Quality impact:** Quality-positive. Optimization explicitly maximizes quality metric.

**Implementation reference:** [stanfordnlp/dspy](https://github.com/stanfordnlp/dspy). [dspy.ai/learn/optimization/optimizers](https://dspy.ai/learn/optimization/optimizers/)

**Maps to our system:** Optimize system prompts and instruction templates in `PromptTemplateRegistry`. BootstrapFinetune could optimize local LLM calls (summarization, fact extraction). Requires DSPy evaluation pipeline setup.

**Priority: P2** — High potential but non-trivial setup. Best applied to most frequently dispatched templates.

---

### new: MemGPT/Letta (Virtual Context Management)

**What:** Two-tier memory: main context (bounded working memory) + archival storage (unbounded, vector-indexed). Agent manages its own context via explicit memory tools.

**Evidence:** Enables "infinite" conversations. No specific compression ratio published. Grade: **[weak]** on token efficiency; **[medium]** on capability.

**Quality impact:** Depends on agent's memory management decisions.

**Implementation reference:** [letta-ai/letta](https://github.com/letta-ai/letta). Paper: [arxiv.org/abs/2310.08560](https://arxiv.org/abs/2310.08560)

**Maps to our system:** CLI subprocess boundary limits applicability — can't inject memory tools into agents. The orchestrator itself could use two-tier architecture: current task in "main memory", archived results in retrieval storage. `RuntimeSnapshotStore` already provides snapshot persistence.

**Priority: P2** — Architecturally interesting but blocked by subprocess boundary.

---

### new: Response Caching via Proxy (LiteLLM)

**What:** Proxy layer intercepts LLM requests, caches responses. Exact-match for identical prompts, optional semantic caching via embeddings. Supports Redis, in-memory, S3, Qdrant backends.

**Evidence:** Up to 100% savings on cache hits. Practical hit rates: 10-40% depending on workload. Grade: **[medium]**

**Quality impact:** Exact-match is quality-neutral. Semantic caching carries stale-response risk.

**Implementation reference:** [BerriAI/litellm](https://github.com/BerriAI/litellm). [LiteLLM caching docs](https://docs.litellm.ai/docs/proxy/caching)

**Maps to our system:** Limited for CLI dispatch since agents manage their own API connections. Could work if CLIs support proxy env vars (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`) — a LiteLLM proxy could intercept and cache subagent API calls. But this adds infrastructure and the orchestrator has no visibility into cache behavior.

**Priority: P2** — Requires proxy infrastructure between CLI agents and providers. Provider-native caching via prompt ordering (P0) is simpler for the same benefit.

---

## Implementation Roadmap

### Phase 1 — Immediate (P0, this sprint)

| Action | Files to change | Expected savings |
|--------|----------------|-----------------|
| Observation masking: aggressively truncate old `pairRole === 'result'` messages, keep action history | `src/core/llm/history-reducer.ts` | ~50% context reduction |
| KV-cache prompt audit: ensure static content always precedes dynamic in all dispatch paths | `src/core/llm/prompt-prefix-compiler.ts`, dispatch templates | Multiplier on provider caching |
| Tool-result size gate: offload >N char results to `.spec/tmp/`, inject reference + preview | `src/tools/workflow/dispatch-runtime.ts` | Prevents blowouts |
| Tighten structured output: add "no prose outside JSON" instructions, use `--output-format json` flags | Dispatch prompt templates, `SchemaRegistry` | 30-60% output reduction |
| Prompt prefix stability: ensure `compile_prompt` produces identical prefixes across dispatches within a spec | `src/core/llm/prompt-prefix-compiler.ts`, dispatch templates | Up to 90% on subagent provider cache hits |

**Combined P0 estimate: 50-70% reduction on typical dispatch cycles with zero quality risk.**

### Phase 2 — Near-Term (P1, next sprint)

| Action | Expected savings |
|--------|-----------------|
| LLMLingua-2 as optional pre-dispatch compression for dynamic tail | 2-5x on compressed segments |
| Task Ledger / Progress Ledger formalization from spec files | Reduces per-dispatch prompt size |
| Selective tool provision by workflow phase | 40% exec time reduction |
| MCP tool-result caching (mtime-based) | Eliminates redundant host-agent context |
| Proactive CLI agent routing with task-complexity classifier | Up to 94% on simple tasks |

### Phase 3 — Future (P2, evaluate)

| Technique | Gate condition |
|-----------|---------------|
| Zep/Graphiti knowledge graph | Long-running sessions with many dispatch cycles |
| C3PO formal cascade guarantees | Dispatch volume justifies calibration effort |
| DSPy prompt optimization | High-frequency templates identified |
| QUITO query-guided compression | Dispatcher sends >10K token contexts regularly |
| TokenSkip | Self-hosted model or provider support for compressed reasoning |

---

## Sources

### Papers
- [Observation Masking / Complexity Trap (NeurIPS 2025)](https://arxiv.org/abs/2508.21433)
- [LLMLingua-2 (ACL 2024)](https://arxiv.org/abs/2403.12968)
- [LongLLMLingua (ACL 2024)](https://arxiv.org/abs/2310.06839)
- [ACON Context Optimization (Oct 2025)](https://arxiv.org/abs/2510.00615)
- [Selective Context (EMNLP 2023)](https://arxiv.org/abs/2310.06201)
- [QUITO (CCIR 2024)](https://arxiv.org/abs/2408.00274)
- [Agentic Plan Caching (NeurIPS 2025)](https://arxiv.org/abs/2506.14852)
- [C3PO Cascading (NeurIPS 2025)](https://arxiv.org/abs/2511.07396)
- [TokenSkip (EMNLP 2025)](https://arxiv.org/abs/2502.12067)
- [BudgetMLAgent](https://arxiv.org/abs/2411.07464)
- [Efficient Agents](https://arxiv.org/abs/2508.02694)
- [FrugalGPT](https://arxiv.org/abs/2305.05176)
- [JSONSchemaBench](https://arxiv.org/abs/2501.10868)
- [Less-is-More Tool Selection (DATE 2025)](https://arxiv.org/abs/2411.15399)
- [Router-R1 (NeurIPS 2025)](https://arxiv.org/abs/2506.09033)
- [Zep Temporal KG](https://arxiv.org/abs/2501.13956)
- [MemGPT/Letta](https://arxiv.org/abs/2310.08560)
- [GPT Semantic Cache](https://arxiv.org/abs/2411.05276)
- [Prompt Compression Survey (NAACL 2025)](https://arxiv.org/abs/2410.12388)

### GitHub Repos
- [JetBrains-Research/the-complexity-trap](https://github.com/JetBrains-Research/the-complexity-trap)
- [microsoft/LLMLingua](https://github.com/microsoft/LLMLingua)
- [liyucheng09/Selective_Context](https://github.com/liyucheng09/Selective_Context)
- [Wenshansilvia/attention_compressor](https://github.com/Wenshansilvia/attention_compressor)
- [stanfordnlp/dspy](https://github.com/stanfordnlp/dspy)
- [lm-sys/RouteLLM](https://github.com/lm-sys/RouteLLM)
- [withmartian/routerbench](https://github.com/withmartian/routerbench)
- [ulab-uiuc/Router-R1](https://github.com/ulab-uiuc/Router-R1)
- [AntonValk/C3PO-LLM](https://github.com/AntonValk/C3PO-LLM)
- [automix-llm/automix](https://github.com/automix-llm/automix)
- [hemingkx/TokenSkip](https://github.com/hemingkx/TokenSkip)
- [getzep/graphiti](https://github.com/getzep/graphiti)
- [letta-ai/letta](https://github.com/letta-ai/letta)
- [BerriAI/litellm](https://github.com/BerriAI/litellm)
- [zilliztech/GPTCache](https://github.com/zilliztech/GPTCache)
- [guidance-ai/jsonschemabench](https://github.com/guidance-ai/jsonschemabench)
- [Saibo-creator/Awesome-LLM-Constrained-Decoding](https://github.com/Saibo-creator/Awesome-LLM-Constrained-Decoding)
- [google/adk-python](https://github.com/google/adk-python)
- [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph)
- [sst/opencode](https://github.com/sst/opencode)

### Provider Docs
- [Anthropic Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [OpenAI Prompt Caching](https://platform.openai.com/docs/guides/prompt-caching)
- [MCP Tools Specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [LiteLLM Caching](https://docs.litellm.ai/docs/proxy/caching)
- [Google ADK Context Compaction](https://google.github.io/adk-docs/context/compaction/)

### Practitioner Reports
- [LangChain Deep Agents Context Management](https://blog.langchain.com/context-management-for-deepagents/)
- [JetBrains Research Blog](https://blog.jetbrains.com/research/2025/12/efficient-context-management/)
- [llm-d KV Cache Blog](https://llm-d.ai/blog/kvcache-wins-you-can-see)
- [Red Hat llm-d Article](https://developers.redhat.com/articles/2025/10/07/master-kv-cache-aware-routing-llm-d-efficient-ai-inference)
- [LMCache Tech Report](https://lmcache.ai/tech_report.pdf)
- [ngrok Prompt Caching Blog](https://ngrok.com/blog/prompt-caching/)
