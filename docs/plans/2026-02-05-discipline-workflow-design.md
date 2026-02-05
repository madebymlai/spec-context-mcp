# Discipline Workflow Enhancement

## Attribution

This design is based on the **Superpowers Skills** - a collection of battle-tested prompt engineering patterns for LLM agents. These skills represent some of the most effective techniques for ensuring quality and discipline in AI-assisted development.

### Source Skills

- `superpowers/skills/test-driven-development`
- `superpowers/skills/verification-before-completion`
- `superpowers/skills/receiving-code-review`
- `superpowers/skills/requesting-code-review`
- `superpowers/skills/subagent-driven-development`

### Foundational Principles (Adapted for Spec-Context)

**Test-Driven Development (TDD):**

> Write the test first. Watch it fail. Write minimal code to pass.
>
> **Core principle:** If you didn't watch the test fail, you don't know if it tests the right thing.

> **The Iron Law:**
> ```
> NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
> ```
> Write code before the test? Delete it. Start over.

> Tests-after answer "What does this do?" Tests-first answer "What should this do?"

Applied in spec-context: When `SPEC_CONTEXT_DISCIPLINE=full`, the `get-implementer-guide` MCP tool returns TDD rules. Task generation skips separate test tasks since TDD is implicit.

**Verification Before Completion:**

> Claiming work is complete without verification is dishonesty, not efficiency.
>
> **Core principle:** Evidence before claims, always.

> **The Iron Law:**
> ```
> NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
> ```

> **The Gate Function:**
> 1. IDENTIFY: What command proves this claim?
> 2. RUN: Execute the FULL command (fresh, complete)
> 3. READ: Full output, check exit code, count failures
> 4. VERIFY: Does output confirm the claim?
> 5. ONLY THEN: Make the claim

Applied in spec-context: Verification rules are always included in `get-implementer-guide` regardless of discipline mode. Implementers must verify before reporting task complete.

**Receiving Code Review:**

> Code review requires technical evaluation, not emotional performance.
>
> **Core principle:** Verify before implementing. Ask before assuming. Technical correctness over social comfort.

> **Forbidden Responses:**
> - "You're absolutely right!"
> - "Great point!" / "Excellent feedback!"
> - "Let me implement that now" (before verification)

> External feedback = suggestions to evaluate, not orders to follow.
> Verify against `principles.md` and `tech.md`. Question. Then implement.

Applied in spec-context: Implementer receives reviewer feedback directly. Must verify suggestions against project's `principles.md` before implementing. Push back with technical reasoning if feedback conflicts with documented principles.

**Subagent-Driven Development:**

> **Core principle:** Fresh CLI per task + two-stage review (spec then quality) = high quality, fast iteration

> **Quality gates:**
> - Two-stage review: spec compliance, then code quality
> - Review loops ensure fixes actually work
> - Spec compliance prevents over/under-building
> - Check against `tech.md` for architecture, `principles.md` for coding standards

> **Red Flags - Never:**
> - Skip reviews (when `full` or `standard` mode)
> - Accept "close enough" on spec compliance
> - Skip review loops (same issue twice = orchestrator takes over)
> - Start code quality review before spec compliance passes

Applied in spec-context: Orchestrator dispatches to configurable CLIs (`SPEC_CONTEXT_IMPLEMENTER_CLI`, `SPEC_CONTEXT_REVIEWER_CLI`). Reviewer uses `get-reviewer-guide` which references `principles.md` and `tech.md` for review criteria.

---

## Overview

Enhance spec-context-mcp with development discipline enforcement (TDD, code review, verification) and multi-LLM CLI dispatch support. Disciplines are configurable at server level and guides are LLM-agnostic.

## Motivation

The superpowers skills (test-driven-development, receiving-code-review, requesting-code-review, subagent-driven-development, verification-before-completion) provide valuable development discipline but are Claude-specific. This design:

1. Embeds these behaviors into the spec-context workflow
2. Makes them LLM-agnostic (any CLI agent can follow the guides)
3. Enables multi-LLM orchestration (different CLIs for different roles)
4. Configures discipline level via environment variables

## Configuration

### Environment Variables

```bash
# Discipline mode (default: full)
SPEC_CONTEXT_DISCIPLINE=full|standard|minimal

# CLI dispatch overrides (default: auto-detect current CLI)
SPEC_CONTEXT_IMPLEMENTER_CLI=claude|codex|gpt|...
SPEC_CONTEXT_REVIEWER_CLI=claude|codex|gpt|...
SPEC_CONTEXT_BRAINSTORM_CLI=claude|codex|gpt|...
```

### Discipline Modes

| Mode | TDD | Reviews | Verification |
|------|-----|---------|--------------|
| `full` | ✓ | ✓ | ✓ |
| `standard` | ✗ | ✓ | ✓ |
| `minimal` | ✗ | ✗ | ✓ |

Verification is always on (it's just honesty about completion status).

### CLI Dispatch

If `SPEC_CONTEXT_*_CLI` vars are not set, defaults to the current CLI being used. Only set when you want a different CLI for a specific role.

Any CLI that accepts a prompt as input can be used. Common options:

| CLI | Command | Description |
|-----|---------|-------------|
| `claude` | Claude Code | Anthropic's CLI agent |
| `codex` | OpenAI Codex | OpenAI's coding CLI |
| `aider` | Aider | AI pair programming |
| `gpt` | GPT CLI | OpenAI GPT interface |
| `gemini` | Gemini CLI | Google's CLI agent |

Example: Use Claude for implementation, Codex for review:
```bash
SPEC_CONTEXT_REVIEWER_CLI=codex
```

The orchestrator invokes the CLI with the guide + task prompt. The CLI must accept a prompt and return output.

**Future extension:** Architecture is open to API-based dispatch (e.g., OpenRouter). Since `OPENROUTER_API_KEY` is already configured for dashboard AI review, the same `*_CLI` vars could later accept model identifiers (e.g., `openrouter:anthropic/claude-3-opus`) that dispatch via API instead of CLI. Single config pattern, no separate env vars.

## Architecture

### Roles and Responsibilities

| Role | Responsibility | Guide Tool |
|------|----------------|------------|
| Orchestrator | Workflow coordination, task dispatch, review loops | `spec-workflow-guide` |
| Brainstormer | Pre-spec ideation, clarify requirements | `get-brainstorm-guide` |
| Implementer | Build code following TDD/verification rules | `get-implementer-guide` |
| Reviewer | Check spec compliance, code quality, principles | `get-reviewer-guide` |

### Steering Doc Access by Role

| Steering doc | Orchestrator | Implementer | Reviewer |
|--------------|--------------|-------------|----------|
| `product.md` | ✓ | ✗ | ✗ |
| `tech.md` | ✓ | ✓ | ✓ |
| `structure.md` | ✓ | ✗ | ✗ |
| `principles.md` | ✓ | ✓ | ✓ |

- **Orchestrator** gets all four (knows product, structure, tech, principles)
- **Implementer** gets `tech.md` + `principles.md` (knows how to code)
- **Reviewer** gets `tech.md` + `principles.md` (knows what to check)

Task `_Prompt` already tells implementer which files to touch. Structure is orchestrator's concern.

## New Steering Document: principles.md

### Purpose

Separate key principles from tech.md. Principles are cross-cutting - everyone needs them. Tech.md becomes lean (stack, architecture, tools only).

### Template Structure

```markdown
# Key Principles

## Architecture Rules
- [e.g., Domain layer has no I/O]
- [e.g., Depend on abstractions, not implementations]

## Coding Standards

### SOLID Principles
1. **Single Responsibility (SRP)** — One class, one reason to change
   - Ask: "Can I describe this class's purpose without using 'and'?"

2. **Open/Closed (OCP)** — Extend behavior without modifying existing code
   - Ask: "Can I add this behavior without changing existing code?"

3. **Liskov Substitution (LSP)** — Implementations are interchangeable
   - Ask: "Would swapping this implementation break callers?"

4. **Interface Segregation (ISP)** — Small, focused interfaces
   - Ask: "Does this class use every method it's forced to implement?"

5. **Dependency Inversion (DIP)** — Depend on abstractions
   - Ask: "Am I importing a concrete class or an interface?"

### Additional Principles
- [e.g., No defensive garbage - let bugs surface]
- [e.g., KISS - simplest solution that works]
- [e.g., DRY - extract repeated logic]

## Design Patterns
- [Patterns to use in this codebase]
- [Anti-patterns to avoid]

## Quality Gates
- [What must be true before code is accepted]
```

## New MCP Tools

### get-brainstorm-guide

Returns guide for pre-spec ideation. Includes:
- Question-driven exploration process
- How to present options with trade-offs
- When idea is clear enough for formal spec

### get-implementer-guide

Returns guide for implementing tasks. Content varies by discipline mode:

| Mode | Content |
|------|---------|
| `full` | TDD rules + verification rules + `principles.md` |
| `standard` | Verification rules + `principles.md` |
| `minimal` | Verification rules + `principles.md` |

**TDD Rules (full mode):**
- Write failing test first, watch it fail
- Write minimal code to pass
- Refactor while green
- No production code without failing test
- Delete code written before test

**Verification Rules (all modes):**
- Run tests before claiming done
- Evidence before assertions
- No "should work" - verify it does

### get-reviewer-guide

Returns guide for reviewing implementations. Only active for `full` and `standard` modes.

**Review checklist:**
1. Spec compliance - does code match task requirements?
2. Code quality - errors handled, tests pass, maintainable?
3. Principles compliance - follows `principles.md` rules?
4. Tech compliance - follows `tech.md` architecture?

**Issue severity:**
- Critical: bugs, security, data loss
- Important: architecture, missing features, test gaps
- Minor: style, optimization, docs

## Updated MCP Tools

### spec-workflow-guide

Enhanced to include:
1. Discipline-based content (review workflow if full/standard)
2. Steering doc imports for orchestrator
3. Brainstorm option at start

**New flow:**
1. Recap understanding of idea
2. Ask: "Clear enough for spec, or brainstorm first?"
3. User chooses → brainstorm or proceed to spec

### Task Generation (Phase 3)

Affected by discipline mode:

| Mode | Task generation |
|------|-----------------|
| `full` | No separate test tasks - TDD is implicit in each task |
| `standard` | May include test tasks after implementation |
| `minimal` | May include test tasks after implementation |

## Implementation Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                         ORCHESTRATOR                              │
│                                                                   │
│  1. Calls spec-workflow-guide                                     │
│     → Gets workflow + discipline config + all steering docs       │
│     → Asks: brainstorm or proceed?                                │
│                                                                   │
│  2. If brainstorm:                                                │
│     → Dispatches to BRAINSTORM_CLI with get-brainstorm-guide      │
│     → Refines idea until clear                                    │
│                                                                   │
│  3. Spec workflow: Requirements → Design → Tasks                  │
│                                                                   │
│  4. For each task:                                                │
│     ┌─────────────────────────────────────────────────────────┐  │
│     │  Dispatches to IMPLEMENTER_CLI with:                     │  │
│     │    - Task _Prompt                                        │  │
│     │    - get-implementer-guide content                       │  │
│     │    - tech.md + principles.md                             │  │
│     │                                                          │  │
│     │  Implementer:                                            │  │
│     │    - Follows TDD (if full mode)                          │  │
│     │    - Implements task                                     │  │
│     │    - Verifies before reporting done                      │  │
│     └─────────────────────────────────────────────────────────┘  │
│                              ↓                                    │
│     ┌─────────────────────────────────────────────────────────┐  │
│     │  If full or standard mode:                               │  │
│     │  Dispatches to REVIEWER_CLI with:                        │  │
│     │    - Implementation diff                                 │  │
│     │    - get-reviewer-guide content                          │  │
│     │    - tech.md + principles.md                             │  │
│     │                                                          │  │
│     │  Reviewer:                                               │  │
│     │    - Checks spec compliance                              │  │
│     │    - Checks code quality                                 │  │
│     │    - Checks principles compliance                        │  │
│     │    - Reports issues with severity                        │  │
│     └─────────────────────────────────────────────────────────┘  │
│                              ↓                                    │
│     If issues: Implementer fixes → Reviewer re-reviews           │
│     If approved: Mark task complete, next task                   │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

## Changes Summary

| Change | Description |
|--------|-------------|
| New env var | `SPEC_CONTEXT_DISCIPLINE=full\|standard\|minimal` |
| New env vars | `SPEC_CONTEXT_IMPLEMENTER_CLI`, `SPEC_CONTEXT_REVIEWER_CLI`, `SPEC_CONTEXT_BRAINSTORM_CLI` |
| New steering doc | `principles.md` + `principles-template.md` |
| Update steering doc | `tech-template.md` (remove principles section) |
| New MCP tool | `get-brainstorm-guide` |
| New MCP tool | `get-implementer-guide` |
| New MCP tool | `get-reviewer-guide` |
| Update MCP tool | `spec-workflow-guide` (discipline logic, steering imports, brainstorm option) |
| Update | `steering-guide` (add principles.md creation) |
| Update | Task generation (no separate test tasks if TDD mode) |

## File Structure

```
.spec-context/
├── templates/
│   ├── requirements-template.md
│   ├── design-template.md
│   ├── tasks-template.md
│   ├── product-template.md
│   ├── tech-template.md          # Updated: remove principles
│   ├── structure-template.md
│   └── principles-template.md    # New
├── specs/
│   └── {spec-name}/
│       ├── requirements.md
│       ├── design.md
│       └── tasks.md
└── steering/
    ├── product.md
    ├── tech.md                   # Lean: stack, architecture, tools
    ├── structure.md
    └── principles.md             # New: coding rules, SOLID, patterns
```

## Review Loop Flow

When reviewer finds issues, the fix-review loop works as follows:

```
Implementer completes task
         ↓
Reviewer reviews
         ↓
    ┌────┴────┐
    │ Issues? │
    └────┬────┘
    No   │  Yes
    ↓    ↓
  Done   Implementer fixes (gets feedback directly)
              ↓
         Reviewer re-reviews (fix diff + spot-check previous)
              ↓
         ┌────┴────────┐
         │ Same issue  │
         │ appears?    │
         └────┬────────┘
         No   │  Yes
         ↓    ↓
       Loop   Orchestrator takes over and fixes
```

**Key decisions:**
- Implementer sees reviewer feedback directly (no summarization)
- Reviewer sees fix diff + spot-checks previous issues were fixed
- No magic number for max loops - progress-based instead
- If same issue appears twice, orchestrator takes over (implementer doesn't understand)
- Different issues can keep looping until resolved

## Guide Content Summary

### get-brainstorm-guide

- Ask questions one at a time
- Prefer multiple choice when possible
- Explore 2-3 approaches with trade-offs
- Present design in small sections for validation
- When to move to formal spec

### get-implementer-guide

**Full mode:**
- TDD: Red-green-refactor cycle
- No code without failing test first
- Delete code written before test
- Verification: run tests before claiming done
- principles.md content

**Standard/Minimal mode:**
- Verification: run tests before claiming done
- principles.md content

### get-reviewer-guide

- Read tech.md for architecture rules
- Read principles.md for coding standards
- Check spec compliance (does it match requirements?)
- Check code quality (errors, tests, maintainability)
- Check principles compliance (SOLID, patterns, rules)
- Report issues with severity (critical/important/minor)
- Include file:line references
