export type RuntimeSettingSource = 'json' | 'default';

export interface ResolvedRuntimeSetting<T> {
  value: T;
  source: RuntimeSettingSource;
}

export interface RuntimeSettingsResponse {
  discipline: ResolvedRuntimeSetting<'full' | 'standard' | 'minimal'>;
  implementer: ResolvedRuntimeSetting<string | null>;
  reviewer: ResolvedRuntimeSetting<string | null>;
  implementerModelSimple: ResolvedRuntimeSetting<string | null>;
  implementerModelComplex: ResolvedRuntimeSetting<string | null>;
  reviewerModelSimple: ResolvedRuntimeSetting<string | null>;
  reviewerModelComplex: ResolvedRuntimeSetting<string | null>;
}

export const RUNTIME_SETTINGS_FIELD_KEYS = [
  'discipline',
  'implementer',
  'reviewer',
  'implementerModelSimple',
  'implementerModelComplex',
  'reviewerModelSimple',
  'reviewerModelComplex',
] as const;

export type RuntimeSettingsFieldKey = (typeof RUNTIME_SETTINGS_FIELD_KEYS)[number];

export type RuntimeSettingsDraft = Record<RuntimeSettingsFieldKey, string | null>;

export function createEmptyRuntimeSettingsDraft(): RuntimeSettingsDraft {
  return {
    discipline: null,
    implementer: null,
    reviewer: null,
    implementerModelSimple: null,
    implementerModelComplex: null,
    reviewerModelSimple: null,
    reviewerModelComplex: null,
  };
}

function resolveEditableValue<T extends string>(
  setting: ResolvedRuntimeSetting<T | null>
): string | null {
  if (setting.source !== 'json') {
    return null;
  }
  return setting.value;
}

export function deriveRuntimeSettingsDraft(
  settings: RuntimeSettingsResponse
): RuntimeSettingsDraft {
  return {
    discipline: resolveEditableValue(settings.discipline),
    implementer: resolveEditableValue(settings.implementer),
    reviewer: resolveEditableValue(settings.reviewer),
    implementerModelSimple: resolveEditableValue(settings.implementerModelSimple),
    implementerModelComplex: resolveEditableValue(settings.implementerModelComplex),
    reviewerModelSimple: resolveEditableValue(settings.reviewerModelSimple),
    reviewerModelComplex: resolveEditableValue(settings.reviewerModelComplex),
  };
}

export function buildRuntimeSettingsUpdatePayload(
  initial: RuntimeSettingsDraft,
  current: RuntimeSettingsDraft
): Partial<Record<RuntimeSettingsFieldKey, string | null>> {
  const updates: Partial<Record<RuntimeSettingsFieldKey, string | null>> = {};
  for (const key of RUNTIME_SETTINGS_FIELD_KEYS) {
    if (initial[key] === current[key]) {
      continue;
    }
    updates[key] = current[key];
  }
  return updates;
}

export function hasRuntimeSettingsChanges(
  initial: RuntimeSettingsDraft,
  current: RuntimeSettingsDraft
): boolean {
  return RUNTIME_SETTINGS_FIELD_KEYS.some((key) => initial[key] !== current[key]);
}
