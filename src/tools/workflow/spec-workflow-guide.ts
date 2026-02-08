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
  const disciplineMode = getDisciplineMode();
  const reviewsRequired = disciplineMode !== 'minimal';

  // Get dispatch CLIs
  const implementerCli = getDispatchCli('implementer');
  const reviewerCli = getDispatchCli('reviewer');

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
    message: 'Complete spec workflow guide loaded - follow this workflow exactly',
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

## Overview

You guide users through spec-driven development using MCP tools. Transform rough ideas into detailed specifications through Requirements → Design → Tasks → Implementation phases. Use web search when available for current best practices (current year: ${currentYear}). Its important that you follow this workflow exactly to avoid errors.
Feature names use kebab-case (e.g., user-authentication). Create ONE spec at a time.

**Discipline Mode:** ${disciplineMode}
${disciplineMode === 'full' ? '- TDD required, code reviews enabled' : disciplineMode === 'standard' ? '- Code reviews enabled (no TDD requirement)' : '- Verification only (no reviews)'}

## Before Starting

**Recap your understanding** of what the user wants to build, then ask:
> "Clear enough for spec, or brainstorm first?"

If the idea needs refinement, use \`get-brainstorm-guide\` to explore before formal spec creation.

## Workflow Diagram
\`\`\`mermaid
flowchart TD
    Start([Start: User requests feature]) --> CheckSteering{Steering docs exist?}
    CheckSteering -->|Yes| P1_Load[Read steering docs:<br/>.spec-context/steering/*.md]
    CheckSteering -->|No| P1_Template

    %% Phase 1: Requirements
    P1_Load --> P1_Template[Use injected server template:<br/>requirements-template.md]
    P1_Template --> P1_Research[Web search if available]
    P1_Research --> P1_Create[Create file:<br/>.spec-context/specs/{name}/<br/>requirements.md]
    P1_Create --> P1_Approve[approvals<br/>action: request<br/>filePath only]
    P1_Approve --> P1_Wait[wait-for-approval<br/>blocks until resolved<br/>auto-deletes]
    P1_Wait --> P1_Check{Status?}
    P1_Check -->|needs-revision| P1_Update[Update document using user comments as guidance]
    P1_Update --> P1_Approve
    P1_Check -->|rejected| P1_Stop[Ask user for guidance]

    %% Phase 2: Design
    P1_Check -->|approved| P2_Template[Use injected server template:<br/>design-template.md]
    P2_Template --> P2_Analyze[Analyze codebase patterns]
    P2_Analyze --> P2_Create[Create file:<br/>.spec-context/specs/{name}/<br/>design.md]
    P2_Create --> P2_Approve[approvals<br/>action: request<br/>filePath only]
    P2_Approve --> P2_Wait[wait-for-approval<br/>blocks until resolved<br/>auto-deletes]
    P2_Wait --> P2_Check{Status?}
    P2_Check -->|needs-revision| P2_Update[Update document using user comments as guidance]
    P2_Update --> P2_Approve
    P2_Check -->|rejected| P2_Stop[Ask user for guidance]

    %% Phase 3: Tasks
    P2_Check -->|approved| P3_Template[Use injected server template:<br/>tasks-template.md]
    P3_Template --> P3_Break[Convert design to tasks]
    P3_Break --> P3_Create[Create file:<br/>.spec-context/specs/{name}/<br/>tasks.md]
    P3_Create --> P3_Approve[approvals<br/>action: request<br/>filePath only]
    P3_Approve --> P3_Wait[wait-for-approval<br/>blocks until resolved<br/>auto-deletes]
    P3_Wait --> P3_Check{Status?}
    P3_Check -->|needs-revision| P3_Update[Update document using user comments as guidance]
    P3_Update --> P3_Approve
    P3_Check -->|rejected| P3_Stop[Ask user for guidance]

    %% Phase 4: Implementation (ONE task at a time)
    P3_Check -->|approved| P4_Ready[Spec complete.<br/>Ready to implement?]
    P4_Ready -->|Yes| P4_Pick[Pick ONE next pending task<br/>NEVER multiple]
    P4_Pick --> P4_Dispatch[Dispatch to implementer:<br/>${implementerCli}]
    P4_Dispatch --> P4_Verify[Verify: task marked [x],<br/>tests pass]
    P4_Verify --> P4_Review{Reviews enabled?}
    P4_Review -->|Yes| P4_DoReview[Dispatch reviewer via<br/>dispatch-runtime compile_prompt]
    P4_DoReview --> P4_ReviewResult{Review result?}
    P4_ReviewResult -->|Issues found| P4_Fix[Dispatch implementer<br/>to fix issues]
    P4_Fix --> P4_DoReview
    P4_ReviewResult -->|Approved| P4_More{More tasks?}
    P4_Review -->|No minimal mode| P4_More
    P4_More -->|Yes| P4_Pick
    P4_More -->|No| End([Implementation Complete])

    style Start fill:#e1f5e1
    style End fill:#e1f5e1
    style P1_Check fill:#ffe6e6
    style P2_Check fill:#ffe6e6
    style P3_Check fill:#ffe6e6
    style P1_Wait fill:#e3f2fd
    style P2_Wait fill:#e3f2fd
    style P3_Wait fill:#e3f2fd
    style CheckSteering fill:#fff4e6
    style P4_More fill:#fff4e6
\`\`\`

## Spec Workflow

### Phase 1: Requirements
**Purpose**: Define what to build based on user needs.

**File Operations**:
- Use injected template payload from this tool response first: \`data.templates.requirements\`
- Read steering docs: \`.spec-context/steering/*.md\` (if they exist)
- Use server template: \`requirements-template.md\` from injected payload
- Create document: \`.spec-context/specs/{spec-name}/requirements.md\`

**Tools**:
- approvals: Create approval requests (action: request)
- wait-for-approval: Block until user responds, auto-cleans up

**Process**:
1. Check if \`.spec-context/steering/\` exists (if yes, read product.md, tech.md, structure.md, principles.md)
2. Use \`data.templates.requirements.content\` from this tool response when available (includes resolved source + path)
3. If \`data.templates.requirements\` is missing, stop and ask user to retry tool loading (no local template fallback)
4. Research market/user expectations (if web search available, current year: ${currentYear})
5. Generate requirements as user stories with EARS criteria
6. Create \`requirements.md\` at \`.spec-context/specs/{spec-name}/requirements.md\`
7. Request approval using approvals tool with action:'request' (filePath only, never content)
8. Call wait-for-approval with the approvalId - this blocks until user responds and auto-deletes
9. Handle result:
   - approved: proceed to Phase 2
   - needs-revision: update document with feedback, create NEW approval request, wait again
   - rejected: STOP, ask user for guidance

### Phase 2: Design
**Purpose**: Create technical design addressing all requirements.

**File Operations**:
- Use injected template payload from this tool response first: \`data.templates.design\`
- Use server template: \`design-template.md\` from injected payload
- Create document: \`.spec-context/specs/{spec-name}/design.md\`

**Tools**:
- approvals: Create approval requests (action: request)
- wait-for-approval: Block until user responds, auto-cleans up

**Process**:
1. Use \`data.templates.design.content\` from this tool response when available (includes resolved source + path)
2. If \`data.templates.design\` is missing, stop and ask user to retry tool loading (no local template fallback)
3. Analyze codebase for patterns to reuse
4. Research technology choices (if web search available, current year: ${currentYear})
5. Generate design with all template sections
6. Create \`design.md\` at \`.spec-context/specs/{spec-name}/design.md\`
7. Request approval using approvals tool with action:'request'
8. Call wait-for-approval with the approvalId - this blocks until user responds and auto-deletes
9. Handle result:
   - approved: proceed to Phase 3
   - needs-revision: update document with feedback, create NEW approval request, wait again
   - rejected: STOP, ask user for guidance

### Phase 3: Tasks
**Purpose**: Break design into atomic implementation tasks.

**File Operations**:
- Use injected template payload from this tool response first: \`data.templates.tasks\`
- Use server template: \`tasks-template.md\` from injected payload
- Create document: \`.spec-context/specs/{spec-name}/tasks.md\`

**Tools**:
- approvals: Create approval requests (action: request)
- wait-for-approval: Block until user responds, auto-cleans up

**Process**:
1. Use \`data.templates.tasks.content\` from this tool response when available (includes resolved source + path)
2. If \`data.templates.tasks\` is missing, stop and ask user to retry tool loading (no local template fallback)
3. Convert design into atomic tasks (1-3 files each)
4. Include file paths and requirement references
5. **IMPORTANT**: Generate a _Prompt field for each task with:
   - Role: specialized developer role for the task
   - Task: clear description with context references
   - Restrictions: what not to do, constraints to follow
   - _Leverage: files/utilities to use
   - _Requirements: requirements that the task implements
   - Success: specific completion criteria
   - Instructions: "Mark this ONE task as [-] in tasks.md before starting. Follow the loaded implementer guide rules (${disciplineMode === 'full' ? 'TDD required' : 'verification required'}). When done, mark [x] in tasks.md.${disciplineMode !== 'minimal' ? ' Then perform code review using the loaded reviewer guide.' : ''}"
   - Start the prompt with "Implement the task for spec {spec-name}, first call get-implementer-guide to load implementation rules then implement the task:"
6. Create \`tasks.md\` at \`.spec-context/specs/{spec-name}/tasks.md\`
7. Request approval using approvals tool with action:'request'
8. Call wait-for-approval with the approvalId - this blocks until user responds and auto-deletes
9. Handle result:
   - approved: "Spec complete. Ready to implement?"
   - needs-revision: update document with feedback, create NEW approval request, wait again
   - rejected: STOP, ask user for guidance

### Phase 4: Implementation
${!implementerCli ? `
**⛔ BLOCKED: SPEC_CONTEXT_IMPLEMENTER is not set.**

Implementation requires a dispatch CLI. Set the \`SPEC_CONTEXT_IMPLEMENTER\` environment variable to the CLI command for your implementer agent (supported shortcuts: \`claude\`, \`codex\`, \`gemini\`, \`opencode\`).

Example: \`SPEC_CONTEXT_IMPLEMENTER=claude\`

Do NOT implement tasks yourself. STOP and ask the user to configure the env var.
` : `**Purpose**: Execute tasks ONE AT A TIME with ${disciplineMode === 'full' ? 'TDD, ' : ''}verification${disciplineMode !== 'minimal' ? ', and review' : ''}.

**Agent Dispatch:**
- Implementer CLI: \`${implementerCli}\`
${reviewsRequired
  ? '- Reviewer dispatch CLI: runtime-resolved from `dispatch-runtime` compile_prompt (`dispatch_cli`)'
  : '- Reviewer dispatch: not required in minimal mode'}
- You are the ORCHESTRATOR. You do NOT implement tasks yourself.
- You DISPATCH each task to the implementer agent via bash.
${reviewsRequired ? '- You DISPATCH reviews to the reviewer agent via bash.' : '- Reviews are disabled in minimal mode.'}

**File Operations**:
- Read tasks.md to check status and pick next task
- Edit tasks.md to update status:
  - \`- [ ]\` = Pending task
  - \`- [-]\` = In-progress task (ONLY ONE at a time)
  - \`- [x]\` = Completed task

**Tools**:
- spec-status: Check overall progress
- dispatch-runtime: Validate/ingest structured agent output and read runtime snapshot state
- Direct editing: Mark tasks as in-progress [-] or complete [x] in tasks.md
- Bash: Dispatch tasks to implementer agent (\`${implementerCli}\`)
${reviewsRequired
  ? '- Bash: Dispatch reviewer using `dispatch_cli` returned by reviewer compile_prompt'
  : '- Review dispatch is skipped in minimal mode'}

\`\`\`
╔══════════════════════════════════════════════════════════════╗
║  CRITICAL: ONE TASK AT A TIME                               ║
║                                                              ║
║  - NEVER mark multiple tasks as [-] in-progress              ║
║  - NEVER start task N+1 before task N is [x] AND reviewed    ║
║  - NEVER batch tasks together                                ║
║  - Each task = implement → verify → review → THEN next       ║
╚══════════════════════════════════════════════════════════════╝
\`\`\`

**Process:**

**Repeat for EACH task, sequentially:**

1. **Pick ONE task**: Check spec-status, read tasks.md, identify the next pending \`[ ]\` task
2. **Capture base SHA** (for reviewer later):
   \`\`\`bash
   git rev-parse HEAD
   \`\`\`
   Save this SHA — you'll pass it to the reviewer.
3. **Build the task prompt**: Read the _Prompt field. Combine with:
   - The spec name and task ID
   - File paths from _Leverage fields
   - Requirements from _Requirements fields
   - Instructions to mark [-] before starting and [x] when done
4. **Initialize runtime state for this task**:
   - Call \`dispatch-runtime\` with:
     - \`action: "init_run"\`
     - \`specName: "{spec-name}"\`
     - \`taskId: "{taskId}"\`
   - Save \`runId\` for subsequent ingest calls.
5. **Dispatch to implementer agent via bash** (split contract and debug logs):
   - First call \`dispatch-runtime\` with:
     - \`action: "compile_prompt"\`
     - \`runId: "{runId}"\`
     - \`role: "implementer"\`
     - \`taskId: "{taskId}"\`
     - \`maxOutputTokens: 1200\`
   - Omit \`taskPrompt\` to use runtime ledger task prompt (fail fast if missing).
   - Use returned \`prompt\`, \`dispatch_cli\`, \`contractOutputPath\`, and \`debugOutputPath\` for dispatch.
   \`\`\`bash
   {dispatch_cli from implementer compile_prompt} "{compiled implementer prompt from dispatch-runtime}" 1>"{contractOutputPath}" 2>"{debugOutputPath}"
   \`\`\`
   - Implementer LAST output must be strict contract markers \`BEGIN_DISPATCH_RESULT ... END_DISPATCH_RESULT\`
   - Wait for the command to complete before proceeding
6. **Ingest implementer output (no raw-log orchestration):**
   - Call \`dispatch-runtime\` with:
     - \`action: "ingest_output"\`
     - \`runId: "{runId}"\`
     - \`role: "implementer"\`
     - \`taskId: "{taskId}"\`
     - \`maxOutputTokens: 1200\`
     - \`outputFilePath: "{contractOutputPath}"\`
   - Use returned \`nextAction\` for branch decisions.
7. **Verify task completion**:
   - Check tasks.md — task should now be [x].
   - Get the diff (this is all you need to see):
     \`\`\`bash
     git diff {base-sha}..HEAD
     \`\`\`
8. **Review**${disciplineMode !== 'minimal' ? '' : ' (skipped in minimal mode)'}:
   ${disciplineMode === 'minimal'
      ? '   - Skip review in minimal mode.'
      : `   - First call \`dispatch-runtime\` with:
     - \`action: "compile_prompt"\`
     - \`runId: "{runId}"\`
     - \`role: "reviewer"\`
     - \`taskId: "{taskId}"\`
     - \`maxOutputTokens: 1200\`
   - Omit \`taskPrompt\` to use runtime ledger task prompt (fail fast if missing).
   - Reviewer context remains explicit here: use base SHA and run \`git diff {base-sha}..HEAD\` before/while reviewing.
   - Use returned \`prompt\`, \`dispatch_cli\`, \`contractOutputPath\`, and \`debugOutputPath\` for reviewer dispatch.
   \`\`\`bash
   {dispatch_cli from reviewer compile_prompt} "{compiled reviewer prompt from dispatch-runtime}" 1>"{contractOutputPath}" 2>"{debugOutputPath}"
   \`\`\`
   - Call \`dispatch-runtime\` with:
     - \`action: "ingest_output"\`
     - \`runId: "{runId}"\`
     - \`role: "reviewer"\`
     - \`taskId: "{taskId}"\`
     - \`maxOutputTokens: 1200\`
     - \`outputFilePath: "{contractOutputPath}"\``}
   - If issues found: dispatch implementer again to fix, then re-review
   - If approved: proceed to next task
9. **Repeat from step 1** for the next pending task

**CRITICAL rules:**
- NEVER implement tasks yourself — always dispatch to \`${implementerCli}\`
- NEVER dispatch multiple tasks at once — wait for each to complete
- NEVER skip the review step
- NEVER branch orchestration state from raw logs; only use \`dispatch-runtime\` validated output
- If the implementer agent fails or produces bad output, dispatch it again with clearer instructions`}

## Workflow Rules

- Create documents directly at specified file paths
- Use server-injected template payloads from this tool response
- Follow exact template structures
- Get explicit user approval between phases using: approvals action:'request' → wait-for-approval
- Complete phases in sequence (no skipping)
- One spec at a time
- Use kebab-case for spec names
- Approval requests: provide filePath only, never content
- wait-for-approval handles blocking AND cleanup automatically
- CRITICAL: Verbal approval is NEVER accepted - dashboard only
- NEVER proceed on user saying "approved" - use wait-for-approval tool
- Steering docs are optional - only create when explicitly requested
- **CRITICAL: ONE task at a time during implementation — never batch, never parallelize**
- **CRITICAL: NEVER implement tasks yourself — always dispatch to \`${implementerCli}\`**
${reviewsRequired ? '- **CRITICAL: NEVER review tasks yourself — always dispatch to reviewer via configured CLI/runtime dispatch_cli**' : ''}

## Implementation Review Workflow
${disciplineMode === 'minimal' ? `
Reviews are disabled in minimal mode. Focus on verification before completion.
**Still enforce: ONE task at a time. Complete and verify before starting next.**
` : `
**MANDATORY after EACH task** (${disciplineMode === 'full' ? 'TDD + ' : ''}verification + review):

For EACH task:
1. **Implement**: Dispatch to \`${implementerCli}\` via bash — agent calls \`get-implementer-guide\`, follows ${disciplineMode === 'full' ? 'TDD' : 'verification'} rules, marks [x]
   - Guide policy: call \`get-implementer-guide\` in \`mode:"full"\` once per run, then \`mode:"compact"\` on later tasks
2. **Review**: Dispatch reviewer via reviewer compile_prompt -> dispatch_cli — check spec compliance, code quality, principles
3. **Handle feedback:**
   - If issues found: dispatch implementer again to fix, re-verify, dispatch reviewer again
   - If same issue appears twice: orchestrator takes over (implementer doesn't understand)
   - If approved: START the next task (go back to step 1)

**NEVER start the next task before the current task is reviewed and approved.**
**NEVER have more than one task marked [-] in-progress at any time.**
**NEVER implement tasks yourself — always dispatch to \`${implementerCli}\`.**
**NEVER review tasks yourself — always dispatch to reviewer via configured CLI/runtime dispatch_cli.**
`}
## File Structure
\`\`\`
.spec-context/
├── specs/
│   └── {spec-name}/
│       ├── requirements.md
│       ├── design.md
│       └── tasks.md
└── steering/
    ├── product.md
    ├── tech.md
    ├── structure.md
    └── principles.md
\`\`\`

Template files are server-bundled and injected into this tool response.`;
}
