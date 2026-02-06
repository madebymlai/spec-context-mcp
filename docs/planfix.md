# Plan Fix: Move Runtime Core to CLI Dispatch Path

Date: 2026-02-06  
Status: Required correction to align implementation with `plan.md` / `plan2.md`

## Problem Statement

Current state is misaligned:
- `src/core/llm/*` runtime infrastructure is mostly consumed by `src/dashboard/services/ai-review-service.ts`.
- CLI sub-agent orchestration still depends on log-oriented workflows and prompt-only contracts.
- Result: high complexity in a narrow feature, while the main token-cost path (dispatch orchestration) gets limited gains.

## Target Outcome

Make `src/core/llm/*` first-class for CLI orchestration:
- Orchestrator reads structured state/contracts, not raw logs.
- Implementer/reviewer agents return strict machine-parseable outputs.
- Snapshot + delta context powers next-step decisions.
- AI review uses a lighter path, not the primary runtime owner.

## Design Principles

- `SRP`: AI review service handles review only; orchestration runtime handles dispatch state/contracts.
- `OCP`: provider/cache/runtime contracts remain extensible without changing orchestrator logic.
- `DIP`: orchestrator depends on interfaces (`EventBusAdapter`, `SnapshotStore`, `SchemaRegistry`) not concrete file/log handling.
- `DRY`: one canonical contract for agent results and one runtime update pipeline.

## Scope Changes

### Keep in `src/core/llm/*`
- `RuntimeEventStream`
- `RuntimeSnapshotStore`
- `StateProjector`
- `SchemaRegistry`
- `PromptTemplateRegistry`
- `BudgetGuard`
- `InterceptionLayer`

### Re-scope usage
- Primary consumer: CLI task orchestration flow (`implement-task`, spec workflow dispatch path).
- Secondary consumer: AI review (minimal telemetry and schema enforcement only).

## New Contracts (CLI Dispatch)

Add strict response schemas for sub-agent completion:

### Implementer Result Schema (`v1`)
- `task_id: string`
- `status: "completed" | "blocked" | "failed"`
- `summary: string`
- `files_changed: string[]`
- `tests: { command: string; passed: boolean; failures?: string[] }[]`
- `follow_up_actions: string[]`

### Reviewer Result Schema (`v1`)
- `task_id: string`
- `assessment: "approved" | "needs_changes" | "blocked"`
- `strengths: string[]`
- `issues: { severity: "critical" | "important" | "minor"; file?: string; message: string; fix: string }[]`
- `required_fixes: string[]`

## Runtime Flow (CLI-Oriented)

1. Orchestrator compiles dispatch prompt via `PromptTemplateRegistry` (stable prefix).
2. CLI agent execution returns strict JSON to stdout (single structured payload).
3. Orchestrator validates payload with `SchemaRegistry`.
4. Publish runtime event (`LLM_RESPONSE`/`STATE_DELTA`/`ERROR`) into `RuntimeEventStream`.
5. `StateProjector` applies event -> `RuntimeSnapshotStore`.
6. Next task decision uses snapshot + bounded deltas only.

## Phase Plan

### Phase A (P0): Contract-first dispatch (2-4 days)
- Add implementer/reviewer JSON schemas and validators.
- Update dispatch prompts to require final JSON-only block.
- Parse/validate stdout payload; fail fast on schema mismatch.
- Stop reading raw log bodies for decision-making.

Acceptance:
- No orchestration branch depends on `tail`/raw logs for state transitions.
- Invalid JSON result produces deterministic retry/failure path.

### Phase B (P0): Snapshot-driven orchestration (3-5 days)
- Wire `RuntimeEventStream` + `StateProjector` + `RuntimeSnapshotStore` into implement-task workflow.
- Persist applied offsets per run/task.
- Use snapshot status for task progression and review gating.

Acceptance:
- Task lifecycle transitions derived from snapshot state.
- Run recovery works from persisted snapshot + event offsets.

### Phase C (P1): Prompt/token optimization in dispatch path (2-4 days)
- Standardize stable prompt prefixes for implementer/reviewer dispatch prompts.
- Add delta context packet (changed task fields + prior result summary) instead of full replay.
- Enforce output token budget per dispatch response contract.

Acceptance:
- Reduced average dispatch prompt length.
- Deterministic prompt prefix hash available for cache locality.

### Phase D (P1): AI review simplification (1-2 days)
- Keep schema + budget + provider call.
- Remove/disable heavyweight runtime projection where not needed.
- Retain minimal telemetry endpoint only.

Acceptance:
- AI review code path is thinner and isolated.
- Core runtime ownership is clearly in CLI orchestration modules.

## Backlog (Prioritized)

### P0
- Introduce `DispatchResultParser` (schema-validated stdout extraction).
- Add `ImplementerResult` and `ReviewerResult` schemas to registry.
- Refactor `implement-task` orchestration to state transitions from snapshot, not logs.
- Add explicit retry policy for schema-invalid agent responses (max 1 retry).

### P1
- Add `DispatchContextAssembler` (delta-only context packet generation).
- Add dispatch token telemetry counters (`tokens_per_dispatch`, `invalid_schema_retries`, `approval_loops`).
- Add structured failure taxonomy (`agent_timeout`, `schema_invalid`, `review_blocked`, `budget_queue`).

### P2
- Remove obsolete log-tail guidance from workflow prompts/docs.
- Consolidate duplicated dispatch prompt text into template registry entries.

## KPI Targets (CLI Path)

- `tokens_per_task` down 25-50%
- `orchestrator_context_tokens` down 40-70%
- `schema_invalid_rate` < 3%
- `re-dispatch_due_to_parse_error` < 2%
- `p95_dispatch_decision_latency` down 15-30%

## Risk & Mitigation

- Risk: agents fail strict JSON contract initially.
  - Mitigation: one bounded repair retry + clear contract examples.
- Risk: transition churn while replacing log-based behavior.
  - Mitigation: feature flag `SPEC_CONTEXT_DISPATCH_RUNTIME_V2=1` with rollback to legacy path.
- Risk: snapshot/state drift during migration.
  - Mitigation: dual-write events + snapshot consistency check in test mode.

## Definition of Done

- CLI orchestration is the primary consumer of runtime core modules.
- No log-reading required for orchestration decisions.
- Dispatch result contracts are strict, validated, and versioned.
- Snapshot + delta flow drives task sequencing and review gates.
- AI review remains functional with reduced runtime coupling.
