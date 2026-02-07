/**
 * get-reviewer-guide MCP tool
 * Returns review criteria and project standards
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolContext, ToolResponse } from '../../workflow-types.js';
import { getDisciplineMode } from '../../config/discipline.js';
import { getSteeringDocs, getMissingSteeringDocs } from './steering-loader.js';
import {
  DISPATCH_CONTRACT_SCHEMA_VERSION,
  DISPATCH_REVIEWER_SCHEMA_ID,
} from './dispatch-contract-schemas.js';

type GuideMode = 'full' | 'compact';

interface ReviewerGuideCacheEntry {
  guide: string;
  disciplineMode: 'full' | 'standard';
  steering: Record<string, string>;
  cachedAt: string;
}

const reviewerGuideCache = new Map<string, ReviewerGuideCacheEntry>();

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
    properties: {
      mode: {
        type: 'string',
        enum: ['full', 'compact'],
        description: 'Guide mode. Use "full" once per run, then "compact" for subsequent review dispatches.',
      },
      runId: {
        type: 'string',
        description: 'Required for compact mode. Stable dispatch runtime runId used for guide cache lookup.',
      },
    },
    additionalProperties: false
  }
};

export async function getReviewerGuideHandler(
  args: unknown,
  context: ToolContext
): Promise<ToolResponse> {
  const input = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const guideMode = String(input.mode ?? 'full').trim() as GuideMode;
  const runId = String(input.runId ?? '').trim();
  if (guideMode !== 'full' && guideMode !== 'compact') {
    return {
      success: false,
      message: 'mode must be one of: full, compact',
    };
  }

  const mode = getDisciplineMode();
  const cacheKey = runId ? buildGuideCacheKey(runId) : '';

  if (guideMode === 'compact') {
    if (!runId) {
      return {
        success: false,
        message: 'compact mode requires runId',
      };
    }
    const cached = reviewerGuideCache.get(cacheKey);
    if (!cached) {
      return {
        success: false,
        message: `No cached reviewer guide found for runId "${runId}". Call get-reviewer-guide with mode:"full" first.`,
      };
    }
    return {
      success: true,
      message: `Reviewer compact guide loaded (run: ${runId})`,
      data: {
        guide: buildCompactReviewerGuide(cached),
        disciplineMode: cached.disciplineMode,
        guideMode: 'compact',
        guideCacheKey: cacheKey,
        searchGuidance: getSearchGuidance(),
      },
      nextSteps: [
        'Review against compact checklist and cached full criteria',
        'Call mode:"full" only when steering docs or discipline mode changes',
      ],
    };
  }

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

  const guide = buildReviewerGuide(mode, steering ?? {});

  const response: ToolResponse = {
    success: true,
    message: `Reviewer guide loaded (discipline: ${mode})`,
    data: {
      guide,
      disciplineMode: mode,
      guideMode: 'full',
      guideCacheKey: runId ? cacheKey : undefined,
      searchGuidance: getSearchGuidance(),
    },
    nextSteps: [
      'Review the implementation against spec requirements',
      'Check code quality and principles compliance',
      'Use search tools to check for duplicates',
      'Provide feedback with severity levels'
    ],
    meta: {
      minVisibilityTier: 2,
    },
  };

  if (runId && (mode === 'full' || mode === 'standard')) {
    reviewerGuideCache.set(cacheKey, {
      guide,
      disciplineMode: mode,
      steering: steering ?? {},
      cachedAt: new Date().toISOString(),
    });
  }

  return response;
}

function buildReviewerGuide(mode: string, steering: Record<string, string>): string {
  return `# Code Review Guide

**Core principle:** Review early, review often. Catch issues before they cascade.

## Review Process

1. **Get Context**
   - Read the task description and _Prompt field (contains role, requirements, success criteria)
   - The _Prompt has everything you need — do NOT read requirements.md or design.md
   - Understand what was supposed to be implemented from the _Prompt

2. **Get the Diff**
   The orchestrator should provide a base SHA in the dispatch prompt.
   \`\`\`bash
   git diff <base-sha>..HEAD
   \`\`\`
   If no base SHA was provided, use:
   \`\`\`bash
   git log --oneline -5    # find the commit before the task
   git diff HEAD~1          # or diff against parent
   \`\`\`

3. **Review Changes**
   - Verify changes match task scope
   - Check for scope creep
   - Look for missing pieces

4. **Apply Checklist**
   - Go through each category below
   - Assign severity to issues found
   - **Cross-reference against project principles below**

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

${steering.principles ? `**Project Principles (from principles.md):**
\`\`\`
${steering.principles}
\`\`\`

Review EACH change against the principles above:` : 'No principles.md found — review against general best practices:'}
- [ ] Adheres to project-specific rules
- [ ] Matches established patterns
- [ ] YAGNI - no unused features

### Tech Stack Compliance (Important)

${steering.tech ? `**Project Tech Stack (from tech.md):**
\`\`\`
${steering.tech}
\`\`\`

Review against the tech stack above:` : 'No tech.md found — review against general conventions:'}
- [ ] Uses approved technologies/patterns
- [ ] Follows project conventions
- [ ] Dependencies are appropriate
- [ ] No unnecessary new dependencies

### Testing (${mode === 'full' ? 'Critical' : 'Important'})

- [ ] Tests exist for new functionality
- [ ] Tests cover edge cases and error paths
- [ ] Tests are meaningful (not just coverage)
- [ ] All tests pass
${mode === 'full' ? '- [ ] TDD evidence: test commit before implementation' : ''}

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

## Required Final Output Contract

Your LAST output must be one strict trailing contract block only:

${'```text'}
BEGIN_DISPATCH_RESULT
{
  "task_id": "2.1",
  "assessment": "needs_changes",
  "strengths": ["Clear structure"],
  "issues": [
    {
      "severity": "important",
      "file": "src/a.ts",
      "message": "Missing error path handling",
      "fix": "Return explicit Result on parse failure"
    }
  ],
  "required_fixes": ["Handle parse error path in src/a.ts"]
}
END_DISPATCH_RESULT
${'```'}

Rules:
- \`assessment\` must be one of: \`approved\`, \`needs_changes\`, \`blocked\`
- \`issues[].severity\` must be one of: \`critical\`, \`important\`, \`minor\`
- Use empty arrays when no issues/fixes
- Output must start with \`BEGIN_DISPATCH_RESULT\` and end with \`END_DISPATCH_RESULT\` (no extra prose)
- Schema ID: \`${DISPATCH_REVIEWER_SCHEMA_ID}\`
- Schema Version: \`${DISPATCH_CONTRACT_SCHEMA_VERSION}\`
- This contract is parsed by \`dispatch-runtime\`; invalid contract is a terminal failure

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

function buildGuideCacheKey(runId: string): string {
  return `reviewer:${runId}`;
}

function clipSnippet(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'none';
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function buildCompactReviewerGuide(entry: ReviewerGuideCacheEntry): string {
  return `# Reviewer Compact Guide

Guide cache: ${entry.cachedAt}
Discipline mode: ${entry.disciplineMode}

## Review Contract
- Use severity levels: critical, important, minor.
- Validate task scope, spec compliance, tests, and architectural fit.
- If unclear requirement exists, block and request clarification.
- Final output MUST be strict contract block: BEGIN_DISPATCH_RESULT ... END_DISPATCH_RESULT
- No prose outside the final contract block.
- Schema contract: ${DISPATCH_REVIEWER_SCHEMA_ID}@${DISPATCH_CONTRACT_SCHEMA_VERSION}

## Compact Checklist
- Spec compliance: requirements met, no scope creep.
- Code quality: clear structure, no avoidable duplication, robust error handling.
- Testing: meaningful coverage and passing verification evidence.
- Security: no obvious exposure, injection, or auth regressions.

## Steering Digest
- Tech: ${clipSnippet(entry.steering.tech ?? '', 240)}
- Principles: ${clipSnippet(entry.steering.principles ?? '', 240)}
`;
}
