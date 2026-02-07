# Requirements: Session Fact Tracker

## Introduction

The orchestrator runs all spec tasks in a single long-lived session (8+ tasks × 2-3 dispatches each = 16-24+ dispatch cycles). The history reducer aggressively masks old observations to control token costs, but masking destroys cross-task knowledge: which files were created, what conventions were established, what reviewer feedback applies going forward. By task 8, the orchestrator has no memory of decisions made during task 2.

This feature adds a lightweight in-memory fact store that extracts structured facts from dispatch results before masking destroys them, and injects only relevant facts into subsequent dispatch prompts. Inspired by Zep/Graphiti's temporal knowledge graph pattern, but implemented as a zero-dependency in-memory store with single-session lifetime.

## Alignment with Product Vision

This directly supports the token efficiency roadmap (Dimension 1+5: shrink accumulated context + avoid redundant state re-computation). It fills the gap between observation masking (which saves tokens by discarding old results) and cross-task continuity (which requires remembering key facts from those results).

## Requirements

### Requirement 1: Fact Extraction from Dispatch Results

**User Story:** As the orchestrator, I want structured facts automatically extracted from each dispatch result, so that cross-task knowledge survives observation masking.

#### Acceptance Criteria

1. WHEN `ingest_output` processes an implementer result THEN the system SHALL extract facts including: task_id, status, files_modified (from summary), conventions established, and blockers encountered.
2. WHEN `ingest_output` processes a reviewer result THEN the system SHALL extract facts including: task_id, assessment, issues raised, required_fixes, and conventions enforced.
3. WHEN a fact is extracted THEN the system SHALL assign it a deterministic ID derived from (subject, relation, object) and tag it with categories from a fixed set: `file_change`, `convention`, `decision`, `error`, `dependency`, `test`.
4. IF a fact with the same subject+relation already exists THEN the system SHALL set `validTo` on the old fact and create a new fact with `validFrom` set to now (temporal invalidation, not overwrite).

### Requirement 2: In-Memory Session Fact Store

**User Story:** As the orchestrator, I want facts accumulated across all tasks in a session stored in memory, so that later tasks can access earlier decisions without re-reading masked history.

#### Acceptance Criteria

1. WHEN the `DispatchRuntimeManager` is instantiated THEN it SHALL create a `SessionFactStore` that persists for the lifetime of the process.
2. WHEN facts are stored THEN they SHALL follow the `SessionFact` structure: `{ id, subject, relation, object, tags, validFrom, validTo?, sourceTaskId, sourceRole, confidence }`.
3. WHEN the store contains more than a configurable maximum (default: 500) valid facts THEN the system SHALL compact by merging older facts with the same subject into summary facts.
4. IF the session ends (process exits) THEN the fact store SHALL be garbage collected with no persistence — facts are session-scoped only.

### Requirement 3: Fact Retrieval by Relevance

**User Story:** As the orchestrator, I want to retrieve only facts relevant to the current task, so that dispatch prompts stay focused and within token budget.

#### Acceptance Criteria

1. WHEN `compile_prompt` assembles a dispatch prompt THEN the system SHALL query the fact store for facts relevant to the current task.
2. WHEN querying for relevant facts THEN the system SHALL use tag filtering first (match task category tags), then keyword overlap scoring (match task description terms against fact subjects/objects), and return the top-K results sorted by relevance score then recency.
3. WHEN retrieving facts THEN the system SHALL exclude facts where `validTo` is set (temporally invalidated facts).
4. IF the token budget for facts exceeds a configurable limit (default: 500 tokens) THEN the system SHALL truncate the fact list to fit within budget.

### Requirement 4: Prompt Injection of Session Facts

**User Story:** As the orchestrator, I want relevant session facts injected into dispatch prompts, so that the implementer/reviewer agent has cross-task context without replaying full history.

#### Acceptance Criteria

1. WHEN `compile_prompt` builds the dynamic tail THEN the system SHALL include a `[Session Context]` section containing relevant facts formatted as concise one-line statements.
2. WHEN the `[Session Context]` section is assembled THEN it SHALL appear after the delta packet and before the task prompt in the dynamic tail.
3. IF no relevant facts exist for the current task THEN the system SHALL omit the `[Session Context]` section entirely (no empty section).
4. WHEN facts are formatted for prompt injection THEN each fact SHALL be rendered as: `- {subject} {relation} {object} [task:{sourceTaskId}]` — one line per fact, max 120 chars per line.

### Requirement 5: Rule-Based Fact Extraction (No LLM Cost)

**User Story:** As a cost-conscious operator, I want fact extraction to use rule-based parsing with zero LLM calls, so that the fact tracker adds no token cost.

#### Acceptance Criteria

1. WHEN extracting facts from implementer results THEN the system SHALL parse the structured JSON fields (`status`, `summary`, `files_modified`, `follow_up_actions`) using deterministic rules — no LLM calls.
2. WHEN extracting facts from reviewer results THEN the system SHALL parse the structured JSON fields (`assessment`, `issues`, `required_fixes`) using deterministic rules — no LLM calls.
3. WHEN a structured field contains file paths THEN the system SHALL extract each path as a separate `file_change` fact.
4. WHEN a reviewer issue contains a pattern/convention reference THEN the system SHALL extract it as a `convention` fact.

## Non-Functional Requirements

### Code Architecture and Modularity
- **Single Responsibility**: The fact store, fact extractor, and fact retriever SHALL be separate modules with distinct interfaces.
- **Interface Segregation**: The `DispatchRuntimeManager` SHALL depend on `ISessionFactStore` and `IFactExtractor` interfaces, not concrete implementations.
- **Open/Closed**: New fact extraction rules SHALL be addable without modifying existing extractor code (rule registry pattern).

### Performance
- Fact extraction SHALL complete in < 5ms per dispatch result (rule-based, no I/O).
- Fact retrieval SHALL complete in < 10ms for stores with up to 1000 facts.
- Memory usage SHALL not exceed 1MB for a 20-task session (~200 facts).

### Token Efficiency
- The `[Session Context]` section SHALL consume at most 500 tokens per dispatch prompt (configurable).
- The token cost of injecting facts SHALL be less than 10% of the tokens saved by observation masking of the same facts.

### Reliability
- Each implementation SHALL guarantee it never throws to its caller — error handling is internal to each component, not pushed to the integration point.
- `IFactExtractor` implementations SHALL catch per-rule failures internally, log warnings, and return successfully extracted facts (partial results, not empty on single-rule failure).
- `IFactRetriever` implementations SHALL return an empty array on any internal error, never throw.
- `ISessionFactStore` implementations SHALL silently skip malformed facts on `add()`, never throw.
- `DispatchRuntimeManager` SHALL call fact tracker methods directly without try/catch wrappers — it trusts the contract.
