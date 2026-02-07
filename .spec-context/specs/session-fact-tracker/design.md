# Design: Session Fact Tracker

## Overview

A lightweight in-memory fact tracking system that sits between `ingest_output` (where dispatch results arrive) and `compile_prompt` (where dispatch prompts are assembled). It extracts structured facts from each dispatch result using rule-based parsing, stores them for the session lifetime, and injects only relevant facts into subsequent dispatch prompts. Zero LLM cost, zero external dependencies, single-session scope.

## Steering Document Alignment

### Technical Standards (tech.md)
- TypeScript, async/await for any future I/O extension points
- In-memory storage, no database dependencies
- Interfaces for all public contracts (DIP)

### Project Structure (structure.md)
- New modules under `src/core/session/` for domain logic (fact store, extractor, retriever)
- Integration hooks in existing `src/tools/workflow/dispatch-runtime.ts`
- Tests alongside source in `src/core/session/*.test.ts`

## Code Reuse Analysis

### Existing Components to Leverage
- **`StateSnapshotFact`** (`src/core/llm/types.ts`): Existing fact type `{ k, v, confidence }`. The session fact tracker uses a richer `SessionFact` type but converts to/from `StateSnapshotFact` at the integration boundary.
- **`DispatchRuntimeManager.mergeFacts()`** (`src/tools/workflow/dispatch-runtime.ts:1317`): Existing key-based merge. Session facts use a different identity model (subject+relation+object triple vs single key) so they get their own store, but the merge pattern is reused conceptually.
- **`ImplementerResult` / `ReviewerResult`** (`src/tools/workflow/dispatch-contract-schemas.ts`): The structured JSON schemas that fact extraction parses. Already validated by `SchemaRegistry` before reaching the extractor.
- **`buildDispatchDynamicTail()`** (`src/tools/workflow/dispatch-runtime.ts:476`): The function where `[Session Context]` injection happens. Extended to accept an optional facts string.

### Integration Points
- **`DispatchRuntimeManager.ingestOutput()`**: After schema validation succeeds, call `IFactExtractor.extract()` on the validated result and store in `ISessionFactStore`.
- **`DispatchRuntimeManager.compilePrompt()`**: Before building the dynamic tail, call `IFactRetriever.retrieve()` to get relevant facts, format them, and include in the tail.

## Architecture

```
                    DispatchRuntimeManager
                    /         |          \
            initRun()    ingestOutput()   compilePrompt()
                              |                |
                    ┌─────────┴──────┐    ┌────┴─────────┐
                    │ IFactExtractor │    │IFactRetriever│
                    └────────┬───────┘    └────┬─────────┘
                             │                 │
                      ┌──────┴─────────────────┴──────┐
                      │      ISessionFactStore        │
                      │  Map<string, SessionFact>     │
                      │  (in-memory, session-scoped)  │
                      └───────────────────────────────┘
```

## Components and Interfaces

### Component 1: SessionFact (Value Object)

```typescript
interface SessionFact {
  readonly id: string;           // deterministic: hash(subject + relation + object)
  readonly subject: string;      // e.g., "src/services/FooService.ts"
  readonly relation: string;     // e.g., "created_by", "flagged_in", "convention"
  readonly object: string;       // e.g., "task-3", "naming: use camelCase"
  readonly tags: ReadonlyArray<SessionFactTag>;
  readonly validFrom: Date;
  readonly validTo?: Date;       // set when temporally invalidated
  readonly sourceTaskId: string;
  readonly sourceRole: 'implementer' | 'reviewer';
  readonly confidence: number;   // 0-1
}

type SessionFactTag = 'file_change' | 'convention' | 'decision' | 'error' | 'dependency' | 'test';
```

**Purpose:** Immutable value object representing a single cross-task fact. Identity is the (subject, relation, object) triple. Temporal validity via `validFrom`/`validTo`.

### Component 2: ISessionFactStore

```typescript
interface ISessionFactStore {
  add(facts: SessionFact[]): void;
  invalidate(subject: string, relation: string): void;
  getValid(): SessionFact[];
  getValidByTags(tags: SessionFactTag[]): SessionFact[];
  count(): number;
  compact(maxFacts: number): void;
}
```

**Purpose:** In-memory store for session facts. Keyed by fact ID. `invalidate()` sets `validTo` on matching facts. `compact()` deduplicates and trims when count exceeds threshold.
**Dependencies:** None (pure in-memory).
**Reuses:** Merge pattern from `DispatchRuntimeManager.mergeFacts()`.

**Implementation:** `InMemorySessionFactStore` backed by `Map<string, SessionFact>`. On `add()`, if a fact with the same `subject+relation` already exists and is valid, auto-invalidate the old one. Silently skips malformed facts (missing required fields). `compact()` keeps most recent N facts by `validFrom`, discards oldest invalidated facts first. Never throws — all methods handle errors internally.

### Component 3: IFactExtractor

```typescript
interface IFactExtractor {
  extractFromImplementer(result: ImplementerResult, taskId: string): SessionFact[];
  extractFromReviewer(result: ReviewerResult, taskId: string): SessionFact[];
}
```

**Purpose:** Rule-based extraction of `SessionFact` instances from validated dispatch results. No LLM calls.
**Dependencies:** `ImplementerResult`, `ReviewerResult` types from `dispatch-contract-schemas.ts`.

**Extraction Rules:**

| Source Field | Fact Subject | Relation | Object | Tag |
|-------------|-------------|----------|--------|-----|
| `implementer.status` | `task:{taskId}` | `completed_with` | status value | `decision` |
| `implementer.summary` | `task:{taskId}` | `summary` | summary text (clipped 120 chars) | `decision` |
| `implementer.files_modified[]` | file path | `modified_by` | `task:{taskId}` | `file_change` |
| `implementer.follow_up_actions[]` | `task:{taskId}` | `requires` | action text | `dependency` |
| `reviewer.assessment` | `task:{taskId}` | `reviewed_as` | assessment value | `decision` |
| `reviewer.issues[].message` | issue file or `task:{taskId}` | `issue` | message (clipped 120 chars) | `error` |
| `reviewer.required_fixes[]` | `task:{taskId}` | `must_fix` | fix text (clipped 120 chars) | `convention` |

**Implementation:** `RuleBasedFactExtractor`. Each rule is a pure function `(result, taskId) => SessionFact[]`. Rules are registered in an array, iterated sequentially. New rules added by appending to the array (OCP). Each rule is individually try/catch guarded **inside the extractor** — if one rule fails, the others still run. The extractor never throws to its caller; it returns whatever facts were successfully extracted.

### Component 4: IFactRetriever

```typescript
interface IFactRetriever {
  retrieve(query: FactQuery): SessionFact[];
}

interface FactQuery {
  taskDescription: string;
  taskId: string;
  tags?: SessionFactTag[];
  maxFacts: number;
  maxTokens: number;
}
```

**Purpose:** Given a task context, retrieve the most relevant valid facts from the store.
**Dependencies:** `ISessionFactStore`.

**Retrieval Strategy (sequential filtering):**

1. **Get valid facts** — exclude `validTo !== undefined`
2. **Tag filter** — if `query.tags` provided, keep only facts with matching tags; otherwise keep all
3. **Exclude self** — exclude facts where `sourceTaskId === query.taskId` (task already knows its own context)
4. **Score by keyword overlap** — tokenize `query.taskDescription` into words, score each fact by overlap with `subject + relation + object`
5. **Sort** — by score descending, then by `validFrom` descending (most recent wins ties)
6. **Truncate** — take top `maxFacts`, then truncate to `maxTokens` budget (estimate 4 chars/token)

**Implementation:** `KeywordFactRetriever`. Keyword tokenization: split on whitespace and common delimiters, lowercase, remove stopwords (a, the, is, etc. — hardcoded set of ~30 words). The retriever never throws — on any internal error it returns an empty array.

### Component 5: Prompt Integration (in DispatchRuntimeManager)

No new class. Modifications to `buildDispatchDynamicTail()` and `DispatchRuntimeManager.compilePrompt()`:

```typescript
// In compilePrompt(), after building deltaPacket, before compiling:
// No try/catch — retriever guarantees it never throws (returns [] on error)
const relevantFacts = this.factRetriever.retrieve({
  taskDescription: taskPrompt,
  taskId: args.taskId,
  maxFacts: 10,
  maxTokens: 500,
});
const sessionContext = formatSessionFacts(relevantFacts);
// sessionContext is "" if no facts, otherwise "[Session Context]\n- fact1\n- fact2\n..."
```

```typescript
// In buildDispatchDynamicTail(), add sessionContext parameter:
function buildDispatchDynamicTail(input: {
  // ... existing fields ...
  sessionContext?: string;  // NEW
}): string {
  const sections = [
    `Task ID: ${input.taskId}`,
    `Max output tokens: ${input.maxOutputTokens}`,
    `Delta context: ${JSON.stringify(input.deltaPacket)}`,
    `Guide cache key: ${input.guideCacheKey}`,
    guideInstruction,
  ];
  if (input.sessionContext) {
    sections.push(input.sessionContext);  // injected between delta and task prompt
  }
  sections.push('Task prompt:', input.taskPrompt);
  return sections.join('\n');
}
```

**Fact formatting:**
```
[Session Context]
- src/services/FooService.ts modified_by task:2 [file_change]
- task:4 reviewed_as needs_changes [decision]
- naming: use camelCase for service methods convention task:4 [convention]
```

Each line max 120 chars. Section omitted entirely if no relevant facts.

## Data Models

### SessionFact
```
id: string (SHA-256 hash of subject+relation+object, truncated to 16 chars)
subject: string (max 200 chars)
relation: string (max 50 chars)
object: string (max 200 chars)
tags: SessionFactTag[] (1-3 tags per fact)
validFrom: Date
validTo: Date | undefined
sourceTaskId: string
sourceRole: 'implementer' | 'reviewer'
confidence: number (0-1, default 1 for rule-based extraction)
```

### InMemorySessionFactStore internal state
```
facts: Map<string, SessionFact>  // keyed by fact.id
index_by_subject: Map<string, Set<string>>  // subject -> fact IDs (for fast invalidation)
```

## Error Handling

**Principle: Each component owns its errors.** No defensive try/catch at the integration point. Each implementation guarantees it never throws to its caller. This follows the "No Defensive Garbage" principle — the caller trusts the contract, the implementation honors it.

### Error Scenarios
1. **Fact extraction fails on one rule (e.g., malformed `files_modified` field)**
   - **Handling:** `RuleBasedFactExtractor` catches the failing rule internally, logs warning, continues with remaining rules. Returns partial results.
   - **Caller sees:** A shorter `SessionFact[]` — never an exception.

2. **Fact store exceeds max capacity**
   - **Handling:** `InMemorySessionFactStore.add()` calls `compact()` internally when count exceeds threshold. Removes oldest invalidated facts first, then oldest valid facts.
   - **Caller sees:** Normal `add()` return — never an exception.

3. **Fact retrieval encounters internal error**
   - **Handling:** `KeywordFactRetriever.retrieve()` catches internally, returns empty array.
   - **Caller sees:** Empty `SessionFact[]` — `formatSessionFacts([])` returns `""`, `[Session Context]` section omitted.

4. **Token budget exceeded for facts section**
   - **Handling:** `KeywordFactRetriever` truncates to fit within `maxTokens` before returning.
   - **Caller sees:** A shorter `SessionFact[]` within budget.

## Testing Strategy

### Unit Testing
- `InMemorySessionFactStore`: add, invalidate, getValid, compact, count
- `RuleBasedFactExtractor`: extract from implementer result, extract from reviewer result, handle missing fields, handle empty arrays
- `KeywordFactRetriever`: scoring, tag filtering, self-exclusion, token budget truncation, empty store
- `formatSessionFacts`: formatting, line truncation, empty input

### Integration Testing
- Full flow: ingestOutput → extract facts → compilePrompt → facts appear in dynamic tail
- Multi-task session: task 1 facts available during task 3 prompt compilation
- Temporal invalidation: fact from task 2 invalidated by task 4, not included in task 5 prompt
- Compaction: store with 600 facts compacts to 500 without losing recent facts

### Edge Cases
- Implementer result with no `files_modified` field → zero `file_change` facts, no error
- Reviewer result with 0 issues → zero `error` facts, no error
- Task with no keyword overlap to any stored facts → empty `[Session Context]`, no error
- First task in session → no facts stored yet → prompt compiled without `[Session Context]`
