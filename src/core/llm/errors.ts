import type { BudgetDecision } from './types.js';

export class BudgetExceededError extends Error {
    readonly code = '429_budget_exceeded';
    constructor(
        message: string,
        readonly budgetDecision: BudgetDecision,
    ) {
        super(message);
        this.name = 'BudgetExceededError';
    }
}

export class InterceptorDroppedError extends Error {
    readonly code = 'interceptor_dropped';
    constructor(message: string) {
        super(message);
        this.name = 'InterceptorDroppedError';
    }
}
