import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatOptions, ChatProvider, ChatResponse } from '../../core/llm/index.js';
import { AiReviewService } from './ai-review-service.js';

class MockChatProvider implements ChatProvider {
    public calls: Array<{ messages: ChatMessage[]; options?: ChatOptions }> = [];

    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
        this.calls.push({
            messages: messages.map(message => ({ ...message })),
            options: options ? { ...options } : undefined,
        });
        return {
            content: JSON.stringify({
                suggestions: [
                    {
                        comment: 'Looks good',
                    },
                ],
            }),
            model: options?.model ?? 'mock-model',
            usage: {
                promptTokens: 100,
                completionTokens: 20,
                totalTokens: 120,
            },
        };
    }
}

describe('AiReviewService', () => {
    it('reuses unchanged sections through snapshot-backed context packets', async () => {
        const chatProvider = new MockChatProvider();
        const service = new AiReviewService('test-key', {
            chatProvider,
        });

        const commonSteering = {
            product: '# Product\nBuild a fast system',
            tech: '# Tech\nTypeScript',
        };

        await service.reviewDocument(
            '# Tasks\n- [ ] task 1',
            'deepseek-v3',
            commonSteering,
            {
                requirements: '# Requirements\nMust be reliable',
            },
            {
                runId: 'run-reuse',
            }
        );

        await service.reviewDocument(
            '# Tasks\n- [ ] task 2',
            'deepseek-v3',
            commonSteering,
            {
                requirements: '# Requirements\nMust be reliable',
            },
            {
                runId: 'run-reuse',
            }
        );

        const secondCallPrompt = chatProvider.calls[1]?.messages[1]?.content ?? '';
        expect(secondCallPrompt).toContain('[UNCHANGED]');

        await service.flushRuntimeState();
    });

    it('enforces hard deny budget policy when emergency degrade is disabled', async () => {
        const chatProvider = new MockChatProvider();
        const service = new AiReviewService('test-key', {
            chatProvider,
            budgetPolicy: {
                maxCostUsdPerRequest: 0.000001,
                allowEmergencyDegrade: false,
            },
            defaultMaxOutputTokens: 4000,
        });

        await expect(
            service.reviewDocument('# Document\nSome content')
        ).rejects.toThrow(/429_budget_exceeded/i);
    });
});
