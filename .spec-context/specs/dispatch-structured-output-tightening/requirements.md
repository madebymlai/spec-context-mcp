# Requirements Document: Dispatch Structured Output Tightening (Dimension 3 P0)

## Introduction

Tighten subagent structured output contracts for dispatch orchestration so outputs are reliably machine-parseable with minimal wasted tokens. The system already enforces marker-delimited JSON (`BEGIN_DISPATCH_RESULT ... END_DISPATCH_RESULT`) and validates parsed payloads. This spec upgrades that baseline with capability-aware constrained decoding and stronger schema contracts.

This corresponds to Dimension 3 P0 in `docs/research/token-efficiency-findings.md`.

## Evidence Notes (from references)

- JSONSchemaBench shows constrained decoding meaningfully impacts **efficiency, coverage, and quality** across frameworks/models.
- The paper reports up to ~50% generation speedup and up to ~4% quality gain in some setups, but also large coverage variance (around 2x between frameworks for certain schema classes).
- Therefore this spec requires capability-aware fallback modes instead of a one-size-fits-all schema-constrained path.

## Alignment with Product Vision

This feature supports spec-context-mcp by:
- Reducing verbose/free-form subagent output
- Increasing deterministic orchestrator behavior
- Lowering schema-invalid retry loops
- Preserving strict contracts across heterogeneous CLI providers

## Requirements

### Requirement 1: Strict Contract Boundary (No Prose)

**User Story:** As an orchestrator, I want subagent outputs to be strictly machine-readable, so dispatch ingestion can avoid manual/parsing ambiguity.

#### Acceptance Criteria

1. WHEN an implementer/reviewer response is produced THEN output SHALL contain exactly one trailing `BEGIN_DISPATCH_RESULT ... END_DISPATCH_RESULT` block.
2. WHEN any non-whitespace text exists outside markers THEN response SHALL be rejected as contract-invalid.
3. WHEN contract-invalid output occurs THEN runtime SHALL trigger deterministic retry policy (single retry then terminal failure).
4. Contract rules SHALL be present in both full and compact guide variants.

### Requirement 2: Canonical JSON Schema Contracts

**User Story:** As a maintainer, I want explicit versioned JSON schemas for dispatch outputs, so contract evolution is controlled and testable.

#### Acceptance Criteria

1. Define canonical versioned schemas for `ImplementerResult` and `ReviewerResult` in a reusable schema module.
2. Runtime validation SHALL use canonical schema definitions (or equivalent strict validators generated from them).
3. Schema versions SHALL be included in validation paths and telemetry.
4. Backward compatibility strategy SHALL be explicit (e.g., `v1` accepted until migration cutoff).

### Requirement 3: Capability-Aware Constrained Decoding Modes

**User Story:** As an orchestrator, I want the best available structured-output mode per provider, so schema compliance is maximized without breaking unsupported CLIs.

#### Acceptance Criteria

1. Introduce dispatch output modes:
   - `schema_constrained` (provider supports JSON schema constrained decoding)
   - `json_mode` (provider supports JSON object mode but not full schema constraints)
   - `contract_only` (marker + instruction + post-parse validation fallback)
2. Mode selection SHALL be driven by provider capability mapping, not hardcoded assumptions.
3. WHEN a provider lacks a higher mode THEN runtime SHALL degrade to next safe mode deterministically.
4. Degraded mode SHALL preserve strict marker contract and runtime schema validation.

### Requirement 4: Schema Profile for Decode-Time Compatibility

**User Story:** As an engineer, I want decode-time schemas that avoid unsupported features, so constrained decoding remains reliable across engines.

#### Acceptance Criteria

1. Maintain two schema profiles:
   - `full` (complete runtime validation)
   - `decode_safe` (feature subset for constrained decoding compatibility)
2. Decode-time paths SHALL use `decode_safe`; ingest-time validation SHALL use `full`.
3. Unsupported schema features SHALL be documented and test-covered in compatibility tests.
4. Profile divergence SHALL never allow invalid payloads to bypass ingest-time validation.

### Requirement 5: Telemetry and Failure Diagnostics

**User Story:** As an operator, I want visibility into output contract health by mode/provider, so regressions are measurable.

#### Acceptance Criteria

1. Telemetry SHALL record selected output mode per dispatch (`schema_constrained` | `json_mode` | `contract_only`).
2. Telemetry SHALL record schema-invalid retry count and terminal schema failures by provider/role.
3. Telemetry SHALL record output token usage and schema-compliance success rate by mode.
4. Error responses SHALL carry typed reason categories (`marker_missing`, `json_parse_failed`, `schema_invalid`, `mode_unsupported`).

### Requirement 6: Test Matrix for Structured Output Guarantees

**User Story:** As a developer, I want deterministic tests across modes, so future changes cannot silently degrade structured-output reliability.

#### Acceptance Criteria

1. Unit tests SHALL cover canonical schemas, decode-safe profile derivation, and mode selection logic.
2. Runtime tests SHALL cover accept/reject behavior for all failure classes and retry policy.
3. Integration tests SHALL cover at least one path per output mode.
4. Existing dispatch-runtime contract tests SHALL remain passing.

## Non-Functional Requirements

### Reliability
- Ingest-time validation remains authoritative gate regardless of provider mode.
- No mode may bypass strict runtime validation.

### Performance
- Mode selection and schema profile operations must add negligible overhead.
- Output tightening should reduce average output tokens and/or schema-invalid retries.

### Compatibility
- Preserve current dispatch-runtime public API behavior while adding mode-aware metadata.

### Observability
- Structured-output mode and schema version must be queryable from telemetry.

## References

- JSONSchemaBench repo: https://github.com/guidance-ai/jsonschemabench
- JSONSchemaBench paper: https://arxiv.org/abs/2501.10868
- Awesome LLM Constrained Decoding: https://github.com/Saibo-creator/Awesome-LLM-Constrained-Decoding
