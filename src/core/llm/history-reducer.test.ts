import { describe, expect, it } from 'vitest';
import { HistoryReducer } from './history-reducer.js';

describe('HistoryReducer', () => {
    it('keeps call/result pairs when reducing', () => {
        const reducer = new HistoryReducer();
        const result = reducer.reduce(
            [
                { role: 'system', content: 'system rules' },
                { role: 'user', content: `old question ${'A'.repeat(400)}` },
                { role: 'assistant', content: 'calling tool', pairId: 't1', pairRole: 'call' },
                { role: 'tool', content: 'tool output', pairId: 't1', pairRole: 'result', toolCallId: 't1' },
                { role: 'user', content: 'latest question' },
            ],
            {
                enabled: true,
                maxInputChars: 140,
                preserveRecentRawTurns: 2,
            }
        );

        const pairMessages = result.messages.filter(message => message.pairId === 't1');
        expect(pairMessages).toHaveLength(2);
    });

    it('includes tagged unresolved and constraint messages in summary', () => {
        const reducer = new HistoryReducer();
        const result = reducer.reduce(
            [
                { role: 'system', content: 'system rules' },
                { role: 'user', content: `old question ${'A'.repeat(400)}` },
                { role: 'user', content: 'Fix the login bug', tags: ['unresolved'] },
                { role: 'user', content: 'Max response time must be under 200ms', tags: ['constraint'] },
                { role: 'user', content: 'latest question' },
            ],
            {
                enabled: true,
                maxInputChars: 450,
                preserveRecentRawTurns: 1,
                summaryMaxChars: 1400,
            }
        );

        expect(result.reduced).toBe(true);
        const summaryMessage = result.messages.find(
            m => m.role === 'system' && m.content.includes('Conversation summary')
        );
        expect(summaryMessage).toBeDefined();
        expect(summaryMessage!.content).toContain('Fix the login bug');
        expect(summaryMessage!.content).toContain('Max response time');
    });

    it('falls back safely when max budget is too small', () => {
        const reducer = new HistoryReducer();
        const result = reducer.reduce(
            [
                { role: 'system', content: 'system instructions' },
                { role: 'user', content: 'A'.repeat(400) },
                { role: 'assistant', content: 'B'.repeat(400) },
                { role: 'user', content: 'latest turn' },
            ],
            {
                enabled: true,
                maxInputChars: 20,
                preserveRecentRawTurns: 1,
            }
        );

        expect(result.invariantStatus).toBe('fallback');
        expect(result.messages.some(message => message.role === 'system')).toBe(true);
        expect(result.messages[result.messages.length - 1]?.content).toContain('latest');
    });
});
