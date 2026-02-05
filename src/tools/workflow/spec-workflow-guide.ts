import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolContext, ToolResponse } from '../../workflow-types.js';
import { getSteeringDocs } from './steering-loader.js';
import { getDisciplineMode } from '../../config/discipline.js';

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

  // Read steering docs if they exist
  const steeringContent = getSteeringDocs(context.projectPath, ['product', 'tech', 'structure', 'principles']);

  return {
    success: true,
    message: 'Complete spec workflow guide loaded - follow this workflow exactly',
    data: {
      guide: getSpecWorkflowGuide(disciplineMode),
      steering: steeringContent,
      disciplineMode,
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

function getSpecWorkflowGuide(disciplineMode: 'full' | 'standard' | 'minimal'): string {
  const currentYear = new Date().getFullYear();
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
    P1_Load --> P1_Template[Check user-templates first,<br/>then read template:<br/>requirements-template.md]
    P1_Template --> P1_Research[Web search if available]
    P1_Research --> P1_Create[Create file:<br/>.spec-context/specs/{name}/<br/>requirements.md]
    P1_Create --> P1_Approve[approvals<br/>action: request<br/>filePath only]
    P1_Approve --> P1_Wait[wait-for-approval<br/>blocks until resolved<br/>auto-deletes]
    P1_Wait --> P1_Check{Status?}
    P1_Check -->|needs-revision| P1_Update[Update document using user comments as guidance]
    P1_Update --> P1_Approve
    P1_Check -->|rejected| P1_Stop[Ask user for guidance]

    %% Phase 2: Design
    P1_Check -->|approved| P2_Template[Check user-templates first,<br/>then read template:<br/>design-template.md]
    P2_Template --> P2_Analyze[Analyze codebase patterns]
    P2_Analyze --> P2_Create[Create file:<br/>.spec-context/specs/{name}/<br/>design.md]
    P2_Create --> P2_Approve[approvals<br/>action: request<br/>filePath only]
    P2_Approve --> P2_Wait[wait-for-approval<br/>blocks until resolved<br/>auto-deletes]
    P2_Wait --> P2_Check{Status?}
    P2_Check -->|needs-revision| P2_Update[Update document using user comments as guidance]
    P2_Update --> P2_Approve
    P2_Check -->|rejected| P2_Stop[Ask user for guidance]

    %% Phase 3: Tasks
    P2_Check -->|approved| P3_Template[Check user-templates first,<br/>then read template:<br/>tasks-template.md]
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
    P4_Ready -->|Yes| P4_LoadGuides[Load guides once:<br/>get-implementer-guide<br/>get-reviewer-guide]
    P4_LoadGuides --> P4_Pick[Pick ONE next pending task<br/>NEVER multiple]
    P4_Pick --> P4_Mark[Edit tasks.md:<br/>Change [ ] to [-]<br/>for this ONE task only]
    P4_Mark --> P4_Code[Implement with TDD:<br/>RED → GREEN → REFACTOR]
    P4_Code --> P4_Verify[Verify: run tests,<br/>check all pass]
    P4_Verify --> P4_Complete[Edit tasks.md:<br/>Change [-] to [x]]
    P4_Complete --> P4_Review{Reviews enabled?}
    P4_Review -->|Yes| P4_DoReview[Review implementation<br/>using loaded guide]
    P4_DoReview --> P4_ReviewResult{Review result?}
    P4_ReviewResult -->|Issues found| P4_Fix[Fix issues,<br/>re-verify]
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
- Read steering docs: \`.spec-context/steering/*.md\` (if they exist)
- Check for custom template: \`.spec-context/user-templates/requirements-template.md\`
- Read template: \`.spec-context/templates/requirements-template.md\` (if no custom template)
- Create document: \`.spec-context/specs/{spec-name}/requirements.md\`

**Tools**:
- approvals: Create approval requests (action: request)
- wait-for-approval: Block until user responds, auto-cleans up

**Process**:
1. Check if \`.spec-context/steering/\` exists (if yes, read product.md, tech.md, structure.md, principles.md)
2. Check for custom template at \`.spec-context/user-templates/requirements-template.md\`
3. If no custom template, read from \`.spec-context/templates/requirements-template.md\`
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
- Check for custom template: \`.spec-context/user-templates/design-template.md\`
- Read template: \`.spec-context/templates/design-template.md\` (if no custom template)
- Create document: \`.spec-context/specs/{spec-name}/design.md\`

**Tools**:
- approvals: Create approval requests (action: request)
- wait-for-approval: Block until user responds, auto-cleans up

**Process**:
1. Check for custom template at \`.spec-context/user-templates/design-template.md\`
2. If no custom template, read from \`.spec-context/templates/design-template.md\`
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
- Check for custom template: \`.spec-context/user-templates/tasks-template.md\`
- Read template: \`.spec-context/templates/tasks-template.md\` (if no custom template)
- Create document: \`.spec-context/specs/{spec-name}/tasks.md\`

**Tools**:
- approvals: Create approval requests (action: request)
- wait-for-approval: Block until user responds, auto-cleans up

**Process**:
1. Check for custom template at \`.spec-context/user-templates/tasks-template.md\`
2. If no custom template, read from \`.spec-context/templates/tasks-template.md\`
3. Convert design into atomic tasks (1-3 files each)
4. Include file paths and requirement references
5. **IMPORTANT**: Generate a _Prompt field for each task with:
   - Role: specialized developer role for the task
   - Task: clear description with context references
   - Restrictions: what not to do, constraints to follow
   - _Leverage: files/utilities to use
   - _Requirements: requirements that the task implements
   - Success: specific completion criteria
   - Instructions: "Mark this ONE task as [-] in tasks.md before starting. Follow the loaded implementer guide rules (TDD in full mode, verification in all modes). When done, mark [x] in tasks.md. Then perform code review using the loaded reviewer guide (full/standard modes). Do NOT start the next task until review is approved."
   - Start the prompt with "Implement the task for spec {spec-name}, first run spec-workflow-guide to get the workflow guide then implement the task:"
6. Create \`tasks.md\` at \`.spec-context/specs/{spec-name}/tasks.md\`
7. Request approval using approvals tool with action:'request'
8. Call wait-for-approval with the approvalId - this blocks until user responds and auto-deletes
9. Handle result:
   - approved: "Spec complete. Ready to implement?"
   - needs-revision: update document with feedback, create NEW approval request, wait again
   - rejected: STOP, ask user for guidance

### Phase 4: Implementation
**Purpose**: Execute tasks ONE AT A TIME with TDD and review.

**File Operations**:
- Read specs: \`.spec-context/specs/{spec-name}/*.md\` (if returning to work)
- Edit tasks.md to update status:
  - \`- [ ]\` = Pending task
  - \`- [-]\` = In-progress task (ONLY ONE at a time)
  - \`- [x]\` = Completed task

**Tools**:
- spec-status: Check overall progress
- get-implementer-guide: Load TDD rules + verification rules (call once before first task)
- get-reviewer-guide: Load review checklist (call once before first review)
- Direct editing: Mark tasks as in-progress [-] or complete [x] in tasks.md

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

**Process**:

**Before first task:** Call \`get-implementer-guide\` once to load TDD and verification rules. Call \`get-reviewer-guide\` once to load review checklist (full/standard modes).

**Then repeat for EACH task, sequentially:**

1. **Pick ONE task**: Check spec-status, read tasks.md, identify the next pending \`[ ]\` task
2. **Mark in-progress**: Edit tasks.md — change \`[ ]\` to \`[-]\` for THIS ONE task only
3. **Read task guidance**: Read the _Prompt field for role, approach, restrictions, and success criteria
4. **Implement with TDD** (full mode) or implement with verification (standard/minimal):
   - Follow the _Prompt guidance exactly
   - Use files mentioned in _Leverage fields
   - ${disciplineMode === 'full' ? 'Follow strict Red-Green-Refactor TDD cycle' : 'Write tests alongside implementation'}
   - Run tests and verify all pass
5. **Verify completion**: Run full verification — tests pass, build succeeds, success criteria met
6. **Mark complete**: Edit tasks.md — change \`[-]\` to \`[x]\`
7. **Review** (full/standard modes only):
   - Review implementation against spec, code quality, principles (using loaded reviewer guide)
   - If issues found: fix them, re-verify, re-review
   - If approved: proceed to next task
8. **Repeat from step 1** for the next pending task

## Workflow Rules

- Create documents directly at specified file paths
- Read templates from \`.spec-context/templates/\` directory
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
- **CRITICAL: Call \`get-implementer-guide\` once before starting implementation**
- **CRITICAL: Call \`get-reviewer-guide\` once before first review (full/standard modes)**
- **CRITICAL: Follow the loaded guide rules for EVERY task — TDD, verification, review**

## Implementation Review Workflow
${disciplineMode === 'minimal' ? `
Reviews are disabled in minimal mode. Focus on verification before completion.
**Still enforce: ONE task at a time. Complete and verify before starting next.**
` : `
**MANDATORY after EACH task** (${disciplineMode === 'full' ? 'TDD + ' : ''}verification + review):

Load \`get-implementer-guide\` and \`get-reviewer-guide\` once before starting. Then for EACH task:
1. **Implementer**: Implement ONE task following loaded implementer guide (${disciplineMode === 'full' ? 'TDD' : 'verification'})
2. **Implementer**: Mark task [x] complete
3. **Reviewer**: Review the implementation following loaded reviewer guide
4. **Handle feedback:**
   - If issues found: implementer fixes, re-verify, reviewer re-reviews
   - If same issue appears twice: orchestrator takes over (implementer doesn't understand)
   - If approved: START the next task (go back to step 1)

**NEVER start the next task before the current task is reviewed and approved.**
**NEVER have more than one task marked [-] in-progress at any time.**
`}
## File Structure
\`\`\`
.spec-context/
├── templates/           # Auto-populated on server start
│   ├── requirements-template.md
│   ├── design-template.md
│   ├── tasks-template.md
│   ├── product-template.md
│   ├── tech-template.md
│   ├── structure-template.md
│   └── principles-template.md
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
\`\`\``;
}
