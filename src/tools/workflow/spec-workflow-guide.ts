import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolContext, ToolResponse } from '../../workflow-types.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

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
    'Please start the dashboard with: spec-workflow-mcp --dashboard';

  // Read steering docs if they exist
  const steeringContent = getSteeringDocsContent(context.projectPath);

  return {
    success: true,
    message: 'Complete spec workflow guide loaded - follow this workflow exactly',
    data: {
      guide: getSpecWorkflowGuide(),
      steering: steeringContent,
      dashboardUrl: context.dashboardUrl,
      dashboardAvailable: !!context.dashboardUrl
    },
    nextSteps: [
      'Follow sequence: Requirements → Design → Tasks → Implementation',
      'Load templates with get-template-context first',
      'Request approval after each document',
      'Use MCP tools only',
      dashboardMessage
    ]
  };
}

function getSteeringDocsContent(projectPath: string): { product?: string; tech?: string; structure?: string } | null {
  const steeringDir = join(projectPath, '.spec-context', 'steering');

  if (!existsSync(steeringDir)) {
    return null;
  }

  const result: { product?: string; tech?: string; structure?: string } = {};

  const docs = ['product', 'tech', 'structure'] as const;
  for (const doc of docs) {
    const docPath = join(steeringDir, `${doc}.md`);
    if (existsSync(docPath)) {
      try {
        result[doc] = readFileSync(docPath, 'utf-8');
      } catch {
        // Skip if can't read
      }
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

function getSpecWorkflowGuide(): string {
  const currentYear = new Date().getFullYear();
  return `# Spec Development Workflow

## Overview

You guide users through spec-driven development using MCP tools. Transform rough ideas into detailed specifications through Requirements → Design → Tasks → Implementation phases. Use web search when available for current best practices (current year: ${currentYear}). Its important that you follow this workflow exactly to avoid errors.
Feature names use kebab-case (e.g., user-authentication). Create ONE spec at a time.

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

    %% Phase 4: Implementation
    P3_Check -->|approved| P4_Ready[Spec complete.<br/>Ready to implement?]
    P4_Ready -->|Yes| P4_Status[spec-status]
    P4_Status --> P4_Task[Edit tasks.md:<br/>Change [ ] to [-]<br/>for in-progress]
    P4_Task --> P4_Code[Implement code]
    P4_Code --> P4_Complete[Edit tasks.md:<br/>Change [-] to [x]<br/>for completed]
    P4_Complete --> P4_More{More tasks?}
    P4_More -->|Yes| P4_Task
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
1. Check if \`.spec-context/steering/\` exists (if yes, read product.md, tech.md, structure.md)
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
   - Instructions related to setting the task in progress in tasks.md, and then marking it as complete when the task is complete.
   - Start the prompt with "Implement the task for spec {spec-name}, first run spec-workflow-guide to get the workflow guide then implement the task:"
6. Create \`tasks.md\` at \`.spec-context/specs/{spec-name}/tasks.md\`
7. Request approval using approvals tool with action:'request'
8. Call wait-for-approval with the approvalId - this blocks until user responds and auto-deletes
9. Handle result:
   - approved: "Spec complete. Ready to implement?"
   - needs-revision: update document with feedback, create NEW approval request, wait again
   - rejected: STOP, ask user for guidance

### Phase 4: Implementation
**Purpose**: Execute tasks systematically.

**File Operations**:
- Read specs: \`.spec-context/specs/{spec-name}/*.md\` (if returning to work)
- Edit tasks.md to update status:
  - \`- [ ]\` = Pending task
  - \`- [-]\` = In-progress task
  - \`- [x]\` = Completed task

**Tools**:
- spec-status: Check overall progress
- Direct editing: Mark tasks as in-progress [-] or complete [x] in tasks.md

**Process**:
1. Check current status with spec-status
2. Read \`tasks.md\` to see all tasks
3. For each task:
   - Edit tasks.md: Change \`[ ]\` to \`[-]\` for the task you're starting
   - **Read the _Prompt field** for guidance on role, approach, and success criteria
   - Follow _Leverage fields to use existing code/utilities
   - Implement the code according to the task description
   - Test your implementation
   - Edit tasks.md: Change \`[-]\` to \`[x]\` when completed
4. Continue until all tasks show \`[x]\`

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

## File Structure
\`\`\`
.spec-context/
├── templates/           # Auto-populated on server start
│   ├── requirements-template.md
│   ├── design-template.md
│   ├── tasks-template.md
│   ├── product-template.md
│   ├── tech-template.md
│   └── structure-template.md
├── specs/
│   └── {spec-name}/
│       ├── requirements.md
│       ├── design.md
│       └── tasks.md
└── steering/
    ├── product.md
    ├── tech.md
    └── structure.md
\`\`\``;
}