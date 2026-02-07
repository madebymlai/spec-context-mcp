# Tasks Document: Dispatch Task + Progress Ledgers (Dimension 2 P1)

> Tasks follow TDD: write or adjust tests as part of each task.

- [ ] 1. Create dispatch ledger module and types
  - File: `src/tools/workflow/dispatch-ledger.ts` (new)
  - Add `ProgressLedger` and `TaskLedger` interfaces
  - Add helpers for extracting/serializing ledger data from `StateSnapshotFact[]`
  - Purpose: Centralize ledger model and eliminate ad-hoc fact-key handling
  - _Leverage: `src/core/llm/types.ts`, `src/tools/workflow/dispatch-runtime.ts`_
  - _Requirements: 2, 3_
  - _Prompt: |
      Implement the task for spec dispatch-task-progress-ledgers, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in runtime state modeling

      Task: Create `dispatch-ledger.ts` with strongly typed TaskLedger/ProgressLedger contracts and conversion utilities for snapshot facts.

      Restrictions:
      - Keep existing dispatch-runtime public API unchanged
      - Do not remove existing fact keys yet; support compatibility mapping
      - No new dependencies

      Success:
      - New module compiles
      - Ledger types are explicit and reusable
      - Fact-to-ledger mapping is deterministic

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 2. Implement progress ledger extraction from tasks.md with fingerprinting
  - File: `src/tools/workflow/dispatch-ledger.ts`
  - Parse tasks using `parseTasksFromMarkdown`
  - Build compact progress ledger (totals, activeTaskId, current task details)
  - Capture source fingerprint (mtime + hash)
  - Purpose: Convert raw tasks file into compact progress context
  - _Leverage: `src/core/workflow/task-parser.ts`_
  - _Requirements: 1, 4_
  - _Prompt: |
      Implement the task for spec dispatch-task-progress-ledgers, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in parsing and data extraction

      Task: Implement progress-ledger extraction that reads tasks content and returns compact status + fingerprint metadata.

      Restrictions:
      - Use existing task parser; do not write a second markdown parser
      - Keep output compact (no full task body dumps)
      - Handle missing/invalid tasks content with typed errors

      Success:
      - Extracted ledger includes totals and active task
      - Fingerprint is deterministic
      - Missing/invalid tasks paths are surfaced explicitly

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 3. Add stalled-progress detector and replan hint generation
  - File: `src/tools/workflow/dispatch-ledger.ts`
  - Track consecutive non-progress outcomes per task
  - Flag stalled tasks after threshold and emit replan hint fact payload
  - Reset counters on successful progress
  - Purpose: Introduce Magentic-One-style progress reflection loop
  - _Leverage: `src/tools/workflow/dispatch-runtime.ts` ingest result statuses_
  - _Requirements: 5_
  - _Prompt: |
      Implement the task for spec dispatch-task-progress-ledgers, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in workflow state machines

      Task: Add deterministic stalled-progress detection logic and replan hint generation for repeated blocked/failed outcomes.

      Restrictions:
      - Default threshold should be configurable and conservative
      - No probabilistic logic
      - Keep state transitions easy to unit test

      Success:
      - Counters increment on non-progress outcomes
      - Counters reset on success
      - Replan hint appears when threshold reached

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 4. Integrate ledgers into dispatch-runtime init/ingest paths
  - File: `src/tools/workflow/dispatch-runtime.ts`
  - On `init_run`, build/persist progress ledger facts
  - On `ingest_output`, update task-ledger facts and stalled counters
  - Keep existing fact keys for backward compatibility while adding namespaced ledger keys
  - Purpose: Persist ledger state as first-class runtime data
  - _Leverage: `mergeFacts`, `updateSnapshot`, `assertRunBinding` in dispatch-runtime_
  - _Requirements: 1, 2, 5_
  - _Prompt: |
      Implement the task for spec dispatch-task-progress-ledgers, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in orchestration runtime integration

      Task: Wire ledger extraction and updates into init_run and ingest_output flows with backward-compatible snapshot facts.

      Restrictions:
      - Preserve current dispatch result schema validation behavior
      - Do not remove existing telemetry fields
      - Keep failures explicit and actionable

      Success:
      - Snapshot facts include progress/task ledger keys
      - Existing runtime behavior remains compatible
      - Stalled counters update during ingest loops

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 5. Switch compile_prompt to ledger-first delta packet with targeted fallback
  - File: `src/tools/workflow/dispatch-runtime.ts`
  - Build `deltaPacket` from ledger values by default
  - Inject fallback context only for missing required fields
  - Preserve Dimension 2 P0 prefix-stability behavior
  - Purpose: Reduce prompt payload from raw spec replay while keeping quality safety net
  - _Leverage: `DispatchPromptCompiler.compile`, compaction stages A/B/C_
  - _Requirements: 3, 4, 6_
  - _Prompt: |
      Implement the task for spec dispatch-task-progress-ledgers, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in prompt-assembly pipelines

      Task: Refactor compile_prompt to consume task/progress ledgers first and apply minimal fallback context only when needed.

      Restrictions:
      - Stable prefix behavior from P0 must remain unchanged
      - Keep compaction logic intact
      - Avoid full-document context replay unless explicitly unavoidable

      Success:
      - Ledger-only path is default
      - Fallback path is targeted and telemetry-labeled
      - Prompt compile contracts stay backward compatible

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 6. Add ledger telemetry fields and runtime reporting
  - File: `src/tools/workflow/dispatch-runtime.ts`
  - Add counters/fields: ledger mode usage, fallback reasons, ledger rebuild count
  - Expose in `get_telemetry` response
  - Purpose: Measure token-efficiency gains and degraded-mode frequency
  - _Leverage: existing compaction telemetry patterns_
  - _Requirements: 6_
  - _Prompt: |
      Implement the task for spec dispatch-task-progress-ledgers, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in telemetry design

      Task: Extend dispatch telemetry with ledger usage/fallback/rebuild metrics and surface them through get_telemetry.

      Restrictions:
      - Keep metric names stable and machine-readable
      - Do not remove existing telemetry fields
      - Ensure zero-division-safe ratio calculations

      Success:
      - Telemetry reports ledger modes and fallback categories
      - Metrics update during runtime operations
      - Existing telemetry consumers remain compatible

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 7. Add comprehensive test coverage for ledger lifecycle
  - File: `src/tools/workflow/dispatch-ledger.test.ts` (new), `src/tools/workflow/dispatch-runtime.test.ts`, `src/tools/workflow/dispatch-runtime.integration.test.ts`
  - Cover extraction, invalidation, stalled detection, compile fallback, telemetry updates
  - Purpose: Prevent prompt-quality regressions and ledger drift bugs
  - _Leverage: existing dispatch runtime tests and integration harness_
  - _Requirements: 1, 2, 3, 4, 5, 6_
  - _Prompt: |
      Implement the task for spec dispatch-task-progress-ledgers, first call get-implementer-guide to load implementation rules then implement the task:

      Role: QA Engineer specializing in runtime and integration testing

      Task: Add test coverage for full ledger lifecycle including source invalidation, stalled detection, ledger-first compile behavior, and telemetry reporting.

      Restrictions:
      - Do not remove existing tests
      - Prefer deterministic fixtures over random data
      - Keep integration tests no-mock where current patterns require it

      Success:
      - New tests fail on ledger regression and pass on expected behavior
      - Existing tests continue passing
      - Coverage includes normal and degraded/fallback paths

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_
