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
${!implementerCli ? `
⛔ **BLOCKED: SPEC_CONTEXT_IMPLEMENTER is not set.**

Implementation requires a dispatch CLI. Set the \`SPEC_CONTEXT_IMPLEMENTER\` environment variable to the CLI command for your implementer agent (supported shortcuts: \`claude\`, \`codex\`, \`gemini\`, \`opencode\`).

Example: \`SPEC_CONTEXT_IMPLEMENTER=claude\`

Do NOT implement tasks yourself. STOP and ask the user to configure the env var.
` : `
╔══════════════════════════════════════════════════════════════╗
║  YOU ARE THE ORCHESTRATOR — DO NOT IMPLEMENT YOURSELF        ║
║                                                              ║
║  Dispatch each task to: ${implementerCli.padEnd(37)}║
║  You build the prompt, dispatch via bash, wait for result.   ║
╚══════════════════════════════════════════════════════════════╝

╔══════════════════════════════════════════════════════════════╗
║  CRITICAL: ONE TASK AT A TIME                               ║
║                                                              ║
║  - Implement exactly ONE task, then STOP                     ║
║  - NEVER mark multiple tasks as [-] in-progress              ║
║  - NEVER start the next task before this one is reviewed     ║
║  - Flow: implement → verify → complete → review → THEN next  ║
╚══════════════════════════════════════════════════════════════╝

**Orchestrator Workflow (dispatch to agents):**

1. **Check Current Status:**
   - Use the spec-status tool with specName "${specName}" to see overall progress
   - Read .spec-context/specs/${specName}/tasks.md to see all tasks
   - Identify ${taskId ? `task ${taskId}` : 'the next pending task marked with [ ]'}
   - Verify NO other task is currently marked [-] (only one in-progress allowed)

2. **Capture base SHA** (for reviewer later):
   \`\`\`bash
   git rev-parse HEAD
   \`\`\`
   Save this SHA — you'll pass it to the reviewer.

3. **Read Task Guidance:**
   - Read the _Prompt field from the task
   - Note _Leverage fields, _Requirements fields, and success criteria

4. **Build and Dispatch to Implementer Agent** (redirect output to log):
   - Build the task prompt from the _Prompt field content
   - Dispatch via bash:
     \`\`\`bash
     ${implementerCli} "Implement the task for spec ${specName}, first call get-implementer-guide to load implementation rules then implement the task: [task prompt content from _Prompt field]." > /tmp/spec-impl.log 2>&1
     \`\`\`
   - Full output goes to log file — do NOT read the full log
   - WAIT for the command to complete — do not proceed until done

5. **Verify Completion:**
   - Check tasks.md — the task should now be marked [x]
   - If still [-], check \`tail -n 30 /tmp/spec-impl.log\` for errors, then re-dispatch
   - Get the diff (this is all you need to see):
     \`\`\`bash
     git diff {base-sha from step 2}..HEAD
     \`\`\`

${reviewsEnabled ? '6. **Dispatch Review:**' : '6. **Skip Review (minimal mode):**'}
${reviewerCli ? `   - Dispatch to reviewer agent via bash (redirect output to log):
     \`\`\`bash
     ${reviewerCli} "Review task ${taskId || '{taskId}'} for spec ${specName}. Base SHA: {base-sha from step 2}. Run: git diff {base-sha}..HEAD to see changes. Call get-reviewer-guide for review criteria. Check spec compliance, code quality, and principles. IMPORTANT: Your LAST output must be ONLY the Review Outcome block (Strengths/Issues/Assessment)." > /tmp/spec-review.log 2>&1
     \`\`\`
   - Full output goes to log — read only the verdict:
     \`\`\`bash
     tail -n 40 /tmp/spec-review.log
     \`\`\`` : `   - No reviewer CLI configured — review the implementation yourself
   - Run \`git diff {base-sha}..HEAD\` to see changes
   - Call get-reviewer-guide for review criteria`}
   - If issues found: dispatch implementer again to fix, then re-review
   - If approved: this task is done

7. **STOP** — do NOT proceed to the next task in this same session

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
- Read: Read tasks.md, _Prompt fields`}

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
