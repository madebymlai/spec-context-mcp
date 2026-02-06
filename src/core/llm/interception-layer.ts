import type {
    ChatInterceptionReport,
    ChatInterceptionRequest,
    ChatInterceptor,
    InterceptorContext,
    InterceptorDecision,
    InterceptorHook,
} from './types.js';

export interface InterceptionChainResult {
    request: ChatInterceptionRequest;
    reports: ChatInterceptionReport[];
    dropped: boolean;
    dropReasonCode: string | null;
}

const DEFAULT_PER_HOOK_BUDGET_MS = 5;
const DEFAULT_TOTAL_CHAIN_BUDGET_MS = 20;

function cloneRequest(request: ChatInterceptionRequest): ChatInterceptionRequest {
    return {
        model: request.model,
        options: request.options,
        messages: request.messages.map(message => ({ ...message })),
    };
}

export class InterceptionLayer {
    constructor(
        private readonly perHookBudgetMs: number = DEFAULT_PER_HOOK_BUDGET_MS,
        private readonly totalChainBudgetMs: number = DEFAULT_TOTAL_CHAIN_BUDGET_MS
    ) {}

    async run(
        hook: InterceptorHook,
        request: ChatInterceptionRequest,
        interceptors: ChatInterceptor[],
        context: InterceptorContext
    ): Promise<InterceptionChainResult> {
        const reports: ChatInterceptionReport[] = [];
        let current = request;
        let copied = false;
        const startedAt = Date.now();

        for (const interceptor of interceptors) {
            if (Date.now() - startedAt > this.totalChainBudgetMs) {
                reports.push({
                    interceptor_id: interceptor.id,
                    criticality: interceptor.criticality,
                    action: 'allow',
                    reason_code: 'chain_budget_exceeded',
                    mutated_fields: [],
                    duration_ms: 0,
                });
                continue;
            }

            const handler = this.resolveHandler(interceptor, hook);
            if (!handler) {
                continue;
            }

            const hookStart = Date.now();
            let decision: InterceptorDecision;

            try {
                decision = await handler(current, context);
            } catch (error) {
                const durationMs = Date.now() - hookStart;
                if (interceptor.criticality === 'critical') {
                    throw new Error(
                        `Critical interceptor "${interceptor.id}" failed on ${hook}: ${
                            error instanceof Error ? error.message : String(error)
                        }`
                    );
                }

                reports.push({
                    interceptor_id: interceptor.id,
                    criticality: interceptor.criticality,
                    action: 'allow',
                    reason_code: 'interceptor_error',
                    mutated_fields: [],
                    duration_ms: durationMs,
                });
                continue;
            }

            const durationMs = Date.now() - hookStart;
            const reasonCode = decision.reasonCode || 'noop';

            if (durationMs > this.perHookBudgetMs) {
                reports.push({
                    interceptor_id: interceptor.id,
                    criticality: interceptor.criticality,
                    action: 'allow',
                    reason_code: 'hook_budget_exceeded',
                    mutated_fields: [],
                    duration_ms: durationMs,
                });
            }

            if (decision.action === 'drop') {
                reports.push({
                    interceptor_id: interceptor.id,
                    criticality: interceptor.criticality,
                    action: 'drop',
                    reason_code: reasonCode,
                    mutated_fields: [],
                    duration_ms: durationMs,
                });

                return {
                    request: current,
                    reports,
                    dropped: true,
                    dropReasonCode: reasonCode,
                };
            }

            if (decision.action === 'mutate') {
                if (hook === 'on_send_post_route') {
                    throw new Error(
                        `Interceptor "${interceptor.id}" attempted forbidden mutation at ${hook}`
                    );
                }
                if (!copied) {
                    current = cloneRequest(current);
                    copied = true;
                }

                if (decision.messages) {
                    current.messages = decision.messages.map(message => ({ ...message }));
                }

                if (decision.model) {
                    current.model = decision.model;
                }

                reports.push({
                    interceptor_id: interceptor.id,
                    criticality: interceptor.criticality,
                    action: 'mutate',
                    reason_code: reasonCode,
                    mutated_fields: decision.mutatedFields ?? [],
                    duration_ms: durationMs,
                });
                continue;
            }

            reports.push({
                interceptor_id: interceptor.id,
                criticality: interceptor.criticality,
                action: 'allow',
                reason_code: reasonCode,
                mutated_fields: [],
                duration_ms: durationMs,
            });
        }

        return {
            request: current,
            reports,
            dropped: false,
            dropReasonCode: null,
        };
    }

    private resolveHandler(
        interceptor: ChatInterceptor,
        hook: InterceptorHook
    ):
        | ((
              request: Readonly<ChatInterceptionRequest>,
              context: Readonly<InterceptorContext>
          ) => Promise<InterceptorDecision> | InterceptorDecision)
        | undefined {
        if (hook === 'on_ingress') {
            return interceptor.onIngress;
        }

        if (hook === 'on_send_pre_cache_key') {
            return interceptor.onSendPreCacheKey;
        }

        return interceptor.onSendPostRoute;
    }
}
