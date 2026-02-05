/**
 * get-reviewer-guide MCP tool
 * Returns review criteria and project standards
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolContext, ToolResponse } from '../../workflow-types.js';
import { getDisciplineMode } from '../../config/discipline.js';
import { getSteeringDocs, getMissingSteeringDocs } from './steering-loader.js';

export const getReviewerGuideTool: Tool = {
  name: 'get-reviewer-guide',
  description: `Load code review checklist for a dispatched reviewer agent. FOR REVIEWER SUB-AGENTS ONLY.

DO NOT call this tool unless you are a reviewer agent dispatched via SPEC_CONTEXT_REVIEWER to review a specific task, OR you are the orchestrator and no SPEC_CONTEXT_REVIEWER is configured. If a reviewer CLI is configured, dispatch the review to that agent instead.

Returns:
- Review checklist with severity levels
- Spec compliance checks
- Code quality and principles compliance
- Project tech stack and principles
- Search guidance for checking duplicates

Only active in full and standard modes. Returns error in minimal mode.
Fails if required steering docs (tech.md, principles.md) are missing.`,
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  }
};

export async function getReviewerGuideHandler(
  _args: unknown,
  context: ToolContext
): Promise<ToolResponse> {
  const mode = getDisciplineMode();

  // Reviews not active in minimal mode
  if (mode === 'minimal') {
    return {
      success: false,
      message: 'Code reviews are not active in minimal discipline mode. Change SPEC_CONTEXT_DISCIPLINE to "full" or "standard" to enable reviews.',
    };
  }

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

  const guide = buildReviewerGuide();

  return {
    success: true,
    message: `Reviewer guide loaded (discipline: ${mode})`,
    data: {
      guide,
      steering,
      disciplineMode: mode,
      searchGuidance: getSearchGuidance(),
    },
    nextSteps: [
      'Review the implementation against spec requirements',
      'Check code quality and principles compliance',
      'Use search tools to check for duplicates',
      'Provide feedback with severity levels'
    ]
  };
}

function buildReviewerGuide(): string {
  return `# Code Review Guide

**Core principle:** Review early, review often. Catch issues before they cascade.

## When to Review

**Mandatory:**
- After each task in implementation
- After completing major feature
- Before merge to main

**Optional but valuable:**
- When implementer is stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing complex bug

## Review Process

1. **Get Context**
   - Read the task description and _Prompt field
   - Review the spec (requirements.md, design.md)
   - Understand what was supposed to be implemented

2. **Get the Diff**
   \`\`\`bash
   git diff BASE_SHA..HEAD_SHA
   \`\`\`

3. **Review Changes**
   - Verify changes match task scope
   - Check for scope creep
   - Look for missing pieces

4. **Apply Checklist**
   - Go through each category below
   - Assign severity to issues found

5. **Provide Feedback**
   - Be specific and actionable
   - Reference code locations (file:line)
   - Suggest fixes when possible

## Issue Severity Levels

| Severity      | Description                                        | Action Required           |
|---------------|----------------------------------------------------|---------------------------|
| **Critical**  | Breaks functionality, security issue, data loss risk | Must fix before proceeding |
| **Important** | Violates spec, bad patterns, missing tests         | Should fix before merge   |
| **Minor**     | Style issues, naming, minor improvements           | Note for future           |

## Acting on Review Results

**Implementer should:**
- Fix Critical issues immediately
- Fix Important issues before proceeding
- Note Minor issues for later
- Push back if reviewer is wrong (with reasoning)

## Review Checklist

### Spec Compliance (Critical/Important)

- [ ] Implements all requirements from task
- [ ] Follows design document architecture
- [ ] No scope creep (extra features not requested)
- [ ] Edge cases from requirements handled
- [ ] Matches _Prompt success criteria

### Code Quality (Important)

- [ ] Functions have single responsibility
- [ ] No code duplication (check for existing utilities)
- [ ] Error handling is appropriate
- [ ] No hardcoded values that should be configurable
- [ ] Names are clear and descriptive
- [ ] No defensive garbage (unnecessary fallbacks)

### Principles Compliance (Important)

Review against the project's principles.md:
- [ ] Follows SOLID principles
- [ ] Adheres to project-specific rules
- [ ] Matches established patterns
- [ ] YAGNI - no unused features

### Testing (Critical in full mode, Important otherwise)

- [ ] Tests exist for new functionality
- [ ] Tests cover edge cases and error paths
- [ ] Tests are meaningful (not just coverage)
- [ ] All tests pass
- [ ] TDD evidence (if full mode): test commit before implementation

### Technical Stack (Important)

Review against the project's tech.md:
- [ ] Uses approved technologies/patterns
- [ ] Follows project conventions
- [ ] Dependencies are appropriate
- [ ] No unnecessary new dependencies

### Security (Critical)

- [ ] No sensitive data exposed
- [ ] Input validation present
- [ ] No injection vulnerabilities
- [ ] Authentication/authorization correct

## Feedback Format

When providing feedback, use this structure:

\`\`\`
**[Severity]**: Brief description

Location: file:line
Issue: What's wrong
Suggestion: How to fix

Example (if helpful):
\`\`\`code fix\`\`\`
\`\`\`

## Review Outcome

Provide assessment:

\`\`\`
Strengths: [What was done well]
Issues:
  Critical: [List]
  Important: [List]
  Minor: [List]
Assessment: [Approved | Needs Changes | Blocked]
\`\`\`

## Red Flags in Review

**Never:**
- Skip review because "it's simple"
- Ignore Critical issues
- Approve with unfixed Important issues
- Argue with valid technical feedback

**If implementer pushes back:**
- Consider their technical reasoning
- Check if you have full context
- Verify against actual codebase
- Escalate if disagreement persists

## Review Loop

- If issues found: implementer receives feedback directly
- If same issue appears twice: escalate (implementer doesn't understand)
- If different issues: continue loop until resolved

`;
}

function getSearchGuidance(): string {
  return `## Using Search Tools for Review

Use search tools to verify implementation quality:

**Check for Duplicates:**
- Search for similar function names before approving new utilities
- Check if pattern already exists elsewhere in codebase

**Verify Consistency:**
- Search for similar patterns to ensure consistency
- Check how similar problems are solved elsewhere

**Examples:**
- Check for duplicate: search regex "function.*validate"
- Find similar patterns: search semantic "error handling in API"
- Verify convention: search regex "export (async )?function"
`;
}
