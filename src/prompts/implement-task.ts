import { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';
import { PromptDefinition } from './types.js';
import { ToolContext } from '../workflow-types.js';

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

  const messages: PromptMessage[] = [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Implement ${taskId ? `task ${taskId}` : 'the next pending task'} for the "${specName}" feature.

**Context:**
- Project: ${context.projectPath}
- Feature: ${specName}
${taskId ? `- Task ID: ${taskId}` : ''}
${context.dashboardUrl ? `- Dashboard: ${context.dashboardUrl}` : ''}

**Implementation Workflow:**

1. **Check Current Status:**
   - Use the spec-status tool with specName "${specName}" to see overall progress
   - Read .spec-context/specs/${specName}/tasks.md to see all tasks
   - Identify ${taskId ? `task ${taskId}` : 'the next pending task marked with [ ]'}

2. **Start the Task:**
   - Edit .spec-context/specs/${specName}/tasks.md directly
   - Change the task marker from [ ] to [-] for the task you're starting
   - Only one task should be in-progress at a time

3. **Read Task Guidance:**
   - Look for the _Prompt field in the task - it contains structured guidance:
     - Role: The specialized developer role to assume
     - Task: Clear description with context references
     - Restrictions: What not to do and constraints
     - Success: Specific completion criteria
   - Note the _Leverage fields for files/utilities to use
   - Check _Requirements fields for which requirements this implements

4. **Discover Existing Implementations (CRITICAL):**
   - BEFORE writing any code, use the \`search_code\` tool to find existing implementations
   - First check if codebase is indexed with \`get_indexing_status\`, run \`index_codebase\` if needed

   **Use the search_code tool (PRIMARY METHOD):**
   \`\`\`
   search_code: "authentication middleware"
   search_code: "API endpoint handler"
   search_code: "user validation function"
   \`\`\`

   **Fallback: grep/ripgrep (only if search_code doesn't find results)**
   \`\`\`bash
   grep -r "pattern" ".spec-context/specs/${specName}/Implementation Logs/"
   \`\`\`

   **Discovery best practices:**
   - First: Use \`search_code\` to find existing API patterns and similar implementations
   - Second: Search for component names or function signatures you need
   - Third: Search for integration patterns and data flow
   - Why this matters:
     - ❌ Don't create duplicate API endpoints - check for similar paths
     - ❌ Don't reimplement components/functions - verify utilities already don't exist
     - ❌ Don't ignore established patterns - understand middleware/integration setup
     - ✅ Reuse existing code - leverage already-implemented functions and components
     - ✅ Follow patterns - maintain consistency with established architecture
   - Document any existing related implementations before proceeding
   - If you find existing code that does what the task asks, leverage it instead of recreating

5. **Implement the Task:**
   - Follow the _Prompt guidance exactly
   - Use the files mentioned in _Leverage fields
   - Create or modify the files specified in the task
   - Write clean, well-commented code
   - Follow existing patterns in the codebase
   - Test your implementation thoroughly

6. **Complete the Task:**
   - Verify all success criteria from the _Prompt are met
   - Run any relevant tests to ensure nothing is broken
   - Edit .spec-context/specs/${specName}/tasks.md directly
   - Change the task marker from [-] to [x] for the completed task
   - Only mark complete when fully implemented and tested

7. **Log Implementation (CRITICAL - ARTIFACTS REQUIRED):**
   - After completing a task, use the log-implementation tool to record comprehensive implementation details
   - This creates a searchable knowledge base for future AI agents to discover and reuse existing code
   - You MUST include artifacts (required field) to enable other agents to find your work:
     - **apiEndpoints**: List all API endpoints created/modified with method, path, purpose, request/response formats, and location
     - **components**: List all UI components created with name, type, purpose, props, and location
     - **functions**: List all utility functions with signature and location
     - **classes**: List all classes with methods and location
     - **integrations**: Document how frontend connects to backend with data flow description
   - Call log-implementation with:
     - specName: "${specName}"
     - taskId: ${taskId ? `"${taskId}"` : 'the task ID you just completed'}
     - summary: Clear description of what was implemented (1-2 sentences)
     - filesModified: List of files you edited
     - filesCreated: List of files you created
     - statistics: {linesAdded: number, linesRemoved: number}
     - artifacts: {apiEndpoints: [...], components: [...], functions: [...], classes: [...], integrations: [...]}
   - Example artifacts for an API endpoint:
     \`\`\`json
     "apiEndpoints": [{
       "method": "GET",
       "path": "/api/todos/:id",
       "purpose": "Fetch a specific todo by ID",
       "requestFormat": "URL param: id (string)",
       "responseFormat": "{ id: string, title: string, completed: boolean }",
       "location": "src/server.ts:245"
     }]
     \`\`\`
   - Why: Future AI agents will query logs before implementing, preventing duplicate code and ensuring architecture consistency

**Important Guidelines:**
- Always mark a task as in-progress before starting work
- Follow the _Prompt field guidance for role, approach, and success criteria
- Use existing patterns and utilities mentioned in _Leverage fields
- Test your implementation before marking the task complete
- If a task has subtasks (e.g., 4.1, 4.2), complete them in order
- If you encounter blockers, document them and move to another task

8. **Update Search Index:**
   - After completing the task, run \`sync_index\` to update the codebase index with your changes
   - This ensures future searches can find the code you just wrote

**Tools to Use:**
- get_indexing_status: Check if codebase is indexed before searching
- index_codebase: Index the codebase if not already indexed
- search_code: PRIMARY - Search existing implementations before coding (step 4)
- sync_index: Update index after completing task (step 8)
- spec-status: Check overall progress
- log-implementation: Record implementation details with artifacts after task completion (step 7)
- Edit: Directly update task markers in tasks.md file
- Read/Write/Edit: Implement the actual code changes
- Bash: Run tests and verify implementation (fallback grep if search_code doesn't find results)

**View Implementation Logs:**
- All logged implementations appear in the "Logs" tab of the dashboard
- Filter by spec, task ID, or search by summary
- View detailed statistics including files changed and lines modified
- Or search directly using grep on markdown files in .spec-context/specs/{specName}/Implementation Logs/

Please proceed with implementing ${taskId ? `task ${taskId}` : 'the next task'} following this workflow.`
      }
    }
  ];

  return messages;
}

export const implementTaskPrompt: PromptDefinition = {
  prompt,
  handler,
  _metadata: {
    preferredModel: 'opus'  // Complex multi-step reasoning
  }
};