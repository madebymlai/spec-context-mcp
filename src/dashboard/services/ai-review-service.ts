import { createHash, randomUUID } from 'crypto';
import {
    filterBudgetCandidates,
    BudgetExceededError,
    createRuntimeTelemetryMeter,
    redactionInterceptor,
} from '../../core/llm/index.js';
import type {
    IBudgetGuard,
    IRuntimeTelemetryMeter,
    BudgetCandidate,
    BudgetDecision,
    BudgetPolicy,
    ChatMessage,
    ChatInterceptor,
    ChatOptions,
    ChatProvider,
    ChatResponse,
    StateSnapshotFact,
} from '../../core/llm/index.js';

/**
 * AI suggestion for document review.
 */
export interface AiSuggestion {
    quote?: string;
    comment: string;
}

export interface AiReviewModelConfig {
    model: string;
    reasoning: boolean;
    estimatedInputCostUsdPer1k: number;
    estimatedOutputCostUsdPer1k: number;
    tags: string[];
}

/**
 * Available models for AI review.
 * DeepSeek V3.2 supports reasoning toggle via provider options.
 */
export const AI_REVIEW_MODELS = {
    'deepseek-v3': {
        model: 'deepseek/deepseek-v3.2',
        reasoning: false,
        estimatedInputCostUsdPer1k: 0.0008,
        estimatedOutputCostUsdPer1k: 0.0016,
        tags: ['balanced', 'default'],
    },
    'deepseek-v3-reasoning': {
        model: 'deepseek/deepseek-v3.2',
        reasoning: true,
        estimatedInputCostUsdPer1k: 0.0008,
        estimatedOutputCostUsdPer1k: 0.0016,
        tags: ['quality', 'reasoning'],
    },
    'gemini-flash': {
        model: 'google/gemini-2.5-flash',
        reasoning: false,
        estimatedInputCostUsdPer1k: 0.0003,
        estimatedOutputCostUsdPer1k: 0.0006,
        tags: ['fast', 'budget', 'emergency'],
    },
} as const satisfies Record<string, AiReviewModelConfig>;

export type AiReviewModel = keyof typeof AI_REVIEW_MODELS;

export interface AiReviewRuntimeOptions {
    runId?: string;
    interactive?: boolean;
    maxInputChars?: number;
    maxOutputTokens?: number;
}

export interface AiReviewResult {
    suggestions: AiSuggestion[];
    modelUsed: string;
    budgetDecision: BudgetDecision;
    snapshotRevision: number;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    contextStats: {
        includedSections: number;
        unchangedSections: number;
        inputChars: number;
    };
}

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

const REVIEW_USER_PREFIX = 'Please review this document and provide feedback:';
const REVIEW_USER_SUFFIX = 'Respond with JSON containing your suggestions.';
const MAX_SCHEMA_RETRIES = 2;
const SCHEMA_RETRY_PROMPT = 'Your previous reply did not match the required JSON schema. Return only valid JSON with top-level {"suggestions":[{"quote?":"...","comment":"..."}]} and no extra text.';

/**
 * Steering documents for project context.
 */
export interface SteeringContext {
    product?: string;
    tech?: string;
    structure?: string;
    principles?: string;
}

/**
 * Previous spec documents for context when reviewing design/tasks.
 */
export interface SpecDocsContext {
    requirements?: string;
    design?: string;
}

interface AiReviewRunState {
    revision: number;
    status: 'running' | 'blocked' | 'done' | 'failed';
    facts: StateSnapshotFact[];
}

export interface AiReviewServiceOptions {
    chatProvider?: ChatProvider;
    budgetPolicy?: Partial<BudgetPolicy>;
    budgetGuard?: IBudgetGuard;
    telemetryMeter?: IRuntimeTelemetryMeter;
    interceptors?: ChatInterceptor[];
    defaultMaxInputChars?: number;
    defaultMaxOutputTokens?: number;
}

interface ContextSection {
    id: string;
    title: string;
    content: string;
    required: boolean;
}

interface ContextBuildResult {
    contextText: string;
    facts: StateSnapshotFact[];
    includedSections: number;
    unchangedSections: number;
}

const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
    maxCostUsdPerRequest: 0.03,
    emergencyModelId: AI_REVIEW_MODELS['gemini-flash'].model,
    maxEmergencyCostUsdPerRequest: 0.005,
    allowEmergencyDegrade: true,
    retryAfterSeconds: 3600,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isAiReviewResponsePayload(payload: unknown): payload is { suggestions: Array<{ quote?: string; comment: string }> } {
    if (!isRecord(payload)) {
        return false;
    }
    if (!Array.isArray(payload.suggestions)) {
        return false;
    }
    return payload.suggestions.every(item => {
        if (!isRecord(item)) {
            return false;
        }
        if (typeof item.comment !== 'string' || item.comment.trim().length === 0) {
            return false;
        }
        if (typeof item.quote !== 'undefined' && typeof item.quote !== 'string') {
            return false;
        }
        return true;
    });
}

/**
 * Service for AI-powered document review.
 * Thin path: budget + schema validation + provider call + telemetry.
 */
export class AiReviewService {
    private chat: ChatProvider;
    private budgetPolicy: BudgetPolicy;
    private budgetGuard: IBudgetGuard;
    private telemetryMeter: IRuntimeTelemetryMeter;
    private interceptors: ChatInterceptor[];
    private defaultMaxInputChars: number;
    private defaultMaxOutputTokens: number;
    private runState = new Map<string, AiReviewRunState>();

    constructor(_apiKey: string, options: AiReviewServiceOptions = {}) {
        const chatProvider = options.chatProvider;
        if (!chatProvider) {
            throw new Error('AiReviewService requires an injected chatProvider');
        }

        this.telemetryMeter = options.telemetryMeter ?? createRuntimeTelemetryMeter();
        this.chat = chatProvider;
        this.budgetPolicy = { ...DEFAULT_BUDGET_POLICY, ...options.budgetPolicy };
        this.budgetGuard = options.budgetGuard ?? { filterCandidates: filterBudgetCandidates };
        this.interceptors = options.interceptors ?? [redactionInterceptor];
        this.defaultMaxInputChars = options.defaultMaxInputChars ?? 18000;
        this.defaultMaxOutputTokens = options.defaultMaxOutputTokens ?? 1200;
    }

    getTelemetrySnapshot() {
        return this.telemetryMeter.snapshot();
    }

    async flushRuntimeState(): Promise<void> {
        // No-op for thin AI review path.
    }

    /**
     * Review a document and return suggestions.
     */
    async reviewDocument(
        content: string,
        model: AiReviewModel = 'deepseek-v3',
        steeringContext?: SteeringContext,
        specDocsContext?: SpecDocsContext,
        runtimeOptions: AiReviewRuntimeOptions = {}
    ): Promise<AiReviewResult> {
        const modelConfig = AI_REVIEW_MODELS[model];
        const runId = runtimeOptions.runId ?? randomUUID();
        const interactive = runtimeOptions.interactive ?? true;
        const maxInputChars = runtimeOptions.maxInputChars ?? this.defaultMaxInputChars;
        const maxOutputTokens = runtimeOptions.maxOutputTokens ?? this.defaultMaxOutputTokens;
        const previousFacts = this.getRunFacts(runId);

        const context = this.buildContextPacket(content, steeringContext, specDocsContext, previousFacts, maxInputChars);
        const userPrompt = `${REVIEW_USER_PREFIX}

${context.contextText}

${REVIEW_USER_SUFFIX}`;

        const estimatedInputTokens = this.estimateTokens(REVIEW_SYSTEM_PROMPT.length + userPrompt.length);
        const candidates = this.buildBudgetCandidates();
        const budgetResult = this.budgetGuard.filterCandidates(
            { estimatedInputTokens, estimatedOutputTokens: maxOutputTokens, interactive },
            candidates,
            this.budgetPolicy,
            modelConfig.model
        );

        if (
            budgetResult.decision.decision === 'deny' ||
            budgetResult.decision.decision === 'queue' ||
            !budgetResult.selectedCandidate
        ) {
            this.upsertRunState(runId, 'failed', [
                ...context.facts,
                { k: 'budget_decision', v: budgetResult.decision.decision, confidence: 1 },
            ]);
            throw new BudgetExceededError(
                `429_budget_exceeded: ${budgetResult.decision.reason_codes.join(', ')}`,
                budgetResult.decision
            );
        }

        const selectedCandidate = budgetResult.selectedCandidate;
        const decision = budgetResult.decision;

        const baseMessages: ChatMessage[] = [
            { role: 'system' as const, content: REVIEW_SYSTEM_PROMPT },
            { role: 'user' as const, content: userPrompt },
        ];

        try {
            this.upsertRunState(runId, 'running', context.facts);
            const { response, suggestions } = await this.performSchemaValidatedReview({
                baseMessages,
                runId,
                model: selectedCandidate.model,
                maxOutputTokens,
                maxInputChars,
                modelConfig,
            });

            const revision = this.upsertRunState(
                runId,
                'done',
                [
                    ...context.facts,
                    {
                        k: 'model_used',
                        v: response.model,
                        confidence: 1,
                    },
                    {
                        k: 'budget_decision',
                        v: decision.decision,
                        confidence: 1,
                    },
                    {
                        k: 'prompt_stable_prefix_hash',
                        v: this.getStablePromptPrefixHash(),
                        confidence: 1,
                    },
                ]
            );

            return {
                suggestions,
                modelUsed: response.model,
                budgetDecision: decision,
                snapshotRevision: revision,
                usage: response.usage,
                contextStats: {
                    includedSections: context.includedSections,
                    unchangedSections: context.unchangedSections,
                    inputChars: REVIEW_SYSTEM_PROMPT.length + userPrompt.length,
                },
            };
        } catch (error) {
            this.upsertRunState(runId, 'failed', context.facts);
            if (error instanceof BudgetExceededError) {
                throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            const wrapped = new Error(`AI review failed: ${message}`) as Error & { code?: string };
            wrapped.code = (error as any)?.code ?? 'ai_review_failed';
            throw wrapped;
        }
    }

    private async performSchemaValidatedReview(args: {
        baseMessages: ChatMessage[];
        runId: string;
        model: string;
        maxOutputTokens: number;
        maxInputChars: number;
        modelConfig: AiReviewModelConfig;
    }): Promise<{ response: ChatResponse; suggestions: AiSuggestion[] }> {
        let previousAssistantContent: string | null = null;

        for (let attempt = 1; attempt <= MAX_SCHEMA_RETRIES; attempt += 1) {
            const attemptMessages: ChatMessage[] = [...args.baseMessages];
            if (previousAssistantContent) {
                attemptMessages.push({ role: 'assistant' as const, content: previousAssistantContent });
                attemptMessages.push({ role: 'user' as const, content: SCHEMA_RETRY_PROMPT });
            }

            const response = await this.chat.chat(attemptMessages, {
                model: args.model,
                temperature: 0.3,
                maxTokens: args.maxOutputTokens,
                jsonMode: true,
                metadata: {
                    requestId: randomUUID(),
                    runId: args.runId,
                    stepId: `review-attempt-${attempt}`,
                    partitionKey: args.runId,
                    idempotencyKey: `${args.runId}:review:${attempt}`,
                    agentId: 'ai_review_service',
                },
                runtime: {
                    interceptors: this.interceptors,
                    historyReducer: {
                        enabled: true,
                        maxInputChars: args.maxInputChars,
                        preserveRecentRawTurns: 4,
                        summaryMaxChars: 1200,
                    },
                },
                providerOptions: this.buildProviderOptions(args.modelConfig),
            });

            try {
                return {
                    response,
                    suggestions: this.parseResponseStrict(response.content),
                };
            } catch (error) {
                previousAssistantContent = response.content;
                if (attempt >= MAX_SCHEMA_RETRIES) {
                    throw new Error(`schema_validation_failed: ${String(error)}`);
                }
            }
        }

        throw new Error('schema_validation_failed');
    }

    private parseResponseStrict(content: string): AiSuggestion[] {
        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch (error) {
            const parseError = new Error(`schema_validation_failed: invalid_json: ${String(error)}`) as Error & { code?: string };
            parseError.code = 'schema_validation_failed';
            throw parseError;
        }

        if (!isAiReviewResponsePayload(parsed)) {
            const schemaError = new Error('schema_validation_failed: invalid_schema') as Error & { code?: string };
            schemaError.code = 'schema_validation_failed';
            throw schemaError;
        }

        return parsed.suggestions
            .map(item => ({
                quote: typeof item.quote === 'string' && item.quote.trim() ? item.quote.trim() : undefined,
                comment: String(item.comment).trim(),
            }))
            .filter(suggestion => suggestion.comment.length > 0);
    }

    private buildContextPacket(
        content: string,
        steeringContext: SteeringContext | undefined,
        specDocsContext: SpecDocsContext | undefined,
        previousFacts: Map<string, string>,
        maxInputChars: number
    ): ContextBuildResult {
        const sections: ContextSection[] = [
            {
                id: 'product',
                title: 'Product Vision',
                content: steeringContext?.product ?? '',
                required: false,
            },
            {
                id: 'tech',
                title: 'Tech Stack',
                content: steeringContext?.tech ?? '',
                required: false,
            },
            {
                id: 'structure',
                title: 'Codebase Structure',
                content: steeringContext?.structure ?? '',
                required: false,
            },
            {
                id: 'principles',
                title: 'Engineering Principles',
                content: steeringContext?.principles ?? '',
                required: false,
            },
            {
                id: 'requirements',
                title: 'Requirements Document',
                content: specDocsContext?.requirements ?? '',
                required: false,
            },
            {
                id: 'design',
                title: 'Design Document',
                content: specDocsContext?.design ?? '',
                required: false,
            },
            {
                id: 'document',
                title: 'Document To Review',
                content,
                required: true,
            },
        ].filter(section => section.content.trim().length > 0);

        const included: string[] = [];
        const facts: StateSnapshotFact[] = [];
        let includedSections = 0;
        let unchangedSections = 0;
        const sectionBudget = Math.max(800, Math.floor(maxInputChars / Math.max(1, sections.length)));

        for (const section of sections) {
            const normalized = section.content.trim();
            const digest = createHash('sha256').update(normalized).digest('hex');
            const hashKey = `section_hash:${section.id}`;
            const summaryKey = `section_summary:${section.id}`;
            const previousHash = previousFacts.get(hashKey);

            facts.push({ k: hashKey, v: digest, confidence: 1 });
            facts.push({
                k: summaryKey,
                v: this.compactText(normalized, Math.min(1000, Math.floor(sectionBudget / 2))),
                confidence: 0.85,
            });

            if (!section.required && previousHash === digest) {
                const previousSummary = previousFacts.get(summaryKey) ?? 'Unchanged from previous run.';
                included.push(`## ${section.title}\n[UNCHANGED]\n${previousSummary}`);
                unchangedSections += 1;
                includedSections += 1;
                continue;
            }

            included.push(`## ${section.title}\n${this.compactText(normalized, section.id === 'document' ? Math.floor(maxInputChars * 0.7) : sectionBudget)}`);
            includedSections += 1;
        }

        return {
            contextText: included.join('\n\n'),
            facts,
            includedSections,
            unchangedSections,
        };
    }

    private compactText(content: string, maxChars: number): string {
        if (content.length <= maxChars) {
            return content;
        }

        const head = Math.floor(maxChars * 0.72);
        const tail = Math.floor(maxChars * 0.2);
        const omitted = content.length - head - tail;
        return `${content.slice(0, head)}\n\n[... ${omitted} characters omitted ...]\n\n${content.slice(content.length - tail)}`;
    }

    private estimateTokens(chars: number): number {
        return Math.ceil(chars / 4);
    }

    private buildBudgetCandidates(): BudgetCandidate[] {
        return Object.entries(AI_REVIEW_MODELS).map(([key, config]) => ({
            id: key,
            model: config.model,
            estimatedInputCostUsdPer1k: config.estimatedInputCostUsdPer1k,
            estimatedOutputCostUsdPer1k: config.estimatedOutputCostUsdPer1k,
            tags: config.tags,
        }));
    }

    private getStablePromptPrefixHash(): string {
        return createHash('sha256').update(`${REVIEW_SYSTEM_PROMPT}\n${REVIEW_USER_PREFIX}\n${REVIEW_USER_SUFFIX}`).digest('hex');
    }

    private buildProviderOptions(modelConfig: AiReviewModelConfig): ChatOptions['providerOptions'] {
        const providerOptions: NonNullable<ChatOptions['providerOptions']> = {
            promptCaching: {
                key: `ai-review:${this.getStablePromptPrefixHash()}`,
                retention: 'in_memory',
            },
        };

        if (modelConfig.reasoning) {
            providerOptions.reasoning = true;
        }

        return providerOptions;
    }

    private getRunFacts(runId: string): Map<string, string> {
        const run = this.runState.get(runId);
        return new Map((run?.facts ?? []).map(fact => [fact.k, fact.v]));
    }

    private upsertRunState(
        runId: string,
        status: AiReviewRunState['status'],
        facts: StateSnapshotFact[]
    ): number {
        const previous = this.runState.get(runId);
        const factMap = new Map<string, StateSnapshotFact>();
        for (const fact of previous?.facts ?? []) {
            factMap.set(fact.k, fact);
        }
        for (const fact of facts) {
            factMap.set(fact.k, fact);
        }

        const revision = (previous?.revision ?? 0) + 1;
        this.runState.set(runId, {
            revision,
            status,
            facts: Array.from(factMap.values()),
        });
        return revision;
    }
}
