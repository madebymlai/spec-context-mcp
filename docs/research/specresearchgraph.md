# Session Fact Tracker Research — Lightweight Graphiti for Dispatch Sessions

**Date:** 2026-02-07
**Scope:** In-memory fact tracking across multi-task dispatch sessions (spec-context-mcp)
**Inspired by:** Zep/Graphiti (arxiv 2501.13956), LangChain Entity Memory, AutoGen State, Magentic-One Ledger

---

## Problem

The orchestrator runs all spec tasks in one long session (8 tasks × 2-3 dispatches = 16-24 dispatches). The history reducer masks old observations for token savings, but masking loses cross-task facts: "task 2 created IFooService.ts", "reviewer on task 4 flagged a naming convention", "task 5 changed the config schema." By task 8, those facts are gone from context.

## Key Decision: No Graph DB

- Facts only matter within a single session — session dies, facts die
- In-memory map/array is sufficient (~100-200KB for 500-1000 facts)
- No Neo4j, no external services, no persistence layer
- Self-contained TypeScript, fits MCP server architecture

---

## Pattern Analysis

### 3 Approaches to Fact Extraction

| Approach | How | LLM Cost | Pros | Cons |
|----------|-----|----------|------|------|
| **A. Entity-Relationship** (LangChain) | Extract entities, maintain evolving summaries per entity | LLM call per entity update | Cumulative knowledge building | Token cost per dispatch |
| **B. Fact Tuples** (Graphiti) | Parse results into (subject, relation, object, timestamp) triples | LLM call per dispatch | Queryable, temporal invalidation, compact | Requires extraction prompt |
| **C. Tag-Based Metadata** | Annotate dispatch results with tags/metadata, no extraction | Zero | Fast, preserves full context | Less structured, needs rule-based tagger |

**Recommendation:** Start with C (tag-based, zero LLM cost), graduate to B (tuples) if tag matching proves insufficient.

### 4 Approaches to Relevance Matching

| Strategy | How | Quality | Cost |
|----------|-----|---------|------|
| **Keyword overlap** | Count shared words between fact and task | Low-medium | Zero |
| **TF-IDF** | Weight by inverse frequency, distinctive words score higher | Medium | Zero (compute only) |
| **Tag filtering** | Pre-tag facts with categories, filter by task tag | Medium-high | Zero |
| **Embedding similarity** | Cosine similarity on vector embeddings | Highest | Embedding API call |

**Recommendation:** Tags + keyword overlap (phase 1), add TF-IDF (phase 2), defer embeddings.

### Temporal Facts (Graphiti's Core Insight)

Facts have validity intervals: `[validFrom, validTo]`. When a fact becomes false, set `validTo` instead of deleting. Both versions coexist, time-sliced.

```
Fact 1: ("config.debug", "was", "true",  validFrom=T1, validTo=T2)
Fact 2: ("config.debug", "is",  "false", validFrom=T2)
```

This prevents stale facts from polluting context while preserving history for reasoning.

### Episodes (Graphiti's Temporal Units)

An **episode** = one dispatch cycle. Contains: timestamp, dispatch ID, task description, extracted facts, entities mentioned. Episodes preserve causality — fact at time T2 can only reference facts from T1 < T2.

---

## Existing Codebase Integration Points

### StateSnapshotFact (already exists)
- Structure: `{ k: string, v: string, confidence: number }`
- Used in: `dispatch-runtime.ts`, `dispatch-ledger.ts`, `state-projector.ts`
- Stores: classification results, ledger data, task status, provider selection
- **Gap:** No temporal validity, no cross-task persistence within session, no relevance matching

### DispatchRuntimeManager (produces facts)
- `initRun()`: Creates initial facts (spec_name, task_id, classification_level, selected_provider)
- `ingest_output()`: Creates outcome facts (implementer_status, reviewer_assessment)
- `mergeFacts()`: Updates latest values for keys
- **Gap:** Facts are per-snapshot, not accumulated across tasks

### HistoryReducer (consumes context)
- 3-stage pipeline: masking → summarization → truncation
- Masks old `pairRole === 'result'` messages
- **Gap:** Masking destroys facts embedded in old results. No mechanism to preserve extracted facts separately.

### ProgressLedger / TaskLedger (structured state)
- Already converts to/from `StateSnapshotFact` arrays
- `progressLedgerToFacts()`, `taskLedgerToFacts()`, reverse functions
- **Gap:** Tracks task status, not cross-task knowledge (files changed, patterns established, conventions adopted)

---

## What the Session Fact Tracker Adds

| Current System | With Fact Tracker |
|---------------|-------------------|
| Facts live in StateSnapshot per task | Facts accumulate across session |
| Old observations get masked (facts lost) | Facts extracted before masking, preserved separately |
| Task 8 has no knowledge of task 2's decisions | Task 8 queries: "what files did task 2 create?" |
| Reviewer feedback lost after fix dispatch | Reviewer constraints stored as facts for all future tasks |
| Prompt assembles from full spec files | Prompt includes relevant facts from prior tasks |

---

## Minimal Viable Architecture

```
DispatchResult → FactExtractor → SessionFactStore → FactRetriever → PromptAssembler
                 (rule-based)    (in-memory Map)    (tag+keyword)   (inject into dispatch)
```

### FactExtractor (rule-based, no LLM)
- Parse structured dispatch results (JSON between BEGIN/END markers)
- Extract: files_modified, tests_added, status, reviewer_issues, conventions_established
- Tag with categories: [file_change, test, convention, error, decision]

### SessionFactStore
- `Map<string, SessionFact>` keyed by deterministic ID
- SessionFact: `{ subject, relation, object, tags, validFrom, validTo?, sourceTask, confidence }`
- Deduplication by (subject, relation, object) triple
- Temporal invalidation: when same subject+relation gets new object, invalidate old

### FactRetriever
- Input: task description + required tags
- Output: relevant facts sorted by recency
- Strategy: tag filter → keyword overlap → top-K
- Budget: max N facts injected into prompt (configurable, default 10)

### Prompt Integration
- After compile_prompt assembles stable prefix + dynamic tail
- Inject `[Session Facts]` section between them
- Contains only facts relevant to current task
- Capped at token budget (e.g., 500 tokens)

---

## Memory Characteristics

| Session Size | Facts | Memory | Prompt Overhead |
|-------------|-------|--------|-----------------|
| 5 tasks (small spec) | ~25-50 | ~5-10KB | ~100-200 tokens |
| 10 tasks (medium spec) | ~50-100 | ~10-20KB | ~200-400 tokens |
| 20 tasks (large spec) | ~100-200 | ~20-40KB | ~300-500 tokens |

Overhead is negligible. The token cost of injecting 10 relevant facts (~200 tokens) is far less than what masking saves (~5000+ tokens).

---

## Sources

- [Zep/Graphiti Paper (arxiv 2501.13956)](https://arxiv.org/abs/2501.13956) — temporal knowledge graph, episodes, fact invalidation
- [LangChain ConversationEntityMemory](https://python.langchain.com/api_reference/langchain/memory/langchain.memory.entity.ConversationEntityMemory.html) — entity extraction + evolving summaries
- [AutoGen State Management](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/state.html) — session state serialization
- [Magentic-One Ledger Pattern](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html) — task + progress ledgers
- [LlamaIndex Agent Memory](https://www.llamaindex.ai/blog/improved-long-and-short-term-memory-for-llamaindex-agents) — short/long-term memory patterns
- [Mem0 Memory Layer](https://www.datacamp.com/tutorial/mem0-tutorial) — layered memory for agents
- [KGGen Knowledge Graph Extraction (arxiv 2502.09956)](https://arxiv.org/html/2502.09956v1) — lightweight KG extraction
