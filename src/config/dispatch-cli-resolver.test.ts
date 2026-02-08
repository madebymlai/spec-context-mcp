import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDispatchCommandForComplexity } from './dispatch-cli-resolver.js';

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
    delete process.env.SPEC_CONTEXT_IMPLEMENTER_REASONING_EFFORT;
    delete process.env.SPEC_CONTEXT_REVIEWER_REASONING_EFFORT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('appends model flags for claude tiers', () => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'claude';
    process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE = 'sonnet-4.5';
    process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_COMPLEX = 'opus-4.6';

    expect(getDispatchCommandForComplexity('implementer', 'simple')?.args).toContain('sonnet-4.5');
    expect(getDispatchCommandForComplexity('implementer', 'complex')?.args).toContain('opus-4.6');
  });

  it('appends model and reasoning effort for codex tiers', () => {
    process.env.SPEC_CONTEXT_REVIEWER = 'codex';
    process.env.SPEC_CONTEXT_REVIEWER_MODEL_SIMPLE = 'codex-5.3';
    process.env.SPEC_CONTEXT_REVIEWER_REASONING_EFFORT = 'medium';

    const command = getDispatchCommandForComplexity('reviewer', 'simple');
    expect(command?.args).toContain('codex-5.3');
    expect(command?.args).toContain('model_reasoning_effort=medium');
  });

  it('uses non-tiered reasoning effort when set', () => {
    process.env.SPEC_CONTEXT_REVIEWER = 'codex';
    process.env.SPEC_CONTEXT_REVIEWER_MODEL_COMPLEX = 'codex-5.3';
    process.env.SPEC_CONTEXT_REVIEWER_REASONING_EFFORT = 'xhigh';

    const command = getDispatchCommandForComplexity('reviewer', 'complex');
    expect(command?.args).toContain('codex-5.3');
    expect(command?.args).toContain('model_reasoning_effort=xhigh');
  });

  it('fails loud when role env does not resolve to known provider', () => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'my-agent --headless';
    expect(() => getDispatchCommandForComplexity('implementer', 'simple')).toThrow(
      'SPEC_CONTEXT_IMPLEMENTER must reference a known provider; received "my-agent --headless"'
    );
  });
});
