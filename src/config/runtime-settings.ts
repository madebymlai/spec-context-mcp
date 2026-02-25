import { SettingsManager } from '../dashboard/settings-manager.js';
import type { RuntimeSettings } from '../workflow-types.js';

export type SettingSource = 'json' | 'default';

export interface ResolvedSetting<T> {
  value: T;
  source: SettingSource;
}

type DisciplineMode = NonNullable<RuntimeSettings['discipline']>;

export interface ResolvedRuntimeSettings {
  discipline: ResolvedSetting<DisciplineMode>;
  implementer: ResolvedSetting<string | null>;
  reviewer: ResolvedSetting<string | null>;
  implementerModelSimple: ResolvedSetting<string | null>;
  implementerModelComplex: ResolvedSetting<string | null>;
  reviewerModelSimple: ResolvedSetting<string | null>;
  reviewerModelComplex: ResolvedSetting<string | null>;
  implementerReasoningEffort: ResolvedSetting<string | null>;
  reviewerReasoningEffort: ResolvedSetting<string | null>;
  dashboardUrl: ResolvedSetting<string>;
}

const DISCIPLINE_VALUES: readonly DisciplineMode[] = ['full', 'standard', 'minimal'];
const DEFAULT_DISCIPLINE: DisciplineMode = 'full';
const DEFAULT_DASHBOARD_URL = 'http://localhost:3000';

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value;
}

function toDisciplineMode(value: unknown): DisciplineMode | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!DISCIPLINE_VALUES.includes(normalized as DisciplineMode)) {
    return null;
  }

  return normalized as DisciplineMode;
}

function resolveNullableSetting(jsonValue: unknown): ResolvedSetting<string | null> {
  const value = toOptionalString(jsonValue);
  if (value !== undefined) {
    return { value, source: 'json' };
  }

  return { value: null, source: 'default' };
}

function resolveDiscipline(runtimeSettings: RuntimeSettings): ResolvedSetting<DisciplineMode> {
  if (runtimeSettings.discipline === undefined || runtimeSettings.discipline === null) {
    return { value: DEFAULT_DISCIPLINE, source: 'default' };
  }

  const jsonValue = toDisciplineMode(runtimeSettings.discipline);
  if (jsonValue === null) {
    throw new Error(
      `Invalid discipline value in settings.json: "${String(runtimeSettings.discipline)}". ` +
      `Valid options: ${DISCIPLINE_VALUES.join(', ')}`
    );
  }

  return { value: jsonValue, source: 'json' };
}

function resolveDashboardUrl(runtimeSettings: RuntimeSettings): ResolvedSetting<string> {
  const jsonValue = toOptionalString(runtimeSettings.dashboardUrl);
  if (jsonValue !== undefined) {
    return { value: jsonValue, source: 'json' };
  }

  return { value: DEFAULT_DASHBOARD_URL, source: 'default' };
}

export async function resolveRuntimeSettings(): Promise<ResolvedRuntimeSettings> {
  const settingsManager = new SettingsManager();
  const runtimeSettings = await settingsManager.getRuntimeSettings();

  return {
    discipline: resolveDiscipline(runtimeSettings),
    implementer: resolveNullableSetting(runtimeSettings.implementer),
    reviewer: resolveNullableSetting(runtimeSettings.reviewer),
    implementerModelSimple: resolveNullableSetting(runtimeSettings.implementerModelSimple),
    implementerModelComplex: resolveNullableSetting(runtimeSettings.implementerModelComplex),
    reviewerModelSimple: resolveNullableSetting(runtimeSettings.reviewerModelSimple),
    reviewerModelComplex: resolveNullableSetting(runtimeSettings.reviewerModelComplex),
    implementerReasoningEffort: resolveNullableSetting(runtimeSettings.implementerReasoningEffort),
    reviewerReasoningEffort: resolveNullableSetting(runtimeSettings.reviewerReasoningEffort),
    dashboardUrl: resolveDashboardUrl(runtimeSettings),
  };
}
