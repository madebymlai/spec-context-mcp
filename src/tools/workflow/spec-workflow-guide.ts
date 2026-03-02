import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolContext, ToolResponse, requireFileContentCache } from '../../workflow-types.js';
import { getSteeringDocs } from './steering-loader.js';
import { getSpecTemplates, SPEC_WORKFLOW_TEMPLATES } from './template-loader.js';
import { getDisciplineMode, getDispatchCli } from '../../config/discipline.js';

export const specWorkflowGuideTool: Tool = {
  name: 'spec-workflow-guide',
  description: `Load spec workflow guide. Use when user mentions "spec workflow", wants to understand the spec process, or needs guidance on spec-driven development.

# Instructions
Call this tool FIRST when users request spec creation, feature development, or mention specifications. This provides the complete workflow sequence (Requirements → Design → Tasks → Implementation) that must be followed. Always load before any other spec tools to ensure proper workflow understanding.`,
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  }
};

export async function specWorkflowGuideHandler(args: any, context: ToolContext): Promise<ToolResponse> {
  // Dashboard URL is populated from registry in server.ts
  const dashboardMessage = context.dashboardUrl ?
    `Monitor progress on dashboard: ${context.dashboardUrl}` :
    'Please start the dashboard with: spec-context-dashboard';

  // Get discipline mode
  const disciplineMode = await getDisciplineMode();
  const reviewsRequired = disciplineMode !== 'minimal';

  // Get dispatch CLIs
  const implementerCli = await getDispatchCli('implementer');
  const reviewerCli = await getDispatchCli('reviewer');

  // Read steering docs if they exist
  const fileContentCache = requireFileContentCache(context);
  const steeringContent = await getSteeringDocs(
    context.projectPath,
    ['product', 'tech', 'structure', 'principles'],
    fileContentCache
  );
  const templates = await getSpecTemplates(
    SPEC_WORKFLOW_TEMPLATES,
    fileContentCache
  );

  return {
    success: true,
    message: 'You are the orchestrator. Read the full guide carefully before taking any action.',
    data: {
      guide: getSpecWorkflowGuide(disciplineMode, implementerCli, reviewerCli),
      steering: steeringContent,
      templates,
      disciplineMode,
      dispatch: {
        implementerCli,
        reviewerCli,
        implementerConfigured: !!implementerCli,
        reviewerConfigured: !reviewsRequired || !!reviewerCli || !!process.env.SPEC_CONTEXT_ROUTE_SIMPLE?.trim(),
      },
      dashboardUrl: context.dashboardUrl,
      dashboardAvailable: !!context.dashboardUrl
    },
    nextSteps: [
      'Recap your understanding of the request',
      'Ask: "Clear enough for spec, or brainstorm first?"',
      'Follow sequence: Requirements → Design → Tasks → Implementation',
      'Request approval after each document',
      dashboardMessage
    ]
  };
}

function getSpecWorkflowGuide(disciplineMode: 'full' | 'standard' | 'minimal', implementerCli: string | null, reviewerCli: string | null): string {
  const currentYear = new Date().getFullYear();
  const reviewsRequired = disciplineMode !== 'minimal';
  return `# Spec Development Workflow

You are the orchestrator. You write spec documents, not code. Phases run in order: Requirements → Design → Tasks → Implementation. One spec at a time, kebab-case names.

**Discipline:** ${disciplineMode} — ${disciplineMode === 'full' ? 'TDD + code reviews' : disciplineMode === 'standard' ? 'code reviews (no TDD)' : 'verification only'}

## Before Starting

Recap your understanding, then ask: "Clear enough for spec, or brainstorm first?"
If the idea needs refinement, use \`get-brainstorm-guide\` first.

## Phases 1-3: Spec Documents

Each phase follows the same pattern:
1. Use the injected template from \`data.templates.{phase}\` (requirements, design, or tasks)
2. If template is missing, stop and ask user to retry
3. Read steering docs from \`.spec-context/steering/\` if they exist
4. Create the document at \`.spec-context/specs/{spec-name}/{phase}.md\`
5. Request approval: call \`approvals\` with action:\`request\`, filePath only (never content)
6. Call \`wait-for-approval\` with the approvalId — blocks until resolved
7. On approved: proceed to next phase. On needs-revision: update and re-request. On rejected: stop.

Verbal approval is never accepted — only dashboard approval via \`wait-for-approval\`.

### Phase-specific notes

**Requirements**: Research market/user expectations if web search is available (current year: ${currentYear}). Write requirements as user stories with EARS acceptance criteria.

**Design**: Analyze codebase for patterns to reuse. Research technology choices if web search is available (current year: ${currentYear}).

**Tasks**: Follow the format rules in the tasks template exactly — the approval validator enforces them. Each task needs a numeric ID, \`_Prompt:\` with Role/Task/Restrictions/Success sections, \`_Requirements:\` references, and \`_Leverage:\` file paths. After tasks are approved, ask: "Spec complete. Ready to implement?"

## Phase 4: Implementation
${!implementerCli ? `
No implementer configured. Ask the user to set the implementer provider in dashboard settings before proceeding.
` : `
You do not write code. You dispatch each task to \`${implementerCli}\` via \`dispatch-runtime\`.
${reviewsRequired ? `After each task completes, dispatch a reviewer via \`dispatch-runtime\`.` : 'Reviews are disabled in minimal mode.'}

**For each task, sequentially:**

1. Read tasks.md, pick the next \`[ ]\` task. Only one \`[-]\` at a time.
2. Capture base SHA: \`git rev-parse HEAD\`
3. Call \`dispatch-runtime\` action:\`init_run\` with specName and taskId. Save the returned runId.
4. Call \`dispatch-runtime\` action:\`dispatch_and_ingest\` with runId, role:\`implementer\`, taskId, maxOutputTokens:1200. Omit taskPrompt to use the ledger prompt. Follow the returned nextAction.
5. Verify: task should be \`[x]\`, check \`git diff {base-sha}..HEAD\`.
${reviewsRequired ? `6. Call \`dispatch-runtime\` action:\`dispatch_and_ingest\` with runId, role:\`reviewer\`, taskId, maxOutputTokens:1200. If issues: re-dispatch implementer to fix, then re-review. If same issue twice: runtime returns halt_and_escalate.` : ''}
${reviewsRequired ? '7' : '6'}. Proceed to the next task.

Only use \`dispatch-runtime\` results for orchestration decisions — never raw logs.
If the implementer fails or produces bad output, re-dispatch with clearer instructions.`}

## File Structure

\`\`\`
.spec-context/
├── specs/{spec-name}/
│   ├── requirements.md
│   ├── design.md
│   └── tasks.md
└── steering/  (optional)
    ├── product.md
    ├── tech.md
    ├── structure.md
    └── principles.md
\`\`\``;
}
