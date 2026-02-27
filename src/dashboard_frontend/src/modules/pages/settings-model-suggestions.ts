export type ModelComplexity = 'simple' | 'complex';

function normalizeProvider(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

export function getModelSuggestion(
  provider: string | null | undefined,
  complexity: ModelComplexity
): string {
  const normalizedProvider = normalizeProvider(provider);

  if (normalizedProvider === 'codex') {
    return complexity === 'simple'
      ? 'e.g. gpt-<X.Y>-codex or gpt-<X.Y>-mini'
      : 'e.g. gpt-<X.Y>-codex or gpt-<X.Y>';
  }

  if (normalizedProvider === 'claude') {
    return complexity === 'simple'
      ? 'e.g. haiku, sonnet, or opus'
      : 'e.g. sonnet, opus, or haiku';
  }

  if (normalizedProvider === 'gemini') {
    return complexity === 'simple'
      ? 'e.g. gemini-<X.Y>-flash or gemini-<X.Y>-pro'
      : 'e.g. gemini-<X.Y>-pro or gemini-<X.Y>-flash';
  }

  if (normalizedProvider === 'opencode') {
    return 'e.g. provider/model';
  }

  return 'e.g. model-id';
}
