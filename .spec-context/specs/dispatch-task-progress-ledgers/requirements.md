# Requirements Document: Dispatch Task + Progress Ledgers (Dimension 2 P1)

## Introduction

Implement a Magentic-One-inspired ledger pattern for dispatch orchestration: maintain a compact **Task Ledger** (facts, decisions, active plan) and **Progress Ledger** (task completion/blocking state) so `compile_prompt` no longer depends on replaying full spec documents on every dispatch.

This is the P1 item from Dimension 2 in `docs/research/token-efficiency-findings.md`.

## Alignment with Product Vision

This feature supports spec-context-mcp by:
- Reducing repeated prompt payload from full `requirements.md`/`design.md`/`tasks.md` replay
- Increasing consistency across multi-dispatch runs with explicit state ledgers
- Enabling orchestrator-level replanning when progress stalls

## Requirements

### Requirement 1: Progress Ledger Extraction from tasks.md

**User Story:** As an orchestrator, I want a compact view of task status from `tasks.md`, so dispatch prompts include only the current actionable task context.

#### Acceptance Criteria

1. WHEN a run is initialized THEN system SHALL parse `.spec-context/specs/{specName}/tasks.md` into a progress ledger using existing task parser primitives.
2. WHEN tasks contain status markers (`[ ]`, `[-]`, `[x]`) THEN ledger SHALL capture counts and current active task ID.
3. WHEN tasks include numbered IDs (e.g., `1`, `1.2`, `3.4.1`) THEN ledger SHALL preserve those IDs as canonical task references.
4. IF `tasks.md` is missing or invalid THEN runtime SHALL return a typed error that identifies progress-ledger extraction failure.

### Requirement 2: Task Ledger from Runtime Facts + Dispatch Outcomes

**User Story:** As an orchestrator, I want a compact ledger of facts/decisions/blockers, so each prompt carries only high-signal task state.

#### Acceptance Criteria

1. WHEN `ingest_output` receives implementer/reviewer results THEN system SHALL update task-ledger facts for summary, assessment, issues, blockers, and required fixes.
2. WHEN new task-ledger facts are persisted THEN system SHALL store them in `StateSnapshotFact` with stable key conventions.
3. WHEN the same fact key is updated THEN latest value SHALL overwrite prior value for prompt assembly while preserving snapshot history revisions.
4. WHEN task-ledger facts are absent THEN system SHALL gracefully fall back to existing minimal delta packet behavior.

### Requirement 3: Ledger-First Prompt Compilation

**User Story:** As an orchestrator, I want `compile_prompt` to use ledger context by default, so prompt size is bounded and focused.

#### Acceptance Criteria

1. WHEN `compile_prompt` runs THEN dynamic-tail context SHALL be assembled primarily from task/progress ledgers.
2. WHEN ledger data is sufficient THEN runtime SHALL NOT require embedding full spec file content in the prompt.
3. WHEN ledger data is insufficient for required task context THEN runtime SHALL include targeted fallback context (only missing fields), not full-document replay.
4. WHEN compiling prompts across repeated dispatches THEN stable-prefix semantics from Dimension 2 P0 SHALL remain unchanged.

### Requirement 4: Source-of-Truth Integrity and Invalidation

**User Story:** As a maintainer, I want ledger correctness tied to source files, so stale ledgers do not cause incorrect dispatch prompts.

#### Acceptance Criteria

1. WHEN ledger entries are generated from `tasks.md` THEN ledger metadata SHALL store source fingerprint (mtime and/or content hash).
2. WHEN source fingerprint changes THEN runtime SHALL invalidate and rebuild the relevant ledger before next compile.
3. WHEN rebuild fails THEN runtime SHALL surface a non-silent error or explicit degraded fallback mode.
4. WHEN no source change occurs THEN runtime SHALL reuse existing ledger without reparsing files.

### Requirement 5: Stalled Progress Detection and Replan Hints

**User Story:** As an orchestrator, I want stalled-loop detection, so the system can pivot task strategy instead of repeating the same failed cycle.

#### Acceptance Criteria

1. WHEN consecutive blocked/failed outcomes exceed threshold for the same task THEN runtime SHALL mark progress as stalled.
2. WHEN stalled is detected THEN task ledger SHALL append a replan hint fact (e.g., revise constraints, request missing dependency, split task).
3. WHEN a successful outcome arrives THEN stalled counters SHALL reset for that task.
4. Stalled detection SHALL be deterministic and test-covered.

### Requirement 6: Telemetry for Token-Efficiency and Quality Safety

**User Story:** As an engineer, I want measurable before/after prompt metrics and fallback rates, so ledger impact is visible and safe.

#### Acceptance Criteria

1. WHEN `compile_prompt` executes THEN telemetry SHALL record ledger usage mode (`ledger_only`, `ledger_plus_fallback`, `legacy`).
2. WHEN fallback context is injected THEN telemetry SHALL record fallback reason category.
3. WHEN ledgers are active THEN telemetry SHALL expose prompt token deltas compared with baseline compile path.
4. Runtime SHALL retain existing schema and budget guard behavior with no contract regression.

## Non-Functional Requirements

### Architecture and Modularity
- Reuse `parseTasksFromMarkdown` from `src/core/workflow/task-parser.ts` for progress extraction.
- Keep ledger assembly logic isolated in a dedicated module (no ad-hoc string building across runtime methods).
- Preserve backward compatibility of public `dispatch-runtime` tool actions.

### Performance
- Ledger extraction/update should be O(n) in task count and incremental across dispatches.
- File reads/reparse should occur only on initialization or invalidation events.

### Reliability
- Any ledger parse failure must produce explicit signals (error or degraded mode), never silent data loss.
- Prompt compilation must continue with safe fallback if ledger is partially unavailable.

### Testability
- Unit tests must cover parser-to-ledger mapping, key conventions, invalidation, and stalled detection.
- Integration tests must cover init -> compile -> ingest loops with ledger update assertions.

## References

- Magentic-One (Task Ledger / Progress Ledger orchestration): https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html
- Existing code:
  - `src/tools/workflow/dispatch-runtime.ts`
  - `src/core/workflow/task-parser.ts`
  - `src/core/llm/types.ts`
