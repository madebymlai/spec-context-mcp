# Requirements Document: Dispatch Prompt Prefix Stability (Dimension 2 P0)

## Introduction

Implement a provider-aware prompt ordering contract for `dispatch-runtime` prompt compilation so stable prompt content stays cacheable while per-dispatch data remains isolated in the dynamic tail. This is the P0 item for Dimension 2 from `docs/research/token-efficiency-findings.md`.

The goal is not to reduce prompt size directly. The goal is to maximize prefix-cache reuse by keeping a deterministic, static prefix and placing volatile task data last.

## Alignment with Product Vision

This feature supports spec-context-mcp by:
- Reducing repeated input cost across dispatches through higher cache hit probability
- Preserving strict dispatch-output contracts while improving prompt stability
- Lowering risk of regressions from accidental prompt reordering or dynamic data leakage into stable segments

## Requirements

### Requirement 1: Canonical Prompt Ordering

**User Story:** As an orchestrator, I want dispatch prompts built in a fixed order, so provider-side prefix caching can reliably match prior requests.

#### Acceptance Criteria

1. WHEN `compile_prompt` builds a dispatch prompt THEN stable template segments SHALL appear before any dynamic dispatch-specific content.
2. WHEN `compile_prompt` builds the dynamic section THEN it SHALL include task metadata and delta context before the task body.
3. WHEN `compile_prompt` builds the dynamic section THEN `Task prompt:` and the task content SHALL be the final section in the compiled prompt.
4. WHEN two requests use the same role/template but different task content THEN stable prompt segment ordering SHALL remain identical.

### Requirement 2: Dynamic Data Isolation

**User Story:** As an engineer, I want run-specific and task-specific values isolated to the dynamic tail, so stable prefix hashes are not invalidated by normal workflow variance.

#### Acceptance Criteria

1. WHEN building stable segments THEN system SHALL NOT include per-dispatch values (e.g., `runId`, `taskId`, changing summaries, token budgets).
2. WHEN guide mode or cache key changes per dispatch THEN those values SHALL be placed only in dynamic content.
3. WHEN compaction (stage A/B/C) rewrites prompt content THEN only dynamic-tail content SHALL be modified.
4. IF a new dispatch field is introduced in the future THEN it SHALL default to dynamic placement unless explicitly justified as stable.

### Requirement 3: Hash Semantics for Cacheability

**User Story:** As an engineer, I want stable and dynamic hashes to reflect true prompt structure, so cache behavior is observable and testable.

#### Acceptance Criteria

1. WHEN dynamic-tail content changes and stable prefix is unchanged THEN `stablePrefixHash` SHALL remain unchanged.
2. WHEN dynamic-tail content changes THEN full prompt hash (`fullPromptHash`) SHALL change.
3. WHEN role/template changes (`implementer` vs `reviewer`) THEN `stablePrefixHash` SHALL change.
4. WHEN stable template content changes THEN `stablePrefixHash` SHALL change.

### Requirement 4: Provider-Aware Prefix Stability Guardrails

**User Story:** As a maintainer, I want explicit guardrails that keep stable prefixes deterministic, so cache-hit behavior does not silently regress.

#### Acceptance Criteria

1. WHEN templates are compiled THEN segment ordering SHALL be deterministic (`tools` -> `system` -> `examples` -> `dynamic`).
2. WHEN dynamic tail is appended THEN it SHALL never be included in `stablePrefix`.
3. WHEN dispatch prompts are compacted THEN stable role/contract instructions SHALL remain unchanged.
4. WHEN prompt construction logic is refactored THEN tests SHALL fail if canonical ordering or isolation is violated.

### Requirement 5: Regression Test Coverage

**User Story:** As a developer, I want focused tests for ordering and hash behavior, so future edits cannot degrade cache efficiency unnoticed.

#### Acceptance Criteria

1. Add unit tests for `PromptTemplateRegistry` ordering and `stablePrefix` extraction.
2. Add unit tests for `PromptPrefixCompiler` stable-vs-dynamic hash behavior.
3. Add dispatch-runtime tests that verify task prompt is last and stable hash invariance across dynamic changes.
4. Add tests that compaction stages do not alter stable-prefix identity.

## Non-Functional Requirements

### Architecture and Modularity
- Reuse existing `PromptTemplateRegistry` and `PromptPrefixCompiler`; avoid introducing alternate prompt builders.
- Keep dynamic-tail assembly in one canonical code path.

### Performance
- Changes SHALL add negligible overhead (string assembly + hashing only).
- No additional external API calls.

### Reliability
- Prompt building must remain deterministic for identical inputs.
- Compaction behavior must remain backward compatible with existing overflow protections.

### Testability
- Hash invariants and ordering must be verifiable with deterministic unit tests.
- Dispatch runtime tests must validate behavior through the public `compile_prompt` action.

## References

- Anthropic Prompt Caching docs: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- llm-d KV cache blog: https://llm-d.ai/blog/kvcache-wins-you-can-see
- Existing code: `src/core/llm/prompt-prefix-compiler.ts`, `src/core/llm/prompt-template-registry.ts`, `src/tools/workflow/dispatch-runtime.ts`
