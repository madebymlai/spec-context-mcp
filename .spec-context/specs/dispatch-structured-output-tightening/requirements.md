# Requirements Document: Dispatch Structured Output Tightening (Dimension 3 P0)

## Introduction

Enforce strict schema-constrained structured output for dispatch subagents. Output must be machine-parseable JSON inside the `BEGIN_DISPATCH_RESULT ... END_DISPATCH_RESULT` envelope with zero prose outside the envelope.

This spec is intentionally fail-fast: no fallback output modes, no degraded parsing paths, and no defensive retry loops for malformed output.

## Evidence Notes (from references)

- JSONSchemaBench demonstrates that constrained decoding materially affects reliability/efficiency.
- Coverage differs across frameworks/providers, so capability checks must be explicit.
- This spec chooses strictness over graceful degradation: unsupported providers are blocked rather than silently downgraded.

## Requirements

### Requirement 1: Strict Envelope and Terminal Failure

**User Story:** As an orchestrator, I want deterministic machine output only, so ingestion never depends on prose handling.

#### Acceptance Criteria

1. Output SHALL contain exactly one trailing `BEGIN_DISPATCH_RESULT ... END_DISPATCH_RESULT` block.
2. Any non-whitespace content outside the block SHALL be rejected.
3. Envelope/parse/schema failures SHALL be terminal for that dispatch attempt (no auto-retry loop in runtime).
4. Full and compact guides SHALL both state the no-prose rule explicitly.

### Requirement 2: Canonical Versioned Schema as Single Source of Truth

**User Story:** As a maintainer, I want one authoritative contract definition, so validation and prompting cannot drift.

#### Acceptance Criteria

1. Define canonical versioned schemas for implementer and reviewer results.
2. Runtime validation SHALL be derived from these schema artifacts.
3. Prompt/guide contract examples SHALL match canonical schema fields exactly.
4. Schema version used for validation SHALL be exposed in telemetry.

### Requirement 3: Schema-Constrained Mode Only

**User Story:** As an operator, I want guaranteed constrained decoding behavior, so output contract compliance is enforced at generation time.

#### Acceptance Criteria

1. Dispatch output policy SHALL be `schema_constrained` only.
2. If provider/CLI cannot satisfy schema-constrained output, dispatch SHALL fail fast with `mode_unsupported`.
3. No fallback to `json_mode` or `contract_only` SHALL be allowed.
4. Capability checks SHALL run before dispatch execution.

### Requirement 4: Provider Capability Gate

**User Story:** As an operator, I want unsupported providers rejected early, so failures are explicit and immediate.

#### Acceptance Criteria

1. Maintain explicit provider capability mapping for schema-constrained support.
2. `compile_prompt`/dispatch SHALL refuse unsupported providers with typed error.
3. Unknown providers SHALL be treated as unsupported by default.
4. Overrides (if any) SHALL be explicit and audited.

### Requirement 5: Operational Telemetry

**User Story:** As an engineer, I want clear contract-health metrics, so strict mode impact is measurable.

#### Acceptance Criteria

1. Telemetry SHALL record schema version and provider capability decisions.
2. Telemetry SHALL record categorized terminal failures: `marker_missing`, `json_parse_failed`, `schema_invalid`, `mode_unsupported`.
3. Telemetry SHALL record output token stats for successful dispatches.
4. Telemetry SHALL not report degraded/fallback modes (none exist in this spec).

### Requirement 6: Test Matrix for Strictness

**User Story:** As a developer, I want tests that fail on any softening of strict contracts, so behavior remains deterministic.

#### Acceptance Criteria

1. Unit tests SHALL validate schema artifacts and capability gate behavior.
2. Runtime tests SHALL verify terminal failure on each failure category.
3. Integration tests SHALL verify unsupported providers fail before execution.
4. Existing strict-envelope tests SHALL remain passing.

## Non-Functional Requirements

### Reliability
- Ingest-time schema validation is mandatory and authoritative.
- No auto-recovery or fallback path for malformed output.

### Compatibility
- Public dispatch-runtime API stays compatible where possible, with additive typed error metadata.

### Performance
- Capability checks and schema selection add negligible overhead.

### Simplicity
- No fallback ladders.
- No alternate parsing branches.

## References

- JSONSchemaBench repo: https://github.com/guidance-ai/jsonschemabench
- JSONSchemaBench paper: https://arxiv.org/abs/2501.10868
- Awesome LLM Constrained Decoding: https://github.com/Saibo-creator/Awesome-LLM-Constrained-Decoding
