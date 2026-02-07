import { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';
import { PromptDefinition } from './types.js';
import { ToolContext, requireFileContentCache } from '../workflow-types.js';
import { getSpecTemplates, type SpecTemplateType } from '../tools/workflow/template-loader.js';

const prompt: Prompt = {
  name: 'create-spec',
  title: 'Create Specification Document',
  description: 'Create a spec, write requirements, write design doc, create tasks document, start new feature. Use when user wants to create a new specification, write requirements, design a feature, or says "create spec for X", "write requirements for", "design document for".',
  arguments: [
    {
      name: 'specName',
      description: 'Feature name in kebab-case (e.g., user-authentication, data-export)',
      required: true
    },
    {
      name: 'documentType',
      description: 'Type of document to create: requirements, design, or tasks',
      required: true
    },
    {
      name: 'description',
      description: 'Brief description of what this spec should accomplish',
      required: false
    }
  ]
};

async function handler(args: Record<string, any>, context: ToolContext): Promise<PromptMessage[]> {
  const { specName, description } = args;
  const documentTypeRaw = String(args.documentType ?? '');

  if (!specName || !documentTypeRaw) {
    throw new Error('specName and documentType are required arguments');
  }

  const validDocTypes: SpecTemplateType[] = ['requirements', 'design', 'tasks'];
  if (!validDocTypes.includes(documentTypeRaw as SpecTemplateType)) {
    throw new Error(`documentType must be one of: ${validDocTypes.join(', ')}`);
  }
  const documentType = documentTypeRaw as SpecTemplateType;
  const fileContentCache = requireFileContentCache(context);
  const templates = await getSpecTemplates([documentType], fileContentCache);
  const resolvedTemplate = templates[documentType];
  if (!resolvedTemplate) {
    throw new Error(`Missing bundled template for ${documentType}`);
  }
  const templateBlock = `\n\n**Injected Template (${documentType}-template.md):**
Source: ${resolvedTemplate.source}
Path: ${resolvedTemplate.path}
\`\`\`markdown
${resolvedTemplate.content}
\`\`\``;

  // Build context-aware messages
  const messages: PromptMessage[] = [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Create a ${documentType} document for the "${specName}" feature using the spec-workflow methodology.

**Context:**
- Project: ${context.projectPath}
- Feature: ${specName}
- Document type: ${documentType}
${description ? `- Description: ${description}` : ''}
${context.dashboardUrl ? `- Dashboard: ${context.dashboardUrl}` : ''}

**Instructions:**
1. Use the \`search\` tool to discover existing code patterns to leverage
   - search type="semantic" query="..." for conceptual searches
   - search type="regex" query="..." for exact patterns
   - The codebase auto-indexes on first search and auto-syncs with file watching
2. Use the injected template content below (server-provided canonical template)
3. Do not search for or read local template files unless explicitly instructed by the user
4. Follow the template structure exactly - this ensures consistency across the project
5. Create comprehensive content that follows spec-driven development best practices
6. Include all required sections from the template
7. Use clear, actionable language
8. Create the document at: .spec-context/specs/${specName}/${documentType}.md
9. After creating, use approvals tool with action:'request' to get user approval

**File Paths:**
- Document destination: .spec-context/specs/${specName}/${documentType}.md

**Workflow Guidelines:**
- Requirements documents define WHAT needs to be built
- Design documents define HOW it will be built
- Tasks documents break down implementation into actionable steps
- Each document builds upon the previous one in sequence
- Templates are server-bundled and injected directly by the tool

${documentType === 'tasks' ? `
**Special Instructions for Tasks Document:**
- For each task, generate a _Prompt field with structured AI guidance
- Format: _Prompt: Role: [role] | Task: [description] | Restrictions: [constraints] | Success: [criteria]
- Make prompts specific to the project context and requirements
- Use the \`search\` tool to populate _Leverage fields with actual file paths
- Include _Requirements fields showing which requirements each task implements
- Tasks should be atomic (1-3 files each) and in logical order
` : ''}

Please read the ${documentType} template and create the comprehensive document at the specified path.${templateBlock}`
      }
    }
  ];

  return messages;
}

export const createSpecPrompt: PromptDefinition = {
  prompt,
  handler,
};
