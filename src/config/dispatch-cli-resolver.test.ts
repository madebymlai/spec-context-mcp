import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDispatchCliForComplexity } from './dispatch-cli-resolver.js';

describe('dispatch-cli-resolver', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SPEC_CONTEXT_IMPLEMENTER;
    delete process.env.SPEC_CONTEXT_REVIEWER;
    delete process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE;
    delete process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_COMPLEX;
    delete process.env.SPEC_CONTEXT_REVIEWER_MODEL_SIMPLE;
    delete process.env.SPEC_CONTEXT_REVIEWER_MODEL_COMPLEX;
    delete process.env.SPEC_CONTEXT_IMPLEMENTER_REASONING_EFFORT_SIMPLE;
    delete process.env.SPEC_CONTEXT_IMPLEMENTER_REASONING_EFFORT_COMPLEX;
    delete process.env.SPEC_CONTEXT_REVIEWER_REASONING_EFFORT_SIMPLE;
    delete process.env.SPEC_CONTEXT_REVIEWER_REASONING_EFFORT_COMPLEX;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('appends model flags for claude tiers', () => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'claude';
    process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE = 'sonnet-4.5';
    process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_COMPLEX = 'opus-4.6';

    expect(getDispatchCliForComplexity('implementer', 'simple')).toContain('--model sonnet-4.5');
    expect(getDispatchCliForComplexity('implementer', 'complex')).toContain('--model opus-4.6');
  });

  it('appends model and reasoning effort for codex tiers', () => {
    process.env.SPEC_CONTEXT_REVIEWER = 'codex';
    process.env.SPEC_CONTEXT_REVIEWER_MODEL_SIMPLE = 'codex-5.3';
    process.env.SPEC_CONTEXT_REVIEWER_REASONING_EFFORT_SIMPLE = 'medium';

    const command = getDispatchCliForComplexity('reviewer', 'simple');
    expect(command).toContain('--model codex-5.3');
    expect(command).toContain('model_reasoning_effort=medium');
  });

  it('keeps custom commands unchanged', () => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'my-agent --headless';
    process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE = 'ignored-model';
    expect(getDispatchCliForComplexity('implementer', 'simple')).toBe('my-agent --headless');
  });
});
