import { OpenRouterChat } from '../../core/llm/index.js';

/**
 * AI suggestion for document review.
 */
export interface AiSuggestion {
    quote?: string;  // Exact text from document (optional for general comments)
    comment: string; // The feedback/suggestion
}

/**
 * Available models for AI review.
 * DeepSeek V3.2 supports reasoning toggle via provider options.
 */
export const AI_REVIEW_MODELS = {
    'deepseek-v3': { model: 'deepseek/deepseek-v3.2', reasoning: false },
    'deepseek-v3-reasoning': { model: 'deepseek/deepseek-v3.2', reasoning: true },
    'gemini-flash': { model: 'google/gemini-2.5-flash', reasoning: false },
} as const;

export type AiReviewModel = keyof typeof AI_REVIEW_MODELS;

/**
 * System prompt for document review.
 */
const REVIEW_SYSTEM_PROMPT = `You are an expert document reviewer for a spec-driven development workflow. Your task is to review specification documents and provide constructive feedback.

Documents you'll review:
- Requirements: define what to build based on user needs
- Design: technical design addressing all requirements
- Tasks: atomic implementation tasks derived from design

For each issue you find:
1. Quote the EXACT text from the document that relates to your feedback (if applicable)
2. Provide a clear, actionable comment

Focus on:
- Misalignment with project goals or tech stack (if context provided)
- Consistency with previous spec documents (requirements when reviewing design, requirements+design when reviewing tasks)
- Ambiguous statements (could be interpreted multiple ways)
- What's unclear or missing?

Do NOT suggest adding documentation, tests, or things outside the document's purpose.

Keep each comment to 1-3 sentences. Be specific and actionable.

Respond with valid JSON only, in this exact format:
{
  "suggestions": [
    {
      "quote": "exact text from document",
      "comment": "your feedback about this text"
    },
    {
      "comment": "general feedback not tied to specific text"
    }
  ]
}

Be selective - only include suggestions that would significantly improve the document.`;

/**
 * Steering documents for project context.
 */
export interface SteeringContext {
    product?: string;   // Product vision and goals
    tech?: string;      // Tech stack and architecture
    structure?: string; // Codebase structure
}

/**
 * Previous spec documents for context when reviewing design/tasks.
 */
export interface SpecDocsContext {
    requirements?: string; // Requirements doc (when reviewing design or tasks)
    design?: string;       // Design doc (when reviewing tasks)
}

/**
 * Service for AI-powered document review.
 */
export class AiReviewService {
    private chat: OpenRouterChat;

    constructor(apiKey: string) {
        this.chat = new OpenRouterChat({
            apiKey,
            timeout: 60000, // 60 second timeout
        });
    }

    /**
     * Review a document and return suggestions.
     */
    async reviewDocument(
        content: string,
        model: AiReviewModel = 'deepseek-v3',
        steeringContext?: SteeringContext,
        specDocsContext?: SpecDocsContext
    ): Promise<AiSuggestion[]> {
        const modelConfig = AI_REVIEW_MODELS[model];

        // Build context section from steering docs
        let contextSection = '';
        if (steeringContext) {
            const parts: string[] = [];
            if (steeringContext.product) {
                parts.push(`## Product Vision\n${steeringContext.product}`);
            }
            if (steeringContext.tech) {
                parts.push(`## Tech Stack\n${steeringContext.tech}`);
            }
            if (steeringContext.structure) {
                parts.push(`## Codebase Structure\n${steeringContext.structure}`);
            }
            if (parts.length > 0) {
                contextSection = `\n\n# PROJECT CONTEXT\nUse this context to evaluate if the spec aligns with project goals and architecture:\n\n${parts.join('\n\n')}\n\n---\n`;
            }
        }

        // Build previous spec docs section
        let specDocsSection = '';
        if (specDocsContext) {
            const parts: string[] = [];
            if (specDocsContext.requirements) {
                parts.push(`## Requirements Document\nThe document being reviewed should align with these requirements:\n\n${specDocsContext.requirements}`);
            }
            if (specDocsContext.design) {
                parts.push(`## Design Document\nThe document being reviewed should implement this design:\n\n${specDocsContext.design}`);
            }
            if (parts.length > 0) {
                specDocsSection = `\n\n# PREVIOUS SPEC DOCUMENTS\nUse these as reference - the document being reviewed should be consistent with and build upon them:\n\n${parts.join('\n\n')}\n\n---\n`;
            }
        }

        const userPrompt = `Please review this document and provide feedback:${contextSection}${specDocsSection}

# DOCUMENT TO REVIEW
---
${content}
---

Respond with JSON containing your suggestions.`;

        try {
            const response = await this.chat.chatWithModel(
                modelConfig.model,
                [
                    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
                    { role: 'user', content: userPrompt },
                ],
                {
                    temperature: 0.3, // Lower temperature for more consistent output
                    maxTokens: 4096,
                    jsonMode: true,
                    providerOptions: modelConfig.reasoning ? { reasoning: true } : undefined,
                }
            );

            return this.parseResponse(response.content);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`AI review failed: ${message}`);
        }
    }

    /**
     * Parse AI response into suggestions array.
     */
    private parseResponse(content: string): AiSuggestion[] {
        try {
            const parsed = JSON.parse(content);

            if (!parsed.suggestions || !Array.isArray(parsed.suggestions)) {
                console.warn('AI response missing suggestions array, returning empty');
                return [];
            }

            // Validate and clean suggestions
            return parsed.suggestions
                .filter((s: unknown): s is { quote?: string; comment?: string } => {
                    return typeof s === 'object' && s !== null && 'comment' in s;
                })
                .map((s: { quote?: string; comment: string }) => ({
                    quote: typeof s.quote === 'string' && s.quote.trim() ? s.quote.trim() : undefined,
                    comment: String(s.comment).trim(),
                }))
                .filter((s: AiSuggestion) => s.comment.length > 0);
        } catch (parseError) {
            console.error('Failed to parse AI response:', parseError);
            console.error('Raw response:', content);

            // Try to extract any useful content as a single general comment
            if (content && content.trim()) {
                return [{
                    comment: 'AI review completed but response format was unexpected. Please try again.',
                }];
            }

            return [];
        }
    }
}
