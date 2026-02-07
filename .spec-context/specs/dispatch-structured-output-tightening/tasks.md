# Tasks Document: Dispatch Structured Output Tightening (Dimension 3 P0)

> Tasks follow TDD. Keep existing dispatch-runtime behavior compatible while tightening contracts.

- [ ] 1. Create canonical dispatch schema module
  - File: `src/tools/workflow/dispatch-contract-schemas.ts` (new)
  - Define canonical `v1` schemas for implementer/reviewer outputs
  - Export `full` + `decode_safe` profiles and helper validators
  - Purpose: Establish a single source of truth for structured output contracts
  - _Leverage: `src/tools/workflow/dispatch-runtime.ts` existing interfaces_
  - _Requirements: 2, 4_
  - _Prompt: |
      Implement the task for spec dispatch-structured-output-tightening, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in schema contracts

      Task: Add canonical dispatch JSON schemas with full/decode-safe profiles and strict typing.

      Restrictions:
      - No new runtime dependencies
      - Keep schema keys aligned with existing interfaces
      - Maintain current `v1` payload compatibility

      Success:
      - Canonical schemas compile and are reusable
      - decode_safe profile is explicit and documented in code
      - Existing contract fields remain compatible

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 2. Add output mode capability resolver
  - File: `src/tools/workflow/dispatch-output-mode.ts` (new)
  - Implement mode resolver: `schema_constrained` -> `json_mode` -> `contract_only`
  - Add provider capability map + optional env override support
  - Purpose: Avoid invalid assumptions about provider constrained-decoding support
  - _Leverage: `src/config/discipline.ts` provider catalog_
  - _Requirements: 3_
  - _Prompt: |
      Implement the task for spec dispatch-structured-output-tightening, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in capability negotiation

      Task: Create deterministic output-mode selection based on provider capabilities and fallback rules.

      Restrictions:
      - Deterministic behavior only (no heuristics)
      - Unknown providers must degrade safely to contract_only
      - Keep role-aware extension points

      Success:
      - Mode selection is predictable and testable
      - Unsupported mode requests are surfaced cleanly
      - Fallback chain is enforced

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 3. Integrate canonical schemas into dispatch runtime validation
  - File: `src/tools/workflow/dispatch-runtime.ts`
  - Register validators from schema module instead of ad-hoc-only validators
  - Add typed schema error categories (`marker_missing`, `json_parse_failed`, `schema_invalid`)
  - Preserve retry-on-invalid behavior
  - Purpose: Tighten ingest gate while maintaining current runtime contract
  - _Leverage: `SchemaRegistry`, existing retry flow in dispatch-runtime_
  - _Requirements: 1, 2, 5_
  - _Prompt: |
      Implement the task for spec dispatch-structured-output-tightening, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in runtime validation pipelines

      Task: Wire canonical schema validation and categorized contract errors into ingest_output.

      Restrictions:
      - Do not remove existing retry policy semantics
      - Keep output parsing deterministic
      - Preserve current public response shape unless extending with additive fields

      Success:
      - Runtime validates with canonical schema source
      - Error categories are explicit
      - Existing tests remain green with additive updates

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 4. Add mode-aware guidance text for implementer/reviewer dispatch
  - File: `src/tools/workflow/get-implementer-guide.ts`, `src/tools/workflow/get-reviewer-guide.ts`, `src/prompts/implement-task.ts`
  - Add output-mode-specific contract instructions while preserving strict marker rules
  - Ensure compact and full guides both include hard no-prose requirement
  - Purpose: Increase first-pass schema compliance from subagents
  - _Leverage: existing output contract sections in guide files_
  - _Requirements: 1, 3_
  - _Prompt: |
      Implement the task for spec dispatch-structured-output-tightening, first call get-implementer-guide to load implementation rules then implement the task:

      Role: Technical Writer + TypeScript Developer

      Task: Add mode-aware structured-output guidance without weakening existing strict contract instructions.

      Restrictions:
      - Keep contract examples concise
      - No provider marketing language
      - Preserve existing discipline mode behavior

      Success:
      - Guidance includes mode-specific instructions
      - No-prose and marker rules remain explicit in all variants
      - Prompt orchestration text references selected mode cleanly

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 5. Extend telemetry for structured output modes and errors
  - File: `src/tools/workflow/dispatch-runtime.ts`
  - Add telemetry counters for mode usage, schema versions, and categorized failures
  - Expose through `get_telemetry`
  - Purpose: Measure real impact and detect regressions per mode/provider
  - _Leverage: existing compaction and schema retry telemetry patterns_
  - _Requirements: 5_
  - _Prompt: |
      Implement the task for spec dispatch-structured-output-tightening, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in operational telemetry

      Task: Extend dispatch telemetry with structured-output mode and error-category metrics.

      Restrictions:
      - Do not remove existing fields
      - Keep metric keys stable and machine-readable
      - Maintain backward-compatible numeric defaults

      Success:
      - Telemetry reports mode counts and error breakdowns
      - Metrics are updated in ingest/compile flows
      - get_telemetry remains backward compatible

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 6. Add full test matrix for mode selection and validation paths
  - File: `src/tools/workflow/dispatch-contract-schemas.test.ts` (new), `src/tools/workflow/dispatch-output-mode.test.ts` (new), `src/tools/workflow/dispatch-runtime.test.ts`, `src/tools/workflow/dispatch-runtime.integration.test.ts`
  - Cover success + failure classes for each output mode and retry behavior
  - Purpose: lock in deterministic structured-output guarantees
  - _Leverage: existing dispatch runtime tests_
  - _Requirements: 6_
  - _Prompt: |
      Implement the task for spec dispatch-structured-output-tightening, first call get-implementer-guide to load implementation rules then implement the task:

      Role: QA Engineer specializing in contract/integration testing

      Task: Add tests for schema profiles, output-mode fallback, strict marker enforcement, and categorized failure telemetry.

      Restrictions:
      - Do not remove existing tests
      - Keep integration tests deterministic
      - Ensure one test covers each failure category

      Success:
      - Unit and integration tests cover all modes and failure paths
      - Existing dispatch-runtime tests remain passing
      - Regression risk for structured-output drift is significantly reduced

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_
