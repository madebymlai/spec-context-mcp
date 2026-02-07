# Tasks Document: Dispatch Prompt Prefix Stability (Dimension 2 P0)

> Tasks follow TDD: add/adjust tests with each implementation task.

- [x] 1. Add PromptTemplateRegistry ordering and stable-prefix tests
  - File: `src/core/llm/prompt-template-registry.test.ts` (new)
  - Verify `compile()` orders segments by kind (`tools` -> `system` -> `examples` -> `dynamic`)
  - Verify appended `dynamicTail` is excluded from `stablePrefix`
  - Verify `stablePrefixHash` changes only when stable content changes
  - Purpose: Lock deterministic template ordering and stable-prefix extraction
  - _Leverage: `src/core/llm/prompt-template-registry.ts`_
  - _Requirements: 4, 5_
  - _Prompt: |
      Implement the task for spec dispatch-prompt-prefix-stability, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in deterministic prompt assembly

      Task: Create unit tests for PromptTemplateRegistry ordering and stable-prefix behavior.

      Restrictions:
      - Do not modify runtime behavior yet
      - Keep tests deterministic (no randomness)
      - Use Vitest patterns already used in `src/core/llm/`

      Success:
      - Tests prove segment ordering is deterministic
      - Tests prove dynamic tail is excluded from stablePrefix
      - Tests fail if ordering/prefix rules regress

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [x] 2. Add PromptPrefixCompiler hash-invariant tests
  - File: `src/core/llm/prompt-prefix-compiler.test.ts` (new)
  - Verify changing only the dynamic tail keeps `stablePrefixHash` constant
  - Verify changing dynamic tail changes `dynamicTailHash` and `cacheKey`
  - Verify changing stable prefix (model/system content) changes `stablePrefixHash`
  - Purpose: Lock cacheability invariants at the hashing boundary
  - _Leverage: `src/core/llm/prompt-prefix-compiler.ts`_
  - _Requirements: 3, 5_
  - _Prompt: |
      Implement the task for spec dispatch-prompt-prefix-stability, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in hashing and cache keys

      Task: Add unit tests for PromptPrefixCompiler hash semantics to enforce stable-vs-dynamic behavior.

      Restrictions:
      - Do not change the hashing algorithm
      - Do not add external dependencies
      - Keep test fixtures small and readable

      Success:
      - Stable hash remains unchanged for dynamic-tail-only edits
      - Dynamic hash/cache key change when dynamic tail changes
      - Stable hash changes when stable prefix changes

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [x] 3. Canonicalize dispatch dynamic-tail construction order
  - File: `src/tools/workflow/dispatch-runtime.ts`
  - Refactor `DispatchPromptCompiler.compile()` to build dynamic tail through one helper with fixed section order
  - Ensure `Task prompt` block is always appended last
  - Ensure run/task/delta/guide values remain dynamic (not stable template)
  - Purpose: Prevent ordering drift and accidental stable-prefix invalidation
  - _Leverage: `DispatchPromptCompiler` in `src/tools/workflow/dispatch-runtime.ts`_
  - _Requirements: 1, 2, 4_
  - _Prompt: |
      Implement the task for spec dispatch-prompt-prefix-stability, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in prompt-compilation pipelines

      Task: Refactor dispatch dynamic-tail assembly into a canonical helper with fixed field ordering and explicit "Task prompt" last placement.

      Restrictions:
      - Keep current dispatch contract markers unchanged
      - Preserve existing compaction behavior and schema expectations
      - Do not move per-dispatch values into stable template segments

      Success:
      - Dynamic-tail order is explicit and deterministic
      - Task prompt always appears as last section
      - Stable prefix content remains role-template-only

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [x] 4. Add dispatch-runtime regression tests for ordering and hash stability
  - File: `src/tools/workflow/dispatch-runtime.test.ts`
  - Add tests that compile two prompts for same run/role with different task prompts and confirm:
  - `stablePrefixHash` unchanged
  - `fullPromptHash` changed
  - prompt still ends with task prompt block
  - Add test that switching role changes stable hash
  - Purpose: Validate P0 behavior at public tool boundary (`compile_prompt`)
  - _Leverage: existing compile_prompt tests in `src/tools/workflow/dispatch-runtime.test.ts`_
  - _Requirements: 1, 3, 5_
  - _Prompt: |
      Implement the task for spec dispatch-prompt-prefix-stability, first call get-implementer-guide to load implementation rules then implement the task:

      Role: QA Engineer specializing in workflow runtime tests

      Task: Add compile_prompt regression tests for canonical ordering and hash invariants.

      Restrictions:
      - Do not remove existing tests
      - Use public dispatch-runtime handler (no private-method access)
      - Keep assertions robust to formatting but strict on ordering/hash behavior

      Success:
      - Same role/template + different dynamic tail keeps stable hash constant
      - Full hash changes with dynamic-tail changes
      - Role change alters stable hash
      - Task prompt remains final section

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [x] 5. Add compaction-path regression test for stable-prefix identity
  - File: `src/tools/workflow/dispatch-runtime.integration.test.ts`
  - Create scenario where auto-compaction triggers and compare with non-compacted compile for same role/template
  - Verify compaction changes dynamic content/tokens but preserves stable-prefix identity
  - Purpose: Ensure Stage A/B/C compaction cannot break prefix-cache reuse
  - _Leverage: existing compaction integration tests in `src/tools/workflow/dispatch-runtime.integration.test.ts`_
  - _Requirements: 2, 4, 5_
  - _Prompt: |
      Implement the task for spec dispatch-prompt-prefix-stability, first call get-implementer-guide to load implementation rules then implement the task:

      Role: QA Engineer specializing in integration testing

      Task: Add integration test coverage proving compaction affects only dynamic tail and does not alter stable-prefix identity for the same role/template.

      Restrictions:
      - Use real dispatch-runtime tool calls (no mocks)
      - Keep fixture text explicit and readable
      - Assert compaction stage and prompt token deltas when applicable

      Success:
      - Test reproduces compaction path
      - Stable prefix hash remains invariant across compaction variants
      - Full prompt hash and token counts reflect dynamic changes

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_
