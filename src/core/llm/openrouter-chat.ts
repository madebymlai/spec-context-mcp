import type OpenAI from 'openai';
import { randomUUID } from 'crypto';
import type { IBudgetGuard } from './budget-guard.js';
import { BudgetExceededError, InterceptorDroppedError } from './errors.js';
import type { LlmProvider, ProviderCacheAdapter } from './provider-cache-adapter.js';
import type { IRuntimeTelemetryMeter } from './telemetry-meter.js';
import type {
    ChatProvider,
    ChatMessage,
    ChatResponse,
    ChatOptions,
    RuntimeEventDraft,
    ChatInterceptor,
    ChatInterceptionReport,
} from './types.js';

export interface OpenRouterChatConfig {
    apiKey: string;
    defaultModel?: string;
    timeout?: number;
    provider?: LlmProvider;
    cacheAdapter?: ProviderCacheAdapter;
    telemetryMeter?: IRuntimeTelemetryMeter;
}

type RuntimeRequest = {
    model: string;
    messages: ChatMessage[];
    options: ChatOptions;
};

type InterceptionHook = 'on_ingress' | 'on_send_pre_cache_key' | 'on_send_post_route';

interface InterceptionContext {
    hook: InterceptionHook;
    requestId: string;
    runId: string;
    stepId: string;
    ts: string;
}

interface InterceptionResult {
    request: RuntimeRequest;
    reports: ChatInterceptionReport[];
    dropped: boolean;
    dropReasonCode: string | null;
}

export type ProviderChatRequest = OpenAI.ChatCompletionCreateParamsNonStreaming & {
    reasoning?: { effort: string };
    prompt_cache_key?: string;
    prompt_cache_retention?: '24h';
};

export interface OpenRouterClient {
    createChatCompletion(
        requestOptions: ProviderChatRequest,
        options: { timeout: number },
    ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
}

export interface RuntimeInterceptionLayer {
    run(
        hook: InterceptionHook,
        request: RuntimeRequest,
        interceptors: ChatInterceptor[],
        context: InterceptionContext,
    ): Promise<InterceptionResult>;
}

export interface RuntimeHistoryReducer {
    reduce(
        messages: ChatMessage[],
        policy: NonNullable<NonNullable<ChatOptions['runtime']>['historyReducer']>,
    ): { messages: ChatMessage[] };
}

export interface RuntimePromptPrefixCompiler {
    compile(input: {
        model: string;
        messages: ChatMessage[];
        jsonMode: boolean;
        dynamicTailMessages?: number;
    }): {
        cacheKey: string;
        stablePrefixHash: string;
        dynamicTailHash: string;
    };
}

export interface OpenRouterChatDependencies {
    client: OpenRouterClient;
    interceptionLayer: RuntimeInterceptionLayer;
    historyReducer: RuntimeHistoryReducer;
    budgetGuard: IBudgetGuard;
    promptPrefixCompiler: RuntimePromptPrefixCompiler;
    cacheAdapter: ProviderCacheAdapter;
    telemetryMeter: IRuntimeTelemetryMeter;
}

type ProviderChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

type ChatMessageSerializer = (message: ChatMessage) => ProviderChatMessage;

const CHAT_MESSAGE_SERIALIZERS: Record<ChatMessage['role'], ChatMessageSerializer> = {
    system: (message) => ({
        role: 'system',
        content: message.content,
        name: message.name,
    }),
    user: (message) => ({
        role: 'user',
        content: message.content,
        name: message.name,
    }),
    assistant: (message) => ({
        role: 'assistant',
        content: message.content,
        name: message.name,
    }),
    tool: (message) => ({
        role: 'tool',
        content: message.content,
        tool_call_id: message.toolCallId ?? 'tool',
    }),
};

function serializeProviderChatMessage(message: ChatMessage): ProviderChatMessage {
    return CHAT_MESSAGE_SERIALIZERS[message.role](message);
}

/**
 * OpenRouter-based chat provider using the OpenAI SDK.
 * Supports multiple models via OpenRouter's unified API.
 */
export class OpenRouterChat implements ChatProvider {
    private client: OpenRouterClient;
    private defaultModel: string;
    private timeout: number;
    private interceptionLayer: RuntimeInterceptionLayer;
    private historyReducer: RuntimeHistoryReducer;
    private budgetGuard: IBudgetGuard;
    private promptPrefixCompiler: RuntimePromptPrefixCompiler;
    private cacheAdapter: ProviderCacheAdapter;
    private telemetryMeter: IRuntimeTelemetryMeter;
    private provider: LlmProvider;

    constructor(config: OpenRouterChatConfig, dependencies: OpenRouterChatDependencies) {
        this.client = dependencies.client;
        this.defaultModel = config.defaultModel || 'deepseek/deepseek-chat';
        this.timeout = config.timeout || 60000;
        this.interceptionLayer = dependencies.interceptionLayer;
        this.historyReducer = dependencies.historyReducer;
        this.budgetGuard = dependencies.budgetGuard;
        this.promptPrefixCompiler = dependencies.promptPrefixCompiler;
        this.provider = config.provider ?? 'openrouter';
        this.cacheAdapter = dependencies.cacheAdapter;
        this.telemetryMeter = dependencies.telemetryMeter;
    }

    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
        const startedAt = Date.now();
        const requestId = options?.metadata?.requestId ?? randomUUID();
        const runId = options?.metadata?.runId ?? requestId;
        const stepId = options?.metadata?.stepId ?? 'llm';
        const agentId = options?.metadata?.agentId ?? 'llm_gateway';
        const partitionKey = options?.metadata?.partitionKey ?? runId;
        const idempotencyKey = options?.metadata?.idempotencyKey ?? requestId;

        let request = {
            model: options?.model ?? this.defaultModel,
            messages: messages.map(message => ({ ...message })),
            options: options ?? {},
        };
        const interceptionReports = [];
        let budgetDecision = undefined;
        let eventCounter = 0;

        const emitEvent = async (type: 'LLM_REQUEST' | 'LLM_RESPONSE' | 'BUDGET_DECISION' | 'INTERCEPTOR_DECISION' | 'STATE_DELTA' | 'ERROR', payload: Record<string, unknown>) => {
            if (!options?.runtime?.emitEvent) {
                return;
            }
            eventCounter += 1;
            const eventDraft: RuntimeEventDraft = {
                idempotency_key: `${idempotencyKey}:${type.toLowerCase()}:${eventCounter}`,
                partition_key: partitionKey,
                causal_parent_event_id: options?.metadata?.causalParentEventId ?? null,
                run_id: runId,
                step_id: stepId,
                agent_id: agentId,
                type,
                payload,
            };
            await options.runtime.emitEvent(eventDraft);
        };

        try {
            const interceptors = options?.runtime?.interceptors ?? [];
            if (interceptors.length > 0) {
                const ingressContext = {
                    hook: 'on_ingress' as const,
                    requestId,
                    runId,
                    stepId,
                    ts: new Date().toISOString(),
                };
                const ingressResult = await this.interceptionLayer.run('on_ingress', request, interceptors, ingressContext);
                request = ingressResult.request;
                interceptionReports.push(...ingressResult.reports);
                if (ingressResult.dropped) {
                    throw new InterceptorDroppedError(`Request dropped by interceptor at ingress: ${ingressResult.dropReasonCode}`);
                }

                const preCacheContext = {
                    hook: 'on_send_pre_cache_key' as const,
                    requestId,
                    runId,
                    stepId,
                    ts: new Date().toISOString(),
                };
                const preCacheResult = await this.interceptionLayer.run(
                    'on_send_pre_cache_key',
                    request,
                    interceptors,
                    preCacheContext
                );
                request = preCacheResult.request;
                interceptionReports.push(...preCacheResult.reports);
                if (preCacheResult.dropped) {
                    throw new InterceptorDroppedError(`Request dropped before cache key: ${preCacheResult.dropReasonCode}`);
                }
            }

            if (options?.runtime?.historyReducer?.enabled) {
                const reduced = this.historyReducer.reduce(request.messages, options.runtime.historyReducer);
                request.messages = reduced.messages;
            }

            if (options?.runtime?.budget) {
                const budgetResult = this.budgetGuard.filterCandidates(
                    options.runtime.budget.request,
                    options.runtime.budget.candidates,
                    options.runtime.budget.policy,
                    options.runtime.budget.preferredModel ?? request.model
                );
                budgetDecision = budgetResult.decision;
                await emitEvent('BUDGET_DECISION', budgetDecision as unknown as Record<string, unknown>);

                if (
                    budgetResult.decision.decision === 'deny' ||
                    budgetResult.decision.decision === 'queue' ||
                    !budgetResult.selectedCandidate
                ) {
                    throw new BudgetExceededError('429_budget_exceeded', budgetResult.decision);
                }
                request.model = budgetResult.selectedCandidate.model;
            }

            const prefixCompile = this.promptPrefixCompiler.compile({
                model: request.model,
                messages: request.messages,
                jsonMode: Boolean(options?.jsonMode),
                dynamicTailMessages: 2,
            });

            const promptCacheRetention: 'in_memory' | '24h' =
                options?.providerOptions?.promptCaching?.retention === '24h' ? '24h' : 'in_memory';
            const promptCacheKey = options?.providerOptions?.promptCaching?.key ?? prefixCompile.cacheKey;
            const cacheRequest = {
                model: request.model,
                promptCacheKey,
                promptCacheRetention,
            } as const;

            if ((options?.runtime?.interceptors ?? []).length > 0) {
                const postRouteContext = {
                    hook: 'on_send_post_route' as const,
                    requestId,
                    runId,
                    stepId,
                    ts: new Date().toISOString(),
                };
                const postRouteResult = await this.interceptionLayer.run(
                    'on_send_post_route',
                    request,
                    options?.runtime?.interceptors ?? [],
                    postRouteContext
                );
                request = postRouteResult.request;
                interceptionReports.push(...postRouteResult.reports);
                if (postRouteResult.dropped) {
                    throw new InterceptorDroppedError(`Request dropped post-route: ${postRouteResult.dropReasonCode}`);
                }
            }

            if (interceptionReports.length > 0) {
                await emitEvent('INTERCEPTOR_DECISION', { reports: interceptionReports });
            }

            await emitEvent('LLM_REQUEST', {
                model: request.model,
                message_count: request.messages.length,
                cache_key: promptCacheKey,
                stable_prefix_hash: prefixCompile.stablePrefixHash,
                dynamic_tail_hash: prefixCompile.dynamicTailHash,
            });

            const requestOptions: ProviderChatRequest = {
                model: request.model,
                messages: request.messages.map(serializeProviderChatMessage),
                temperature: options?.temperature ?? 0.7,
                max_tokens: options?.maxTokens ?? 4096,
            };

            const cacheMutation = this.cacheAdapter.apply(cacheRequest);
            Object.assign(requestOptions, cacheMutation);

            if (options?.jsonMode) {
                requestOptions.response_format = { type: 'json_object' };
            }
            if (options?.providerOptions?.reasoning) {
                requestOptions.reasoning = { effort: 'high' };
            }

            const response = await this.executeWithProviderDowngrade(requestOptions, emitEvent);
            const choice = response.choices[0];
            if (!choice || !choice.message?.content) {
                throw new Error('No response content from LLM');
            }

            const cacheTelemetry = this.cacheAdapter.extractTelemetry(response.usage, cacheRequest);
            const runtimeResponse = {
                cacheKey: promptCacheKey,
                requestId,
                budgetDecision,
                interceptorReports: interceptionReports,
                cacheTelemetry: {
                    promptCacheKey: cacheTelemetry.promptCacheKey,
                    promptCacheRetention: cacheTelemetry.promptCacheRetention,
                    cachedInputTokens: cacheTelemetry.cachedInputTokens,
                    cacheWriteTokens: cacheTelemetry.cacheWriteTokens,
                    cacheMissReason: cacheTelemetry.cacheMissReason,
                },
            };

            const promptTokens = response.usage?.prompt_tokens ?? 0;
            const completionTokens = response.usage?.completion_tokens ?? 0;
            const totalTokens = response.usage?.total_tokens ?? (promptTokens + completionTokens);

            this.telemetryMeter.record({
                provider: this.provider,
                model: response.model,
                inputTokens: promptTokens,
                outputTokens: completionTokens,
                cachedInputTokens: cacheTelemetry.cachedInputTokens,
                cacheWriteTokens: cacheTelemetry.cacheWriteTokens,
                latencyMs: Date.now() - startedAt,
            });

            await emitEvent('LLM_RESPONSE', {
                model: response.model,
                usage: {
                    promptTokens,
                    completionTokens,
                    totalTokens,
                    cachedTokens: cacheTelemetry.cachedInputTokens,
                    cacheWriteTokens: cacheTelemetry.cacheWriteTokens,
                    cacheMissReason: cacheTelemetry.cacheMissReason,
                },
                cache_key: promptCacheKey,
                prompt_cache_retention: promptCacheRetention,
            });

            return {
                content: choice.message.content,
                model: response.model,
                usage: response.usage ? {
                    promptTokens,
                    completionTokens,
                    totalTokens,
                } : undefined,
                runtime: runtimeResponse,
            };
        } catch (error) {
            await emitEvent('ERROR', {
                message: error instanceof Error ? error.message : String(error),
                code: (error as any)?.code ?? 'unknown',
            });
            throw error;
        }
    }

    getTelemetrySnapshot() {
        return this.telemetryMeter.snapshot();
    }

    /**
     * Chat with a specific model (overrides default).
     */
    async chatWithModel(
        model: string,
        messages: ChatMessage[],
        options?: ChatOptions
    ): Promise<ChatResponse> {
        return this.chat(messages, {
            ...(options ?? {}),
            model,
        });
    }

    private async executeWithProviderDowngrade(
        requestOptions: ProviderChatRequest,
        emitEvent: (type: 'LLM_REQUEST' | 'LLM_RESPONSE' | 'BUDGET_DECISION' | 'INTERCEPTOR_DECISION' | 'STATE_DELTA' | 'ERROR', payload: Record<string, unknown>) => Promise<void>
    ) {
        try {
            return await this.client.createChatCompletion(requestOptions, { timeout: this.timeout });
        } catch (error) {
            const downgraded = this.stripUnsupportedProviderOptions(requestOptions, error);
            if (!downgraded.changed) {
                throw error;
            }

            await emitEvent('STATE_DELTA', {
                capability_downgrade: true,
                removed_fields: downgraded.removedFields,
                reason: downgraded.reason,
            });

            return this.client.createChatCompletion(downgraded.requestOptions, { timeout: this.timeout });
        }
    }

    private stripUnsupportedProviderOptions(
        requestOptions: ProviderChatRequest,
        error: unknown
    ): {
        changed: boolean;
        removedFields: string[];
        reason: string;
        requestOptions: ProviderChatRequest;
    } {
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        const unsupportedPatterns = ['unsupported', 'unknown parameter', 'not allowed', 'invalid parameter'];
        const hasCapabilityFailure = unsupportedPatterns.some(pattern => message.includes(pattern));

        if (!hasCapabilityFailure) {
            return {
                changed: false,
                removedFields: [],
                reason: 'not_capability_error',
                requestOptions,
            };
        }

        const downgraded = { ...requestOptions };
        const removedFields: string[] = [];

        if (typeof downgraded.reasoning !== 'undefined') {
            delete downgraded.reasoning;
            removedFields.push('reasoning');
        }
        if (typeof downgraded.prompt_cache_retention !== 'undefined') {
            delete downgraded.prompt_cache_retention;
            removedFields.push('prompt_cache_retention');
        }
        if (message.includes('prompt_cache_key') && typeof downgraded.prompt_cache_key !== 'undefined') {
            delete downgraded.prompt_cache_key;
            removedFields.push('prompt_cache_key');
        }

        return {
            changed: removedFields.length > 0,
            removedFields,
            reason: 'provider_capability_unsupported',
            requestOptions: downgraded,
        };
    }
}
