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
  description: `Get code review criteria based on discipline mode. Use when reviewing implementation work.

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

## Review Process

1. **Understand Context**
   - Read the task description and requirements
   - Review the spec (requirements.md, design.md)
   - Understand what was supposed to be implemented

2. **Review Changes**
   - Check git diff for all changes
   - Verify changes match task scope

3. **Apply Checklist**
   - Go through each category below
   - Assign severity to issues found

4. **Provide Feedback**
   - Be specific and actionable
   - Reference code locations
   - Suggest fixes when possible

## Issue Severity Levels

| Severity | Description | Action Required |
|----------|-------------|-----------------|
| **Critical** | Breaks functionality, security issue, data loss risk | Must fix before proceeding |
| **Important** | Violates spec, bad patterns, missing tests | Should fix before merge |
| **Minor** | Style issues, naming, minor improvements | Note for future |

## Review Checklist

### Spec Compliance (Critical/Important)

- [ ] Implements all requirements from task
- [ ] Follows design document architecture
- [ ] No scope creep (extra features not requested)
- [ ] Edge cases from requirements handled

### Code Quality (Important)

- [ ] Functions have single responsibility
- [ ] No code duplication (check for existing utilities)
- [ ] Error handling is appropriate
- [ ] No hardcoded values that should be configurable
- [ ] Names are clear and descriptive

### Principles Compliance (Important)

Review against the project's principles.md:
- [ ] Follows SOLID principles
- [ ] Adheres to project-specific rules
- [ ] Matches established patterns

### Testing (Critical in full mode, Important otherwise)

- [ ] Tests exist for new functionality
- [ ] Tests cover edge cases and error paths
- [ ] Tests are meaningful (not just coverage)
- [ ] All tests pass

### Technical Stack (Important)

Review against the project's tech.md:
- [ ] Uses approved technologies/patterns
- [ ] Follows project conventions
- [ ] Dependencies are appropriate

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

After review, provide one of:
- **Approved**: Ready to proceed
- **Needs Changes**: List specific issues to address
- **Blocked**: Critical issues prevent progress

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
