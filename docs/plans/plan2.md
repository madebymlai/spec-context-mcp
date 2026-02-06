# System-Wide LLM Runtime Remediation Plan (Token-Efficient, Prompt-Strong, SOLID/DRY)

## 1) Scope and Objective

This plan replaces the current partial runtime rollout with a fully enforceable, system-wide architecture that:

- Eliminates orchestrator raw-log reading from hot paths.
- Enforces deterministic runtime contracts for budget, interception, events, snapshots, and schema.
- Maximizes token savings via provider-native prompt caching + canonical prompt prefixing.
- Preserves prompt-engineering power (quality) while minimizing latency and engineering overhead.

This plan addresses all findings from the latest diff review and is implementation-ready.

## 2) Assumptions (Explicit)

- Runtime ownership for orchestration is TypeScript (`src/core/llm/*`, `src/dashboard/*`); `chunkhound/*` is search/research backend scope.
- Event stream + snapshot remain the long-term state substrate (not raw logs).
- Model mix may include OpenAI/Codex, Claude, Gemini through direct SDKs or routed adapters.
- Current date context for doc interpretation: February 6, 2026.

---

## 3) Findings-to-Fixes Matrix (All Issues Closed)

| ID | Severity | Issue | Required fix | Code touchpoints | Acceptance criteria |
|---|---|---|---|---|---|
| F1 | Critical | Wrapper bypass via raw `__getattr__` passthrough | Remove executable passthrough; explicitly proxy allowed methods only via policy-enforced adapter | `chunkhound/providers/llm/runtime_policy_provider.py`, `chunkhound/providers/llm/__init__.py`, `chunkhound/llm_manager.py` | No provider execution path can run without interception+budget+events+snapshot; test fails if direct provider method bypasses wrapper |
| F2 | Critical | Cross-run snapshot/event contamination | Require `run_id`/`thread_id` from caller; fallback to per-request UUID only | `chunkhound/providers/llm/runtime_policy_provider.py`, TS runtime context entrypoints | Distinct requests never share `run_id` unless explicitly provided; snapshot lineage and offsets isolated |
| F3 | High | Non-interactive policy violated by emergency degrade | Enforce mode-aware zero-candidate policy: interactive may degrade, non-interactive must deny/queue | `chunkhound/providers/llm/runtime_policy_provider.py`, `src/core/llm/budget-guard.ts`, `src/dashboard/multi-server.ts` | Batch/non-interactive returns structured deny/queue; no auto-upgrade/degrade path |
| F4 | High | Blocking sync I/O in async path | Move event/snapshot persistence to async buffered writer (queue + flush worker) | `chunkhound/providers/llm/runtime_policy_provider.py` | p95 no longer regresses under concurrent calls due to file I/O stalls |
| F5 | High | Dashboard event stream not canonical/durable | Promote event stream + snapshot store to app-singleton lifecycle, injected once at server boot | `src/dashboard/multi-server.ts`, `src/dashboard/services/ai-review-service.ts` | Events survive request boundaries; replay and projector rebuild supported |
| F6 | Medium | Post-route intercept stage mutates payload | Lock `on_send_post_route` to observe-only, immutable input | `src/core/llm/interception-layer.ts`, `src/core/llm/openrouter-chat.ts` | Mutation at post-route hook rejected with explicit error |
| F7 | Medium | TS event sequence contract broken (`sequence: 0`) | Centralize sequence assignment in event stream component | `src/core/llm/runtime-event-stream.ts`, callers | `(partition_key, sequence)` monotonic, gap-safe policy documented/tested |
| F8 | Medium | Budget deny mapped to HTTP 500 | Map budget denials to `429` + reason codes | `src/dashboard/multi-server.ts` | Budget exhaustion returns machine-readable 429 payload |
| F9 | Medium | Planned modules missing | Implement SchemaRegistry, PromptTemplateRegistry, TelemetryMeter, StateProjector, EventBusAdapter | `src/core/*`, `chunkhound/*` shared contracts | No ad-hoc schema parsing, no duplicated prompt builders, no custom one-off telemetry emitters |
| F10 | Low/Med | Only local cache-key telemetry; no provider-native caching integration | Implement provider-native cache policy + canonical prefix governance | `src/core/llm/openrouter-chat.ts`, provider adapters, prompt compiler | Cached-token fields are captured and hit-rate improves measurably |

---

## 4) Architecture Decision: Replace Log-Reading Orchestration

### Primary architecture (recommended)

Event stream is canonical; snapshots are materialized projections; orchestrator consumes snapshot + bounded deltas only.

```text
[Ingress/API]
    |
    v
[RuntimeContextFactory] --(run_id, mode, tenant, idempotency_key)-------------------+
    |                                                                            |
    v                                                                            v
[PolicyEngine + BudgetGuard] -> [InterceptionLayer(pre-cache-key)] -> [LLMGateway + ProviderCacheAdapter]
    |                                                                            |
    |                                                                            v
    |                                                               [EventBusAdapter.publish(EventEnvelopeV2)]
    |                                                                            |
    +---------------------------------------------------------------------> [StateProjector]
                                                                                 |
                                                                                 v
                                                                       [SnapshotStore(StateSnapshotV2)]
                                                                                 |
                                                                                 v
                                                                        [ContextAssembler(snapshot+deltas)]
                                                                                 |
                                                                                 v
                                                                            [Orchestrator]
```

### Fallback architecture

If durable bus not yet available: structured summaries-by-contract with strict schema + checksums + freshness, and no raw-log replay in orchestration path.

### Why this is faster and cheaper

- Avoids repeated log parsing + prompt inflation.
- Keeps orchestration context O(1) snapshot + small delta window.
- Supports deterministic replay without re-tokenizing historical logs.

---

## 5) Provider-Native Prompt Caching Strategy (Gemini, Claude, Codex/OpenAI)

## 5.1 Research-backed implementation decisions

### OpenAI / Codex-family (OpenAI Prompt Caching)

- Prompt caching is automatic for prompts >= 1024 tokens.
- Cache hits operate on exact prefixes; thresholds advance in 128-token increments.
- Use `prompt_cache_key` to improve routing locality and hit rates for shared prefixes.
- Retention policy available: `in_memory` (default) or `24h` (where supported models allow it).
- Capture `usage.prompt_tokens_details.cached_tokens` per request.

Implementation:

- Always compute deterministic `prompt_cache_key` from `{tenant}:{template_id}:{tools_hash}:{schema_hash}:{model}`.
- Default to `in_memory`; only use `24h` for low-churn, high-reuse prefixes.
- Build guardrail: if prefix churn rate > threshold, disable extended retention to prevent waste.

### Anthropic / Claude (Prompt Caching)

- Cache is explicit using `cache_control` blocks.
- Default cache type is `ephemeral` with 5-minute TTL; optional `ttl: "1h"` is supported.
- Minimum cacheable prompt length is model-dependent (1024 for Sonnet/Opus families; 2048 for Haiku families).
- Cache hierarchy/order sensitivity: `tools -> system -> messages`; upstream changes invalidate downstream cache layers.
- Track `cache_creation_input_tokens` and `cache_read_input_tokens`.

Implementation:

- Insert cache breakpoints at tool definitions, system prompt, and stable few-shot segment only.
- For mixed TTL usage, enforce ordering rule in prompt compiler.
- Batch/concurrent request fan-out waits for initial cache creation when high hit-ratio is required.

### Gemini (Context Caching)

- Implicit caching is default on supported models; optimize by stable large prefixes and temporal locality.
- Explicit caching via `client.caches.create` + `GenerateContentConfig.cached_content` with configurable TTL.
- Token-hit visibility via `usage_metadata` (`cached_content_token_count` etc.).
- Explicit cache TTL defaults to 1 hour if unspecified.

Implementation:

- Use explicit caches for large static artifacts (docs/repos/media/instructions) and repeated workflows.
- Use implicit caching for short-lived, naturally repetitive prefix traffic.
- Maintain cache registry keyed by `(model, artifact_hash, policy_ttl)`; rehydrate from metadata only.

## 5.2 Universal approach (framework/provider agnostic)

Implement a provider-neutral `PromptCachePolicy` + `PromptPrefixCompiler`:

1. Compile prompt into deterministic segments:
- `S1 tools`
- `S2 system`
- `S3 static exemplars`
- `S4 dynamic conversation tail`

2. Compute stable hashes per segment.

3. Provider adapter translates policy to native controls:
- OpenAI: `prompt_cache_key`, optional `prompt_cache_retention`.
- Claude: `cache_control` on selected blocks + optional TTL.
- Gemini: explicit `cached_content` handles or implicit-only path.

4. Emit unified telemetry contract:
- `cached_input_tokens`
- `cache_write_tokens`
- `cache_hit_rate`
- `cache_retention_policy`
- `cache_miss_reason`

This gives one orchestration API while exploiting native provider wins.

---

## 6) Pattern Ratings (Token Efficiency vs Prompt Engineering Power)

Scale: 1 (low) to 10 (high)

| Pattern | Token efficiency | Prompt engineering power | Long-term decision |
|---|---:|---:|---|
| Provider-native caching + canonical prefix compiler | 10 | 8 | Core mandatory path |
| Safe history reduction contracts | 7 | 8 | Keep; quality-preserving reducer |
| Event-runtime interception layer | 4 | 6 | Keep as guardrail/policy layer, not primary saver |
| Snapshot schema with `parent` + `pending_writes` | 6 | 4 | Keep for replay/resume correctness |
| Budget filtering before routing | 5 | 3 | Keep for spend control + routing stability |

Why the four lower-scoring patterns still stay:

- They are second-order token optimizers but first-order reliability controls.
- They prevent regressions that reintroduce token waste (retries, replay inflation, poor routing, policy failures).

---

## 7) SOLID + DRY Refactor Map

## 7.1 Modules and responsibilities

| Module | Responsibility | SOLID mapping | DRY consolidation |
|---|---|---|---|
| `RuntimeContextFactory` | Build immutable runtime context | SRP | Single creation path for run metadata |
| `PolicyEngine` | Budget + routing + mode policy decisions | SRP/OCP | Remove duplicated budget logic |
| `BudgetGuard` | Candidate filtering + zero-candidate semantics | SRP/OCP | One deny/degrade/queue implementation |
| `InterceptionLayer` | Pre-send transforms + post-route observe-only hooks | ISP/OCP | Remove scattered redaction/mutation logic |
| `PromptTemplateRegistry` | Versioned prompt templates + canonical segment ordering | SRP | Single template source |
| `PromptPrefixCompiler` | Deterministic prefix/tail build + cache keys | SRP/LSP | Remove per-provider ad-hoc prompt assembly |
| `ProviderCacheAdapter` | Translate universal cache policy to provider-native controls | DIP/OCP | One adapter surface per provider |
| `LLMGateway` | Unified provider invocation, retries, timeout, tracing | ISP/DIP | One runtime invocation stack |
| `EventBusAdapter` | Publish/subscribe abstraction | DIP/OCP | Remove transport-specific event writes |
| `StateProjector` | Apply events to materialized state with idempotency | SRP | Remove ad-hoc snapshot mutation |
| `SnapshotStore` | Read/write snapshots + offset metadata | SRP | One snapshot persistence API |
| `SchemaRegistry` | Versioned schema validation for events, outputs, snapshots | SRP | Remove duplicate schema checks |
| `TelemetryMeter` | Unified metrics contract emission | SRP | One metrics schema, no custom counters |

## 7.2 Interface contracts (implementation target)

### `RuntimeContext`

```json
{
  "run_id": "uuid",
  "thread_id": "string",
  "tenant_id": "string",
  "interactive": true,
  "idempotency_key": "string",
  "request_ts": "ISO8601"
}
```

### `EventEnvelopeV2`

```json
{
  "event_id": "uuid",
  "partition_key": "tenant:thread",
  "sequence": 123,
  "run_id": "uuid",
  "type": "llm.requested|llm.responded|budget.denied|snapshot.updated",
  "payload": {},
  "schema_version": "v2",
  "created_at": "ISO8601"
}
```

### `StateSnapshotV2`

```json
{
  "run_id": "uuid",
  "snapshot_rev": 42,
  "parent_snapshot_rev": 41,
  "applied_offsets": {"tenant:thread": 123},
  "pending_writes": [{"path": "context.messages", "op": "append", "value": {}}],
  "state": {},
  "schema_version": "v2",
  "updated_at": "ISO8601"
}
```

### `BudgetDecision`

```json
{
  "decision": "allow|deny|degrade|queue",
  "reason_codes": ["provider_budget_exceeded"],
  "interactive": false,
  "http_status": 429
}
```

### `PromptCacheTelemetry`

```json
{
  "provider": "openai|anthropic|gemini",
  "model": "string",
  "cache_policy": "implicit|explicit|in_memory|24h|5m|1h",
  "cached_input_tokens": 0,
  "cache_write_tokens": 0,
  "cache_hit_rate": 0.0,
  "cache_miss_reason": "prefix_mismatch|ttl_expired|min_tokens_not_met|routing_overflow"
}
```

---

## 8) Phased Execution Plan

## Phase 1 (Week 1-2): Contract correctness + fast wins

P0 tasks:

- Remove provider bypass (`__getattr__` execution passthrough).
- Introduce required `RuntimeContext`; fix run identity contamination.
- Enforce non-interactive deny/queue semantics.
- Return budget deny as HTTP 429 structured payload.
- Lock post-route intercept to observe-only.
- Centralize event sequencing.
- Add provider-native caching integration on primary model path (OpenAI first if fastest adoption).

Expected impact:

- Token reduction: 15-30% (primarily via cache hits and reduced retries/rework).
- Latency: p95 improvement 10-20% on repetitive flows.
- Engineering effort: M.
- Risk: Low-Medium.

## Phase 2 (Week 2-6): Structural refactor (SOLID/DRY)

P0/P1 tasks:

- Implement `SchemaRegistry`, `PromptTemplateRegistry`, `TelemetryMeter`.
- Implement `EventBusAdapter` and `StateProjector` with idempotent replay.
- Promote event/snapshot lifecycle to app singletons.
- Move async file persistence to buffered sink worker.
- Add `PromptPrefixCompiler` + `ProviderCacheAdapter` for Claude and Gemini paths.

Expected impact:

- Additional token reduction: 15-25% (cumulative 30-55%).
- Additional latency gain: 8-15%.
- Engineering effort: L.
- Risk: Medium.

## Phase 3 (Week 6+): Optimization + hardening

P1/P2 tasks:

- Add adaptive TTL/caching policy by workload segment.
- Add cache-miss diagnostics and auto-tuning of prefix stability.
- Add resilience drills: snapshot rebuild, event replay, cache outage fallback.
- Add quality guardrails to ensure reductions do not degrade answer quality.

Expected impact:

- Additional token reduction: 10-20% (cumulative 40-70% depending workload).
- Additional latency gain: 5-10%.
- Engineering effort: M-L.
- Risk: Medium.

## 8.1 PR Execution Packages (Ticketized, with Dependencies and DoD)

| PR | Scope | Owner | Depends on | Estimate | Definition of Done |
|---|---|---|---|---|---|
| PR-01 | Runtime wrapper hardening (`F1`) remove executable passthroughs | Python platform | none | 2-3 days | All provider execution methods pass through policy wrapper; bypass regression tests green |
| PR-02 | RuntimeContext propagation + run identity fix (`F2`) | Python + TS runtime | PR-01 | 2-3 days | `run_id` required at ingress (or UUID fallback), no cross-run state contamination in tests |
| PR-03 | Budget semantics (`F3`,`F8`) interactive/non-interactive + HTTP 429 mapping | TS API + Python policy | PR-02 | 2 days | Non-interactive never auto-degrades; budget denies return structured 429 |
| PR-04 | Interception contract (`F6`) post-route observe-only | TS runtime | PR-03 | 1-2 days | Mutation in `on_send_post_route` rejected and tested |
| PR-05 | Event sequence centralization (`F7`) + envelope invariants | TS runtime | PR-02 | 2 days | Monotonic `(partition_key, sequence)` assigned in one component only |
| PR-06 | App-singleton event/snapshot lifecycle (`F5`) | TS dashboard | PR-05 | 2-3 days | Event stream and snapshot store survive request boundaries; replay test passes |
| PR-07 | Async buffered persistence (`F4`) | Python runtime | PR-02 | 3-4 days | No sync writes on async hot path; concurrency/p95 test passes |
| PR-08 | Missing modules (`F9`): `SchemaRegistry`, `PromptTemplateRegistry`, `TelemetryMeter`, `StateProjector`, `EventBusAdapter` | Cross-runtime | PR-05, PR-06 | 1-2 weeks | All five modules live and wired; no duplicate schema/prompt/telemetry logic remains |
| PR-09 | Provider-native caching (`F10`) + universal cache adapter | LLM integrations | PR-08 | 1 week | OpenAI/Claude/Gemini native controls supported with unified telemetry fields |
| PR-10 | Hardening + rollout tooling (flags, kill-switches, migration scripts) | Platform + SRE | PR-01..09 | 3-4 days | Feature flags, rollback scripts, and runbooks validated in staging |

Execution cadence:

1. Merge PR-01..PR-03 before any traffic rollout.
2. Merge PR-04..PR-07 in parallel where dependencies permit.
3. Merge PR-08/PR-09 before Phase 2 traffic increase.
4. Merge PR-10 before >25% rollout.

---

## 9) Prioritized Backlog

### P0 (must ship first)

- Enforce system-wide wrapper invariants (no bypass path).
- RuntimeContext required end-to-end.
- 429 budget denial contract.
- Post-route observe-only enforcement.
- Monotonic event sequence enforcement.
- App-level event/snapshot singleton wiring.
- OpenAI/Claude/Gemini cache telemetry capture in unified meter.

### P1

- SchemaRegistry + PromptTemplateRegistry + ProviderCacheAdapter.
- StateProjector with idempotency and offset tracking.
- Async buffered persistence layer.
- Safe history reduction contract implementation.

### P2

- Adaptive cache retention policy.
- Auto-tuning for cache key granularity.
- Cost-aware routing with quality floor enforcement.
- Replay/drill automation and failure game-days.

---

## 10) KPI Dashboard (Definition)

- `cost_per_request_usd`
- `tokens_per_request_total`
- `tokens_input_uncached`
- `tokens_input_cached`
- `tokens_output`
- `cache_hit_rate`
- `cache_write_tokens`
- `p95_latency_ms`
- `budget_denial_rate`
- `schema_valid_rate`
- `event_projection_lag_ms`
- `snapshot_staleness_ms`
- `quality_pass_rate` (task-specific)

Guardrail thresholds:

- No quality regression > 1.0 percentage point.
- Schema validity >= 99.5%.
- Budget-denial mapping correctness = 100% (`429_budget_exceeded`).

---

## 11) Validation Plan

A/B rollout:

1. Baseline (current runtime) capture 7 days.
2. Phase 1 at 10% traffic; compare tokens/request, p95, quality.
3. Phase 2 at 25% traffic after contract tests pass.
4. Full rollout after two stable windows.

Rollback criteria:

- p95 latency degradation > 15% for > 30 minutes.
- cache_hit_rate drops > 25% from control after rollout.
- schema_valid_rate < 99.5%.
- any cross-run contamination detected.

Acceptance thresholds:

- >= 25% token reduction by end of Phase 1+2 on repetitive workloads.
- >= 15% p95 improvement on cached-prefix flows.
- Zero bypass findings in runtime conformance tests.

## 11.1 Contract Test Matrix (Mapped to F1-F10)

| Finding | Test type | Test location | Required assertions |
|---|---|---|---|
| `F1` wrapper bypass | Python unit | `chunkhound/tests/test_llm_manager_runtime_wrapping.py` | Provider-specific execution methods cannot bypass runtime wrapper |
| `F2` run contamination | Python unit + TS integration | `chunkhound/tests/test_llm_runtime_policy_provider.py`, `src/core/llm/runtime-state.test.ts` | Distinct requests produce distinct run identities unless explicitly shared |
| `F3` mode-aware budget | TS unit + service integration | `src/core/llm/budget-guard.test.ts`, `src/dashboard/services/ai-review-service.test.ts` | Non-interactive denies/queues; interactive can degrade only when configured |
| `F4` async persistence | Python concurrency | `chunkhound/tests/test_llm_runtime_policy_provider.py` (add async I/O benchmark case) | No blocking sync writes on event loop path; bounded flush latency |
| `F5` singleton runtime state | TS integration | `src/dashboard/services/ai-review-service.test.ts` | Event stream and snapshots persist across requests within server lifecycle |
| `F6` observe-only post-route | TS unit | `src/core/llm/interception-layer.test.ts` | Mutations in post-route hook are rejected |
| `F7` event sequencing | TS unit | `src/core/llm/runtime-state.test.ts` | Monotonic sequence per partition; idempotency preserved |
| `F8` HTTP budget mapping | API integration | `src/dashboard/services/ai-review-service.test.ts` + API handler tests | Budget deny emits `429` with machine-readable reason codes |
| `F9` missing modules | TS/Python unit | new tests under `src/core/contracts/*.test.ts` and `chunkhound/tests/*schema*.py` | Registry/projector/adapter modules validate contracts and versions |
| `F10` native caching | Integration smoke | `src/core/llm/*provider*.test.ts` (add) | Provider-native cache controls emitted and usage telemetry captured |

Minimum CI gate for rollout:

1. `python -m pytest chunkhound/tests/test_llm_manager_runtime_wrapping.py chunkhound/tests/test_llm_runtime_policy_provider.py`
2. `npm test -- src/core/llm/runtime-state.test.ts src/core/llm/interception-layer.test.ts src/core/llm/budget-guard.test.ts src/dashboard/services/ai-review-service.test.ts`
3. Add one load/concurrency run in CI nightly for `F4` (event-loop blocking regression guard).

---

## 12) Practitioner Evidence Integrated

Patterns implemented by active production ecosystems:

- LangGraph checkpointing with thread/checkpoint lineage + pending writes:
  - https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint/README.md
  - https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint/langgraph/checkpoint/base/__init__.py
- LiteLLM routing + provider budget controls + fallbacks:
  - https://github.com/BerriAI/litellm/blob/main/litellm/router.py
  - https://github.com/BerriAI/litellm/blob/main/litellm/budget_manager.py
- OpenAI Agents session compaction pattern (history compaction trigger + server-assisted reduction):
  - https://github.com/openai/openai-agents-python/blob/main/src/agents/memory/openai_responses_compaction_session.py
- Prompt caching implementation examples:
  - Anthropic: https://github.com/anthropics/anthropic-cookbook/blob/main/misc/prompt_caching.ipynb
  - OpenAI: https://github.com/openai/openai-cookbook/blob/main/examples/Prompt_Caching101.ipynb
  - Gemini SDK cache APIs: https://github.com/googleapis/python-genai/blob/main/docs/_sources/index.rst.txt

---

## 13) Official Documentation References (Native Caching)

- OpenAI Prompt Caching guide: https://platform.openai.com/docs/guides/prompt-caching
- OpenAI Prompt Caching launch article: https://openai.com/index/api-prompt-caching/
- Gemini Context Caching: https://ai.google.dev/gemini-api/docs/caching
- Anthropic Prompt Caching: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching

---

## 14) Schema Migration and Rollback Runbook (EventEnvelopeV2 / StateSnapshotV2)

Forward migration:

1. Introduce dual-read support (`v1` + `v2`) in all consumers.
2. Enable dual-write for snapshots/events (`v1` and `v2`) behind feature flag.
3. Backfill historical snapshots with defaults:
- `parent_snapshot_rev = null` when unknown.
- `applied_offsets = {}` when unknown.
- `pending_writes = []` when unknown.
4. Validate parity:
- `v2` projector output must match `v1` materialized state for sampled runs.
5. Switch readers to `v2` primary; keep `v1` shadow reads for one release window.
6. Disable `v1` writes only after parity and lag SLOs hold for 7 days.

Rollback:

1. Flip read flag to `v1` only.
2. Keep `v2` writes disabled and preserve stored `v2` for forensic replay.
3. Rebuild snapshots from last verified `v1` checkpoint + event offsets.
4. Block new schema migrations until root-cause report is closed.

Migration acceptance:

- `schema_valid_rate >= 99.5%`
- `event_projection_lag_ms` within SLO
- No data-loss in sampled replay checks

---

## 15) Feature Flags and Kill-Switch Matrix

| Flag | Default | Scope | Kill-switch behavior |
|---|---|---|---|
| `llm_runtime_enforce_wrapper` | on in staging, off in prod until PR-01 | Python runtime | Reverts to previous wrapper while preserving telemetry |
| `llm_runtime_require_context` | off initially | API ingress + runtime | Allows temporary UUID fallback if ingress propagation fails |
| `llm_budget_mode_aware` | off initially | BudgetGuard + policy engine | Falls back to strict deny-only mode |
| `llm_interception_post_route_observe_only` | on | TS runtime | Disables post-route hook chain entirely if violations detected |
| `llm_event_sequence_centralized` | on | event stream | Reverts to legacy sequencing with alarmed degradation |
| `llm_state_singleton_lifecycle` | off initially | dashboard server | Reverts to per-request lifecycle (temporary only) |
| `llm_async_persistence` | off initially | Python runtime | Falls back to sync writes with explicit p95 alerting |
| `llm_schema_v2_dual_write` | off initially | events/snapshots | Stops `v2` writes immediately |
| `llm_provider_native_cache` | off initially | provider adapters | Reverts to local hash-only cache telemetry mode |
| `llm_prompt_prefix_compiler` | off initially | prompt assembly | Reverts to legacy prompt build path |

Flag rollout rule:

1. Enable one major flag cluster at a time per environment.
2. Hold for one error-budget window before enabling dependent flags.

---

## 16) Provider Capability Guards and Fallback Rules

| Provider | Native control | Guard condition | Fallback |
|---|---|---|---|
| OpenAI/Codex | `prompt_cache_key`, retention policy | Model does not support requested retention or cache metadata absent | Send `prompt_cache_key` only; downgrade retention to default and emit `cache_miss_reason=capability_downgrade` |
| Claude | `cache_control` block + optional `ttl` | Cacheable tokens below model minimum, or unsupported block type | Remove cache markers for invalid blocks; keep canonical prefix and record `min_tokens_not_met` |
| Gemini | explicit `cached_content` + implicit caching | Cache create/get failure, invalid cached handle, unsupported endpoint | Fall back to implicit-only path and continue request |

Provider guard requirements:

- Capability check occurs before dispatch.
- Requests never fail solely due to cache feature mismatch.
- Every downgrade emits telemetry with structured reason code.

---

## 17) Capacity and SLO Sizing for State Plane

Planning inputs (initial, revise after 2-week baseline):

- Peak request rate (`RPS_peak`): measure from gateway.
- Average events per request (`E_req`): target 4-8.
- Snapshot frequency: every terminal step or every `N` events (target `N=20` for long runs).

Derived capacity formulas:

- Event write throughput = `RPS_peak * E_req`.
- Snapshot write throughput = `RPS_peak * snapshot_ratio`.
- Storage/day = `(avg_event_bytes * events/day) + (avg_snapshot_bytes * snapshots/day)`.

SLO targets:

- `event_projection_lag_ms` p95 <= 2000 ms
- `snapshot_staleness_ms` p95 <= 5000 ms
- Event publish failure rate <= 0.1%
- Snapshot write failure rate <= 0.1%

Operational controls:

- Backpressure when projector lag exceeds threshold.
- Bounded in-memory queue with drop-to-disk emergency path.
- Automatic snapshot compaction and retention job.

---

## 18) Security, Privacy, and Retention Controls

Data classes:

1. `public_runtime_metadata` (non-sensitive)
2. `sensitive_prompt_segments` (PII/secrets/user data)
3. `audit_events` (security and policy logs)

Controls:

- Interception layer redacts secrets before cache-key generation.
- Sensitive segments are excluded from reusable cached prefixes unless explicitly approved.
- Per-tenant encryption at rest for snapshots and event logs.
- Strict tenant partition keys (`tenant_id` required) for all events/snapshots.
- Provider retention policy defaults to shortest practical:
  - OpenAI: default retention unless business case approves extended.
  - Claude: prefer `ephemeral` 5m unless workload requires `1h`.
  - Gemini: explicit cache TTL minimized; auto-expire unused caches.

Retention policy:

- Runtime events: 30 days hot, 90 days cold (configurable by tenant policy).
- Snapshots: keep latest + periodic checkpoints; purge orphaned snapshots.
- Cache registry metadata: 30 days; no raw sensitive prompt payload storage.

Audit requirements:

- Log all flag changes, schema migrations, and cache policy downgrades.
- Weekly report: top cache miss reasons, budget denials, and privacy redaction counts.

---

## 19) Final Definition of Done (10/10 Ready Gate)

Plan is considered implementation-ready only when all are true:

1. Every finding `F1-F10` has a mapped PR, test, owner, and measurable acceptance criteria.
2. Migration and rollback runbooks are approved by platform + SRE owners.
3. Feature flags and kill-switches exist for each high-risk subsystem.
4. Provider capability downgrades are non-fatal and telemetry-complete.
5. Capacity/SLO budgets are quantified with alert thresholds.
6. Security/retention controls are specified per tenant and provider.
7. CI gate includes required Python + TS contract tests and nightly concurrency regression checks.
