import { describe, expect, it } from 'vitest';
import {
  buildRuntimeSettingsUpdatePayload,
  deriveRuntimeSettingsDraft,
  hasRuntimeSettingsChanges,
  type RuntimeSettingsDraft,
  type RuntimeSettingsResponse,
} from './settings-runtime-config';

function createDraft(overrides: Partial<RuntimeSettingsDraft> = {}): RuntimeSettingsDraft {
  return {
    discipline: null,
    implementer: null,
    reviewer: null,
    implementerModelSimple: null,
    implementerModelComplex: null,
    reviewerModelSimple: null,
    reviewerModelComplex: null,
    implementerReasoningEffort: null,
    reviewerReasoningEffort: null,
    ...overrides,
  };
}

describe('settings-runtime-config', () => {
  it('derives editable draft from json sources only', () => {
    const resolved: RuntimeSettingsResponse = {
      discipline: { value: 'standard', source: 'json' },
      implementer: { value: 'codex', source: 'json' },
      reviewer: { value: 'gemini', source: 'env' },
      implementerModelSimple: { value: 'impl-simple-fallback', source: 'env' },
      implementerModelComplex: { value: null, source: 'default' },
      reviewerModelSimple: { value: 'review-simple', source: 'json' },
      reviewerModelComplex: { value: 'review-complex-fallback', source: 'env' },
      implementerReasoningEffort: { value: 'medium', source: 'json' },
      reviewerReasoningEffort: { value: 'low', source: 'default' },
    };

    expect(deriveRuntimeSettingsDraft(resolved)).toEqual({
      discipline: 'standard',
      implementer: 'codex',
      reviewer: null,
      implementerModelSimple: null,
      implementerModelComplex: null,
      reviewerModelSimple: 'review-simple',
      reviewerModelComplex: null,
      implementerReasoningEffort: 'medium',
      reviewerReasoningEffort: null,
    });
  });

  it('builds update payload with only changed fields', () => {
    const initial = createDraft({
      discipline: 'standard',
      implementer: 'codex',
      reviewerModelSimple: 'reviewer-simple',
    });

    const current = createDraft({
      discipline: 'full',
      implementer: null,
      reviewerModelSimple: 'reviewer-simple',
      reviewerReasoningEffort: 'high',
    });

    expect(buildRuntimeSettingsUpdatePayload(initial, current)).toEqual({
      discipline: 'full',
      implementer: null,
      reviewerReasoningEffort: 'high',
    });
  });

  it('detects change state correctly', () => {
    const initial = createDraft({
      discipline: 'minimal',
      reviewer: 'claude',
    });

    expect(hasRuntimeSettingsChanges(initial, initial)).toBe(false);
    expect(hasRuntimeSettingsChanges(initial, createDraft({
      discipline: 'minimal',
      reviewer: 'codex',
    }))).toBe(true);
  });
});
