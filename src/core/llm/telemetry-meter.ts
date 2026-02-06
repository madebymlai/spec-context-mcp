export interface RuntimeUsageSample {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
    latencyMs?: number;
}

export interface RuntimeTelemetrySnapshot {
    requests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedInputTokens: number;
    totalCacheWriteTokens: number;
    totalCostUsd: number;
    avgLatencyMs: number;
}

export class TelemetryMeter {
    private requests = 0;
    private totalInputTokens = 0;
    private totalOutputTokens = 0;
    private totalCachedInputTokens = 0;
    private totalCacheWriteTokens = 0;
    private totalCostUsd = 0;
    private totalLatencyMs = 0;

    record(sample: RuntimeUsageSample): void {
        this.requests += 1;
        this.totalInputTokens += sample.inputTokens;
        this.totalOutputTokens += sample.outputTokens;
        this.totalCachedInputTokens += sample.cachedInputTokens ?? 0;
        this.totalCacheWriteTokens += sample.cacheWriteTokens ?? 0;
        this.totalCostUsd += sample.costUsd ?? 0;
        this.totalLatencyMs += sample.latencyMs ?? 0;
    }

    snapshot(): RuntimeTelemetrySnapshot {
        return {
            requests: this.requests,
            totalInputTokens: this.totalInputTokens,
            totalOutputTokens: this.totalOutputTokens,
            totalCachedInputTokens: this.totalCachedInputTokens,
            totalCacheWriteTokens: this.totalCacheWriteTokens,
            totalCostUsd: Number(this.totalCostUsd.toFixed(6)),
            avgLatencyMs: this.requests > 0 ? this.totalLatencyMs / this.requests : 0,
        };
    }

    reset(): void {
        this.requests = 0;
        this.totalInputTokens = 0;
        this.totalOutputTokens = 0;
        this.totalCachedInputTokens = 0;
        this.totalCacheWriteTokens = 0;
        this.totalCostUsd = 0;
        this.totalLatencyMs = 0;
    }
}
