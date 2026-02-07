/**
 * get-implementer-guide MCP tool
 * Returns discipline-specific implementation guidance
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'path';
import { ToolContext, ToolResponse } from '../../workflow-types.js';
import { getDisciplineMode } from '../../config/discipline.js';
import { getSteeringDocs, getMissingSteeringDocs } from './steering-loader.js';
import type { FileContentFingerprint, IFileContentCache } from '../../core/cache/file-content-cache.js';
import { getSharedFileContentCache } from '../../core/cache/shared-file-content-cache.js';
import {
  DISPATCH_CONTRACT_SCHEMA_VERSION,
  DISPATCH_IMPLEMENTER_SCHEMA_ID,
} from './dispatch-contract-schemas.js';

type GuideMode = 'full' | 'compact';

interface ImplementerGuideCacheEntry {
  guide: string;
  disciplineMode: 'full' | 'standard' | 'minimal';
  steering: Record<string, string>;
  steeringFingerprints: Record<string, FileContentFingerprint>;
  cachedAt: string;
}

const implementerGuideCache = new Map<string, ImplementerGuideCacheEntry>();
const REQUIRED_STEERING_DOCS = ['tech', 'principles'] as const;

export const getImplementerGuideTool: Tool = {
  name: 'get-implementer-guide',
  description: `Load implementation rules for a dispatched implementer agent. FOR IMPLEMENTER SUB-AGENTS ONLY.

DO NOT call this tool unless you are an implementer agent dispatched via SPEC_CONTEXT_IMPLEMENTER to work on a specific spec task. If you are the orchestrator managing the spec workflow, do NOT call this tool — dispatch it to the implementer agent instead.

Returns (based on discipline mode):
- TDD rules (full mode only)
- Verification rules (all modes)
- Code review feedback handling (full/standard only)
- Project tech stack and principles
- Search tool guidance

Fails if required steering docs (tech.md, principles.md) are missing.`,
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['full', 'compact'],
        description: 'Guide mode. Use "full" on first dispatch for a run, then "compact" for subsequent tasks in the same run.',
      },
      runId: {
        type: 'string',
        description: 'Required for compact mode. Stable dispatch runtime runId used for guide cache lookup.',
      },
    },
    additionalProperties: false
  }
};

export async function getImplementerGuideHandler(
  args: unknown,
  context: ToolContext
): Promise<ToolResponse> {
  const input = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const guideMode = String(input.mode ?? 'full').trim() as GuideMode;
  const runId = String(input.runId ?? '').trim();
  const fileContentCache = context.fileContentCache ?? getSharedFileContentCache();
  if (guideMode !== 'full' && guideMode !== 'compact') {
    return {
      success: false,
      message: 'mode must be one of: full, compact',
    };
  }

  const cacheKey = runId ? buildGuideCacheKey(runId) : '';
  if (guideMode === 'compact') {
    if (!runId) {
      return {
        success: false,
        message: 'compact mode requires runId',
      };
    }
    const cached = implementerGuideCache.get(cacheKey);
    if (!cached) {
      return {
        success: false,
        message: `No cached implementer guide found for runId "${runId}". Call get-implementer-guide with mode:"full" first.`,
      };
    }
    await getSteeringDocs(context.projectPath, [...REQUIRED_STEERING_DOCS], fileContentCache);
    if (hasSteeringFingerprintMismatch(cached, context.projectPath, fileContentCache)) {
      implementerGuideCache.delete(cacheKey);
    } else {
      return {
        success: true,
        message: `Implementer compact guide loaded (run: ${runId})`,
        data: {
          guide: buildCompactImplementerGuide(cached),
          disciplineMode: cached.disciplineMode,
          guideMode: 'compact',
          guideCacheKey: cacheKey,
          searchGuidance: getSearchGuidance(),
        },
        nextSteps: [
          'Follow the compact guide and reuse previously loaded full rules',
          'Call mode:"full" only if discipline mode or steering docs changed',
        ],
      };
    }

  }

  const disciplineMode = getDisciplineMode();

  // Check for required steering docs
  const missing = getMissingSteeringDocs(context.projectPath, [...REQUIRED_STEERING_DOCS]);
  if (missing.length > 0) {
    return {
      success: false,
      message: `Required steering docs missing: ${missing.map(d => `${d}.md`).join(', ')}. Create them using the steering-guide tool first.`,
    };
  }

  // Load steering docs
  const steering = await getSteeringDocs(context.projectPath, [...REQUIRED_STEERING_DOCS], fileContentCache);

  const guide = buildImplementerGuide(disciplineMode);

  const response: ToolResponse = {
    success: true,
    message: `Implementer guide loaded (discipline: ${disciplineMode})`,
    data: {
      guide,
      steering,
      disciplineMode,
      guideMode: 'full',
      guideCacheKey: runId ? cacheKey : undefined,
      searchGuidance: getSearchGuidance(),
    },
    nextSteps: [
      'Read the task requirements and _Prompt field',
      'Follow the guide methodology',
      'Use search tools to discover existing patterns',
      'Mark task complete when done'
    ],
    meta: {
      minVisibilityTier: 2,
    },
  };

  if (runId) {
    implementerGuideCache.set(cacheKey, {
      guide,
      disciplineMode,
      steering: steering ?? {},
      steeringFingerprints: collectSteeringFingerprints(context.projectPath, fileContentCache),
      cachedAt: new Date().toISOString(),
    });
  }

  return response;
}

function buildImplementerGuide(mode: 'full' | 'standard' | 'minimal'): string {
  const sections: string[] = [];

  sections.push('# Implementation Guide\n');
  sections.push(getOutputContract());

  if (mode === 'full') {
    sections.push(getTddRules());
  }

  sections.push(getVerificationRules());

  if (mode !== 'minimal') {
    sections.push(getFeedbackHandling());
  }

  return sections.join('\n');
}

function getOutputContract(): string {
  return `## Required Final Output Contract

Your LAST output must be one strict trailing contract block only:

${'```text'}
BEGIN_DISPATCH_RESULT
{
  "task_id": "2.1",
  "status": "completed",
  "summary": "Implemented X and verified Y",
  "files_changed": ["src/a.ts", "src/b.ts"],
  "tests": [
    {
      "command": "npm test -- src/a.test.ts --run",
      "passed": true
    }
  ],
  "follow_up_actions": ["none"]
}
END_DISPATCH_RESULT
${'```'}

Rules:
- \`status\` must be one of: \`completed\`, \`blocked\`, \`failed\`
- Keep \`summary\` concise (1-3 sentences)
- Include every changed file in \`files_changed\`
- Include at least one test/verification command in \`tests\`
- Output must start with \`BEGIN_DISPATCH_RESULT\` and end with \`END_DISPATCH_RESULT\` (no extra prose)
- Schema ID: \`${DISPATCH_IMPLEMENTER_SCHEMA_ID}\`
- Schema Version: \`${DISPATCH_CONTRACT_SCHEMA_VERSION}\`
- This contract is parsed by \`dispatch-runtime\`; invalid contract is a terminal failure`;
}

function getTddRules(): string {
  return `## Test-Driven Development

Write the test first. Watch it fail. Write minimal code to pass.

**Core principle:** If you didn't watch the test fail, you don't know if it tests the right thing.

**Violating the letter of the rules is violating the spirit of the rules.**

### The Iron Law

\`\`\`
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
\`\`\`

Write code before the test? **Delete it. Start over.**

**No exceptions:**
- Don't keep it as "reference"
- Don't "adapt" it while writing tests
- Don't look at it
- Delete means delete

Implement fresh from tests. Period.

### When to Use TDD

**Always:**
- New features
- Bug fixes
- Refactoring
- Behavior changes

**Exceptions (ask first):**
- Throwaway prototypes
- Generated code
- Configuration files

Thinking "skip TDD just this once"? Stop. That's rationalization.

### Red-Green-Refactor Cycle

**1. RED - Write Failing Test**

Write one minimal test showing what should happen.

\`\`\`typescript
// GOOD: Clear name, tests real behavior, one thing
test('retries failed operations 3 times', async () => {
  let attempts = 0;
  const operation = () => {
    attempts++;
    if (attempts < 3) throw new Error('fail');
    return 'success';
  };
  const result = await retryOperation(operation);
  expect(result).toBe('success');
  expect(attempts).toBe(3);
});

// BAD: Vague name, tests mock not code
test('retry works', async () => {
  const mock = jest.fn().mockRejectedValueOnce(new Error())
    .mockResolvedValueOnce('success');
  await retryOperation(mock);
  expect(mock).toHaveBeenCalledTimes(2);
});
\`\`\`

**Good Tests:**

| Quality       | Good                              | Bad                                              |
|---------------|-----------------------------------|--------------------------------------------------|
| **Minimal**   | One thing. "and" in name? Split.  | \`test('validates email and domain and whitespace')\` |
| **Clear**     | Name describes behavior           | \`test('test1')\`                                    |
| **Shows intent** | Demonstrates desired API       | Obscures what code should do                     |

**2. Verify RED - Watch It Fail**

**MANDATORY. Never skip.**

\`\`\`bash
npm test path/to/test.test.ts
\`\`\`

Confirm:
- Test fails (not errors)
- Failure message is expected
- Fails because feature missing (not typos)

Test passes? You're testing existing behavior. Fix test.

**3. GREEN - Minimal Code**

Write simplest code to pass the test. Don't add features beyond the test.

\`\`\`typescript
// GOOD: Just enough to pass
async function retryOperation<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 3; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === 2) throw e;
    }
  }
  throw new Error('unreachable');
}

// BAD: Over-engineered (YAGNI)
async function retryOperation<T>(
  fn: () => Promise<T>,
  options?: {
    maxRetries?: number;
    backoff?: 'linear' | 'exponential';
    onRetry?: (attempt: number) => void;
  }
): Promise<T> {
  // Don't add features beyond the test
}
\`\`\`

**4. Verify GREEN - Watch It Pass**

**MANDATORY.**

Confirm:
- Test passes
- Other tests still pass
- Output pristine (no errors, warnings)

Test fails? Fix code, not test.

**5. REFACTOR - Clean Up**

After green only: remove duplication, improve names, extract helpers.
Keep tests green. Don't add behavior.

### Common Rationalizations

| Excuse                          | Reality                                                                  |
|---------------------------------|--------------------------------------------------------------------------|
| "Too simple to test"            | Simple code breaks. Test takes 30 seconds.                               |
| "I'll test after"               | Tests passing immediately prove nothing.                                 |
| "Tests after achieve same goals"| Tests-after = "what does this do?" Tests-first = "what should this do?" |
| "Already manually tested"       | Ad-hoc ≠ systematic. No record, can't re-run.                            |
| "Deleting X hours is wasteful"  | Sunk cost fallacy. Keeping unverified code is technical debt.            |
| "Keep as reference"             | You'll adapt it. That's testing after. Delete means delete.              |
| "Need to explore first"         | Fine. Throw away exploration, start with TDD.                            |
| "Test hard = design unclear"    | Listen to test. Hard to test = hard to use.                              |
| "TDD will slow me down"         | TDD faster than debugging.                                               |
| "Existing code has no tests"    | You're improving it. Add tests for what you touch.                       |

### Red Flags - STOP and Start Over

- Code before test
- Test after implementation
- Test passes immediately
- Can't explain why test failed
- Tests added "later"
- Rationalizing "just this once"
- "I already manually tested it"
- "Tests after achieve the same purpose"
- "Keep as reference" or "adapt existing code"
- "Already spent X hours, deleting is wasteful"
- "This is different because..."

**All of these mean: Delete code. Start over with TDD.**

### When Stuck

| Problem                | Solution                                         |
|------------------------|--------------------------------------------------|
| Don't know how to test | Write wished-for API. Write assertion first.     |
| Test too complicated   | Design too complicated. Simplify interface.      |
| Must mock everything   | Code too coupled. Use dependency injection.      |
| Test setup huge        | Extract helpers. Still complex? Simplify design. |

### TDD Verification Checklist

Before marking work complete:

- [ ] Every new function/method has a test
- [ ] Watched each test fail before implementing
- [ ] Each test failed for expected reason (feature missing, not typo)
- [ ] Wrote minimal code to pass each test
- [ ] All tests pass
- [ ] Output pristine (no errors, warnings)
- [ ] Tests use real code (mocks only if unavoidable)
- [ ] Edge cases and errors covered

Can't check all boxes? You skipped TDD. Start over.

### Example: Bug Fix with TDD

**Bug:** Empty email accepted

**RED:**
\`\`\`typescript
test('rejects empty email', async () => {
  const result = await submitForm({ email: '' });
  expect(result.error).toBe('Email required');
});
\`\`\`

**Verify RED:**
\`\`\`bash
$ npm test
FAIL: expected 'Email required', got undefined
\`\`\`

**GREEN:**
\`\`\`typescript
function submitForm(data: FormData) {
  if (!data.email?.trim()) {
    return { error: 'Email required' };
  }
  // ...
}
\`\`\`

**Verify GREEN:**
\`\`\`bash
$ npm test
PASS
\`\`\`

**REFACTOR:** Extract validation for multiple fields if needed.

### Debugging Integration

Bug found? Write failing test reproducing it. Follow TDD cycle. Test proves fix and prevents regression.

**Never fix bugs without a test.**

`;
}

function getVerificationRules(): string {
  return `## Verification Before Completion

Claiming work is complete without verification is dishonesty, not efficiency.

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

### The Iron Law

\`\`\`
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
\`\`\`

If you haven't run the verification command in this message, you cannot claim it passes.

### The Gate Function

\`\`\`
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
\`\`\`

### Common Verification Requirements

| Claim                 | Requires                        | Not Sufficient                  |
|-----------------------|---------------------------------|---------------------------------|
| Tests pass            | Test command output: 0 failures | Previous run, "should pass"     |
| Linter clean          | Linter output: 0 errors         | Partial check, extrapolation    |
| Build succeeds        | Build command: exit 0           | Linter passing, logs look good  |
| Bug fixed             | Test original symptom: passes   | Code changed, assumed fixed     |
| Regression test works | Red-green cycle verified        | Test passes once                |
| Requirements met      | Line-by-line checklist          | Tests passing                   |

### Verification Patterns

**Tests:**
\`\`\`
✅ [Run test command] [See: 34/34 pass] "All tests pass"
❌ "Should pass now" / "Looks correct"
\`\`\`

**Build:**
\`\`\`
✅ [Run build] [See: exit 0] "Build passes"
❌ "Linter passed" (linter doesn't check compilation)
\`\`\`

**Requirements:**
\`\`\`
✅ Re-read plan → Create checklist → Verify each → Report gaps or completion
❌ "Tests pass, phase complete"
\`\`\`

### Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!")
- About to commit/push without verification
- Relying on partial verification
- Thinking "just this once"
- **ANY wording implying success without having run verification**

### Rationalization Prevention

| Excuse                                   | Reality                 |
|------------------------------------------|-------------------------|
| "Should work now"                        | RUN the verification    |
| "I'm confident"                          | Confidence ≠ evidence   |
| "Just this once"                         | No exceptions           |
| "Linter passed"                          | Linter ≠ compiler       |
| "Partial check is enough"                | Partial proves nothing  |
| "Different words so rule doesn't apply"  | Spirit over letter      |

**No shortcuts for verification. Run the command. Read the output. THEN claim the result.**

`;
}

function getFeedbackHandling(): string {
  return `## Handling Code Review Feedback

Code review requires technical evaluation, not emotional performance.

**Core Principle:** Verify before implementing. Ask before assuming. Technical correctness over social comfort.

### The Response Pattern

\`\`\`
WHEN receiving code review feedback:

1. READ: Complete feedback without reacting
2. UNDERSTAND: Restate requirement in own words (or ask)
3. VERIFY: Check against codebase reality
4. EVALUATE: Technically sound for THIS codebase?
5. RESPOND: Technical acknowledgment or reasoned pushback
6. IMPLEMENT: One item at a time, test each
\`\`\`

### Forbidden Responses

**NEVER:**
- "You're absolutely right!"
- "Great point!" / "Excellent feedback!"
- "Thanks for catching that!"
- "Let me implement that now" (before verification)

**INSTEAD:**
- Restate the technical requirement
- Ask clarifying questions
- Push back with technical reasoning if wrong
- Just start working (actions > words)

### When Feedback is Unclear

\`\`\`
IF any item is unclear:
  STOP - do not implement anything yet
  ASK for clarification on unclear items

WHY: Items may be related. Partial understanding = wrong implementation.
\`\`\`

**Example:**
\`\`\`
Feedback: "Fix items 1-6"
You understand 1,2,3,6. Unclear on 4,5.

❌ WRONG: Implement 1,2,3,6 now, ask about 4,5 later
✅ RIGHT: "I understand items 1,2,3,6. Need clarification on 4 and 5 before proceeding."
\`\`\`

### YAGNI Check for "Professional" Features

\`\`\`
IF reviewer suggests "implementing properly":
  grep codebase for actual usage

  IF unused: "This endpoint isn't called. Remove it (YAGNI)?"
  IF used: Then implement properly
\`\`\`

### When to Push Back

Push back when:
- Suggestion breaks existing functionality
- Reviewer lacks full context
- Violates YAGNI (unused feature)
- Technically incorrect for this stack
- Legacy/compatibility reasons exist
- Conflicts with architectural decisions

**How to push back:**
- Use technical reasoning, not defensiveness
- Ask specific questions
- Reference working tests/code

### Implementation Order for Multi-Item Feedback

\`\`\`
FOR multi-item feedback:
  1. Clarify anything unclear FIRST
  2. Then implement in this order:
     - Blocking issues (breaks, security)
     - Simple fixes (typos, imports)
     - Complex fixes (refactoring, logic)
  3. Test each fix individually
  4. Verify no regressions
\`\`\`

### Acknowledging Correct Feedback

When feedback IS correct:
\`\`\`
✅ "Fixed. [Brief description of what changed]"
✅ "Good catch - [specific issue]. Fixed in [location]."
✅ [Just fix it and show in the code]

❌ "You're absolutely right!"
❌ "Great point!"
❌ "Thanks for catching that!"
\`\`\`

**Why no thanks:** Actions speak. Just fix it. The code itself shows you heard the feedback.

### Gracefully Correcting Your Pushback

If you pushed back and were wrong:
\`\`\`
✅ "You were right - I checked [X] and it does [Y]. Implementing now."
✅ "Verified this and you're correct. Fixing."

❌ Long apology
❌ Defending why you pushed back
❌ Over-explaining
\`\`\`

State the correction factually and move on.

### Common Mistakes

| Mistake                       | Fix                                      |
|-------------------------------|------------------------------------------|
| Performative agreement        | State requirement or just act            |
| Blind implementation          | Verify against codebase first            |
| Batch without testing         | One at a time, test each                 |
| Assuming reviewer is right    | Check if breaks things                   |
| Avoiding pushback             | Technical correctness > comfort          |
| Partial implementation        | Clarify all items first                  |
| Can't verify, proceed anyway  | State limitation, ask for direction      |

### Real Examples

**Performative Agreement (Bad):**
\`\`\`
Reviewer: "Remove legacy code"
❌ "You're absolutely right! Let me remove that..."
\`\`\`

**Technical Verification (Good):**
\`\`\`
Reviewer: "Remove legacy code"
✅ "Checking... build target is 10.15+, this API needs 13+.
   Need legacy for backward compat. Current impl has wrong
   bundle ID - fix it or drop pre-13 support?"
\`\`\`

**YAGNI (Good):**
\`\`\`
Reviewer: "Implement proper metrics tracking with database, date filters, CSV export"
✅ "Grepped codebase - nothing calls this endpoint. Remove it (YAGNI)?
   Or is there usage I'm missing?"
\`\`\`

**Unclear Item (Good):**
\`\`\`
Feedback: "Fix items 1-6"
You understand 1,2,3,6. Unclear on 4,5.
✅ "Understand 1,2,3,6. Need clarification on 4 and 5 before implementing."
\`\`\`

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

**Examples:**
- Find existing helpers: search regex "export function" in utils/
- Check import patterns: search regex "import.*from" for package
- Understand error handling: search semantic "error handling patterns"
`;
}

function buildGuideCacheKey(runId: string): string {
  return `implementer:${runId}`;
}

function collectSteeringFingerprints(
  projectPath: string,
  fileContentCache: IFileContentCache
): Record<string, FileContentFingerprint> {
  const fingerprints: Record<string, FileContentFingerprint> = {};
  for (const doc of REQUIRED_STEERING_DOCS) {
    const fingerprint = fileContentCache.getFingerprint(buildSteeringDocPath(projectPath, doc));
    if (fingerprint) {
      fingerprints[doc] = fingerprint;
    }
  }
  return fingerprints;
}

function hasSteeringFingerprintMismatch(
  entry: ImplementerGuideCacheEntry,
  projectPath: string,
  fileContentCache: IFileContentCache
): boolean {
  for (const doc of REQUIRED_STEERING_DOCS) {
    const docPath = buildSteeringDocPath(projectPath, doc);
    const current = fileContentCache.getFingerprint(docPath);
    const previous = entry.steeringFingerprints[doc];
    if (!current || !previous) {
      return true;
    }
    if (current.mtimeMs !== previous.mtimeMs || current.hash !== previous.hash) {
      return true;
    }
  }
  return false;
}

function buildSteeringDocPath(projectPath: string, doc: (typeof REQUIRED_STEERING_DOCS)[number]): string {
  return join(projectPath, '.spec-context', 'steering', `${doc}.md`);
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

function buildCompactImplementerGuide(entry: ImplementerGuideCacheEntry): string {
  const tddRule = entry.disciplineMode === 'full'
    ? '- TDD is mandatory: Red -> Green -> Refactor on every code change.'
    : '- TDD is optional, but verification evidence is still mandatory.';
  const feedbackRule = entry.disciplineMode === 'minimal'
    ? '- Reviews are disabled in minimal mode; still verify all completion claims.'
    : '- Handle review feedback technically: clarify unclear items and fix one issue at a time.';

  return `# Implementer Compact Guide

Guide cache: ${entry.cachedAt}
Discipline mode: ${entry.disciplineMode}

## Non-negotiable Rules
- Output MUST end with a strict contract block: BEGIN_DISPATCH_RESULT ... END_DISPATCH_RESULT
- No prose outside the final contract block.
- Schema contract: ${DISPATCH_IMPLEMENTER_SCHEMA_ID}@${DISPATCH_CONTRACT_SCHEMA_VERSION}
${tddRule}
- Before claiming completion, run and report fresh verification commands with pass/fail evidence.
${feedbackRule}

## Steering Digest
- Tech: ${clipSnippet(entry.steering.tech ?? '', 240)}
- Principles: ${clipSnippet(entry.steering.principles ?? '', 240)}
`;
}
