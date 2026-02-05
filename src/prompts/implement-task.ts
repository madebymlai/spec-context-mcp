import { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';
import { PromptDefinition } from './types.js';
import { ToolContext } from '../workflow-types.js';
import { getDisciplineMode, getDispatchCli } from '../config/discipline.js';

const prompt: Prompt = {
  name: 'implement-task',
  title: 'Implement Specification Task',
  description: 'Implement task, do task, work on task, execute task, build feature. Use when user wants to implement a task from spec, work on a feature task, or says "implement task X", "do task 2.1", "work on the next task".',
  arguments: [
    {
      name: 'specName',
      description: 'Feature name in kebab-case for the task to implement',
      required: true
    },
    {
      name: 'taskId',
      description: 'Specific task ID to implement (e.g., "1", "2.1", "3")',
      required: false
    }
  ]
};

async function handler(args: Record<string, any>, context: ToolContext): Promise<PromptMessage[]> {
  const { specName, taskId } = args;

  if (!specName) {
    throw new Error('specName is a required argument');
  }

  const disciplineMode = getDisciplineMode();
  const modeDescription = disciplineMode === 'full'
    ? 'TDD required (Red-Green-Refactor), code reviews enabled'
    : disciplineMode === 'standard'
    ? 'Code reviews enabled (no TDD requirement)'
    : 'Verification only (no reviews)';

  const implementerCli = getDispatchCli('implementer');
  const reviewerCli = getDispatchCli('reviewer');

  const isFull = disciplineMode === 'full';
  const isMinimal = disciplineMode === 'minimal';
  const reviewsEnabled = !isMinimal;

  // Build discipline-sensitive fragments to avoid deeply nested template escaping
  const guideLoadStep = [
    `3. **Load Guides (once, before first task — you act as implementer${reviewsEnabled ? '+reviewer' : ''}):**`,
    `   - Call \`get-implementer-guide\` to load ${isFull ? 'TDD rules and' : ''} verification rules`,
    reviewsEnabled
      ? '   - Call `get-reviewer-guide` to load review checklist'
      : '   - Reviews are disabled in minimal mode — skip get-reviewer-guide',
    '   - These guides only need to be loaded once — follow their rules for every task',
  ].join('\n');

  const guidelinesSection = [
    '**Important Guidelines:**',
    '- ONE task at a time — this is non-negotiable',
    `- Call \`get-implementer-guide\`${reviewsEnabled ? ' and `get-reviewer-guide`' : ''} once before starting (not per-task)`,
    `- Follow loaded ${isFull ? 'TDD and ' : ''}verification${reviewsEnabled ? ' and review' : ''} rules for EVERY task`,
    ...(isFull ? ['- NEVER skip TDD in full discipline mode'] : []),
    '- NEVER skip verification in any mode',
    '- If a task has subtasks (e.g., 4.1, 4.2), each subtask follows this same workflow',
    '- If you encounter blockers, STOP and report — do NOT silently move to another task',
  ].join('\n');

  const toolsSection = [
    '**Tools to Use:**',
    `- get-implementer-guide: Load ${isFull ? 'TDD + ' : ''}verification rules (call once before first task)`,
    ...(reviewsEnabled ? ['- get-reviewer-guide: Load review checklist (call once before first review)'] : []),
    '- search: Search existing implementations before coding',
    '- code_research: Deep analysis for architecture questions',
    '- spec-status: Check overall progress',
    '- Edit: Update task markers in tasks.md',
    '- Read/Write/Edit: Implement code changes',
    '- Bash: Run tests and verify',
  ].join('\n');

  const messages: PromptMessage[] = [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Implement ${taskId ? `task ${taskId}` : 'the next pending task'} for the "${specName}" feature.

**Context:**
- Project: ${context.projectPath}
- Feature: ${specName}
- **Discipline Mode: ${disciplineMode}** — ${modeDescription}
${implementerCli ? `- **Implementer CLI: ${implementerCli}** — dispatch tasks to this agent` : '- Implementer: direct (no dispatch CLI configured)'}
${reviewerCli ? `- **Reviewer CLI: ${reviewerCli}** — dispatch reviews to this agent` : '- Reviewer: direct (no dispatch CLI configured)'}
${taskId ? `- Task ID: ${taskId}` : ''}
${context.dashboardUrl ? `- Dashboard: ${context.dashboardUrl}` : ''}
${implementerCli ? `
╔══════════════════════════════════════════════════════════════╗
║  YOU ARE THE ORCHESTRATOR — DO NOT IMPLEMENT YOURSELF        ║
║                                                              ║
║  Dispatch each task to: ${implementerCli.padEnd(37)}║
║  You build the prompt, dispatch via bash, wait for result.   ║
╚══════════════════════════════════════════════════════════════╝
` : ''}
╔══════════════════════════════════════════════════════════════╗
║  CRITICAL: ONE TASK AT A TIME                               ║
║                                                              ║
║  - Implement exactly ONE task, then STOP                     ║
║  - NEVER mark multiple tasks as [-] in-progress              ║
║  - NEVER start the next task before this one is reviewed     ║
║  - Flow: implement → verify → complete → review → THEN next  ║
╚══════════════════════════════════════════════════════════════╝

${implementerCli ? `**Orchestrator Workflow (dispatch to agents):**

1. **Check Current Status:**
   - Use the spec-status tool with specName "${specName}" to see overall progress
   - Read .spec-context/specs/${specName}/tasks.md to see all tasks
   - Identify ${taskId ? `task ${taskId}` : 'the next pending task marked with [ ]'}
   - Verify NO other task is currently marked [-] (only one in-progress allowed)

2. **Read Task Guidance:**
   - Read the _Prompt field from the task
   - Note _Leverage fields, _Requirements fields, and success criteria

3. **Build and Dispatch to Implementer Agent:**
   - Build the task prompt from the _Prompt field content
   - Dispatch via bash:
     \`\`\`bash
     ${implementerCli} "Implement the task for spec ${specName}, first run spec-workflow-guide to get the workflow guide then implement the task: [task prompt content from _Prompt field]"
     \`\`\`
   - The implementer agent will: mark task [-], call get-implementer-guide, implement with ${isFull ? 'TDD' : 'verification'}, mark [x]
   - WAIT for the agent to complete — do not proceed until done

4. **Verify Completion:**
   - Check tasks.md — the task should now be marked [x]
   - If still [-], the implementer agent failed — investigate and re-dispatch

${reviewsEnabled ? '5. **Dispatch Review:**' : '5. **Skip Review (minimal mode):**'}
${reviewerCli ? `   - Dispatch to reviewer agent via bash:
     \`\`\`bash
     ${reviewerCli} "Review the implementation of task ${taskId || '{taskId}'} for spec ${specName}. Call get-reviewer-guide for review criteria. Review the git diff, check spec compliance, code quality, and principles."
     \`\`\`
   - WAIT for review to complete` : `   - No reviewer CLI configured — review the implementation yourself
   - Call get-reviewer-guide for review criteria`}
   - If issues found: dispatch implementer again to fix, then re-review
   - If approved: this task is done

6. **STOP** — do NOT proceed to the next task in this same session

**Important Guidelines:**
- You are the ORCHESTRATOR — NEVER implement tasks yourself
- ONE task at a time — dispatch, wait, review, THEN next
- NEVER dispatch multiple tasks in parallel
- If the implementer agent fails, re-dispatch with clearer instructions
- If same issue appears twice in review, take over directly

**Tools to Use:**
- spec-status: Check overall progress
- Bash: Dispatch to implementer/reviewer agents
- Edit: Update task markers if agents fail to
- Read: Read tasks.md, _Prompt fields` : `**Implementation Workflow:**

1. **Check Current Status:**
   - Use the spec-status tool with specName "${specName}" to see overall progress
   - Read .spec-context/specs/${specName}/tasks.md to see all tasks
   - Identify ${taskId ? `task ${taskId}` : 'the next pending task marked with [ ]'}
   - Verify NO other task is currently marked [-] (only one in-progress allowed)

2. **Start the Task:**
   - Edit .spec-context/specs/${specName}/tasks.md directly
   - Change the task marker from [ ] to [-] for THIS ONE task only
   - NEVER change multiple tasks to [-] at once

${guideLoadStep}

4. **Read Task Guidance:**
   - Look for the _Prompt field in the task - it contains structured guidance:
     - Role: The specialized developer role to assume
     - Task: Clear description with context references
     - Restrictions: What not to do and constraints
     - Success: Specific completion criteria
   - Note the _Leverage fields for files/utilities to use
   - Check _Requirements fields for which requirements this implements

5. **Discover Existing Implementations (CRITICAL):**
   - BEFORE writing any code, use the \`search\` tool to find existing implementations
   - Use \`search\` type="semantic" for patterns, type="regex" for exact names
   - Use \`code_research\` for cross-file architecture questions
   - Reuse existing code, follow established patterns

6. **Implement the Task${isFull ? ' (with TDD)' : ''}:**
   - Follow the _Prompt guidance exactly
   - Use the files mentioned in _Leverage fields
${isFull ? '   - Write failing test FIRST → watch it fail → write minimal code to pass → refactor' : '   - Write tests alongside implementation'}
   - Follow existing patterns in the codebase

7. **Verify and Complete:**
   - Run ALL tests — they must pass
   - Verify all success criteria from the _Prompt are met
   - Edit .spec-context/specs/${specName}/tasks.md directly
   - Change the task marker from [-] to [x] for the completed task
   - Only mark complete when fully implemented, tested, AND verified

${reviewsEnabled ? `8. **Code Review:**
   - Review the implementation against spec, code quality, principles (using loaded reviewer guide)
   - If issues found: fix them, re-verify, then re-review
   - If approved: this task is done
   - STOP HERE — do NOT proceed to the next task in this same session` : `8. **STOP** — do NOT proceed to the next task in this same session`}

${guidelinesSection}

${toolsSection}`}

Please proceed with implementing ${taskId ? `task ${taskId}` : 'the next task'} following this workflow. Remember: ONE task only.`
      }
    }
  ];

  return messages;
}

export const implementTaskPrompt: PromptDefinition = {
  prompt,
  handler,
};
