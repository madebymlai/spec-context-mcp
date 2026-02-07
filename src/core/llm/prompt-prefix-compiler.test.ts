import { describe, expect, it } from 'vitest';
import { PromptPrefixCompiler } from './prompt-prefix-compiler.js';
import type { ChatMessage } from './types.js';

describe('PromptPrefixCompiler', () => {
    it('keeps stable prefix hash when only dynamic tail changes', () => {
        const compiler = new PromptPrefixCompiler();
        const baseMessages: ChatMessage[] = [
            { role: 'system', content: 'stable-system' },
            { role: 'user', content: 'dynamic-a' },
        ];

        const first = compiler.compile({
            model: 'dispatch-implementer',
            messages: baseMessages,
            jsonMode: true,
            dynamicTailMessages: 1,
        });
        const second = compiler.compile({
            model: 'dispatch-implementer',
            messages: [
                { role: 'system', content: 'stable-system' },
                { role: 'user', content: 'dynamic-b' },
            ] as ChatMessage[],
            jsonMode: true,
            dynamicTailMessages: 1,
        });

        expect(first.stablePrefixHash).toBe(second.stablePrefixHash);
        expect(first.dynamicTailHash).not.toBe(second.dynamicTailHash);
        expect(first.cacheKey).not.toBe(second.cacheKey);
    });

    it('changes stable prefix hash when stable prefix changes', () => {
        const compiler = new PromptPrefixCompiler();

        const modelChanged = compiler.compile({
            model: 'dispatch-reviewer',
            messages: [
                { role: 'system', content: 'stable-system' },
                { role: 'user', content: 'dynamic-a' },
            ] as ChatMessage[],
            jsonMode: true,
            dynamicTailMessages: 1,
        });
        const modelBaseline = compiler.compile({
            model: 'dispatch-implementer',
            messages: [
                { role: 'system', content: 'stable-system' },
                { role: 'user', content: 'dynamic-a' },
            ] as ChatMessage[],
            jsonMode: true,
            dynamicTailMessages: 1,
        });
        expect(modelChanged.stablePrefixHash).not.toBe(modelBaseline.stablePrefixHash);

        const systemChanged = compiler.compile({
            model: 'dispatch-implementer',
            messages: [
                { role: 'system', content: 'stable-system-updated' },
                { role: 'user', content: 'dynamic-a' },
            ] as ChatMessage[],
            jsonMode: true,
            dynamicTailMessages: 1,
        });
        expect(systemChanged.stablePrefixHash).not.toBe(modelBaseline.stablePrefixHash);
    });
});
