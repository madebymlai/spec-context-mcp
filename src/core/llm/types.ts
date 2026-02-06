/**
 * Chat message for LLM conversation.
 */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;
    toolCallId?: string;
    /**
     * Pairing metadata used by HistoryReducer invariants.
     * If one side of the pair is present, the reducer must keep both.
     */
    pairId?: string;
    pairRole?: 'call' | 'result';
    tags?: string[];
}

/**
 * Runtime event envelope used for orchestration telemetry.
 */
export interface RuntimeEventEnvelope {
    event_id: string;
    idempotency_key: string;
    partition_key: string;
    sequence: number;
    causal_parent_event_id: string | null;
    producer_ts: string;
    run_id: string;
    step_id: string;
    agent_id: string;
    type: 'LLM_REQUEST' | 'LLM_RESPONSE' | 'BUDGET_DECISION' | 'INTERCEPTOR_DECISION' | 'STATE_DELTA' | 'ERROR';
    ts: string;
    payload: Record<string, unknown>;
    schema_version: 'v2';
}

export interface RuntimeEventDraft {
    idempotency_key?: string;
    partition_key: string;
    causal_parent_event_id?: string | null;
    run_id: string;
    step_id: string;
    agent_id: string;
    type: RuntimeEventEnvelope['type'];
    payload: Record<string, unknown>;
}

export interface AppliedOffset {
    partition_key: string;
    sequence: number;
}

export interface StateSnapshotParentConfig {
    checkpoint_id: string;
    thread_id: string;
}

export interface StateSnapshotPendingWrite {
    channel: string;
    task_id: string;
    value: Record<string, unknown>;
}

export interface StateSnapshotFact {
    k: string;
    v: string;
    confidence: number;
}

export interface StateSnapshot {
    run_id: string;
    revision: number;
    projector_version: 'v2';
    applied_offsets: AppliedOffset[];
    parent_config: StateSnapshotParentConfig;
    pending_writes: StateSnapshotPendingWrite[];
    status: 'running' | 'blocked' | 'done' | 'failed';
    goal: string;
    facts: StateSnapshotFact[];
    token_budget: {
        remaining_input: number;
        remaining_output: number;
    };
    updated_at: string;
}

export interface BudgetCandidate {
    id: string;
    model: string;
    estimatedInputCostUsdPer1k: number;
    estimatedOutputCostUsdPer1k: number;
    tags?: string[];
}

export interface BudgetRequest {
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    interactive?: boolean;
}

export interface BudgetPolicy {
    maxCostUsdPerRequest?: number;
    maxCostUsdPerModel?: Record<string, number>;
    allowedTags?: string[];
    deniedTags?: string[];
    emergencyModelId?: string;
    maxEmergencyCostUsdPerRequest?: number;
    allowEmergencyDegrade?: boolean;
    retryAfterSeconds?: number;
}

export interface BudgetDecision {
    decision: 'allow' | 'deny' | 'degrade' | 'queue';
    reason_codes: string[];
    candidate_count_before: number;
    candidate_count_after: number;
    degraded_model: string | null;
    retry_after_s: number;
}

export interface BudgetRuntimeOptions {
    candidates: BudgetCandidate[];
    policy: BudgetPolicy;
    request: BudgetRequest;
    preferredModel?: string;
}

export type InterceptorHook = 'on_ingress' | 'on_send_pre_cache_key' | 'on_send_post_route';

export interface InterceptorContext {
    hook: InterceptorHook;
    requestId: string;
    runId: string;
    stepId: string;
    ts: string;
}

export interface InterceptorDecision {
    action: 'allow' | 'mutate' | 'drop';
    reasonCode: string;
    messages?: ChatMessage[];
    model?: string;
    mutatedFields?: string[];
}

export interface ChatInterceptionRequest {
    model: string;
    messages: ChatMessage[];
    options: ChatOptions;
}

export interface ChatInterceptor {
    id: string;
    criticality: 'critical' | 'best_effort';
    onIngress?: (
        request: Readonly<ChatInterceptionRequest>,
        context: Readonly<InterceptorContext>
    ) => Promise<InterceptorDecision> | InterceptorDecision;
    onSendPreCacheKey?: (
        request: Readonly<ChatInterceptionRequest>,
        context: Readonly<InterceptorContext>
    ) => Promise<InterceptorDecision> | InterceptorDecision;
    onSendPostRoute?: (
        request: Readonly<ChatInterceptionRequest>,
        context: Readonly<InterceptorContext>
    ) => Promise<InterceptorDecision> | InterceptorDecision;
}

export interface ChatInterceptionReport {
    interceptor_id: string;
    criticality: 'critical' | 'best_effort';
    action: 'allow' | 'mutate' | 'drop';
    reason_code: string;
    mutated_fields: string[];
    duration_ms: number;
}

export interface HistoryReducerOptions {
    enabled?: boolean;
    /** Character budget input used to derive token budget when maxInputTokens is not provided. */
    maxInputChars: number;
    /** Preferred budget control; reducer decisions are token-based. */
    maxInputTokens?: number;
    preserveRecentRawTurns?: number;
    summaryMaxChars?: number;
    /** Defaults to true when history reduction is enabled. */
    observationMasking?: boolean;
    /** Defaults to 80 when observation masking is enabled. */
    maxObservationChars?: number;
    /** Lower bound for adaptive masking strength. Defaults to 24. */
    minObservationChars?: number;
    /** Optional one-line digest length embedded in masked observation placeholders. Defaults to 48. */
    observationDigestChars?: number;
    /** Approximate chars per token for budget estimation. Defaults to 4. */
    tokenCharsPerToken?: number;
}

export interface ChatRuntimeOptions {
    interceptors?: ChatInterceptor[];
    historyReducer?: HistoryReducerOptions;
    budget?: BudgetRuntimeOptions;
    emitEvent?: (event: RuntimeEventDraft) => void | Promise<void>;
}

export interface ChatRequestMetadata {
    requestId?: string;
    runId?: string;
    stepId?: string;
    partitionKey?: string;
    idempotencyKey?: string;
    agentId?: string;
    causalParentEventId?: string | null;
}

/**
 * Chat completion response from LLM.
 */
export interface ChatResponse {
    content: string;
    model: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    runtime?: {
        cacheKey?: string;
        requestId: string;
        budgetDecision?: BudgetDecision;
        interceptorReports?: ChatInterceptionReport[];
        cacheTelemetry?: {
            promptCacheKey?: string;
            promptCacheRetention?: 'in_memory' | '24h';
            cachedInputTokens?: number;
            cacheWriteTokens?: number;
            cacheMissReason?: string | null;
        };
    };
}

/**
 * Provider interface for LLM chat completions.
 */
export interface ChatProvider {
    /**
     * Send messages to the LLM and get a response.
     * @param messages - Array of chat messages
     * @param options - Optional configuration (temperature, max tokens, etc.)
     */
    chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
}

/**
 * Options for chat completion requests.
 */
export interface ChatOptions {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    metadata?: ChatRequestMetadata;
    runtime?: ChatRuntimeOptions;
    /** Provider-specific options (e.g., reasoning for DeepSeek) */
    providerOptions?: {
        /** Enable reasoning mode for supported models (e.g., DeepSeek V3.2) */
        reasoning?: boolean;
        /** Provider-native prompt caching controls (OpenAI-compatible routers). */
        promptCaching?: {
            key?: string;
            retention?: 'in_memory' | '24h';
        };
    };
}
