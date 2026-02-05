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

## Purpose

Turn rough ideas into fully formed designs through collaborative dialogue.
Use this before starting formal spec creation when the idea needs refinement.

## The Process

### Phase 1: Understanding the Idea

1. **Check Context First**
   - Review current project state
   - Look at relevant files and recent changes
   - Understand what already exists

2. **Ask Questions One at a Time**
   - One question per message
   - If a topic needs more exploration, break into multiple questions
   - Focus on: purpose, constraints, success criteria

3. **Prefer Multiple Choice**
   - Easier to answer than open-ended
   - Example: "Which approach? A) Simple now, extend later B) Flexible from start C) Minimal viable"
   - Open-ended is fine when choices aren't clear

### Phase 2: Exploring Approaches

1. **Propose 2-3 Options**
   - Each with clear trade-offs
   - Lead with your recommendation and why

2. **Format for Options**
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

3. **Let User Decide**
   - Don't push your recommendation too hard
   - Be ready to explore hybrid approaches

### Phase 3: Presenting the Design

1. **Break Into Sections**
   - 200-300 words per section
   - Cover: architecture, components, data flow, error handling

2. **Validate Incrementally**
   - After each section: "Does this look right so far?"
   - Be ready to go back and clarify

3. **YAGNI Ruthlessly**
   - Remove unnecessary features
   - Start simple, add complexity only when needed

### Phase 4: Transition to Spec

When design is clear:
- Summarize the agreed approach
- Ask: "Ready to create the formal spec?"
- If yes, proceed to spec-workflow-guide

## Key Principles

| Principle | What It Means |
|-----------|---------------|
| **One question at a time** | Don't overwhelm with multiple questions |
| **Multiple choice preferred** | Easier to answer than open-ended |
| **YAGNI ruthlessly** | Remove unnecessary features |
| **Explore alternatives** | Always 2-3 approaches before settling |
| **Incremental validation** | Present in sections, validate each |
| **Be flexible** | Go back when something doesn't fit |

## Signs to Proceed to Formal Spec

- Core requirements are clear
- Approach has been selected
- Major trade-offs are understood
- Scope is well-defined
- User is confident in direction

## Signs to Keep Brainstorming

- User seems uncertain
- Requirements keep changing
- Trade-offs aren't understood
- Scope is unclear
- Multiple conflicting goals
`;
}
