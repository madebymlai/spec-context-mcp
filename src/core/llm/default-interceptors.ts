import type { ChatInterceptor, InterceptorDecision } from './types.js';

const SECRET_PATTERNS: RegExp[] = [
    /\bsk-[A-Za-z0-9_-]{16,}\b/g, // common API token pattern
    /\b(authorization|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}["']?/gi,
    /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
];

function redactSecrets(input: string): { output: string; mutated: boolean } {
    let output = input;
    let mutated = false;

    for (const pattern of SECRET_PATTERNS) {
        const next = output.replace(pattern, '[REDACTED]');
        if (next !== output) {
            mutated = true;
            output = next;
        }
    }

    return { output, mutated };
}

export const redactionInterceptor: ChatInterceptor = {
    id: 'redaction_v1',
    criticality: 'best_effort',
    onSendPreCacheKey(request): InterceptorDecision {
        let changed = false;
        const messages = request.messages.map(message => {
            const result = redactSecrets(message.content);
            if (result.mutated) {
                changed = true;
                return {
                    ...message,
                    content: result.output,
                };
            }
            return message;
        });

        if (!changed) {
            return {
                action: 'allow',
                reasonCode: 'noop',
            };
        }

        return {
            action: 'mutate',
            reasonCode: 'pii_redacted',
            messages,
            mutatedFields: ['messages[*].content'],
        };
    },
};
