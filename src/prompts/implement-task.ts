import { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';
import { PromptDefinition } from './types.js';
import { ToolContext } from '../workflow-types.js';
import { getDisciplineMode, getDispatchCli } from '../config/discipline.js';
import { isDispatchRuntimeV2Enabled } from '../config/dispatch-runtime.js';

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
  const dispatchRuntimeV2 = isDispatchRuntimeV2Enabled();

  const runtimeSteps = dispatchRuntimeV2 ? `
4. **Initialize Runtime State (once per task):**
   - Call \`dispatch-runtime\` with:
     - \`action: "init_run"\`
     - \`specName: "${specName}"\`
     - \`taskId: "${taskId || '{taskId}'}"\`
   - Save returned \`runId\` for this task.

5. **Compile Dispatch Prompt (stable prefix + delta):**
   - Call \`dispatch-runtime\` with:
     - \`action: "compile_prompt"\`
     - \`runId: "{runId from step 4}"\`
     - \`role: "implementer"\`
     - \`taskId: "${taskId || '{taskId}'}"\`
     - \`maxOutputTokens: 1200\`
   - Omit \`taskPrompt\` to use the ledger/task prompt from runtime state (fail fast if missing).
   - Use returned \`prompt\` as the exact implementer dispatch payload.
` : '';

  const implementerIngestStep = dispatchRuntimeV2 ? `
7. **Ingest Implementer Result (no raw-log parsing):**
   - Call \`dispatch-runtime\` with:
     - \`action: "ingest_output"\`
     - \`runId: "{runId from step 4}"\`
     - \`role: "implementer"\`
     - \`taskId: "${taskId || '{taskId}'}"\`
     - \`maxOutputTokens: 1200\`
     - \`outputFilePath: "{contractOutputPath from step 5}"\`
   - If contract validation fails: halt this dispatch attempt and surface the terminal error.
` : `
6. **Legacy Result Handling (runtime v2 disabled):**
   - Use task marker changes + targeted diagnostics from logs.
   - Keep log reads minimal; do not parse full logs.
`;

  const reviewIngestStep = dispatchRuntimeV2 ? `
   - Ingest reviewer result via \`dispatch-runtime\`:
     - \`action: "ingest_output"\`
     - \`runId: "{runId from step 4}"\`
     - \`role: "reviewer"\`
     - \`taskId: "${taskId || '{taskId}'}"\`
     - \`maxOutputTokens: 1200\`
     - \`outputFilePath: "{contractOutputPath from reviewer compile step}"\`` : `
   - Runtime v2 disabled: evaluate reviewer verdict from structured final output manually`;

  const implementerDispatchCommand = dispatchRuntimeV2
    ? `${implementerCli} "{compiled implementer prompt from dispatch-runtime}" 1>"{contractOutputPath from step 5}" 2>"{debugOutputPath from step 5}"`
    : `${implementerCli} "Implement the task for spec ${specName}, first call get-implementer-guide to load implementation rules then implement the task: [task prompt content from _Prompt field]." > /tmp/spec-impl.log 2>&1`;

  const reviewerDispatchBlock = reviewerCli
    ? dispatchRuntimeV2
      ? `   - First call \`dispatch-runtime\` with:
     - \`action: "compile_prompt"\`
     - \`runId: "{runId from step 4}"\`
     - \`role: "reviewer"\`
     - \`taskId: "${taskId || '{taskId}'}"\`
     - \`maxOutputTokens: 1200\`
   - Omit \`taskPrompt\` to use the ledger/task prompt from runtime state (fail fast if missing).
   - Reviewer context remains explicit in workflow steps: base SHA + \`git diff {base-sha}..HEAD\`.
   - Use returned \`prompt\`, \`dispatch_cli\`, \`contractOutputPath\`, and \`debugOutputPath\` as reviewer dispatch context.
   - Dispatch to reviewer agent via bash (split contract and debug logs):
     \`\`\`bash
     ${reviewerCli} "{compiled reviewer prompt from dispatch-runtime}" 1>"{contractOutputPath from reviewer compile step}" 2>"{debugOutputPath from reviewer compile step}"
     \`\`\`
${reviewIngestStep}`
      : `   - Dispatch to reviewer agent via bash (redirect output to log):
     \`\`\`bash
     ${reviewerCli} "Review task ${taskId || '{taskId}'} for spec ${specName}. Base SHA: {base-sha from step 2}. Run: git diff {base-sha}..HEAD to see changes. Call get-reviewer-guide for review criteria. Check spec compliance, code quality, and principles. IMPORTANT: Your LAST output must be strict JSON contract from get-reviewer-guide." > /tmp/spec-review.log 2>&1
     \`\`\`
${reviewIngestStep}`
    : `   - No reviewer CLI configured — review the implementation yourself
   - Run \`git diff {base-sha}..HEAD\` to see changes
   - Call get-reviewer-guide for review criteria`;

  const runtimeGuideline = dispatchRuntimeV2
    ? '- Never branch orchestration logic from raw logs — only from \`dispatch-runtime\` structured results'
    : '- Runtime v2 disabled: prefer minimal log reads and deterministic task markers';

  const runtimeToolLine = dispatchRuntimeV2
    ? '- dispatch-runtime: Validate structured agent output and update runtime snapshot'
    : '- dispatch-runtime: disabled (enable with SPEC_CONTEXT_DISPATCH_RUNTIME_V2=1)';

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

${runtimeSteps}

${dispatchRuntimeV2 ? '6.' : '5.'} **Build and Dispatch to Implementer Agent** (split contract and debug logs):
   - ${dispatchRuntimeV2 ? 'Use compiled prompt from dispatch-runtime compile_prompt action' : 'Build the task prompt from the _Prompt field content'}
   - Dispatch via bash:
     \`\`\`bash
     ${implementerDispatchCommand}
     \`\`\`
   - Agent output must end with strict contract markers (\`BEGIN_DISPATCH_RESULT ... END_DISPATCH_RESULT\`)
   - WAIT for the command to complete — do not proceed until done

${implementerIngestStep}

${dispatchRuntimeV2 ? '8.' : '7.'} **Verify Completion:**
   - Check tasks.md — task should now be marked [x]
   ${dispatchRuntimeV2 ? '- Use \\`dispatch-runtime\\` nextAction as source of truth for orchestration branch' : '- Use explicit task marker + review status as source of truth'}
   - Get the diff (this is all you need to see):
     \`\`\`bash
     git diff {base-sha from step 2}..HEAD
     \`\`\`

${reviewsEnabled ? `${dispatchRuntimeV2 ? '9' : '8'}. **Dispatch Review:**` : `${dispatchRuntimeV2 ? '9' : '8'}. **Skip Review (minimal mode):**`}
${reviewerDispatchBlock}
   - If issues found: dispatch implementer again to fix, then re-review
   - If approved: this task is done

${dispatchRuntimeV2 ? '10' : '9'}. **STOP** — do NOT proceed to the next task in this same session

**Important Guidelines:**
- You are the ORCHESTRATOR — NEVER implement tasks yourself
- ONE task at a time — dispatch, wait, review, THEN next
- NEVER dispatch multiple tasks in parallel
- If the implementer agent fails, re-dispatch with clearer instructions
${runtimeGuideline}
- If same issue appears twice in review, take over directly

**Tools to Use:**
- spec-status: Check overall progress
${runtimeToolLine}
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
