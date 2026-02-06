# Requirements Document: Observation Masking (Sliding Window)

## Introduction

Implement observation masking in the `HistoryReducer` to selectively truncate old tool-result observations while preserving the agent's full action and reasoning history. Based on JetBrains Research findings (NeurIPS 2025 DL4Code Workshop), this technique halves per-instance context cost while matching LLM-summarization solve rates on SWE-bench Verified. This is the highest-priority (P0) item from Dimension 1 of the token-efficiency research.

## Alignment with Product Vision

This feature directly supports spec-context-mcp's goal of efficient orchestration by:
- Reducing orchestrator context growth across dispatch cycles — the single largest token consumer
- Enabling longer multi-step workflows without hitting context limits
- Achieving ~50% context cost reduction with zero quality risk
- Complementing the existing `HistoryReducer` sliding window and pair-invariant mechanisms

## Requirements

### Requirement 1: Observation-Only Masking Strategy

**User Story:** As an orchestrator, I want old tool-result observations masked while my action/reasoning history is preserved, so that context grows slowly across dispatch cycles without losing decision-making history.

#### Acceptance Criteria

1. WHEN context exceeds `maxInputChars` THEN system SHALL mask content of `pairRole === 'result'` messages outside the sliding window before dropping any action messages
2. WHEN masking an observation THEN system SHALL replace the full content with a short placeholder (e.g., `[observation masked — {originalLength} chars]`) preserving the message envelope
3. WHEN masking observations THEN system SHALL preserve all `pairRole === 'call'` messages (agent actions) in full, regardless of window position
4. WHEN masking observations THEN system SHALL preserve all `role === 'assistant'` reasoning messages in full, regardless of window position
5. IF observation masking alone brings context within budget THEN system SHALL NOT drop or summarize any messages

### Requirement 2: Graduated Reduction Pipeline

**User Story:** As an orchestrator, I want reduction to apply progressively — mask observations first, then summarize if needed — so that minimal information is lost at each step.

#### Acceptance Criteria

1. WHEN context exceeds budget THEN system SHALL apply reduction in order: (1) mask old observations, (2) summarize remaining old messages, (3) truncation fallback
2. WHEN observation masking is sufficient THEN system SHALL skip summarization entirely
3. WHEN observation masking is insufficient THEN system SHALL summarize non-recent, non-system messages that remain after masking
4. WHEN all reduction stages are insufficient THEN system SHALL fall back to the existing truncation fallback with `invariantStatus: 'fallback'`

### Requirement 3: Configurable Masking Behavior

**User Story:** As a developer, I want to configure observation masking parameters, so that I can tune the trade-off between context savings and information retention.

#### Acceptance Criteria

1. WHEN `observationMasking` option is `true` (or unset with `enabled: true`) THEN system SHALL apply observation masking before summarization
2. WHEN `observationMasking` option is `false` THEN system SHALL skip masking and use the existing summarization-only path
3. WHEN `maxObservationChars` is set THEN system SHALL truncate masked observations to that length instead of full replacement
4. IF `maxObservationChars` is not set THEN system SHALL use a default of 80 characters for the masking placeholder
5. WHEN `preserveRecentRawTurns` defines the sliding window THEN observations within the window SHALL remain unmasked

### Requirement 4: Pair Invariant Preservation

**User Story:** As an orchestrator, I want tool call/result pairs to remain structurally valid after masking, so that downstream consumers can still associate calls with their results.

#### Acceptance Criteria

1. WHEN a `pairRole === 'result'` message is masked THEN the corresponding `pairRole === 'call'` message with the same `pairId` SHALL remain present and unmodified
2. WHEN masking observations THEN system SHALL NOT create orphaned pair members (call without result or result without call)
3. WHEN the masked result produces a pair invariant violation THEN system SHALL fall back to the existing fallback path
4. WHEN masking an observation THEN system SHALL preserve the `pairId`, `pairRole`, `role`, and `toolCallId` fields on the masked message

### Requirement 5: Dispatch-Result Observation Masking

**User Story:** As an orchestrator processing dispatch results, I want verbose subprocess stdout masked before it enters context, so that large CLI outputs don't consume the context window.

#### Acceptance Criteria

1. WHEN a tool result contains a `BEGIN_DISPATCH_RESULT`...`END_DISPATCH_RESULT` block THEN system SHALL identify it as a dispatch result
2. WHEN masking a dispatch-result observation THEN system SHALL preserve the structured JSON block between the delimiters
3. WHEN masking a dispatch-result observation THEN system SHALL replace all content outside the delimiters with `[dispatch output masked — {maskedLength} chars]`
4. IF a tool result does not contain dispatch delimiters THEN system SHALL apply standard observation masking (full replacement with placeholder)

### Requirement 6: Reduction Telemetry

**User Story:** As a developer, I want visibility into what the reducer masked and summarized, so that I can tune parameters and debug quality issues.

#### Acceptance Criteria

1. WHEN reduction occurs THEN result SHALL include `maskedCount` indicating how many observations were masked
2. WHEN reduction occurs THEN result SHALL include `maskedChars` indicating total characters removed by masking
3. WHEN reduction uses the graduated pipeline THEN result SHALL include `reductionStage` indicating which stage was sufficient (`'masking'`, `'summarization'`, `'fallback'`)

## Non-Functional Requirements

### Code Architecture and Modularity
- **Single Responsibility**: Observation masking is a distinct stage in the reduction pipeline, separate from summarization
- **Backward Compatibility**: Existing `HistoryReducerOptions` interface extends with optional new fields; callers that don't set `observationMasking` get the new behavior by default (opt-out, not opt-in)
- **Pure Functions**: Masking logic is stateless and side-effect-free, operating on message arrays

### Performance
- Masking SHALL operate in O(n) time over the message array (single pass)
- No LLM calls required for masking (unlike summarization)
- Masking SHOULD reduce the need for expensive summarization calls in the common case

### Reliability
- Pair invariant checks SHALL run after masking, before returning results
- Fallback to existing truncation behavior on any invariant violation
- Masking SHALL never increase total context size (monotonically decreasing)

### Testability
- Each reduction stage (masking, summarization, fallback) SHALL be independently testable
- Dispatch-result detection SHALL be testable with synthetic tool output
