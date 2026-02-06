export type CacheRetention = 'in_memory' | '24h';
export type LlmProvider = 'openrouter' | 'openai' | 'claude' | 'gemini';

export interface ProviderCacheRequest {
    model: string;
    promptCacheKey: string;
    promptCacheRetention: CacheRetention;
}

export interface ProviderCacheMutation {
    prompt_cache_key?: string;
    prompt_cache_retention?: '24h';
}

export interface ProviderCacheTelemetry {
    promptCacheKey: string;
    promptCacheRetention: CacheRetention;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    cacheMissReason: string | null;
}

export interface ProviderCacheAdapter {
    provider: LlmProvider;
    apply(request: ProviderCacheRequest): ProviderCacheMutation;
    extractTelemetry(usage: unknown, request: ProviderCacheRequest): ProviderCacheTelemetry;
}

function toRecord(value: unknown): Record<string, unknown> {
    return (typeof value === 'object' && value !== null) ? value as Record<string, unknown> : {};
}

function extractNestedNumber(record: Record<string, unknown>, key: string): number {
    const details = toRecord(record.prompt_tokens_details);
    const value = details[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

class OpenRouterCacheAdapter implements ProviderCacheAdapter {
    provider: LlmProvider = 'openrouter';

    apply(request: ProviderCacheRequest): ProviderCacheMutation {
        return {
            prompt_cache_key: request.promptCacheKey,
            ...(request.promptCacheRetention === '24h' ? { prompt_cache_retention: '24h' as const } : {}),
        };
    }

    extractTelemetry(usage: unknown, request: ProviderCacheRequest): ProviderCacheTelemetry {
        const usageRecord = toRecord(usage);
        const cachedInputTokens = extractNestedNumber(usageRecord, 'cached_tokens');
        const cacheWriteTokens = extractNestedNumber(usageRecord, 'cache_creation_input_tokens');
        return {
            promptCacheKey: request.promptCacheKey,
            promptCacheRetention: request.promptCacheRetention,
            cachedInputTokens,
            cacheWriteTokens,
            cacheMissReason: cachedInputTokens > 0 ? null : 'cache_not_hit',
        };
    }
}

class NoopCacheAdapter implements ProviderCacheAdapter {
    constructor(readonly provider: LlmProvider) {}

    apply(_request: ProviderCacheRequest): ProviderCacheMutation {
        return {};
    }

    extractTelemetry(_usage: unknown, request: ProviderCacheRequest): ProviderCacheTelemetry {
        return {
            promptCacheKey: request.promptCacheKey,
            promptCacheRetention: request.promptCacheRetention,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            cacheMissReason: 'provider_not_supported',
        };
    }
}

export class ProviderCacheAdapterFactory {
    static create(provider: LlmProvider): ProviderCacheAdapter {
        if (provider === 'openrouter') return new OpenRouterCacheAdapter();
        return new NoopCacheAdapter(provider);
    }
}
