import { describe, expect, it } from 'vitest';
import { PromptTemplateRegistry } from './prompt-template-registry.js';

describe('PromptTemplateRegistry', () => {
    it('compiles prompt segments in deterministic kind order', () => {
        const registry = new PromptTemplateRegistry();
        registry.register({
            templateId: 'dispatch',
            version: 'v1',
            segments: [
                { kind: 'examples', stable: true, content: 'examples-segment' },
                { kind: 'dynamic', stable: false, content: 'dynamic-template-segment' },
                { kind: 'system', stable: true, content: 'system-segment' },
                { kind: 'tools', stable: true, content: 'tools-segment' },
                { kind: 'custom', stable: true, content: 'custom-segment' },
            ],
        });

        const compiled = registry.compile('dispatch', 'v1', 'dynamic-tail');
        expect(compiled.text).toBe(
            [
                'tools-segment',
                'system-segment',
                'examples-segment',
                'dynamic-template-segment',
                'custom-segment',
                'dynamic-tail',
            ].join('\n\n')
        );
    });

    it('keeps appended dynamic tail out of stable prefix hash', () => {
        const registry = new PromptTemplateRegistry();
        registry.register({
            templateId: 'dispatch',
            version: 'v1',
            segments: [
                { kind: 'system', stable: true, content: 'stable-system' },
                { kind: 'examples', stable: true, content: 'stable-examples' },
            ],
        });

        const first = registry.compile('dispatch', 'v1', 'dynamic-1');
        const second = registry.compile('dispatch', 'v1', 'dynamic-2');

        expect(first.stablePrefix).toBe('stable-system\n\nstable-examples');
        expect(first.stablePrefix).not.toContain('dynamic-1');
        expect(second.stablePrefix).not.toContain('dynamic-2');
        expect(first.stablePrefixHash).toBe(second.stablePrefixHash);
        expect(first.fullPromptHash).not.toBe(second.fullPromptHash);
    });

    it('changes stable prefix hash when stable segment content changes', () => {
        const registry = new PromptTemplateRegistry();
        registry.register({
            templateId: 'dispatch',
            version: 'v1',
            segments: [{ kind: 'system', stable: true, content: 'stable-v1' }],
        });
        registry.register({
            templateId: 'dispatch',
            version: 'v2',
            segments: [{ kind: 'system', stable: true, content: 'stable-v2' }],
        });

        const v1 = registry.compile('dispatch', 'v1', 'dynamic');
        const v2 = registry.compile('dispatch', 'v2', 'dynamic');

        expect(v1.stablePrefixHash).not.toBe(v2.stablePrefixHash);
    });
});
