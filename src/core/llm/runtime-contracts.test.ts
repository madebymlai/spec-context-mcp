import { describe, expect, it } from 'vitest';
import { SchemaRegistry } from './schema-registry.js';
import { PromptTemplateRegistry } from './prompt-template-registry.js';
import { TelemetryMeter } from './telemetry-meter.js';
import { RuntimeEventStream } from './runtime-event-stream.js';
import { StateProjector } from './state-projector.js';

describe('Runtime contract modules', () => {
    it('validates payloads through schema registry', () => {
        const registry = new SchemaRegistry();
        registry.register('budget.decision', 'budget_decision', 'v2', payload => {
            return typeof payload === 'object' && payload !== null && 'decision' in payload;
        });

        expect(registry.validate('budget.decision', { decision: 'allow' }, 'v2')).toBe(true);
        expect(registry.validate('budget.decision', { nope: true }, 'v2')).toBe(false);
    });

    it('compiles deterministic prompt templates with stable prefix hashes', () => {
        const templates = new PromptTemplateRegistry();
        templates.register({
            templateId: 'review',
            version: 'v1',
            segments: [
                { kind: 'system', stable: true, content: 'You are strict.' },
                { kind: 'tools', stable: true, content: 'Tool definitions...' },
                { kind: 'examples', stable: true, content: 'Example output...' },
            ],
        });

        const compiled = templates.compile('review', 'v1', 'User request');
        expect(compiled.text).toContain('User request');
        expect(compiled.stablePrefixHash.length).toBe(64);
        expect(compiled.fullPromptHash.length).toBe(64);
    });

    it('projects events and captures telemetry', () => {
        const stream = new RuntimeEventStream({ disablePersistence: true });
        const projector = new StateProjector();
        const telemetry = new TelemetryMeter();

        const event = stream.publish({
            partition_key: 'run-1',
            run_id: 'run-1',
            step_id: 'response',
            agent_id: 'agent',
            type: 'LLM_RESPONSE',
            payload: { tokens_used: 100 },
        });

        const projected = projector.apply({ event, previous: null });
        telemetry.record({ provider: 'openai', model: 'gpt', inputTokens: 200, outputTokens: 100, cachedInputTokens: 150 });

        expect(projected.status).toBe('done');
        expect(projected.appliedOffset.sequence).toBe(1);
        expect(telemetry.snapshot().totalCachedInputTokens).toBe(150);
    });
});
