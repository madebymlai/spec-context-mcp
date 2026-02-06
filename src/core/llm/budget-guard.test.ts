import { describe, expect, it } from 'vitest';
import { BudgetGuard } from './budget-guard.js';
import type { BudgetCandidate, BudgetPolicy } from './types.js';

const CANDIDATES: BudgetCandidate[] = [
    {
        id: 'cheap',
        model: 'cheap-model',
        estimatedInputCostUsdPer1k: 0.0002,
        estimatedOutputCostUsdPer1k: 0.0004,
        tags: ['budget', 'fast'],
    },
    {
        id: 'strong',
        model: 'strong-model',
        estimatedInputCostUsdPer1k: 0.002,
        estimatedOutputCostUsdPer1k: 0.004,
        tags: ['quality'],
    },
];

describe('BudgetGuard', () => {
    it('keeps preferred candidate when within budget', () => {
        const guard = new BudgetGuard();
        const policy: BudgetPolicy = { maxCostUsdPerRequest: 0.05 };
        const result = guard.filterCandidates(
            { estimatedInputTokens: 1000, estimatedOutputTokens: 500, interactive: true },
            CANDIDATES,
            policy,
            'strong-model'
        );

        expect(result.decision.decision).toBe('allow');
        expect(result.selectedCandidate?.model).toBe('strong-model');
    });

    it('denies when no candidate is affordable and no emergency path exists', () => {
        const guard = new BudgetGuard();
        const policy: BudgetPolicy = { maxCostUsdPerRequest: 0.0001 };
        const result = guard.filterCandidates(
            { estimatedInputTokens: 2000, estimatedOutputTokens: 1000, interactive: true },
            CANDIDATES,
            policy,
            'strong-model'
        );

        expect(result.decision.decision).toBe('deny');
        expect(result.selectedCandidate).toBeNull();
        expect(result.decision.candidate_count_after).toBe(0);
    });

    it('degrades to emergency model for interactive flows', () => {
        const guard = new BudgetGuard();
        const policy: BudgetPolicy = {
            maxCostUsdPerRequest: 0.0001,
            allowEmergencyDegrade: true,
            emergencyModelId: 'cheap-model',
            maxEmergencyCostUsdPerRequest: 0.01,
        };

        const result = guard.filterCandidates(
            { estimatedInputTokens: 2000, estimatedOutputTokens: 1000, interactive: true },
            CANDIDATES,
            policy,
            'strong-model'
        );

        expect(result.decision.decision).toBe('degrade');
        expect(result.selectedCandidate?.model).toBe('cheap-model');
        expect(result.decision.degraded_model).toBe('cheap-model');
    });

    it('queues non-interactive requests when no candidate is affordable', () => {
        const guard = new BudgetGuard();
        const policy: BudgetPolicy = {
            maxCostUsdPerRequest: 0.0001,
            retryAfterSeconds: 120,
        };

        const result = guard.filterCandidates(
            { estimatedInputTokens: 2000, estimatedOutputTokens: 1000, interactive: false },
            CANDIDATES,
            policy,
            'strong-model'
        );

        expect(result.decision.decision).toBe('queue');
        expect(result.selectedCandidate).toBeNull();
        expect(result.decision.retry_after_s).toBe(120);
        expect(result.decision.reason_codes).toContain('non_interactive_queue');
    });
});
