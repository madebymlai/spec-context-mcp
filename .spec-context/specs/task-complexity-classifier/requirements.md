# Requirements: Task-Complexity Classifier for CLI Agent Routing

## Introduction

The orchestrator currently dispatches all tasks to the same CLI agent regardless of complexity. Simple tasks (test stubs, file moves, doc updates, single-line fixes) consume the same expensive model as multi-file architectural refactors. A task-complexity classifier evaluates each task at dispatch time and routes it to the cheapest CLI agent capable of handling it. This is Dimension 4 (Route to Cheaper Agents) from the token-efficiency research — it reduces cost-per-token without reducing token count, and compounds multiplicatively with all other dimensions.

**Research evidence:** RouteLLM achieves 85% cost reduction retaining 95% quality. BudgetMLAgent achieves 94.2% cost reduction. Efficient Agents retains 96.7% performance at 43% cost reduction.

## Alignment with Product Vision

This feature directly supports the product's core mission of token-efficient agentic orchestration. The existing `BudgetGuard` handles reactive budget enforcement (deny/degrade/queue when budget is exceeded). This classifier makes routing *proactive* — selecting the right agent *before* dispatching, rather than degrading *after* exceeding limits. It leverages the existing `PROVIDER_CATALOG` (claude, codex, gemini, opencode) and `resolveAgentCli()` infrastructure.

## Requirements

### Requirement 1: Task Complexity Classification

**User Story:** As an orchestrator, I want each dispatch task classified by complexity at `initRun` time, so that the system can select the cheapest capable CLI agent.

#### Acceptance Criteria

1. WHEN the orchestrator calls `initRun` with a task description THEN the classifier SHALL return a complexity level from a discrete set (e.g., `simple`, `moderate`, `complex`)
2. WHEN the task description mentions single-file changes, test stubs, doc updates, or mechanical transforms THEN the classifier SHALL classify as `simple`
3. WHEN the task description involves multi-file changes, new interfaces, or architectural decisions THEN the classifier SHALL classify as `moderate` or `complex`
4. IF the task metadata includes file count, estimated scope, or explicit complexity hints THEN the classifier SHALL incorporate these signals into classification
5. WHEN classification completes THEN the classifier SHALL emit the classification result with confidence score and contributing features for observability

### Requirement 2: CLI Agent Routing by Complexity

**User Story:** As an orchestrator, I want tasks routed to the cheapest CLI agent that can handle them, so that simple tasks don't waste expensive model capacity.

#### Acceptance Criteria

1. WHEN a task is classified as `simple` THEN the router SHALL select the cheapest configured CLI agent (e.g., codex, opencode with smaller models)
2. WHEN a task is classified as `complex` THEN the router SHALL select the strongest configured CLI agent (e.g., claude with Opus/Sonnet)
3. WHEN a task is classified as `moderate` THEN the router SHALL select a mid-tier agent based on the configured routing table
4. IF the selected agent is not available or not configured THEN the router SHALL fall back to the next tier up, never down
5. WHEN routing completes THEN the system SHALL log the classification, selected agent, and routing rationale

### Requirement 3: Routing Table Configuration

**User Story:** As a user, I want to configure which CLI agents map to which complexity tiers, so that I can tune routing for my provider setup and cost targets.

#### Acceptance Criteria

1. WHEN the user provides a routing configuration THEN the system SHALL use it to map complexity levels to CLI agents
2. IF no routing configuration is provided THEN the system SHALL use a sensible default mapping derived from `PROVIDER_CATALOG`
3. WHEN the routing table is loaded THEN the system SHALL validate that all referenced agents exist in `PROVIDER_CATALOG` or are valid custom commands
4. IF the routing table references an unknown agent THEN the system SHALL fail loud at startup, not silently fall back

### Requirement 4: Integration with BudgetGuard

**User Story:** As an orchestrator, I want the complexity classifier to work alongside BudgetGuard, so that proactive routing and reactive budget enforcement compose cleanly.

#### Acceptance Criteria

1. WHEN the classifier selects an agent THEN BudgetGuard SHALL still apply its budget filtering to the selected agent's model
2. IF BudgetGuard denies the classifier's selection THEN the system SHALL escalate to the next tier up (not degrade to a cheaper agent that may fail the task)
3. WHEN BudgetGuard triggers emergency degradation THEN the degraded model SHALL be logged alongside the original classification for post-hoc analysis
4. IF budget is exhausted across all tiers THEN BudgetGuard's existing deny/queue behavior SHALL apply unchanged

### Requirement 5: Strategy Pattern for Classifier Implementations

**User Story:** As a developer, I want the classifier to be a swappable strategy, so that I can replace the initial heuristic with ML-based classification later without changing the routing logic.

#### Acceptance Criteria

1. WHEN the system initializes THEN it SHALL resolve the classifier implementation from an interface, not a concrete class
2. WHEN a new classifier strategy is registered THEN it SHALL be usable without modifying routing code
3. IF the initial implementation uses heuristic rules THEN it SHALL implement the same interface that a future ML classifier would

## Non-Functional Requirements

### Code Architecture and Modularity
- **Single Responsibility**: Classifier and router are separate concerns — classifier evaluates complexity, router selects agent
- **Strategy Pattern**: Classifier is behind an `ITaskComplexityClassifier` interface; implementations are swappable
- **Open/Closed**: Adding a new complexity tier or classifier strategy requires no modification to existing routing code
- **Dependency Inversion**: Router depends on `ITaskComplexityClassifier` interface, never on concrete heuristic/ML implementations

### Performance
- Classification must complete in <10ms (no LLM calls in the classifier itself — that would defeat the purpose)
- Zero additional subprocess invocations for classification
- Classification is a pure function of task metadata — no I/O

### Token Efficiency
- Routing to cheaper agents shall reduce cost by at least 50% on tasks classified as `simple` compared to always using the strongest agent
- Classification metadata (complexity level, confidence, features) shall be <200 tokens when serialized for observability

### Reliability
- Classifier failures SHALL default to `complex` (route to strongest agent) — never silently downgrade
- Misclassification of a complex task as simple is worse than the reverse — the default bias is toward the stronger agent
- The C3PO re-dispatch cascade (P2, future) is the safety net for misclassification — this spec does not implement it

### Testability
- Classifier must be testable with deterministic inputs (task description string + metadata) and deterministic outputs (complexity level + confidence)
- Routing table must be injectable for testing without filesystem I/O
