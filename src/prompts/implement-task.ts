import { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';
import { PromptDefinition } from './types.js';
import { ToolContext } from '../workflow-types.js';
import { getDisciplineMode } from '../config/discipline.js';

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
${taskId ? `- Task ID: ${taskId}` : ''}
${context.dashboardUrl ? `- Dashboard: ${context.dashboardUrl}` : ''}

╔══════════════════════════════════════════════════════════════╗
║  CRITICAL: ONE TASK AT A TIME                               ║
║                                                              ║
║  - Implement exactly ONE task, then STOP                     ║
║  - NEVER mark multiple tasks as [-] in-progress              ║
║  - NEVER start the next task before this one is reviewed     ║
║  - Flow: implement → verify → complete → review → THEN next  ║
╚══════════════════════════════════════════════════════════════╝

**Implementation Workflow:**

1. **Check Current Status:**
   - Use the spec-status tool with specName "${specName}" to see overall progress
   - Read .spec-context/specs/${specName}/tasks.md to see all tasks
   - Identify ${taskId ? `task ${taskId}` : 'the next pending task marked with [ ]'}
   - Verify NO other task is currently marked [-] (only one in-progress allowed)

2. **Start the Task:**
   - Edit .spec-context/specs/${specName}/tasks.md directly
   - Change the task marker from [ ] to [-] for THIS ONE task only
   - NEVER change multiple tasks to [-] at once

3. **Load Guides (once, before first task):**
   - Call \`get-implementer-guide\` to load TDD rules and verification rules
   - Call \`get-reviewer-guide\` to load review checklist (full/standard modes)
   - In full discipline mode: you MUST follow strict TDD (Red-Green-Refactor)
   - In all modes: you MUST verify before claiming completion
   - These guides only need to be loaded once — follow their rules for every task

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
   - The codebase auto-indexes on first search and auto-syncs with file watching

   **Use the search tool (PRIMARY METHOD):**
   \`\`\`
   search type="semantic" query="authentication middleware"
   search type="regex" query="def authenticate"
   \`\`\`

   **For complex architecture questions, use code_research:**
   \`\`\`
   code_research query="How does the authentication flow work?"
   \`\`\`

   **Discovery best practices:**
   - Use \`search\` type="semantic" to find existing patterns and similar implementations
   - Use \`search\` type="regex" for exact function names or patterns
   - Use \`code_research\` for understanding cross-file architecture
   - Reuse existing code, follow established patterns
   - If you find existing code that does what the task asks, leverage it

6. **Implement the Task (with TDD in full mode):**
   - Follow the _Prompt guidance exactly
   - Use the files mentioned in _Leverage fields
   - In full mode: Write failing test FIRST → watch it fail → write minimal code to pass → refactor
   - In all modes: Write tests alongside implementation
   - Follow existing patterns in the codebase

7. **Verify and Complete:**
   - Run ALL tests — they must pass
   - Verify all success criteria from the _Prompt are met
   - Edit .spec-context/specs/${specName}/tasks.md directly
   - Change the task marker from [-] to [x] for the completed task
   - Only mark complete when fully implemented, tested, AND verified

8. **Code Review (full/standard modes):**
   - Review the implementation against spec, code quality, principles (using loaded reviewer guide)
   - If issues found: fix them, re-verify, then re-review
   - If approved: this task is done
   - STOP HERE — do NOT proceed to the next task in this same session

**Important Guidelines:**
- ONE task at a time — this is non-negotiable
- Call \`get-implementer-guide\` and \`get-reviewer-guide\` once before starting (not per-task)
- Follow loaded TDD and review rules for EVERY task
- NEVER skip TDD in full discipline mode
- NEVER skip verification in any mode
- If a task has subtasks (e.g., 4.1, 4.2), each subtask follows this same workflow
- If you encounter blockers, STOP and report — do NOT silently move to another task

**Tools to Use:**
- get-implementer-guide: Load TDD + verification rules (call once before first task)
- get-reviewer-guide: Load review checklist (call once before first review)
- search: Search existing implementations before coding
- code_research: Deep analysis for architecture questions
- spec-status: Check overall progress
- Edit: Update task markers in tasks.md
- Read/Write/Edit: Implement code changes
- Bash: Run tests and verify

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
