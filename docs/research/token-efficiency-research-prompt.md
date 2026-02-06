# Token Efficiency & Prompt Power: Deep Research Prompt

## Objective

Find every technique — proven in production or backed by rigorous benchmarks — that reduces token consumption in multi-step CLI agent orchestration **without quality regression**. Prioritize techniques where open-source implementations exist and code can be read.

## Context: What We Already Do

Our system is an MCP-based spec workflow tool that dispatches CLI agents (claude-code, codex, opencode, gemini-cli). Current token-saving stack (~25-50% reduction when enabled):

| Current technique | Savings |
|---|---|
| Structured dispatch contracts (hard-fail JSON, no retries on bad format) | 10-25% |
| Dispatch runtime state store (snapshot-driven branching, not log replay) | 15-35% |
| Schema-invalid retry gate (max 1 retry, then halt) | 5-15% |
| Stable prompt prefix + delta compile (hash-keyed prefix, only send diffs) | 10-30% |
| Output token budget enforcement (cap agent response length) | 5-12% |
| Safe history reduction (truncate/summarize preserving tool-call/result pairs) | 20-50% |
| Runtime interception layer (redact/drop/transform before dispatch) | 0-10% |
| Budget guard pre-filtering (exclude over-budget models before routing) | indirect |

Techniques we've **planned but not built**: adaptive routing (cheap model first), semantic result cache, prompt compression (LLMLingua-family), provider-native prompt caching parity across Claude/Gemini/OpenAI.

## Research Scope

### Must cover

- **Multi-agent/orchestrator coordination patterns** — How do production multi-step agent systems minimize repeated context? Focus on: LangGraph, CrewAI, AutoGen, OpenAI Agents SDK, Anthropic Claude Code internals (if documented), DSPy, Magentic-One, any MCP-based systems.
- **Context window management** — Techniques beyond naive truncation: sliding windows, hierarchical summarization, memory architectures (MemGPT/Letta), fact extraction + replay, conversation compaction.
- **Prompt compression** — LLMLingua, LongLLMLingua, Selective Context, QUITO, any newer 2025-2026 approaches. Actual measured compression ratios AND quality retention numbers.
- **Caching at every layer** — Provider-native prompt caching (OpenAI, Anthropic, Gemini — actual hit rates in production), semantic caching (GPTCache, LangChain cache, custom), tool-result caching, embedding cache, KV-cache-aware prompt design.
- **Model cascade / routing** — FrugalGPT, RouteLLM, Martian, AutoMix, Self-Route, any production routing systems. Actual cost savings AND quality floor enforcement.
- **Output optimization** — Structured outputs, constrained decoding, output length governance, chain-of-thought compression, skeleton-of-thought, response streaming with early termination.
- **Tool-call optimization** — Tool-result deduplication, tool schema compression, parallel tool dispatch to reduce round-trips, tool-result summarization before re-injection.
- **Speculative / predictive techniques** — Speculative decoding coordination at API level, predictive pre-fetching of likely next prompts, parallel branch exploration with early pruning.
- **Batch/async patterns** — Request batching for throughput, async fan-out with token budgets, deferred execution when cheaper.

### Important constraints

- **We are CLI agent dispatchers, not API consumers** — We invoke CLI tools (claude, codex, opencode, gemini) as subprocesses and parse their output. We don't directly call LLM APIs for the agent work. Our API usage is limited to the AI review feature.
- **Quality is non-negotiable** — Every technique must have evidence of quality preservation. If it trades quality for tokens, note the measured regression explicitly.
- **Open-source implementations preferred** — For each technique, link to the actual code if it exists. GitHub repos, SDK implementations, framework internals.

## Research Sources (cast wide)

- **GitHub**: LangGraph, LiteLLM, DSPy, CrewAI, AutoGen, OpenAI Agents SDK, Vercel AI SDK, Magentic-One, MemGPT/Letta, GPTCache, LLMLingua, RouteLLM, Martian router
- **Papers**: arxiv (2024-2026), ACL/EMNLP/NeurIPS proceedings, Self-Route, FrugalGPT, LLMLingua family, Lost in the Middle, any agent-efficiency papers
- **Practitioner reports**: OpenAI dev forum, Anthropic cookbook, Google AI blog, LangChain blog, HuggingFace blog, individual engineering blogs with before/after metrics
- **Discussions**: HN threads on LLM cost optimization, Reddit r/LocalLLaMA and r/MachineLearning, Discord communities (LangChain, LlamaIndex, Anthropic), Twitter/X threads from practitioners
- **Conference talks**: AI Engineer Summit, NeurIPS workshops, LangChain/LlamaIndex meetup recordings

## Output Format

A flat actionable list. Each item:

```
### [gap|new]: <Technique Name>

**What:** One-paragraph description of the technique.

**Evidence:** Specific numbers — token savings %, quality retention %, source with link. Grade evidence: [strong|medium|weak].

**Quality impact:** Measured regression (if any), or "quality-neutral" with citation.

**Implementation reference:** Link to code (GitHub repo, specific file/function) or paper with implementation details.

**Maps to our system:** How this applies to our CLI agent dispatch + MCP orchestration architecture specifically. What would change in our codebase.

**Priority:** [P0|P1|P2] based on (savings * evidence_strength * implementation_feasibility) / quality_risk.
```

- `gap:` = technique we listed in plan.md but this research adds new evidence, implementation detail, or changes priority
- `new:` = technique not in our current plan.md or features.md at all

Sort by priority (P0 first), then by evidence strength within each priority tier.

## What "Done" Looks Like

- Minimum 15 techniques researched, with at least 5 tagged `new:`
- Every item has at least one code link or paper link
- Evidence grades are honest — don't inflate weak evidence
- The list is directly actionable: an engineer could pick any P0 item and start implementing with the provided references
- Written to `docs/research/token-efficiency-findings.md`
