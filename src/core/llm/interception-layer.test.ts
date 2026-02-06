import { describe, expect, it } from 'vitest';
import { InterceptionLayer } from './interception-layer.js';
import type { ChatInterceptor } from './types.js';

describe('InterceptionLayer', () => {
    it('applies mutations in-order and reports them', async () => {
        const layer = new InterceptionLayer();
        const interceptors: ChatInterceptor[] = [
            {
                id: 'mutate-1',
                criticality: 'best_effort',
                onSendPreCacheKey(request) {
                    return {
                        action: 'mutate',
                        reasonCode: 'normalized',
                        messages: request.messages.map(message => ({
                            ...message,
                            content: message.content.replace('SECRET', '[REDACTED]'),
                        })),
                        mutatedFields: ['messages[0].content'],
                    };
                },
            },
        ];

        const result = await layer.run(
            'on_send_pre_cache_key',
            {
                model: 'test-model',
                options: {},
                messages: [{ role: 'user', content: 'contains SECRET token' }],
            },
            interceptors,
            {
                hook: 'on_send_pre_cache_key',
                requestId: 'req-1',
                runId: 'run-1',
                stepId: 'step-1',
                ts: new Date().toISOString(),
            }
        );

        expect(result.dropped).toBe(false);
        expect(result.request.messages[0]?.content).toContain('[REDACTED]');
        expect(result.reports[0]?.action).toBe('mutate');
    });

    it('fails closed for critical interceptor errors', async () => {
        const layer = new InterceptionLayer();
        const interceptors: ChatInterceptor[] = [
            {
                id: 'critical-fail',
                criticality: 'critical',
                onIngress() {
                    throw new Error('boom');
                },
            },
        ];

        await expect(
            layer.run(
                'on_ingress',
                {
                    model: 'test-model',
                    options: {},
                    messages: [{ role: 'user', content: 'hello' }],
                },
                interceptors,
                {
                    hook: 'on_ingress',
                    requestId: 'req-1',
                    runId: 'run-1',
                    stepId: 'step-1',
                    ts: new Date().toISOString(),
                }
            )
        ).rejects.toThrow(/critical interceptor/i);
    });

    it('skips slow best_effort interceptor with hook_budget_exceeded report', async () => {
        const layer = new InterceptionLayer(5, 200);
        const interceptors: ChatInterceptor[] = [
            {
                id: 'slow-hook',
                criticality: 'best_effort',
                async onIngress() {
                    await new Promise(resolve => setTimeout(resolve, 50));
                    return { action: 'allow', reasonCode: 'should_not_reach' };
                },
            },
            {
                id: 'fast-hook',
                criticality: 'best_effort',
                onIngress() {
                    return { action: 'allow', reasonCode: 'fast_ok' };
                },
            },
        ];

        const result = await layer.run(
            'on_ingress',
            {
                model: 'test-model',
                options: {},
                messages: [{ role: 'user', content: 'hello' }],
            },
            interceptors,
            {
                hook: 'on_ingress',
                requestId: 'req-t',
                runId: 'run-t',
                stepId: 'step-t',
                ts: new Date().toISOString(),
            }
        );

        expect(result.dropped).toBe(false);
        const slowReport = result.reports.find(r => r.interceptor_id === 'slow-hook');
        expect(slowReport).toBeDefined();
        expect(slowReport!.reason_code).toBe('hook_budget_exceeded');
        const fastReport = result.reports.find(r => r.interceptor_id === 'fast-hook');
        expect(fastReport).toBeDefined();
        expect(fastReport!.reason_code).toBe('fast_ok');
    });

    it('rejects post-route mutations to preserve observe-only contract', async () => {
        const layer = new InterceptionLayer();
        const interceptors: ChatInterceptor[] = [
            {
                id: 'post-route-mutate',
                criticality: 'best_effort',
                onSendPostRoute(request) {
                    return {
                        action: 'mutate',
                        reasonCode: 'forbidden',
                        model: `${request.model}-mutated`,
                        mutatedFields: ['model'],
                    };
                },
            },
        ];

        await expect(
            layer.run(
                'on_send_post_route',
                {
                    model: 'test-model',
                    options: {},
                    messages: [{ role: 'user', content: 'hello' }],
                },
                interceptors,
                {
                    hook: 'on_send_post_route',
                    requestId: 'req-2',
                    runId: 'run-2',
                    stepId: 'step-2',
                    ts: new Date().toISOString(),
                }
            )
        ).rejects.toThrow(/forbidden mutation/i);
    });
});
