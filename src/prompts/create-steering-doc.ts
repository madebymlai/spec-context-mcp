import { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';
import { PromptDefinition } from './types.js';
import { ToolContext } from '../workflow-types.js';

const prompt: Prompt = {
  name: 'create-steering-doc',
  title: 'Create Steering Document',
  description: 'Create product doc, tech doc, structure doc, project architecture, project vision. Use when user wants to create steering documents, document project architecture, or says "create product doc", "write tech doc", "document project structure".',
  arguments: [
    {
      name: 'docType',
      description: 'Type of steering document: product, tech, or structure',
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
  const { docType, scope } = args;
  
  if (!docType) {
    throw new Error('docType is a required argument');
  }

  const validDocTypes = ['product', 'tech', 'structure'];
  if (!validDocTypes.includes(docType)) {
    throw new Error(`docType must be one of: ${validDocTypes.join(', ')}`);
  }

  const messages: PromptMessage[] = [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Create a ${docType} steering document for the project.

**Context:**
- Project: ${context.projectPath}
- Steering document type: ${docType}
${scope ? `- Scope: ${scope}` : ''}
${context.dashboardUrl ? `- Dashboard: ${context.dashboardUrl}` : ''}

**Instructions:**
1. First, check if codebase is indexed with \`get_indexing_status\`, run \`index_codebase\` if needed
2. Use the \`search_code\` tool to understand the codebase structure before documenting
3. Read the template at: .spec-context/templates/${docType}-template.md
4. Check if steering docs exist at: .spec-context/steering/
5. Create comprehensive content following the template structure
6. Create the document at: .spec-context/steering/${docType}.md
7. After creating, use approvals tool with action:'request' to get user approval

**File Paths:**
- Template location: .spec-context/templates/${docType}-template.md
- Document destination: .spec-context/steering/${docType}.md

**Steering Document Types:**
- **product**: Defines project vision, goals, and user outcomes
- **tech**: Documents technology decisions and architecture patterns
- **structure**: Maps codebase organization and conventions

**Key Principles:**
- Be specific and actionable
- Include examples where helpful
- Consider both technical and business requirements
- Provide clear guidance for future development
- Templates are automatically updated on server start

Please read the ${docType} template and create a comprehensive steering document at the specified path.`
      }
    }
  ];

  return messages;
}

export const createSteeringDocPrompt: PromptDefinition = {
  prompt,
  handler,
  _metadata: {
    preferredModel: 'sonnet'  // Template-based creation
  }
};