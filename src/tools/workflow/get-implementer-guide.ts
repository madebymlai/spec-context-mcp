/**
 * get-implementer-guide MCP tool
 * Returns discipline-specific implementation guidance
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolContext, ToolResponse } from '../../workflow-types.js';
import { getDisciplineMode } from '../../config/discipline.js';
import { getSteeringDocs, getMissingSteeringDocs } from './steering-loader.js';

export const getImplementerGuideTool: Tool = {
  name: 'get-implementer-guide',
  description: `Get implementation guidance based on discipline mode. Use when starting implementation work on a task.

Returns:
- TDD rules (full mode only)
- Verification rules (all modes)
- Code review feedback handling (all modes)
- Project tech stack and principles
- Search tool guidance

Fails if required steering docs (tech.md, principles.md) are missing.`,
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  }
};

export async function getImplementerGuideHandler(
  _args: unknown,
  context: ToolContext
): Promise<ToolResponse> {
  const mode = getDisciplineMode();

  // Check for required steering docs
  const missing = getMissingSteeringDocs(context.projectPath, ['tech', 'principles']);
  if (missing.length > 0) {
    return {
      success: false,
      message: `Required steering docs missing: ${missing.map(d => `${d}.md`).join(', ')}. Create them using the steering-guide tool first.`,
    };
  }

  // Load steering docs
  const steering = getSteeringDocs(context.projectPath, ['tech', 'principles']);

  const guide = buildImplementerGuide(mode);

  return {
    success: true,
    message: `Implementer guide loaded (discipline: ${mode})`,
    data: {
      guide,
      steering,
      disciplineMode: mode,
      searchGuidance: getSearchGuidance(),
    },
    nextSteps: [
      'Read the task requirements and _Prompt field',
      'Follow the guide methodology',
      'Use search tools to discover existing patterns',
      'Mark task complete when done'
    ]
  };
}

function buildImplementerGuide(mode: 'full' | 'standard' | 'minimal'): string {
  const sections: string[] = [];

  sections.push('# Implementation Guide\n');

  if (mode === 'full') {
    sections.push(getTddRules());
  }

  sections.push(getVerificationRules());
  sections.push(getFeedbackHandling());

  return sections.join('\n');
}

function getTddRules(): string {
  return `## Test-Driven Development

Write the test first. Watch it fail. Write minimal code to pass.

**The Iron Law:** No production code without a failing test first.

### Red-Green-Refactor Cycle

1. **RED** - Write one failing test
   - One behavior per test
   - Clear descriptive name
   - Use real code, minimize mocks

2. **Verify RED** - Run test, confirm it fails
   - Must fail for expected reason (feature missing, not typos)
   - If test passes immediately, you're testing existing behavior

3. **GREEN** - Write minimal code to pass
   - Just enough to make the test pass
   - Don't add features beyond the test

4. **Verify GREEN** - Confirm all tests pass
   - New test passes
   - Existing tests still pass

5. **REFACTOR** - Clean up while green
   - Remove duplication
   - Improve names
   - Keep tests passing

### TDD Red Flags (Start Over)

- Code written before test
- Test passes immediately
- Can't explain why test failed
- Rationalizing "just this once"

### Verification Checklist

- [ ] Every new function/method has a test
- [ ] Watched each test fail before implementing
- [ ] Each test failed for expected reason
- [ ] Wrote minimal code to pass each test
- [ ] All tests pass
- [ ] Edge cases and errors covered

`;
}

function getVerificationRules(): string {
  return `## Verification Before Completion

**Core Principle:** Evidence before claims, always.

### The Gate Function

Before claiming any work is complete:

1. **IDENTIFY** - What command proves this claim?
2. **RUN** - Execute the full command (fresh, complete)
3. **READ** - Full output, check exit code, count failures
4. **VERIFY** - Does output confirm the claim?
5. **ONLY THEN** - Make the claim with evidence

### Common Verification Requirements

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check |
| Build succeeds | Build command: exit 0 | Linter passing |
| Bug fixed | Test original symptom passes | Code changed, assumed fixed |

### Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification
- About to commit without running tests
- Relying on partial verification

`;
}

function getFeedbackHandling(): string {
  return `## Handling Code Review Feedback

**Core Principle:** Technical correctness over social comfort.

### Response Pattern

1. **READ** - Complete feedback without reacting
2. **UNDERSTAND** - Restate requirement in own words
3. **VERIFY** - Check against codebase reality
4. **EVALUATE** - Technically sound for THIS codebase?
5. **RESPOND** - Technical acknowledgment or reasoned pushback
6. **IMPLEMENT** - One item at a time, test each

### When Feedback is Unclear

If any item is unclear, STOP and ask for clarification before implementing.
Items may be related - partial understanding leads to wrong implementation.

### When to Push Back

Push back when:
- Suggestion breaks existing functionality
- Reviewer lacks full context
- Violates YAGNI (unused feature)
- Technically incorrect for this stack
- Conflicts with architectural decisions

How to push back:
- Use technical reasoning, not defensiveness
- Reference working tests/code
- Ask specific questions

### Implementation Order for Multi-Item Feedback

1. Clarify anything unclear FIRST
2. Implement in order:
   - Blocking issues (breaks, security)
   - Simple fixes (typos, imports)
   - Complex fixes (refactoring, logic)
3. Test each fix individually
4. Verify no regressions

`;
}

function getSearchGuidance(): string {
  return `## Using Search Tools

Before implementing, use search tools to discover existing patterns:

**When to Search:**
- Before creating new utilities - check if similar exists
- Before adding dependencies - check current usage patterns
- When implementing interfaces - find existing implementations

**Search Strategies:**
- \`search\` with type="regex" for exact patterns (function names, imports)
- \`search\` with type="semantic" for concepts ("error handling", "validation")
- \`code_research\` for architectural understanding across files

**Examples:**
- Find existing helpers: search regex "export function" in utils/
- Check import patterns: search regex "import.*from" for package
- Understand error handling: search semantic "error handling patterns"
`;
}
