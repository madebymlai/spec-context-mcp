import type { BudgetCandidate, BudgetDecision, BudgetPolicy, BudgetRequest } from './types.js';

export interface BudgetFilterResult {
    decision: BudgetDecision;
    candidates: BudgetCandidate[];
    selectedCandidate: BudgetCandidate | null;
}

export interface IBudgetGuard {
    filterCandidates(
        request: BudgetRequest,
        candidates: BudgetCandidate[],
        policy: BudgetPolicy,
        preferredModel?: string
    ): BudgetFilterResult;
}

function estimateRequestCostUsd(candidate: BudgetCandidate, request: BudgetRequest): number {
    const inputCost = (request.estimatedInputTokens / 1000) * candidate.estimatedInputCostUsdPer1k;
    const outputCost = (request.estimatedOutputTokens / 1000) * candidate.estimatedOutputCostUsdPer1k;
    return inputCost + outputCost;
}

function hasRequiredTags(candidate: BudgetCandidate, policy: BudgetPolicy): boolean {
    if (!policy.allowedTags || policy.allowedTags.length === 0) {
        return true;
    }

    const tags = new Set(candidate.tags ?? []);
    return policy.allowedTags.every(tag => tags.has(tag));
}

function hasDeniedTags(candidate: BudgetCandidate, policy: BudgetPolicy): boolean {
    if (!policy.deniedTags || policy.deniedTags.length === 0) {
        return false;
    }

    const tags = new Set(candidate.tags ?? []);
    return policy.deniedTags.some(tag => tags.has(tag));
}

export function filterBudgetCandidates(
    request: BudgetRequest,
    candidates: BudgetCandidate[],
    policy: BudgetPolicy,
    preferredModel?: string
): BudgetFilterResult {
    const reasonCodes = new Set<string>();
    const beforeCount = candidates.length;

    const filtered = candidates.filter(candidate => {
        if (!hasRequiredTags(candidate, policy)) {
            reasonCodes.add('missing_required_tag');
            return false;
        }

        if (hasDeniedTags(candidate, policy)) {
            reasonCodes.add('denied_tag');
            return false;
        }

        const estimatedCost = estimateRequestCostUsd(candidate, request);
        const modelCap = policy.maxCostUsdPerModel?.[candidate.model];
        if (typeof modelCap === 'number' && estimatedCost > modelCap) {
            reasonCodes.add('model_budget_exceeded');
            return false;
        }

        if (typeof policy.maxCostUsdPerRequest === 'number' && estimatedCost > policy.maxCostUsdPerRequest) {
            reasonCodes.add('provider_budget_exceeded');
            return false;
        }

        return true;
    });

    if (filtered.length > 0) {
        const selected =
            filtered.find(candidate => candidate.model === preferredModel) ??
            filtered[0];

        return {
            decision: {
                decision: 'allow',
                reason_codes: ['within_budget'],
                candidate_count_before: beforeCount,
                candidate_count_after: filtered.length,
                degraded_model: null,
                retry_after_s: 0,
            },
            candidates: filtered,
            selectedCandidate: selected,
        };
    }

    const emergencyModel = policy.emergencyModelId
        ? candidates.find(candidate => candidate.model === policy.emergencyModelId)
        : undefined;
    const allowEmergency = Boolean(policy.allowEmergencyDegrade && request.interactive && emergencyModel);

    if (allowEmergency && emergencyModel) {
        const emergencyCost = estimateRequestCostUsd(emergencyModel, request);
        if (
            typeof policy.maxEmergencyCostUsdPerRequest !== 'number' ||
            emergencyCost <= policy.maxEmergencyCostUsdPerRequest
        ) {
            return {
                decision: {
                    decision: 'degrade',
                    reason_codes: ['provider_budget_exceeded', 'emergency_model_allowed'],
                    candidate_count_before: beforeCount,
                    candidate_count_after: 1,
                    degraded_model: emergencyModel.model,
                    retry_after_s: 0,
                },
                candidates: [emergencyModel],
                selectedCandidate: emergencyModel,
            };
        }
        reasonCodes.add('emergency_budget_exceeded');
    }

    const interactive = request.interactive ?? true;
    if (!interactive) {
        return {
            decision: {
                decision: 'queue',
                reason_codes: Array.from(reasonCodes.size > 0 ? reasonCodes : new Set(['provider_budget_exceeded'])).concat('non_interactive_queue'),
                candidate_count_before: beforeCount,
                candidate_count_after: 0,
                degraded_model: null,
                retry_after_s: policy.retryAfterSeconds ?? 900,
            },
            candidates: [],
            selectedCandidate: null,
        };
    }

    return {
        decision: {
            decision: 'deny',
            reason_codes: Array.from(reasonCodes.size > 0 ? reasonCodes : new Set(['provider_budget_exceeded'])),
            candidate_count_before: beforeCount,
            candidate_count_after: 0,
            degraded_model: null,
            retry_after_s: policy.retryAfterSeconds ?? 3600,
        },
        candidates: [],
        selectedCandidate: null,
    };
}

export class BudgetGuard implements IBudgetGuard {
    filterCandidates(
        request: BudgetRequest,
        candidates: BudgetCandidate[],
        policy: BudgetPolicy,
        preferredModel?: string
    ): BudgetFilterResult {
        return filterBudgetCandidates(request, candidates, policy, preferredModel);
    }
}
