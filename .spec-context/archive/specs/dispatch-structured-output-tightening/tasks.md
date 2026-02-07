# Tasks Document: Dispatch Structured Output Tightening (Dimension 3 P0)

> Tasks follow TDD and fail-fast principles. No fallback or defensive recovery paths.

- [x] 1. Create canonical dispatch schema module
  - File: `src/tools/workflow/dispatch-contract-schemas.ts` (new)
  - Define canonical `v1` schemas for implementer/reviewer outputs
  - Export strict validators and schema metadata (id/version)
  - Purpose: single source of truth for runtime and guide contracts
  - _Leverage: `src/tools/workflow/dispatch-runtime.ts` existing result interfaces_
  - _Requirements: 2_
  - _Prompt: |
      Implement the task for spec dispatch-structured-output-tightening, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in schema contracts

      Task: Add canonical dispatch JSON schema artifacts and strict validators for implementer/reviewer outputs.

      Restrictions:
      - No alternate relaxed schema profiles
      - No new dependencies
      - Preserve current `v1` payload shape

      Success:
      - Canonical schemas are explicit and reusable
      - Validators are derived from canonical artifacts
      - Schema metadata is available for telemetry/guides

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [x] 2. Add strict provider capability gate (no fallback)
  - File: `src/tools/workflow/dispatch-output-mode.ts` (new)
  - Implement capability resolver returning `schema_constrained` or terminal `unsupported`
  - Unknown providers must resolve to `unsupported`
  - Purpose: block unsupported providers before dispatch execution
  - _Leverage: `src/config/discipline.ts` provider catalog_
  - _Requirements: 3, 4_
  - _Prompt: |
      Implement the task for spec dispatch-structured-output-tightening, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in capability enforcement

      Task: Build a strict capability gate for schema-constrained dispatch output with no fallback modes.

      Restrictions:
      - No `json_mode` or `contract_only` fallback path
      - Unknown providers are terminally unsupported
      - Deterministic behavior only

      Success:
      - Capability checks pass/fail deterministically
      - Unsupported providers fail before dispatch
      - Gate results are testable and typed

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [x] 3. Integrate canonical schemas and fail-fast ingest errors
  - File: `src/tools/workflow/dispatch-runtime.ts`
  - Replace ad-hoc schema registration with canonical schema validators
  - Add explicit contract error categories (`marker_missing`, `json_parse_failed`, `schema_invalid`)
  - Remove defensive schema-invalid retry loop in runtime
  - Purpose: deterministic terminal behavior for malformed output
  - _Leverage: existing ingest parser + telemetry path_
  - _Requirements: 1, 2_
  - _Prompt: |
      Implement the task for spec dispatch-structured-output-tightening, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in runtime validation

      Task: Wire canonical validators into ingest_output and make contract violations terminal with typed error categories.

      Restrictions:
      - No auto-retry for malformed contract output
      - No silent parse fallbacks
      - Preserve successful-path behavior

      Success:
      - Contract violations fail fast and categorically
      - Runtime uses canonical schema module
      - Existing valid outputs continue to pass

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [x] 4. Align guide/prompt contract text with strict schema policy
  - File: `src/tools/workflow/get-implementer-guide.ts`, `src/tools/workflow/get-reviewer-guide.ts`, `src/prompts/implement-task.ts`
  - Keep strict no-prose marker contract language
  - Add schema id/version references used by runtime
  - Remove fallback/soft-language wording
  - Purpose: keep producer instructions identical to runtime gate
  - _Leverage: existing output contract sections_
  - _Requirements: 1, 2_
  - _Prompt: |
      Implement the task for spec dispatch-structured-output-tightening, first call get-implementer-guide to load implementation rules then implement the task:

      Role: Technical Writer + TypeScript Developer

      Task: Update guide/prompt contract instructions to match strict schema-constrained policy with no fallback language.

      Restrictions:
      - Keep examples concise and schema-accurate
      - Preserve discipline mode behavior
      - Do not introduce optional/defensive wording

      Success:
      - Contract text is unambiguous and strict
      - Schema metadata is visible to agents
      - Instructions match runtime enforcement exactly

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [x] 5. Extend telemetry for strict contract enforcement
  - File: `src/tools/workflow/dispatch-runtime.ts`
  - Add counters for capability gate outcomes and categorized terminal failures
  - Add schema version counters
  - Expose through `get_telemetry`
  - Purpose: measure strict enforcement health and failure hotspots
  - _Leverage: existing dispatch telemetry structure_
  - _Requirements: 5_
  - _Prompt: |
      Implement the task for spec dispatch-structured-output-tightening, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in telemetry

      Task: Add strict-output telemetry for gate decisions, schema version usage, and terminal failure categories.

      Restrictions:
      - Keep existing fields intact
      - No degraded/fallback metrics
      - Machine-readable stable metric keys

      Success:
      - Telemetry surfaces strict-output health clearly
      - Metrics update on both success and failure paths
      - get_telemetry remains backward compatible

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [x] 6. Add strictness test matrix
  - File: `src/tools/workflow/dispatch-contract-schemas.test.ts` (new), `src/tools/workflow/dispatch-output-mode.test.ts` (new), `src/tools/workflow/dispatch-runtime.test.ts`, `src/tools/workflow/dispatch-runtime.integration.test.ts`
  - Cover strict schema pass/fail, capability gate, terminal failure categories
  - Ensure no retry-on-invalid behavior remains
  - Purpose: prevent regression to defensive or fallback behavior
  - _Leverage: existing dispatch runtime tests_
  - _Requirements: 6_
  - _Prompt: |
      Implement the task for spec dispatch-structured-output-tightening, first call get-implementer-guide to load implementation rules then implement the task:

      Role: QA Engineer specializing in contract testing

      Task: Add tests enforcing strict no-fallback behavior across schema validation and provider capability gating.

      Restrictions:
      - Do not remove existing tests
      - Add explicit assertions for terminal failures
      - Keep tests deterministic

      Success:
      - Contract and capability failures are terminal and categorized
      - No retry-on-invalid tests remain
      - Existing valid-path tests still pass

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_
