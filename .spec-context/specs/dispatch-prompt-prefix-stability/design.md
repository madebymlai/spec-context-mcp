# Design Document: Dispatch Prompt Prefix Stability (Dimension 2 P0)

## Overview

This design hardens dispatch prompt compilation around one rule: **stable prefix first, dynamic task tail last**.

`dispatch-runtime` already computes `stablePrefixHash`/`fullPromptHash` using `PromptPrefixCompiler`. This spec formalizes and tests that behavior so provider cacheability is predictable and regressions are caught early.

## Current State

### Existing Components

- `PromptTemplateRegistry` (`src/core/llm/prompt-template-registry.ts`)
  - Orders segments by kind (`tools`, `system`, `examples`, `dynamic`)
  - Produces compiled prompt text + `stablePrefix`
- `PromptPrefixCompiler` (`src/core/llm/prompt-prefix-compiler.ts`)
  - Splits message list into stable prefix and dynamic tail by `dynamicTailMessages`
  - Returns `stablePrefixHash`, `dynamicTailHash`, `cacheKey`
- `DispatchPromptCompiler` in `dispatch-runtime.ts`
  - Registers role templates
  - Assembles dynamic tail containing task metadata, delta packet, guide policy, and task prompt
  - Returns `stablePrefixHash` and `fullPromptHash`

### Gap

Behavior is mostly correct, but P0 depends on strict invariants that are not fully locked by tests:
- Canonical ordering can regress during refactors
- Dynamic fields can accidentally migrate into stable content
- Compaction changes could inadvertently alter prefix identity

## Steering Alignment

- **tech.md principles:** deterministic behavior, simple composable modules, test-driven guardrails
- **structure.md:** keep changes within existing LLM/prompt modules and dispatch runtime tests

## Proposed Design

### 1. Canonical Dynamic-Tail Builder

Create/standardize one helper in `dispatch-runtime.ts` for dynamic-tail assembly. The helper enforces exact section order:

1. `Task ID`
2. `Max output tokens`
3. `Delta context`
4. `Guide cache key` + guide dispatch instruction
5. `Task prompt` (always last)

This avoids ad-hoc string construction and prevents accidental reordering.

### 2. Prefix Purity Contract

Keep all per-dispatch values in dynamic tail only:
- `runId`, `taskId`, max output tokens
- prior summaries/assessments from delta packet
- guide mode/cache key
- compacted task prompt variants

Stable template segments remain static role instructions and output-contract text.

### 3. Hash Invariant Verification

Extend tests to enforce:
- same stable prefix => same `stablePrefixHash`
- dynamic-only changes => different `fullPromptHash`, unchanged stable hash
- role/template changes => different stable hash

### 4. Compaction Compatibility

Compaction stages A/B/C mutate only dynamic data (`deltaPacket` and/or `taskPrompt`).
Stable prefix identity must remain unchanged regardless of compaction path.

## Data/Interface Notes

No protocol redesign required. Existing `compile_prompt` response fields remain primary:
- `stablePrefixHash`
- `fullPromptHash`
- `compactionStage`
- `compactionTrace`

Optional enhancement (non-blocking): expose `dynamicTailHash` in runtime response for deeper cache diagnostics.

## Testing Strategy

### Unit Tests

- `PromptTemplateRegistry`
  - segment order determinism
  - `stablePrefix` excludes appended dynamic section
- `PromptPrefixCompiler`
  - stable hash unchanged when only tail changes
  - cache key changes when tail changes
  - stable hash changes when stable prefix changes

### Runtime Tests

- `dispatch-runtime.test.ts`
  - task prompt remains last section
  - stable hash invariant across different `taskPrompt`/delta values
  - role switch changes stable hash
- compaction tests
  - compaction stages modify prompt size/content but keep stable hash identity

## File Changes

### Modified Files

- `src/tools/workflow/dispatch-runtime.ts`
  - canonicalize dynamic-tail construction
  - (optional) return `dynamicTailHash`
- `src/tools/workflow/dispatch-runtime.test.ts`
  - add ordering/hash regression cases
- `src/tools/workflow/dispatch-runtime.integration.test.ts`
  - add compaction + stable-prefix checks

### New Test Files (if needed)

- `src/core/llm/prompt-template-registry.test.ts`
- `src/core/llm/prompt-prefix-compiler.test.ts`

## Rollout and Risk

- **Risk:** low, because behavior is mostly hardening and tests
- **Impact:** medium-to-high on cache consistency and cost predictability
- **Fallback:** if a refactor breaks ordering/hash invariants, tests fail before release
