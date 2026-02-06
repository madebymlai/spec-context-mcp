# Requirements Document: Discipline Workflow

## Introduction

Enhance spec-context-mcp with development discipline enforcement (TDD, code review, verification) and multi-LLM CLI dispatch support. This feature embeds battle-tested prompt engineering patterns from Superpowers Skills into the spec-context workflow, making them LLM-agnostic and configurable at the server level.

## Alignment with Product Vision

This feature extends spec-context's mission of structured, quality-driven development by:
- Enforcing proven development disciplines during implementation phase
- Enabling multi-LLM orchestration for specialized roles
- Providing configurable discipline levels for different project needs

## Requirements

### Requirement 1: Discipline Mode Configuration

**User Story:** As a developer, I want to configure the discipline level for my development workflow, so that I can choose between strict TDD enforcement or lighter verification modes.

#### Acceptance Criteria

1. WHEN `SPEC_CONTEXT_DISCIPLINE` env var is set to `full` THEN system SHALL enforce TDD + reviews + verification
2. WHEN `SPEC_CONTEXT_DISCIPLINE` env var is set to `standard` THEN system SHALL enforce reviews + verification (no TDD)
3. WHEN `SPEC_CONTEXT_DISCIPLINE` env var is set to `minimal` THEN system SHALL enforce verification only
4. IF `SPEC_CONTEXT_DISCIPLINE` is not set THEN system SHALL default to `full` mode

### Requirement 2: Multi-LLM CLI Dispatch

**User Story:** As a developer, I want to dispatch different roles to different LLM CLIs, so that I can use the best model for each task (e.g., Claude for implementation, Codex for review).

#### Acceptance Criteria

1. WHEN `SPEC_CONTEXT_IMPLEMENTER` env var is set THEN system SHALL dispatch implementer tasks to that CLI
2. WHEN `SPEC_CONTEXT_REVIEWER` env var is set THEN system SHALL dispatch reviewer tasks to that CLI
3. WHEN `SPEC_CONTEXT_BRAINSTORM` env var is set THEN system SHALL dispatch brainstorm tasks to that CLI
4. IF dispatch env vars are not set THEN orchestrator SHALL self-identify and use itself as default
5. WHEN dispatching THEN system SHALL invoke CLI as `cli "task prompt + guide content"`

### Requirement 3: Implementer Guide

**User Story:** As an implementer agent, I want to receive discipline-specific guidance when implementing tasks, so that I follow the correct development practices.

#### Acceptance Criteria

1. WHEN `get-implementer-guide` is called in `full` mode THEN system SHALL return TDD rules + verification rules + steering doc content
2. WHEN `get-implementer-guide` is called in `standard` or `minimal` mode THEN system SHALL return verification rules + steering doc content
3. WHEN guide is returned THEN system SHALL include full content of `tech.md` and `principles.md`
4. IF required steering docs don't exist THEN system SHALL fail with error directing user to create them
5. WHEN guide is returned THEN system SHALL include search tool guidance for discovering existing patterns

### Requirement 4: Reviewer Guide

**User Story:** As a reviewer agent, I want to receive review criteria and project standards, so that I can properly evaluate implementations.

#### Acceptance Criteria

1. WHEN `get-reviewer-guide` is called THEN system SHALL return review checklist + steering doc content
2. WHEN guide is returned THEN system SHALL include full content of `tech.md` and `principles.md`
3. WHEN guide is returned THEN system SHALL specify severity levels (critical, important, minor)
4. WHEN guide is returned THEN system SHALL include search tool guidance for checking duplicates
5. IF discipline mode is `minimal` THEN `get-reviewer-guide` SHALL NOT be active

### Requirement 5: Brainstorm Guide

**User Story:** As an orchestrator, I want a brainstorming guide for pre-spec ideation, so that ideas can be refined before formal spec creation.

#### Acceptance Criteria

1. WHEN `get-brainstorm-guide` is called THEN system SHALL return brainstorming methodology
2. WHEN guide is returned THEN system SHALL NOT include steering docs (orchestrator already has context)
3. WHEN guide is returned THEN system SHALL NOT include search guidance (orchestrator handles search)

### Requirement 6: Principles Steering Document

**User Story:** As a project maintainer, I want a dedicated principles.md steering document, so that coding standards are separated from tech stack documentation.

#### Acceptance Criteria

1. WHEN steering docs are created THEN system SHALL support `principles.md` as a new steering doc type
2. WHEN `principles-template.md` is requested THEN system SHALL provide template with SOLID principles, architecture rules, design patterns sections
3. WHEN guides auto-import steering docs THEN `principles.md` SHALL be included for implementer and reviewer roles

### Requirement 7: Review Loop Flow

**User Story:** As an orchestrator, I want a progress-based review loop, so that stuck implementations are escalated without arbitrary limits.

#### Acceptance Criteria

1. WHEN reviewer finds issues THEN implementer SHALL receive feedback directly (no summarization)
2. WHEN reviewer re-reviews THEN reviewer SHALL see fix diff + spot-check previous issues
3. IF same issue appears twice THEN orchestrator SHALL take over and fix (implementer doesn't understand)
4. WHEN different issues appear THEN loop SHALL continue until resolved

### Requirement 8: Spec Workflow Enhancement

**User Story:** As a user starting a new feature, I want the option to brainstorm before formal spec creation, so that unclear ideas can be refined first.

#### Acceptance Criteria

1. WHEN spec-workflow-guide is called THEN system SHALL recap understanding and ask "Clear enough for spec, or brainstorm first?"
2. IF user chooses brainstorm THEN system SHALL dispatch to brainstorm CLI with guide
3. WHEN discipline mode is `full` THEN task generation SHALL NOT create separate test tasks (TDD implicit)
4. WHEN discipline mode is `standard` or `minimal` THEN task generation MAY include separate test tasks

### Requirement 9: Prompt Combination

**User Story:** As an orchestrator dispatching to CLIs, I want a consistent prompt structure, so that all agents receive properly formatted instructions.

#### Acceptance Criteria

1. WHEN dispatching to CLI THEN system SHALL place task `_Prompt` first
2. WHEN dispatching to CLI THEN system SHALL concatenate guide content at end
3. WHEN dispatching to CLI THEN system SHALL include auto-imported steering doc content

## Non-Functional Requirements

### Code Architecture and Modularity
- **Single Responsibility Principle**: Each MCP tool (guide) has one purpose
- **Modular Design**: Guides are separate tools, steering doc loading is reusable
- **Clear Interfaces**: Guides return structured content, discipline mode affects behavior consistently

### Performance
- Steering doc content is read once per guide call
- No unnecessary file reads (brainstorm guide skips steering docs)

### Security
- Environment variables for configuration (no secrets in code)
- CLI invocation uses standard shell patterns

### Reliability
- Fail fast on missing steering docs
- Progress-based review loops prevent infinite iterations

### Usability
- Default to `full` mode (highest quality)
- Self-identify for CLI default (no config required for basic use)
- Clear error messages when steering docs missing
