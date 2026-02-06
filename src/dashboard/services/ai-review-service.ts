import { createHash, randomUUID } from 'crypto';
import {
    BudgetGuard,
    OpenRouterChat,
    RuntimeEventStream,
    RuntimeSnapshotStore,
    redactionInterceptor,
    InMemoryEventBusAdapter,
    SchemaRegistry,
    PromptTemplateRegistry,
    StateProjector,
    TelemetryMeter,
} from '../../core/llm/index.js';
import type {
    BudgetCandidate,
    BudgetDecision,
    BudgetPolicy,
    ChatMessage,
    ChatInterceptor,
    ChatOptions,
    ChatProvider,
    RuntimeEventDraft,
    RuntimeEventEnvelope,
    EventBusAdapter,
    StateSnapshot,
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

const REVIEW_USER_TEMPLATE_ID = 'ai_review_user_prompt';
const REVIEW_USER_TEMPLATE_VERSION = 'v1';
const MAX_SCHEMA_RETRIES = 2;
const SCHEMA_RETRY_PROMPT = 'Your previous reply did not match the required JSON schema. Return only valid JSON with top-level {"suggestions":[{"quote?":"...","comment":"..."}]} and no extra text.';

/**
 * Steering documents for project context.
 */
export interface SteeringContext {
    product?: string;
    tech?: string;
    structure?: string;
}

/**
 * Previous spec documents for context when reviewing design/tasks.
 */
export interface SpecDocsContext {
    requirements?: string;
    design?: string;
}

export interface AiReviewServiceOptions {
    chatProvider?: ChatProvider;
    budgetPolicy?: Partial<BudgetPolicy>;
    snapshotStore?: RuntimeSnapshotStore;
    eventStream?: RuntimeEventStream;
    eventBus?: EventBusAdapter<RuntimeEventEnvelope>;
    schemaRegistry?: SchemaRegistry;
    promptTemplateRegistry?: PromptTemplateRegistry;
    stateProjector?: StateProjector;
    telemetryMeter?: TelemetryMeter;
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

function isRuntimeEventEnvelope(payload: unknown): payload is RuntimeEventEnvelope {
    if (!isRecord(payload)) {
        return false;
    }
    return typeof payload.event_id === 'string' &&
        typeof payload.idempotency_key === 'string' &&
        typeof payload.partition_key === 'string' &&
        typeof payload.sequence === 'number' &&
        typeof payload.run_id === 'string' &&
        typeof payload.step_id === 'string' &&
        typeof payload.agent_id === 'string' &&
        typeof payload.type === 'string' &&
        payload.schema_version === 'v2' &&
        isRecord(payload.payload);
}

/**
 * Service for AI-powered document review.
 */
export class AiReviewService {
    private chat: ChatProvider;
    private budgetPolicy: BudgetPolicy;
    private budgetGuard: BudgetGuard;
    private eventStream: RuntimeEventStream;
    private snapshotStore: RuntimeSnapshotStore;
    private eventBus: EventBusAdapter<RuntimeEventEnvelope>;
    private schemaRegistry: SchemaRegistry;
    private promptTemplates: PromptTemplateRegistry;
    private stateProjector: StateProjector;
    private telemetryMeter: TelemetryMeter;
    private interceptors: ChatInterceptor[];
    private defaultMaxInputChars: number;
    private defaultMaxOutputTokens: number;

    constructor(apiKey: string, options: AiReviewServiceOptions = {}) {
        this.telemetryMeter = options.telemetryMeter ?? new TelemetryMeter();
        this.chat = options.chatProvider ?? new OpenRouterChat({
            apiKey,
            timeout: 60000,
            telemetryMeter: this.telemetryMeter,
        });
        this.budgetPolicy = { ...DEFAULT_BUDGET_POLICY, ...options.budgetPolicy };
        this.budgetGuard = new BudgetGuard();
        this.eventStream = options.eventStream ?? new RuntimeEventStream();
        this.snapshotStore = options.snapshotStore ?? new RuntimeSnapshotStore();
        this.eventBus = options.eventBus ?? new InMemoryEventBusAdapter<RuntimeEventEnvelope>();
        this.schemaRegistry = options.schemaRegistry ?? new SchemaRegistry();
        this.promptTemplates = options.promptTemplateRegistry ?? new PromptTemplateRegistry();
        this.stateProjector = options.stateProjector ?? new StateProjector();
        this.interceptors = options.interceptors ?? [redactionInterceptor];
        this.defaultMaxInputChars = options.defaultMaxInputChars ?? 18000;
        this.defaultMaxOutputTokens = options.defaultMaxOutputTokens ?? 1200;

        this.registerSchemas();
        this.registerPromptTemplates();
        this.eventBus.subscribe(event => {
            void this.projectAndPersistEvent(event);
        });
    }

    getTelemetrySnapshot() {
        return this.telemetryMeter.snapshot();
    }

    async flushRuntimeState(): Promise<void> {
        await this.eventStream.flush();
        await this.snapshotStore.flush();
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
        const previousSnapshot = await this.snapshotStore.get(runId);

        const context = this.buildContextPacket(content, steeringContext, specDocsContext, previousSnapshot, maxInputChars);
        const userPrompt = this.promptTemplates.compile(
            REVIEW_USER_TEMPLATE_ID,
            REVIEW_USER_TEMPLATE_VERSION,
            context.contextText
        );

        const estimatedInputTokens = this.estimateTokens(REVIEW_SYSTEM_PROMPT.length + userPrompt.text.length);
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
            await this.persistSnapshot(runId, 'failed', context.facts, {
                remaining_input: 0,
                remaining_output: 0,
            }, [
                {
                    channel: 'ai-review',
                    task_id: 'budget-deny',
                    value: {
                        modelRequested: modelConfig.model,
                        decision: budgetResult.decision,
                    },
                },
            ]);
            const budgetError = new Error(
                `429_budget_exceeded: ${budgetResult.decision.reason_codes.join(', ')}`
            ) as Error & { code?: string; budgetDecision?: BudgetDecision };
            budgetError.code = '429_budget_exceeded';
            budgetError.budgetDecision = budgetResult.decision;
            throw budgetError;
        }

        const selectedCandidate = budgetResult.selectedCandidate;
        const decision = budgetResult.decision;

        const budgetEvent = await this.publishRuntimeEvent({
            partition_key: runId,
            run_id: runId,
            step_id: 'budget-filter',
            agent_id: 'ai_review_service',
            type: 'BUDGET_DECISION',
            payload: decision as unknown as Record<string, unknown>,
        });

        const baseMessages: ChatMessage[] = [
            { role: 'system' as const, content: REVIEW_SYSTEM_PROMPT },
            { role: 'user' as const, content: userPrompt.text },
        ];

        let response: Awaited<ReturnType<ChatProvider['chat']>> | null = null;
        let suggestions: AiSuggestion[] | null = null;
        let previousAssistantContent: string | null = null;

        try {
            for (let attempt = 1; attempt <= MAX_SCHEMA_RETRIES; attempt += 1) {
                const attemptMessages: ChatMessage[] = [...baseMessages];
                if (previousAssistantContent) {
                    attemptMessages.push({ role: 'assistant' as const, content: previousAssistantContent });
                    attemptMessages.push({ role: 'user' as const, content: SCHEMA_RETRY_PROMPT });
                }

                response = await this.chat.chat(attemptMessages, {
                    model: selectedCandidate.model,
                    temperature: 0.3,
                    maxTokens: maxOutputTokens,
                    jsonMode: true,
                    metadata: {
                        requestId: randomUUID(),
                        runId,
                        stepId: `review-attempt-${attempt}`,
                        partitionKey: runId,
                        idempotencyKey: `${runId}:review:${attempt}`,
                        agentId: 'ai_review_service',
                        causalParentEventId: budgetEvent.event_id,
                    },
                    runtime: {
                        interceptors: this.interceptors,
                        historyReducer: {
                            enabled: true,
                            maxInputChars,
                            preserveRecentRawTurns: 4,
                            summaryMaxChars: 1200,
                        },
                        emitEvent: async event => {
                            await this.publishRuntimeEvent(event);
                        },
                    },
                    providerOptions: this.buildProviderOptions(modelConfig, userPrompt.stablePrefixHash),
                });

                try {
                    suggestions = this.parseResponseStrict(response.content);
                    break;
                } catch (error) {
                    previousAssistantContent = response.content;
                    await this.publishRuntimeEvent({
                        partition_key: runId,
                        run_id: runId,
                        step_id: `schema-validate-${attempt}`,
                        agent_id: 'ai_review_service',
                        type: 'ERROR',
                        payload: {
                            code: 'schema_validation_failed',
                            message: error instanceof Error ? error.message : String(error),
                            attempt,
                        },
                    });

                    if (attempt >= MAX_SCHEMA_RETRIES) {
                        throw error;
                    }
                }
            }

            if (!response || !suggestions) {
                throw new Error('schema_validation_failed');
            }

            const latestOffset = this.eventStream.latestOffset(runId);
            const snapshot = await this.persistSnapshot(
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
                        v: userPrompt.stablePrefixHash,
                        confidence: 1,
                    },
                ],
                {
                    remaining_input: Math.max(0, maxInputChars - REVIEW_SYSTEM_PROMPT.length - userPrompt.text.length),
                    remaining_output: Math.max(0, maxOutputTokens - (response.usage?.completionTokens ?? 0)),
                },
                [
                    {
                        channel: 'ai-review',
                        task_id: 'latest-result',
                        value: {
                            suggestionsCount: suggestions.length,
                            usage: response.usage ?? null,
                            cacheKey: response.runtime?.cacheKey ?? null,
                        },
                    },
                ],
                latestOffset
            );

            await this.publishRuntimeEvent({
                partition_key: runId,
                run_id: runId,
                step_id: 'snapshot',
                agent_id: 'ai_review_service',
                type: 'STATE_DELTA',
                payload: {
                    revision: snapshot.revision,
                    status: snapshot.status,
                },
            });

            return {
                suggestions,
                modelUsed: response.model,
                budgetDecision: decision,
                snapshotRevision: snapshot.revision,
                usage: response.usage,
                contextStats: {
                    includedSections: context.includedSections,
                    unchangedSections: context.unchangedSections,
                    inputChars: REVIEW_SYSTEM_PROMPT.length + userPrompt.text.length,
                },
            };
        } catch (error) {
            await this.persistSnapshot(
                runId,
                'failed',
                context.facts,
                {
                    remaining_input: 0,
                    remaining_output: 0,
                },
                [
                    {
                        channel: 'ai-review',
                        task_id: 'error',
                        value: {
                            message: error instanceof Error ? error.message : String(error),
                            modelRequested: selectedCandidate.model,
                        },
                    },
                ]
            );

            if ((error as any)?.code === '429_budget_exceeded') {
                throw error;
            }

            const message = error instanceof Error ? error.message : String(error);
            const wrapped = new Error(`AI review failed: ${message}`) as Error & { code?: string };
            wrapped.code = (error as any)?.code ?? 'ai_review_failed';
            throw wrapped;
        }
    }

    private registerSchemas(): void {
        this.schemaRegistry.register('runtime.event.envelope', 'runtime_event_envelope', 'v2', isRuntimeEventEnvelope);
        this.schemaRegistry.register(
            'runtime.event.payload.BUDGET_DECISION',
            'runtime_event_payload_budget_decision',
            'v2',
            (payload): payload is Record<string, unknown> => isRecord(payload) && typeof payload.decision === 'string'
        );
        this.schemaRegistry.register(
            'runtime.event.payload.LLM_REQUEST',
            'runtime_event_payload_llm_request',
            'v2',
            (payload): payload is Record<string, unknown> => isRecord(payload)
        );
        this.schemaRegistry.register(
            'runtime.event.payload.LLM_RESPONSE',
            'runtime_event_payload_llm_response',
            'v2',
            (payload): payload is Record<string, unknown> => isRecord(payload)
        );
        this.schemaRegistry.register(
            'runtime.event.payload.INTERCEPTOR_DECISION',
            'runtime_event_payload_interceptor_decision',
            'v2',
            (payload): payload is Record<string, unknown> => isRecord(payload)
        );
        this.schemaRegistry.register(
            'runtime.event.payload.STATE_DELTA',
            'runtime_event_payload_state_delta',
            'v2',
            (payload): payload is Record<string, unknown> => isRecord(payload)
        );
        this.schemaRegistry.register(
            'runtime.event.payload.ERROR',
            'runtime_event_payload_error',
            'v2',
            (payload): payload is Record<string, unknown> => isRecord(payload) && typeof payload.message === 'string'
        );
        this.schemaRegistry.register('ai_review.response', 'ai_review_response', 'v1', isAiReviewResponsePayload);
    }

    private registerPromptTemplates(): void {
        if (this.promptTemplates.get(REVIEW_USER_TEMPLATE_ID, REVIEW_USER_TEMPLATE_VERSION)) {
            return;
        }

        this.promptTemplates.register({
            templateId: REVIEW_USER_TEMPLATE_ID,
            version: REVIEW_USER_TEMPLATE_VERSION,
            segments: [
                {
                    kind: 'system',
                    stable: true,
                    content: 'Please review this document and provide feedback:',
                },
                {
                    kind: 'examples',
                    stable: true,
                    content: 'Respond with JSON containing your suggestions.',
                },
            ],
        });
    }

    private async projectAndPersistEvent(event: RuntimeEventEnvelope): Promise<void> {
        try {
            this.schemaRegistry.assert('runtime.event.envelope', event, 'v2');
            this.schemaRegistry.assert(`runtime.event.payload.${event.type}`, event.payload, 'v2');

            const previous = await this.snapshotStore.get(event.run_id);
            const projected = this.stateProjector.apply({ event, previous });
            await this.snapshotStore.upsert({
                runId: projected.runId,
                goal: projected.goal,
                status: projected.status,
                facts: projected.facts,
                pendingWrites: projected.pendingWrites,
                tokenBudget: projected.tokenBudget,
                appliedOffset: projected.appliedOffset,
            });
        } catch (error) {
            // Contract failures should not interrupt request path.
            console.warn('[ai-review] runtime event projection failed:', error);
        }
    }

    private async publishRuntimeEvent(draft: RuntimeEventDraft): Promise<RuntimeEventEnvelope> {
        const envelope = this.eventStream.publish(draft);
        await this.eventBus.publish(envelope);
        return envelope;
    }

    private parseResponseStrict(content: string): AiSuggestion[] {
        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch {
            const parseError = new Error('schema_validation_failed: invalid_json') as Error & { code?: string };
            parseError.code = 'schema_validation_failed';
            throw parseError;
        }

        this.schemaRegistry.assert('ai_review.response', parsed, 'v1');
        const payload = parsed as { suggestions: Array<{ quote?: string; comment: string }> };

        return payload.suggestions
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
        previousSnapshot: StateSnapshot | null,
        maxInputChars: number
    ): ContextBuildResult {
        const previousFacts = new Map((previousSnapshot?.facts ?? []).map(fact => [fact.k, fact.v]));

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

    private buildProviderOptions(
        modelConfig: AiReviewModelConfig,
        stablePromptPrefixHash: string
    ): ChatOptions['providerOptions'] {
        const providerOptions: NonNullable<ChatOptions['providerOptions']> = {
            promptCaching: {
                key: `ai-review:${stablePromptPrefixHash}`,
                retention: 'in_memory',
            },
        };

        if (modelConfig.reasoning) {
            providerOptions.reasoning = true;
        }

        return providerOptions;
    }

    private async persistSnapshot(
        runId: string,
        status: StateSnapshot['status'],
        facts: StateSnapshotFact[],
        tokenBudget: StateSnapshot['token_budget'],
        pendingWrites: Array<{
            channel: string;
            task_id: string;
            value: Record<string, unknown>;
        }>,
        sequence?: number
    ) {
        return this.snapshotStore.upsert({
            runId,
            goal: 'review_document',
            status,
            facts,
            pendingWrites,
            tokenBudget,
            appliedOffset: {
                partition_key: runId,
                sequence: sequence ?? this.eventStream.latestOffset(runId),
            },
        });
    }
}
