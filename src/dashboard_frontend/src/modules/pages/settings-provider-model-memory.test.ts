import { describe, expect, it } from 'vitest';
import { createEmptyRuntimeSettingsDraft } from './settings-runtime-config';
import {
  applyModelFieldUpdate,
  applyProviderSwitch,
  buildRuntimeProviderModelMemory,
} from './settings-provider-model-memory';

describe('settings-provider-model-memory', () => {
  it('clears model fields when switching to a provider with no stored values', () => {
    const draft = {
      ...createEmptyRuntimeSettingsDraft(),
      implementer: 'codex',
      implementerModelSimple: 'gpt-5.3-codex',
      implementerModelComplex: 'gpt-5.3-codex',
    };
    const memory = buildRuntimeProviderModelMemory(draft);

    const switched = applyProviderSwitch({
      draft,
      memory,
      role: 'implementer',
      nextProvider: 'claude',
    });

    expect(switched.draft.implementer).toBe('claude');
    expect(switched.draft.implementerModelSimple).toBeNull();
    expect(switched.draft.implementerModelComplex).toBeNull();
  });

  it('restores previous model fields when switching back to old provider', () => {
    const initialDraft = {
      ...createEmptyRuntimeSettingsDraft(),
      implementer: 'codex',
      implementerModelSimple: 'gpt-5.3-codex',
      implementerModelComplex: 'gpt-5.3-codex',
    };
    const initialMemory = buildRuntimeProviderModelMemory(initialDraft);

    const toClaude = applyProviderSwitch({
      draft: initialDraft,
      memory: initialMemory,
      role: 'implementer',
      nextProvider: 'claude',
    });

    const claudeEdited = applyModelFieldUpdate({
      draft: toClaude.draft,
      memory: toClaude.memory,
      field: 'implementerModelSimple',
      value: 'sonnet',
    });
    const claudeEditedComplex = applyModelFieldUpdate({
      draft: claudeEdited.draft,
      memory: claudeEdited.memory,
      field: 'implementerModelComplex',
      value: 'opus',
    });

    const backToCodex = applyProviderSwitch({
      draft: claudeEditedComplex.draft,
      memory: claudeEditedComplex.memory,
      role: 'implementer',
      nextProvider: 'codex',
    });

    expect(backToCodex.draft.implementer).toBe('codex');
    expect(backToCodex.draft.implementerModelSimple).toBe('gpt-5.3-codex');
    expect(backToCodex.draft.implementerModelComplex).toBe('gpt-5.3-codex');
  });

  it('updates memory for current provider when model fields change', () => {
    const draft = {
      ...createEmptyRuntimeSettingsDraft(),
      reviewer: 'claude',
      reviewerModelSimple: null,
      reviewerModelComplex: null,
    };
    const memory = buildRuntimeProviderModelMemory(draft);

    const updatedSimple = applyModelFieldUpdate({
      draft,
      memory,
      field: 'reviewerModelSimple',
      value: 'haiku',
    });
    const updatedComplex = applyModelFieldUpdate({
      draft: updatedSimple.draft,
      memory: updatedSimple.memory,
      field: 'reviewerModelComplex',
      value: 'opus',
    });

    expect(updatedComplex.memory.reviewer.claude).toEqual({
      simple: 'haiku',
      complex: 'opus',
    });
  });
});
