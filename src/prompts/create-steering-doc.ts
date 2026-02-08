import { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';
import { PromptDefinition } from './types.js';
import { ToolContext, requireFileContentCache } from '../workflow-types.js';
import { getSteeringTemplates, type SteeringTemplateType } from '../tools/workflow/template-loader.js';

const prompt: Prompt = {
  name: 'create-steering-doc',
  title: 'Create Steering Document',
  description: 'Create product doc, tech doc, structure doc, principles doc, project architecture, project vision. Use when user wants to create steering documents, document project architecture, or says "create product doc", "write tech doc", "document project structure".',
  arguments: [
    {
      name: 'docType',
      description: 'Type of steering document: product, tech, structure, or principles',
      required: true
    },
    {
      name: 'scope',
      description: 'Scope of the steering document (e.g., frontend, backend, full-stack)',
      required: false
    }
  ]
};

async function handler(args: Record<string, any>, context: ToolContext): Promise<PromptMessage[]> {
  const docTypeRaw = String(args.docType ?? '');
  const scope = args.scope;
  
  if (!docTypeRaw) {
    throw new Error('docType is a required argument');
  }

  const validDocTypes: SteeringTemplateType[] = ['product', 'tech', 'structure', 'principles'];
  if (!validDocTypes.includes(docTypeRaw as SteeringTemplateType)) {
    throw new Error(`docType must be one of: ${validDocTypes.join(', ')}`);
  }
  const typedDocType = docTypeRaw as SteeringTemplateType;
  const fileContentCache = requireFileContentCache(context);
  const templates = await getSteeringTemplates([typedDocType], fileContentCache);
  const resolvedTemplate = templates[typedDocType];
  if (!resolvedTemplate) {
    throw new Error(`Missing bundled template for ${typedDocType}`);
  }
  const templateBlock = `\n\n**Injected Template (${typedDocType}-template.md):**
Source: ${resolvedTemplate.source}
Path: ${resolvedTemplate.path}
\`\`\`markdown
${resolvedTemplate.content}
\`\`\``;

  const messages: PromptMessage[] = [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Create a ${typedDocType} steering document for the project.

**Context:**
- Project: ${context.projectPath}
- Steering document type: ${typedDocType}
${scope ? `- Scope: ${scope}` : ''}
${context.dashboardUrl ? `- Dashboard: ${context.dashboardUrl}` : ''}

**Instructions:**
1. First, check if codebase is indexed with \`get_indexing_status\`, run \`index_codebase\` if needed
2. Use the \`search_code\` tool to understand the codebase structure before documenting
3. Use the injected template content below (server-provided canonical template)
4. Do not search for or read local template files unless explicitly instructed by the user
5. Check if steering docs exist at: .spec-context/steering/
6. Create comprehensive content following the template structure
7. Create the document at: .spec-context/steering/${typedDocType}.md
8. After creating, use approvals tool with action:'request' to get user approval

**File Paths:**
- Injected template: ${resolvedTemplate.path}
- Document destination: .spec-context/steering/${typedDocType}.md

**Steering Document Types:**
- **product**: Defines project vision, goals, and user outcomes
- **tech**: Documents technology decisions and architecture patterns
- **structure**: Maps codebase organization and conventions
- **principles**: Defines coding standards and architecture guardrails

**Key Principles:**
- Be specific and actionable
- Include examples where helpful
- Consider both technical and business requirements
- Provide clear guidance for future development
- Templates are server-bundled and injected directly by the tool

Please read the ${typedDocType} template and create a comprehensive steering document at the specified path.${templateBlock}`
      }
    }
  ];

  return messages;
}

export const createSteeringDocPrompt: PromptDefinition = {
  prompt,
  handler,
};
