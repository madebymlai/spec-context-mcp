import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolContext, ToolResponse, requireFileContentCache } from '../../workflow-types.js';
import { getSteeringTemplates, STEERING_WORKFLOW_TEMPLATES } from './template-loader.js';

export const steeringGuideTool: Tool = {
  name: 'steering-guide',
  description: `Create steering docs, setup project architecture, define product vision, document tech stack, codebase structure, coding principles. Use when user asks to create steering documents, setup project architecture docs, or says "create steering docs", "setup project docs", "document architecture".

# Instructions
Call ONLY when user explicitly requests steering document creation or asks about project architecture docs. Not part of standard spec workflow. Provides templates and guidance for product.md, tech.md, structure.md, and principles.md creation. Its important that you follow this workflow exactly to avoid errors.`,
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  }
};

export async function steeringGuideHandler(args: any, context: ToolContext): Promise<ToolResponse> {
  const fileContentCache = requireFileContentCache(context);
  const templates = await getSteeringTemplates(STEERING_WORKFLOW_TEMPLATES, fileContentCache);

  return {
    success: true,
    message: 'Steering workflow guide loaded - follow this workflow exactly to avoid errors',
    data: {
      guide: getSteeringGuide(),
      templates,
      dashboardUrl: context.dashboardUrl
    },
    nextSteps: [
      'Only proceed if user requested steering docs',
      'Create product.md first',
      'Then tech.md, structure.md, and principles.md',
      'Reference in future specs',
      context.dashboardUrl ? `Dashboard: ${context.dashboardUrl}` : 'Start the dashboard with: spec-context-dashboard'
    ]
  };
}

function getSteeringGuide(): string {
  return `# Steering Workflow

## Overview

Create project-level guidance documents when explicitly requested. Steering docs establish vision, architecture, and conventions for established codebases. Its important that you follow this workflow exactly to avoid errors.

## Workflow Diagram

\`\`\`mermaid
flowchart TD
    Start([Start: Setup steering docs]) --> Guide[steering-guide<br/>Load workflow instructions]

    %% Phase 1: Product
    Guide --> P1_Template[Use injected server template:<br/>product-template.md]
    P1_Template --> P1_Generate[Generate vision & goals]
    P1_Generate --> P1_Create[Create file:<br/>.spec-context/steering/<br/>product.md]
    P1_Create --> P1_Approve[approvals<br/>action: request<br/>filePath only]
    P1_Approve --> P1_Status[approvals<br/>action: status<br/>poll status]
    P1_Status --> P1_Check{Status?}
    P1_Check -->|needs-revision| P1_Update[Update document using user comments for guidance]
    P1_Update --> P1_Create
    P1_Check -->|approved| P1_Clean[approvals<br/>action: delete]
    P1_Clean -->|failed| P1_Status

    %% Phase 2: Tech
    P1_Clean -->|success| P2_Template[Use injected server template:<br/>tech-template.md]
    P2_Template --> P2_Analyze[Analyze tech stack]
    P2_Analyze --> P2_Create[Create file:<br/>.spec-context/steering/<br/>tech.md]
    P2_Create --> P2_Approve[approvals<br/>action: request<br/>filePath only]
    P2_Approve --> P2_Status[approvals<br/>action: status<br/>poll status]
    P2_Status --> P2_Check{Status?}
    P2_Check -->|needs-revision| P2_Update[Update document using user comments for guidance]
    P2_Update --> P2_Create
    P2_Check -->|approved| P2_Clean[approvals<br/>action: delete]
    P2_Clean -->|failed| P2_Status

    %% Phase 3: Structure
    P2_Clean -->|success| P3_Template[Use injected server template:<br/>structure-template.md]
    P3_Template --> P3_Analyze[Analyze codebase structure]
    P3_Analyze --> P3_Create[Create file:<br/>.spec-context/steering/<br/>structure.md]
    P3_Create --> P3_Approve[approvals<br/>action: request<br/>filePath only]
    P3_Approve --> P3_Status[approvals<br/>action: status<br/>poll status]
    P3_Status --> P3_Check{Status?}
    P3_Check -->|needs-revision| P3_Update[Update document using user comments for guidance]
    P3_Update --> P3_Create
    P3_Check -->|approved| P3_Clean[approvals<br/>action: delete]
    P3_Clean -->|failed| P3_Status

    %% Phase 4: Principles
    P3_Clean -->|success| P4_Template[Use injected server template:<br/>principles-template.md]
    P4_Template --> P4_Generate[Generate coding principles]
    P4_Generate --> P4_Create[Create file:<br/>.spec-context/steering/<br/>principles.md]
    P4_Create --> P4_Approve[approvals<br/>action: request<br/>filePath only]
    P4_Approve --> P4_Status[approvals<br/>action: status<br/>poll status]
    P4_Status --> P4_Check{Status?}
    P4_Check -->|needs-revision| P4_Update[Update document using user comments for guidance]
    P4_Update --> P4_Create
    P4_Check -->|approved| P4_Clean[approvals<br/>action: delete]
    P4_Clean -->|failed| P4_Status

    P4_Clean -->|success| Complete([Steering docs complete])

    style Start fill:#e6f3ff
    style Complete fill:#e6f3ff
    style P1_Check fill:#ffe6e6
    style P2_Check fill:#ffe6e6
    style P3_Check fill:#ffe6e6
    style P4_Check fill:#ffe6e6
\`\`\`

## Steering Workflow Phases

### Phase 1: Product Document
**Purpose**: Define vision, goals, and user outcomes.

**File Operations**:
- Use injected template payload from this tool response first: \`data.templates.product\`
- Use server template: \`product-template.md\` from injected payload
- Create document: \`.spec-context/steering/product.md\`

**Tools**:
- steering-guide: Load workflow instructions
- approvals: Manage approval workflow (actions: request, status, delete)

**Process**:
1. Load steering guide for workflow overview
2. Use \`data.templates.product.content\` from this tool response when available (includes resolved source + path)
3. If \`data.templates.product\` is missing, stop and ask user to retry tool loading (no local template fallback)
4. Generate product vision and goals
5. Create \`product.md\` at \`.spec-context/steering/product.md\`
6. Request approval using approvals tool with action:'request' (filePath only)
7. Poll status using approvals with action:'status' until approved/needs-revision (NEVER accept verbal approval)
8. If needs-revision: update document using comments, create NEW approval, do NOT proceed
9. Once approved: use approvals with action:'delete' (must succeed) before proceeding
10. If delete fails: STOP - return to polling

### Phase 2: Tech Document
**Purpose**: Document technology decisions and architecture.

**File Operations**:
- Use injected template payload from this tool response first: \`data.templates.tech\`
- Use server template: \`tech-template.md\` from injected payload
- Create document: \`.spec-context/steering/tech.md\`

**Tools**:
- approvals: Manage approval workflow (actions: request, status, delete)

**Process**:
1. Use \`data.templates.tech.content\` from this tool response when available (includes resolved source + path)
2. If \`data.templates.tech\` is missing, stop and ask user to retry tool loading (no local template fallback)
3. Analyze existing technology stack
4. Document architectural decisions and patterns
5. Create \`tech.md\` at \`.spec-context/steering/tech.md\`
6. Request approval using approvals tool with action:'request'
7. Poll status using approvals with action:'status' until approved/needs-revision
8. If needs-revision: update document using comments, create NEW approval, do NOT proceed
9. Once approved: use approvals with action:'delete' (must succeed) before proceeding
10. If delete fails: STOP - return to polling

### Phase 3: Structure Document
**Purpose**: Map codebase organization and patterns.

**File Operations**:
- Use injected template payload from this tool response first: \`data.templates.structure\`
- Use server template: \`structure-template.md\` from injected payload
- Create document: \`.spec-context/steering/structure.md\`

**Tools**:
- approvals: Manage approval workflow (actions: request, status, delete)

**Process**:
1. Use \`data.templates.structure.content\` from this tool response when available (includes resolved source + path)
2. If \`data.templates.structure\` is missing, stop and ask user to retry tool loading (no local template fallback)
3. Analyze directory structure and file organization
4. Document coding patterns and conventions
5. Create \`structure.md\` at \`.spec-context/steering/structure.md\`
6. Request approval using approvals tool with action:'request'
7. Poll status using approvals with action:'status' until approved/needs-revision
8. If needs-revision: update document using comments, create NEW approval, do NOT proceed
9. Once approved: use approvals with action:'delete' (must succeed) before proceeding
10. If delete fails: STOP - return to polling

### Phase 4: Principles Document
**Purpose**: Define coding standards and principles.

**File Operations**:
- Use injected template payload from this tool response first: \`data.templates.principles\`
- Use server template: \`principles-template.md\` from injected payload
- Create document: \`.spec-context/steering/principles.md\`

**Tools**:
- approvals: Manage approval workflow (actions: request, status, delete)

**Process**:
1. Use \`data.templates.principles.content\` from this tool response when available (includes resolved source + path)
2. If \`data.templates.principles\` is missing, stop and ask user to retry tool loading (no local template fallback)
3. Document SOLID principles with "Ask yourself" questions
4. Document architecture rules and design patterns
5. Define quality gates and review checklist
6. Create \`principles.md\` at \`.spec-context/steering/principles.md\`
7. Request approval using approvals tool with action:'request'
8. Poll status using approvals with action:'status' until approved/needs-revision
9. If needs-revision: update document using comments, create NEW approval, do NOT proceed
10. Once approved: use approvals with action:'delete' (must succeed) before completing
11. If delete fails: STOP - return to polling
12. After successful cleanup: "Steering docs complete. Ready for spec creation?"

## Workflow Rules

- Create documents directly at specified file paths
- Use injected template payloads in \`data.templates\` as canonical source
- Follow exact template structures
- Get explicit user approval between phases (using approvals tool with action:'request')
- Complete phases in sequence (no skipping)
- Approval requests: provide filePath only, never content
- BLOCKING: Never proceed if approval delete fails
- CRITICAL: Must have approved status AND successful cleanup before next phase
- CRITICAL: Verbal approval is NEVER accepted - dashboard or VS Code extension only
- NEVER proceed on user saying "approved" - check system status only

## File Structure
\`\`\`
.spec-context/
├── templates/           # Auto-populated on server start
│   ├── product-template.md
│   ├── tech-template.md
│   ├── structure-template.md
│   └── principles-template.md
└── steering/
    ├── product.md
    ├── tech.md
    ├── structure.md
    └── principles.md
\`\`\``;
}
