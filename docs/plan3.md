# Plan 3 - Final Gap Fixes (Against `plan.md` + `plan2.md` vs Current Diff)

Date: 2026-02-06
Scope checked: `src/core/llm/*`, `src/dashboard/*`, `src/config/discipline*`, workflow prompts, current git diff.

This file lists only remaining fixes required to make the implementation match the plan intent (token efficiency, prompt power, bug resistance, SOLID/DRY).

## P0 (must fix)

### P0-1
PROBLEM: `SchemaRegistry`, `PromptTemplateRegistry`, `TelemetryMeter`, `StateProjector`, and `EventBusAdapter` exist but are mostly test-only; production flow still does ad-hoc event/snapshot/prompt handling (`src/core/llm/openrouter-chat.ts`, `src/dashboard/services/ai-review-service.ts`). This fails plan2 PR-08 DoD.

FIX: Wire these modules into the hot path: route all runtime events through `EventBusAdapter` -> validate via `SchemaRegistry` -> project via `StateProjector` -> persist via `RuntimeSnapshotStore`, and compile prompts through `PromptTemplateRegistry` for all AI-review calls.

### P0-2
PROBLEM: Cache key generation hashes full request payload (`src/core/llm/openrouter-chat.ts`), which destroys prefix locality and sharply reduces cache hit rate for iterative workflows.

FIX: Replace full-payload hash with deterministic prefix/tail compilation (stable prefix hash + dynamic tail hash) using a single `PromptPrefixCompiler` integrated with `PromptTemplateRegistry`.

### P0-3
PROBLEM: No universal provider cache adapter layer in `src`; caching is OpenRouter-only request flags and not normalized to a common telemetry contract (`cached_input_tokens`, `cache_write_tokens`, `cache_miss_reason`). This leaves plan2 F10 incomplete.

FIX: Introduce `ProviderCacheAdapter` in `src/core/llm` and route provider controls through it, even if current runtime is OpenRouter-first; emit normalized cache telemetry fields from one place.

### P0-4
PROBLEM: `RuntimeEventStream` is in-memory only and unbounded (`src/core/llm/runtime-event-stream.ts`), so process restarts lose canonical state and long-running sessions risk memory growth.

FIX: Add bounded idempotency/event retention plus async durable JSONL sink; load offsets on startup to preserve sequence continuity per partition.

### P0-5
PROBLEM: `RuntimeSnapshotStore.upsert()` writes full snapshot file synchronously every call (`src/core/llm/runtime-snapshot-store.ts`), adding avoidable I/O latency to the request path.

FIX: Add buffered/coalescing async writer worker with bounded queue; flush latest snapshot state out-of-band from request handling.

### P0-6
PROBLEM: Runtime option compatibility fallback is missing in `OpenRouterChat`; unsupported params (`reasoning`, `prompt_cache_retention`) can hard-fail calls instead of graceful downgrade.

FIX: Add one retry downgrade path: on provider capability error, strip unsupported params, reissue request once, and emit structured downgrade reason telemetry.

### P0-7
PROBLEM: Non-interactive budget semantics in plan2 target deny/queue behavior, but current budget contract only supports `allow|deny|degrade` (`src/core/llm/types.ts`, `src/core/llm/budget-guard.ts`).

FIX: Extend `BudgetDecision` with `queue` and implement explicit non-interactive queue policy branch (with retry metadata), not just deny.

## P1 (high value, after P0)

### P1-1
PROBLEM: Event idempotency in `OpenRouterChat` uses `${idempotencyKey}:${type}`, which can collapse multiple same-type events in retries/multi-phase flows and reduce observability fidelity.

FIX: Include deterministic per-stage suffix or sequence nonce in emitted idempotency keys (e.g., `${idempotencyKey}:${type}:${stageCounter}`).

### P1-2
PROBLEM: `TelemetryMeter` is not used by production AI-review/openrouter flow, so KPIs in plan2 section 10 are not generated from a single source of truth.

FIX: Record all request usage/caching/cost/latency through `TelemetryMeter` in `OpenRouterChat` and expose snapshots via dashboard service metrics endpoint.

### P1-3
PROBLEM: AI review relies on JSON mode + manual parse and fallback generic comment (`src/dashboard/services/ai-review-service.ts`) instead of strict schema validation, reducing prompt-engineering determinism and causing silent quality loss on malformed outputs.

FIX: Enforce strict structured output contract through `SchemaRegistry` and fail-retry with bounded attempts when schema validation fails.

### P1-4
PROBLEM: `aiReviewServicesByApiKey` keeps raw API keys in-memory map keys and has no eviction (`src/dashboard/multi-server.ts`), creating security and memory-lifetime risk.

FIX: Key by salted hash of API key and add TTL/LRU eviction for service instances.

## P2 (cleanup / DRY / plan consistency)

### P2-1
PROBLEM: Agent CLI mapping duplicates command strings for aliases (`src/config/discipline.ts`) and increases drift risk.

FIX: Introduce canonical agent command map + alias map (alias -> canonical), generate role command from one source.

### P2-2
PROBLEM: Plan docs and implementation status are now boundary-shifted to `src` runtime ownership, but existing review docs still contain stale Python-runtime remediation framing.

FIX: Update plan tracking docs to reflect current architecture boundary (`src` owns orchestration runtime; `chunkhound` is search/research backend scope).

## Suggested execution order

1. P0-1, P0-2, P0-3 together (core runtime contract + caching foundation).
2. P0-4, P0-5 (durability and latency safety).
3. P0-6, P0-7 (capability and policy correctness).
4. P1 and P2 cleanup.
