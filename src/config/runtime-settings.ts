import { SettingsManager } from '../dashboard/settings-manager.js';
import type { RuntimeSettings } from '../workflow-types.js';

export type SettingSource = 'json' | 'env' | 'default';

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

function readOptionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) {
    return null;
  }
  return value;
}

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

function resolveNullableSetting(args: {
  jsonValue: unknown;
  envVar: string;
}): ResolvedSetting<string | null> {
  const jsonValue = toOptionalString(args.jsonValue);
  if (jsonValue !== undefined) {
    return { value: jsonValue, source: 'json' };
  }

  const envValue = readOptionalEnv(args.envVar);
  if (envValue !== null) {
    return { value: envValue, source: 'env' };
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

  const envValue = readOptionalEnv('DASHBOARD_URL');
  if (envValue !== null) {
    return { value: envValue, source: 'env' };
  }

  return { value: DEFAULT_DASHBOARD_URL, source: 'default' };
}

export async function resolveRuntimeSettings(): Promise<ResolvedRuntimeSettings> {
  const settingsManager = new SettingsManager();
  const runtimeSettings = await settingsManager.getRuntimeSettings();

  return {
    discipline: resolveDiscipline(runtimeSettings),
    implementer: resolveNullableSetting({
      jsonValue: runtimeSettings.implementer,
      envVar: 'SPEC_CONTEXT_IMPLEMENTER',
    }),
    reviewer: resolveNullableSetting({
      jsonValue: runtimeSettings.reviewer,
      envVar: 'SPEC_CONTEXT_REVIEWER',
    }),
    implementerModelSimple: resolveNullableSetting({
      jsonValue: runtimeSettings.implementerModelSimple,
      envVar: 'SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE',
    }),
    implementerModelComplex: resolveNullableSetting({
      jsonValue: runtimeSettings.implementerModelComplex,
      envVar: 'SPEC_CONTEXT_IMPLEMENTER_MODEL_COMPLEX',
    }),
    reviewerModelSimple: resolveNullableSetting({
      jsonValue: runtimeSettings.reviewerModelSimple,
      envVar: 'SPEC_CONTEXT_REVIEWER_MODEL_SIMPLE',
    }),
    reviewerModelComplex: resolveNullableSetting({
      jsonValue: runtimeSettings.reviewerModelComplex,
      envVar: 'SPEC_CONTEXT_REVIEWER_MODEL_COMPLEX',
    }),
    implementerReasoningEffort: resolveNullableSetting({
      jsonValue: runtimeSettings.implementerReasoningEffort,
      envVar: 'SPEC_CONTEXT_IMPLEMENTER_REASONING_EFFORT',
    }),
    reviewerReasoningEffort: resolveNullableSetting({
      jsonValue: runtimeSettings.reviewerReasoningEffort,
      envVar: 'SPEC_CONTEXT_REVIEWER_REASONING_EFFORT',
    }),
    dashboardUrl: resolveDashboardUrl(runtimeSettings),
  };
}
