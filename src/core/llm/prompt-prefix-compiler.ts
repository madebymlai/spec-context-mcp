import { createHash } from 'crypto';
import type { ChatMessage } from './types.js';

export interface PromptPrefixCompileInput {
    model: string;
    messages: ChatMessage[];
    jsonMode: boolean;
    dynamicTailMessages?: number;
}

export interface PromptPrefixCompileResult {
    stablePrefixHash: string;
    dynamicTailHash: string;
    cacheKey: string;
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function normalizeMessages(messages: ChatMessage[]): Array<{ role: string; content: string }> {
    return messages.map(message => ({
        role: message.role,
        content: message.content,
    }));
}

export class PromptPrefixCompiler {
    compile(input: PromptPrefixCompileInput): PromptPrefixCompileResult {
        const normalizedMessages = normalizeMessages(input.messages);
        const dynamicTailMessages = Math.max(1, input.dynamicTailMessages ?? 1);
        const splitIndex = Math.max(0, normalizedMessages.length - dynamicTailMessages);

        const stablePrefix = JSON.stringify({
            model: input.model,
            jsonMode: input.jsonMode,
            messages: normalizedMessages.slice(0, splitIndex),
        });

        const dynamicTail = JSON.stringify({
            messages: normalizedMessages.slice(splitIndex),
        });

        const stablePrefixHash = sha256(stablePrefix);
        const dynamicTailHash = sha256(dynamicTail);
        const cacheKey = sha256(`${stablePrefixHash}:${dynamicTailHash}`);

        return {
            stablePrefixHash,
            dynamicTailHash,
            cacheKey,
        };
    }
}
