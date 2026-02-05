/**
 * get-brainstorm-guide MCP tool
 * Returns brainstorming methodology for pre-spec ideation
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolContext, ToolResponse } from '../../workflow-types.js';

export const getBrainstormGuideTool: Tool = {
  name: 'get-brainstorm-guide',
  description: `Get brainstorming methodology for pre-spec ideation. Use when exploring ideas before formal spec creation.

Returns brainstorming process:
- Question-driven exploration
- Multiple choice preference
- Present 2-3 options with trade-offs
- When to proceed to formal spec

Does NOT include steering docs (orchestrator already has context).`,
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  }
};

export async function getBrainstormGuideHandler(
  _args: unknown,
  _context: ToolContext
): Promise<ToolResponse> {
  const guide = buildBrainstormGuide();

  return {
    success: true,
    message: 'Brainstorm guide loaded',
    data: {
      guide,
    },
    nextSteps: [
      'Ask questions one at a time to understand the idea',
      'Propose 2-3 approaches with trade-offs',
      'Present design in small sections for validation',
      'When design is clear, proceed to formal spec creation'
    ]
  };
}

function buildBrainstormGuide(): string {
  return `# Brainstorming Guide

Turn rough ideas into fully formed designs through natural collaborative dialogue.

**Core approach:** Start by understanding the current project context, then ask questions one at a time to refine the idea. Once you understand what you're building, present the design in small sections (200-300 words), checking after each section whether it looks right so far.

## The Process

### Phase 1: Understanding the Idea

**Check context first:**
- Review current project state (files, docs, recent commits)
- Understand what already exists
- Look for related functionality or patterns

**Ask questions one at a time:**
- One question per message - don't overwhelm
- If a topic needs more exploration, break into multiple questions
- Focus on: purpose, constraints, success criteria

**Prefer multiple choice when possible:**
- Easier to answer than open-ended
- Example: "Which approach? A) Simple now, extend later B) Flexible from start C) Minimal viable"
- Open-ended is fine when choices aren't clear

### Phase 2: Exploring Approaches

**Propose 2-3 options with trade-offs:**
- Present options conversationally with your recommendation
- Lead with your recommended option and explain why

**Format:**
\`\`\`
**Option A (Recommended):** [Brief description]
- Pros: [Benefits]
- Cons: [Drawbacks]
- Best when: [Use case]

**Option B:** [Brief description]
- Pros: [Benefits]
- Cons: [Drawbacks]
- Best when: [Use case]
\`\`\`

**Let user decide:**
- Don't push your recommendation too hard
- Be ready to explore hybrid approaches

### Phase 3: Presenting the Design

**Break into sections:**
- 200-300 words per section
- Cover: architecture, components, data flow, error handling, testing

**Validate incrementally:**
- After each section: "Does this look right so far?"
- Be ready to go back and clarify if something doesn't make sense

**YAGNI ruthlessly:**
- Remove unnecessary features from all designs
- Start simple, add complexity only when needed
- Question every "nice to have"

## After the Design

**Documentation:**
- Write the validated design to a design document (e.g., \`docs/plans/YYYY-MM-DD-<topic>-design.md\`)
- Commit the design document to git
- Include: problem statement, chosen approach, key decisions, trade-offs accepted

**Transition to implementation:**
- Ask: "Ready to create the formal spec?"
- If continuing to spec: proceed to spec-workflow-guide
- Summarize the agreed approach before transitioning

## Key Principles

| Principle                       | What It Means                                        |
|---------------------------------|------------------------------------------------------|
| **One question at a time**      | Don't overwhelm with multiple questions              |
| **Multiple choice preferred**   | Easier to answer than open-ended when possible       |
| **YAGNI ruthlessly**            | Remove unnecessary features from all designs         |
| **Explore alternatives**        | Always propose 2-3 approaches before settling        |
| **Incremental validation**      | Present design in sections, validate each            |
| **Be flexible**                 | Go back and clarify when something doesn't make sense |

## Signs to Proceed to Formal Spec

Ready to proceed when:
- Core requirements are clear
- Approach has been selected from options
- Major trade-offs are understood and accepted
- Scope is well-defined
- User is confident in direction

## Signs to Keep Brainstorming

Keep exploring when:
- User seems uncertain about direction
- Requirements keep changing during discussion
- Trade-offs aren't understood
- Scope is unclear or expanding
- Multiple conflicting goals exist
- "I don't know" appears frequently
`;
}
