import { describe, expect, it } from 'vitest';
import { resolveDispatchOutputMode, resolveDispatchProvider } from './dispatch-output-mode.js';

describe('dispatch-output-mode', () => {
  it('resolves known providers from aliases', () => {
    expect(resolveDispatchProvider('claude')).toBe('claude');
    expect(resolveDispatchProvider('codex-cli --full-auto')).toBe('codex');
    expect(resolveDispatchProvider('gemini --yolo')).toBe('gemini');
    expect(resolveDispatchProvider('opencode run')).toBe('opencode');
  });

  it('returns unsupported when provider env is missing', () => {
    const result = resolveDispatchOutputMode({
      role: 'implementer',
      env: {},
    });
    expect(result.decision).toBe('unsupported');
    expect(result.errorCode).toBe('provider_not_configured');
  });

  it('returns unsupported for unknown provider', () => {
    const result = resolveDispatchOutputMode({
      role: 'reviewer',
      env: { SPEC_CONTEXT_REVIEWER: 'my-custom-agent --headless' },
    });
    expect(result.decision).toBe('unsupported');
    expect(result.errorCode).toBe('mode_unsupported');
  });

  it('returns schema_constrained for supported providers', () => {
    const implementer = resolveDispatchOutputMode({
      role: 'implementer',
      env: { SPEC_CONTEXT_IMPLEMENTER: 'claude' },
    });
    expect(implementer.decision).toBe('schema_constrained');
    expect(implementer.mode).toBe('schema_constrained');

    const reviewer = resolveDispatchOutputMode({
      role: 'reviewer',
      env: { SPEC_CONTEXT_REVIEWER: 'codex' },
    });
    expect(reviewer.decision).toBe('schema_constrained');
    expect(reviewer.mode).toBe('schema_constrained');
  });
});

