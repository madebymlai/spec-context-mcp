• Using OpenCode repo (8bf97ef) as reference, here is the concrete plan to implement pre-dispatch compaction in our system the same
  way structurally.
  What OpenCode Actually Does (to mirror)
  1. Token-overflow gate before continuing normal loop (SessionCompaction.isOverflow) using real token usage + model limits.
  2. Auto-compaction task insertion when overflow is detected (does not continue normal path first).
  3. Dedicated hidden compaction agent with no tool permissions to summarize context for continuation.
  4. Optional pruning of old tool outputs by marking them compacted and replacing content with placeholder at render time.
  6. Hook to customize compaction prompt/context (experimental.session.compacting).
  Refs:

  - packages/opencode/src/session/compaction.ts
  - packages/opencode/src/session/prompt.ts
  - packages/opencode/src/session/processor.ts
  - packages/opencode/src/session/message-v2.ts
  - packages/opencode/src/config/config.ts
  - packages/plugin/src/index.ts

  Plan For Our Codebase
  1. Add dispatch compaction policy + budgets
  - File: src/tools/workflow/dispatch-runtime.ts
  - Add DispatchCompactionPolicy:
      - auto: boolean (default true)
      - prune: boolean (default true)
      - maxInputTokensImplementer, maxInputTokensReviewer
      - reserveOutputTokens (default from maxOutputTokens)
      - SPEC_CONTEXT_DISPATCH_COMPACTION_AUTO=0/1

  2. Add pre-dispatch overflow detector in compile_prompt

  - File: src/tools/workflow/dispatch-runtime.ts
  - Compute usable budget = input budget minus reserved output.

  3. Implement compaction pipeline (OpenCode-style staged)

  - File: src/tools/workflow/dispatch-runtime.ts (or dispatch-compaction.ts)
  - Stage A: deterministic prune
      - Drop low-value/old delta fields first.
      - Preserve strict essentials: task_id, latest implementer/reviewer status summary, required constraints.
  - Stage B: deterministic task prompt compaction
  - Stage C: LLM compaction fallback (optional but recommended)
      - No tools. No orchestration side effects.
  - If still overflow after Stage C, return hard failure dispatch_prompt_overflow_terminal.

  4. Add compacted-state placeholders (prune behavior)

  - Keep a fact marker in snapshot:
      - dispatch_compaction_stage:<stage>
  - When rendering delta/telemetry, surface placeholder instead of dropped payload (same spirit as OpenCode’s [Old tool result
    content cleared]).


      - compactionContext?: string[]
      - compactionPromptOverride?: string
  - Use this like OpenCode’s plugin hook to tune compaction prompt per workflow without code changes.

  6. Telemetry + guardrails

  - Extend dispatch telemetry:
      - compaction_count
      - compaction_auto_count
      - compaction_prompt_tokens_before/after
      - compaction_ratio
      - compaction_stage_distribution
  - Add guardrail parity metric:
      - next-action parity between compacted/non-compacted replay traces.

  Tests To Add (exactly)

  1. compile_prompt overflow triggers compaction when auto enabled.
  2. compile_prompt overflow returns terminal error when auto disabled.
  3. Stage A/B/C progression is deterministic and monotonic on token count.
  4. Compacted prompt still contains required invariants (task_id, output contract instructions, branch-critical constraints).
  5. Next-action parity replay tests for compacted vs non-compacted traces.
  6. Snapshot facts include compaction markers when compaction happened.

  Files:

  - src/tools/workflow/dispatch-runtime.test.ts
  - src/tools/workflow/dispatch-runtime.integration.test.ts
  - (optional) new src/tools/workflow/dispatch-compaction.test.ts

  Rollout Order

  1. P0: overflow detector + Stage A/B deterministic compaction + telemetry.
  2. P1: LLM compaction fallback + hook support.
  3. P1: parity replay guardrails + rollout flag (SPEC_CONTEXT_DISPATCH_COMPACTION_V1).
