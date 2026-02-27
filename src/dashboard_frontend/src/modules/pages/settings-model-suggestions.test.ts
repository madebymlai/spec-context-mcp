import { describe, expect, it } from 'vitest';
import { getModelSuggestion } from './settings-model-suggestions';

describe('settings-model-suggestions', () => {
  it('returns codex templates for simple and complex', () => {
    expect(getModelSuggestion('codex', 'simple')).toContain('gpt-<X.Y>-codex');
    expect(getModelSuggestion('codex', 'complex')).toContain('gpt-<X.Y>');
  });

  it('returns claude family templates', () => {
    expect(getModelSuggestion('claude', 'simple')).toContain('haiku');
    expect(getModelSuggestion('claude', 'complex')).toContain('opus');
  });

  it('returns gemini family templates', () => {
    expect(getModelSuggestion('gemini', 'simple')).toContain('flash');
    expect(getModelSuggestion('gemini', 'complex')).toContain('pro');
  });

  it('returns opencode template', () => {
    expect(getModelSuggestion('opencode', 'simple')).toBe('e.g. provider/model');
  });

  it('falls back for unknown providers', () => {
    expect(getModelSuggestion('custom-provider', 'simple')).toBe('e.g. model-id');
    expect(getModelSuggestion(null, 'complex')).toBe('e.g. model-id');
  });
});
