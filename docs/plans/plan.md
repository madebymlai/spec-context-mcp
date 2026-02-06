# Cost-Efficient LLM Orchestration Plan

Date: 2026-02-06  
Status: Baseline architecture plan (reference)
Runtime ownership note: orchestration runtime implementation is under `src/core/llm/*` and `src/dashboard/*`; `chunkhound/*` remains search/research scope.

## Executive Summary
- Replace raw log-reading orchestration with event-sourced state + materialized snapshots.
- Consume compact `StateSnapshot`/delta packets in the orchestration path; keep raw logs for audit only.
- Prioritize provider-native prompt caching first; it is the highest ROI and lowest complexity lever.
- Enforce canonical prompt prefixing (stable shared prefix + variable tail) to maximize cache hit rate.
- Add delta context passing so each step sends only changes, not full transcript replay.
- Add adaptive routing (cheap path first, escalate on low confidence).
- Add strict structured output schemas to remove retry/repair token waste.
- Add safe history reduction contracts (truncation/summarization that preserve tool-call/result coherence).
- Add runtime interception hooks for policy, PII filtering, and message drop/transform before model calls.
- Enforce snapshot lineage fields (`parent_config`, `pending_writes`) for deterministic replay and recovery.
- Add budget filtering before routing so over-budget deployments are excluded pre-selection.
- Define deterministic runtime contracts (event ordering/idempotency, interception lifecycle, and budget no-candidate behavior).
- Centralize policy/routing/budget/telemetry behind stable interfaces (SOLID + DRY).
- Primary architecture: event stream + snapshot store + context assembler + policy engine.
- Realistic target after all phases: ~60-80% token reduction, ~20-45% p95 latency reduction.

Assumption: current orchestrator repeatedly rehydrates context from verbose logs. If this assumption is wrong, expected gain should be adjusted down.

## Pattern Comparison Table
| Pattern | What it is | Pipeline fit | Expected token savings | Latency / complexity overhead | Failure modes / tradeoffs | Best fit / anti-pattern |
|---|---|---|---|---|---|---|
| Provider prompt caching | Reuse shared prompt prefix KV/state between calls | Prompt build + inference | High: up to ~90% input-token cost reduction on cache hits (provider-dependent) | Low runtime, low complexity | Prefix drift causes misses; TTL expiry; warmup race | Best: repetitive prefixes. Anti: highly unique prompts |
| Canonical prompt prefixing | Deterministic ordering of system/tools/examples before variable user tail | Prompt compiler | Med-High: often +20-60pp cache-hit-rate uplift (estimate) | Very low | Requires strict prompt governance | Best: multi-agent common instructions. Anti: ad-hoc prompt mutation |
| Delta context passing | Pass diffs from previous state (not full history) | Orchestrator <-> workers | Very high: ~70-95% orchestration-context token cut (estimate) | Low-Med | Poor diff design can lose critical state | Best: iterative workflows. Anti: one-shot tasks |
| Snapshot state store | Materialized `StateSnapshot` per run/thread instead of replaying logs | State layer | High indirect savings by eliminating log-to-prompt expansion | Low read latency, medium setup | Snapshot/schema drift; corruption handling | Best: long agent chains. Anti: tiny stateless flows |
| Adaptive RAG vs long-context routing | Route by confidence to RAG or LC path | Retrieval + routing | High: ~39-65% cost reduction reported in Self-Route settings | Low-Med | Misrouting hurts quality | Best: mixed traffic difficulty. Anti: uniformly hard tasks |
| Prompt compression (LLMLingua family) | Compress prompt while preserving salient context | Context preprocessor | High: 2x-10x common ranges, up to 20x shown in some settings | Medium precompute | Can drop key details in brittle tasks | Best: long-context QA/doc tasks. Anti: strict symbolic tasks unless tuned |
| Model cascade routing | Cheap model first, escalate only if uncertain | Model router | Med-High: ~30-70% typical target; up to very high in research settings | Low decision overhead | Calibration complexity; possible tail latency if escalated | Best: heterogeneous requests. Anti: all tasks require strongest model |
| Strict structured outputs | Schema-constrained outputs for machine-consumed steps | Output contract layer | Low-Med: ~5-25% via retry/parsing repair elimination (estimate) | Initial schema overhead; low steady-state | Schema design burden; feature constraints | Best: tool-heavy systems. Anti: unconstrained creative output |
| Output budget governance | Dynamic `max_output_tokens`, concise contracts, stop criteria | Generation policy | Med: ~15-50% output-token reduction (estimate) | Very low | Over-truncation risk | Best: machine-consumed responses. Anti: long-form prose products |
| Semantic result cache | Cache normalized semantic Q->A/tool results | Front-door/result layer | Med: ~20-60% on repetitive workloads (evidence weaker) | Low-Med | Staleness/invalidation complexity | Best: repeated intents. Anti: highly dynamic data |
| Safe history reduction contracts | Truncate/summarize history while preserving function/tool call-result pairing | Context preprocessor | Med-High: ~20-50% history token reduction with lower quality regression risk vs naive truncation (estimate) | Low-Med | Weak reducers can still hide key state; summarization drift | Best: long-running tool-heavy threads. Anti: one-turn requests |
| Event-runtime interception layer | Pre-delivery hooks to mutate/drop/redact messages before model/tool execution | Runtime/messaging layer | Low direct (0-10%), medium indirect via reduced bad retries and prompt hygiene | Low runtime, medium implementation | Misconfigured interceptors can block needed context | Best: policy/compliance + quality control. Anti: unmanaged hook sprawl |
| Snapshot lineage (`parent_config`, `pending_writes`) | Persist parent snapshot pointer and partial writes for replay/resume integrity | State/checkpoint layer | Low direct, high indirect by preventing replay inflation and duplicate reprocessing | Low read overhead, medium schema migration | Versioning/migration complexity | Best: resumable multi-step orchestration. Anti: ephemeral stateless jobs |
| Budget filtering before routing | Filter candidate deployments by budget before model selection | Routing/policy layer | Low direct tokens, medium spend and fallback efficiency gains | Very low runtime | Overly strict budgets can reduce quality options | Best: multi-tenant cost governance. Anti: single-model fixed pipelines |

Evidence strength notes:
- Strong: provider prompt caching docs; Self-Route; LLMLingua family.
- Medium: cross-domain transfer of cascade/routing gains.
- Weak: semantic cache gains and some budgeting percentages (workload dependent).

## Replace Log-Reading Orchestration

### Primary Architecture (recommended)
- Typed Event Stream + State Projector + Snapshot API + Delta Context Assembler.
- Snapshot contract includes lineage (`parent_config`) and recovery payload (`pending_writes`).
- Runtime path includes optional interception hooks before LLM/tool dispatch.
- Orchestrator reads O(1) latest snapshot + bounded deltas.
- Raw logs stay out of prompt path (audit/debug only).

### Fallback Architecture
- Summaries-by-contract store (strict schema per agent, checksum, freshness timestamp).
- Use when event+sandbox/snapshot infrastructure is not yet available.

### Why this is faster and cheaper
- Avoids replaying/parsing unbounded logs at decision time.
- Prevents accidental token bloat from raw log inclusion.
- Makes context size deterministic and budget-enforceable.

## Runtime Decisions (Normative)
- `BudgetGuard` zero-candidate policy:
  - Default: hard fail with `429_budget_exceeded` and machine-readable reasons.
  - Optional interactive override: one-shot degrade to an allowlisted `emergency_model_tier` under `max_emergency_cost_usd_per_request`; then revert to normal policy.
  - Non-interactive/batch: enqueue with retry-at budget reset boundary; do not auto-upgrade to expensive tier.
- Interception and cache-key order:
  - Hooks run before prompt cache-key generation, so redaction/normalization is reflected in keying and no raw secrets enter cache.
- Snapshot vs stream source of truth:
  - Event stream is canonical.
  - Snapshot is a materialized projection and must include per-partition applied offsets.
  - On mismatch, rebuild snapshot from last durable checkpoint + events after offset.

## Recommended Target Architecture (ASCII)
```text
                +--------------------+
User/API  ----> | Orchestrator Core  | ----+
                | (state machine)    |     |
                +---------+----------+     |
                          |                |
                          v                v
                +----------------+   +------------------+
                | Context        |   | Policy Engine    |
                | Assembler      |   | (token/model/rag)|
                +---+--------+---+   +---+----------+---+
                    |        |           |          |
                    |        |           |          |
                    v        |           v          v
          +----------------+ |   +----------------+ +------------------+
          | Snapshot API   |<----| Model Router   | | Retrieval Service|
          | (latest state) | |   +----------------+ +------------------+
          +-------+--------+ |            |
                  ^          |            v
                  |          |     +-------------+
        +---------+--------+ |     | LLM Gateway |
        | State Projector  | |     | + cache cfg |
        | (apply deltas)   | |     +------+------+ 
        +---------+--------+ |            |
                  ^          |            v
                  |          |     +-------------+
         +--------+---------+ |     | Workers/   |
         | Event Stream     |<------+ Tool Calls |
         | (typed events)   |       +-------------+
         +--------+---------+
                  |
                  v
           +-------------+
           | Raw Logs    |  (cold/audit only; never in prompt path)
           +-------------+
```

## SOLID + DRY Refactor Map

| Module | Responsibility | Key interfaces | SOLID mapping | DRY consolidation |
|---|---|---|---|---|
| `OrchestratorCore` | Step transitions, retries, deadlines | `IStateReader`, `IActionPlanner` | SRP, DIP, OCP | Remove duplicated flow logic |
| `ContextAssembler` | Build minimal context packet from snapshot + deltas | `build_context(run_id, budget)` | SRP, ISP | Single context construction path |
| `PolicyEngine` | Token budgets, model/rag/escalation policy | `decide_model()`, `decide_retrieval_k()` | SRP, OCP | One policy source of truth |
| `BudgetGuard` | Exclude over-budget providers/models/tags before route selection | `filter_candidates(request, candidates)` | SRP, OCP | Remove repeated budget checks in router code paths |
| `ModelRouter` | Dispatch to model/provider tier | `complete(req)` | LSP, DIP | Remove repeated provider selection code |
| `LLMGateway` | Unified provider adapter + retry + timeout + telemetry | `invoke(prompt, schema, cache_key)` | ISP, DIP | One implementation of retries/metrics |
| `HistoryReducer` | Safe truncation/summarization with tool-call/result pairing invariants | `reduce(history, budget)` | SRP, LSP | Remove per-agent ad-hoc trimming logic |
| `InterceptionLayer` | Pre-send message transforms/redaction/drop policy | `on_send(msg)`, `on_publish(msg)` | ISP, OCP | One hook pipeline instead of scattered middleware |
| `StateProjector` | Apply typed deltas to state | `apply(event)` | SRP | Remove ad-hoc state mutation code |
| `EventBusAdapter` | Pub/sub abstraction | `publish()`, `subscribe()` | OCP | One transport abstraction (Kafka/NATS/etc.) |
| `SchemaRegistry` | Versioned payload contracts | `validate(type, payload)` | SRP | One schema package for all agents |
| `TelemetryMeter` | Cost/tokens/latency/quality metrics | `record_usage()` | SRP | Remove duplicated counters/parsers |

## Interface Contracts and Schemas

```json
{
  "event_id": "uuid",
  "idempotency_key": "string",
  "partition_key": "run_id_or_thread_id",
  "sequence": 1042,
  "causal_parent_event_id": "uuid|null",
  "producer_ts": "2026-02-05T12:34:56Z",
  "run_id": "uuid",
  "step_id": "string",
  "agent_id": "string",
  "type": "AGENT_STARTED|AGENT_RESULT|TOOL_RESULT|ERROR|STATE_DELTA",
  "ts": "2026-02-05T12:34:56Z",
  "payload": {},
  "schema_version": "v2"
}
```

```json
{
  "run_id": "uuid",
  "revision": 128,
  "projector_version": "v2",
  "applied_offsets": [{"partition_key":"run-123","sequence":1042}],
  "parent_config": {"checkpoint_id": "uuid", "thread_id": "string"},
  "pending_writes": [{"channel": "string", "task_id": "string", "value": {}}],
  "status": "running|blocked|done|failed",
  "goal": "string",
  "facts": [{"k":"string","v":"string","confidence":0.0}],
  "open_tasks": [{"id":"t1","owner":"agent-x","due_ts":"..."}],
  "tool_artifacts": [{"id":"a1","type":"sql_result","uri":"...","digest":"sha256"}],
  "token_budget": {"remaining_input": 12000, "remaining_output": 4000},
  "updated_at": "2026-02-05T12:34:56Z"
}
```

```json
{
  "interceptor_id": "redaction_v1",
  "criticality": "critical|best_effort",
  "action": "allow|mutate|drop",
  "reason_code": "pii_redacted|policy_blocked|noop",
  "mutated_fields": ["messages[1].content"],
  "duration_ms": 3
}
```

```json
{
  "decision": "allow|deny|degrade",
  "reason_codes": ["provider_budget_exceeded"],
  "candidate_count_before": 6,
  "candidate_count_after": 0,
  "degraded_model": "string|null",
  "retry_after_s": 3600
}
```

```json
{
  "run_id": "uuid",
  "base_snapshot_rev": 128,
  "delta_since_rev": 5,
  "objective": "string",
  "required_facts": ["..."],
  "relevant_artifacts": ["artifact_id"],
  "constraints": {"max_input_tokens": 3000, "max_output_tokens": 400},
  "output_schema_ref": "agent_result_v2"
}
```

```json
{
  "run_id": "uuid",
  "step_id": "string",
  "status": "ok|needs_input|failed",
  "result": {},
  "state_delta": [{"op":"replace","path":"/facts/3","value":{"k":"...","v":"..."}}],
  "quality": {"confidence": 0.82, "self_check": "pass|fail"},
  "usage": {"input_tokens": 932, "cached_input_tokens": 700, "output_tokens": 112},
  "next_action_hint": "string"
}
```

```json
{
  "run_id": "uuid",
  "decision": "small_model|large_model|rag|long_context",
  "reason_codes": ["low_complexity", "cache_hit_expected"],
  "thresholds": {"confidence_min": 0.78},
  "estimated_cost_usd": 0.0021
}
```

## DRY Violations and Consolidation Strategy
- Duplicate prompt preambles across agents -> `PromptTemplateRegistry` with immutable template IDs and hash keys.
- Repeated token accounting in workers -> centralize in `TelemetryMeter.record_usage()`.
- Repeated log-to-state parsing -> replace with `SnapshotAPI.get_latest(run_id)`.
- Repeated ad-hoc transcript trimming -> centralize in `HistoryReducer` with shared invariants.
- Scattered message redaction/guard logic -> centralize in `InterceptionLayer`.
- Budget checks duplicated in routers and providers -> centralize in `BudgetGuard.filter_candidates()`.
- Provider-specific retries/timeouts scattered -> centralize in `LLMGateway` adapters.
- Multiple output JSON formats -> enforce `SchemaRegistry` + strict output contracts.
- Scattered routing heuristics -> centralize in `PolicyEngine` with versioned policies.

## Implementation Contracts
- Event processing semantics:
  - Transport is at-least-once delivery.
  - Projector applies idempotently using `idempotency_key` + `(partition_key, sequence)` monotonic checks.
  - Reject or dead-letter out-of-order events beyond `max_reorder_window`.
- `InterceptionLayer` lifecycle:
  - `on_ingress` -> `on_send_pre_cache_key` -> `cache_key_compute` -> `on_send_post_route` (observe-only) -> dispatch.
  - Hook execution is copy-on-write; original payload retained for audit hash only.
  - Time budget: `<= 5ms` per hook, `<= 20ms` total chain.
  - Failure policy: `critical` hooks fail-closed; `best_effort` hooks fail-open with metric increment.
- `HistoryReducer` invariants:
  - Never leave `function_call_output` without its originating `function_call`.
  - Preserve last `N_recent_raw_turns` unsummarized (default `N=4`).
  - Summary must include: user objective, unresolved tasks, key tool outcomes, and current constraints.
  - Reject reduction if invariant check fails; fallback to truncation-safe mode.
- `BudgetGuard` semantics:
  - Filter candidates pre-routing by provider/model/tag budgets.
  - If no candidates: apply zero-candidate policy from `Runtime Decisions`.
  - Emit `BudgetDecision` event for observability and postmortems.

## Migration and Compatibility
- Schema rollout:
  1. Additive deploy: accept `v1` + `v2`, write `v2`.
  2. Dual-write snapshots (`snapshot_v1`, `snapshot_v2`) for one release window.
  3. Backfill historical snapshots with lineage/offset defaults.
  4. Cut read path to `v2` behind feature flag.
  5. Decommission `v1` after 2 stable weeks and no rollback triggers.
- Replay safety:
  - Keep event retention >= `max_snapshot_gap + backfill_window`.
  - Snapshot rebuild command must be idempotent and rate-limited.

## Implementation Roadmap

| Phase | Window | Scope | Token reduction | Latency impact | Effort | Risk |
|---|---|---|---|---|---|---|
| Phase 1 (Quick wins) | 1-2 weeks | Canonical prompts, provider caching, strict outputs, output budgets, usage telemetry | ~25-45% | ~10-25% p95 improvement | M | Low |
| Phase 2 (Structural) | 2-6 weeks | Event schema v2, projector idempotency/offset tracking, snapshot API with lineage/pending writes, delta packets, safe history reduction contracts, migration dual-write | additional ~25-40% (cumulative ~50-70%) | additional ~10-20% | L | Med |
| Phase 3 (Optimize/harden) | 6+ weeks | Adaptive routing, budget pre-filtering with zero-candidate policy, runtime interception lifecycle, safe compression, semantic cache, hardening drills | additional ~10-20% (cumulative ~60-80%) | additional ~5-15% | M-L | Med |

## Prioritized Backlog

### P0
- Introduce `SchemaRegistry` and enforce `AgentResult` contract.
- Canonicalize prompts and enable cache metrics (`cached_input_tokens` equivalent).
- Add token and output budgets in `PolicyEngine`.
- Enforce strict structured outputs for machine-consumed steps.
- Ship dashboard metrics (cost/tokens/p95/schema validity/quality).

### P1
- Implement typed `EventEnvelope` bus.
- Add `partition_key`, monotonic `sequence`, and `idempotency_key` fields; enforce projector checks.
- Build `StateProjector` and `SnapshotAPI`.
- Refactor orchestrator to consume snapshots/deltas only.
- Add snapshot lineage and `pending_writes` to checkpoint schema/contracts.
- Add `applied_offsets` tracking in snapshots.
- Implement adaptive RAG/LC and small/large routing.
- Implement `HistoryReducer` with tool-call/result pairing guarantees.
- Add prefix-stability linting and cache key strategy.

### P2
- Add `BudgetGuard` pre-routing filter across provider/model/tag budget dimensions.
- Add `InterceptionLayer` hooks (`on_send`, `on_publish`) for redaction/drop/transform policy.
- Implement zero-candidate policy (`deny|degrade|queue`) and `BudgetDecision` telemetry.
- Enforce interceptor SLOs and failure-mode configuration (`critical` vs `best_effort`).
- Enable prompt compression on selected long-context paths.
- Add semantic cache with TTL and invalidation.
- Add telemetry-driven policy auto-tuning.
- Add resilience drills (snapshot rebuild, event replay, schema migration).

## KPI Dashboard Definition

### Core cost/efficiency
- `cost_per_request_usd`: total model + retrieval + orchestration infra / terminal requests in 15-minute windows.
- `tokens_per_request`: `(input_uncached + input_cached + output) / terminal requests`, segmented by route/model tier.
- `cache_hit_rate` = `cached_input_tokens / total_input_tokens`
- `orchestration_overhead_tokens`: orchestrator-only model tokens / total model tokens.

### Latency
- `p50/p95/p99 end_to_end_latency_ms`
- `p95 orchestrator_decision_ms`
- `p95 model_ttft_ms`
- `p95 tool_execution_ms`

### Quality guardrails
- `task_success_rate`: successful terminal runs / all terminal runs (same task class, same window).
- `schema_valid_rate`
- `tool_call_success_rate`
- `fallback_escalation_rate`
- `groundedness_or_hallucination_proxy`: score from fixed evaluator set with weekly calibration; report mean and p10.

### Operational
- `snapshot_staleness_ms`
- `event_projection_lag_ms`
- `error_budget_burn`

## Validation Plan

### A/B sequence
1. Baseline for 7 days.
2. A/B-1: Phase 1 only (10-20% traffic).
3. A/B-2: Add snapshot/delta architecture (10-20% traffic).
4. A/B-3a: Add adaptive routing only (10-20% traffic).
5. A/B-3b: Add compression only (10-20% traffic).
6. A/B-3c: routing + compression interaction test (10% traffic).

### Acceptance thresholds
- `tokens_per_request` down >= 40%.
- `orchestration_overhead_tokens` down >= 80%.
- `p95 latency` down >= 20%.
- `task_success_rate` non-inferior within -1.0% absolute.
- `schema_valid_rate` >= 99.5%.

### Rollback criteria
- Quality drop > 2.0% absolute for 2 consecutive hours.
- p95 latency regression > 15% for 2 consecutive hours.
- Error rate > 2x baseline.
- Snapshot staleness SLO breach > 5 minutes.
- Interceptor chain p95 > 20ms for 2 consecutive hours.
- Event out-of-order/drop beyond `max_reorder_window` > 0.5% for 30 minutes.

## Sources
- OpenAI Prompt Caching: https://platform.openai.com/docs/guides/prompt-caching
- OpenAI Structured Outputs: https://openai.com/index/introducing-structured-outputs-in-the-api/
- Anthropic Prompt Caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Gemini Caching: https://ai.google.dev/gemini-api/docs/caching
- Gemini Implicit Caching: https://developers.googleblog.com/en/gemini-2-5-models-now-support-implicit-caching/
- Self-Route (RAG vs LC): https://aclanthology.org/2024.emnlp-industry.66/
- FrugalGPT: https://arxiv.org/abs/2305.05176
- LLMLingua: https://arxiv.org/abs/2310.05736
- LongLLMLingua: https://arxiv.org/abs/2310.06839
- Lost in the Middle: https://doi.org/10.1162/tacl_a_00638
- Findings 2025 context length study: https://aclanthology.org/2025.findings-emnlp.1264/
- LangGraph persistence/checkpoints: https://docs.langchain.com/oss/python/langgraph/persistence
- Temporal event history limits: https://docs.temporal.io/workflow-execution/event
- Kafka log compaction: https://docs.confluent.io/kafka/design/log_compaction.html
