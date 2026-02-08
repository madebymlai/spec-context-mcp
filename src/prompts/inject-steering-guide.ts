import { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';
import { PromptDefinition } from './types.js';
import { ToolContext } from '../workflow-types.js';
import { steeringGuideHandler } from '../tools/workflow/steering-guide.js';

const prompt: Prompt = {
  name: 'inject-steering-guide',
  title: 'Inject Steering Guide into Context',
  description: 'Load steering guide, create architecture docs, setup project docs, document project vision. Use when user wants to create steering documents, document architecture, or says "create steering docs", "setup project architecture", "load steering guide".'
};

async function handler(args: Record<string, any>, context: ToolContext): Promise<PromptMessage[]> {
  // Call the steering-guide tool to get the full guide
  const toolResponse = await steeringGuideHandler({}, context);
  
  // Extract the guide content from the tool response
  const guide = toolResponse.data?.guide || '';
  const templates = toolResponse.data?.templates || {};
  const dashboardUrl = toolResponse.data?.dashboardUrl;
  const nextSteps = toolResponse.nextSteps || [];
  const injectedTemplates = ['product', 'tech', 'structure', 'principles']
    .map((key) => {
      const template = templates[key];
      if (!template || typeof template.content !== 'string') {
        return null;
      }
      return [
        `### ${key}-template.md`,
        `Source: ${template.source ?? 'unknown'}`,
        `Path: ${template.path ?? 'unknown'}`,
        '```markdown',
        template.content,
        '```',
      ].join('\n');
    })
    .filter((section): section is string => section !== null)
    .join('\n\n');

  const messages: PromptMessage[] = [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Please review and follow this steering document workflow guide:

${guide}

**Current Context:**
- Project: ${context.projectPath}
${dashboardUrl ? `- Dashboard: ${dashboardUrl}` : '- Dashboard: Please start the dashboard or use VS Code extension "Spec Context MCP"'}

**Next Steps:**
${nextSteps.map(step => `- ${step}`).join('\n')}

**Injected Steering Templates (use these directly; do not re-read template files from disk):**
${injectedTemplates || '_No templates were resolved by the server_'}

**Important Instructions:**
1. This guide has been injected into your context for creating steering documents
2. Only proceed if the user explicitly requested steering document creation
3. Follow the sequence exactly: product.md → tech.md → structure.md → principles.md
4. Use injected template content above as the canonical template source
5. Create documents in .spec-context/steering/ directory
6. Request approval after each document using the approvals tool
7. Never proceed to the next document without successful approval cleanup

**Note:** Steering documents are NOT part of the standard spec workflow. They are project-level guidance documents that should only be created when explicitly requested by the user. These documents establish vision, architecture, and conventions for established codebases.

Please acknowledge that you've reviewed this steering workflow guide and confirm whether the user wants to create steering documents.`
      }
    }
  ];

  return messages;
}

export const injectSteeringGuidePrompt: PromptDefinition = {
  prompt,
  handler,
};
