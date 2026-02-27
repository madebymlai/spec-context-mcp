import type {
  RuntimeSettingsDraft,
  RuntimeSettingsFieldKey,
} from './settings-runtime-config';

export type RuntimeProviderRole = 'implementer' | 'reviewer';

type RuntimeProviderField = 'implementer' | 'reviewer';
type RuntimeModelField =
  | 'implementerModelSimple'
  | 'implementerModelComplex'
  | 'reviewerModelSimple'
  | 'reviewerModelComplex';

interface RoleFieldConfig {
  provider: RuntimeProviderField;
  simpleModel: RuntimeModelField;
  complexModel: RuntimeModelField;
}

const ROLE_FIELD_CONFIG: Record<RuntimeProviderRole, RoleFieldConfig> = {
  implementer: {
    provider: 'implementer',
    simpleModel: 'implementerModelSimple',
    complexModel: 'implementerModelComplex',
  },
  reviewer: {
    provider: 'reviewer',
    simpleModel: 'reviewerModelSimple',
    complexModel: 'reviewerModelComplex',
  },
};

const MODEL_FIELD_TO_ROLE: Record<RuntimeModelField, RuntimeProviderRole> = {
  implementerModelSimple: 'implementer',
  implementerModelComplex: 'implementer',
  reviewerModelSimple: 'reviewer',
  reviewerModelComplex: 'reviewer',
};

export interface RoleProviderModelValues {
  simple: string | null;
  complex: string | null;
}

export interface RuntimeProviderModelMemory {
  implementer: Record<string, RoleProviderModelValues>;
  reviewer: Record<string, RoleProviderModelValues>;
}

export function createEmptyRuntimeProviderModelMemory(): RuntimeProviderModelMemory {
  return {
    implementer: {},
    reviewer: {},
  };
}

function cloneMemory(memory: RuntimeProviderModelMemory): RuntimeProviderModelMemory {
  return {
    implementer: { ...memory.implementer },
    reviewer: { ...memory.reviewer },
  };
}

function captureRoleModels(
  draft: RuntimeSettingsDraft,
  role: RuntimeProviderRole
): RoleProviderModelValues {
  const fieldConfig = ROLE_FIELD_CONFIG[role];
  return {
    simple: draft[fieldConfig.simpleModel],
    complex: draft[fieldConfig.complexModel],
  };
}

export function buildRuntimeProviderModelMemory(
  draft: RuntimeSettingsDraft
): RuntimeProviderModelMemory {
  const memory = createEmptyRuntimeProviderModelMemory();

  for (const role of Object.keys(ROLE_FIELD_CONFIG) as RuntimeProviderRole[]) {
    const fieldConfig = ROLE_FIELD_CONFIG[role];
    const provider = draft[fieldConfig.provider];
    if (!provider) {
      continue;
    }
    memory[role][provider] = captureRoleModels(draft, role);
  }

  return memory;
}

function normalizeProviderValue(provider: string | null): string | null {
  if (provider === null) {
    return null;
  }
  const trimmed = provider.trim();
  return trimmed || null;
}

export function applyProviderSwitch(input: {
  draft: RuntimeSettingsDraft;
  memory: RuntimeProviderModelMemory;
  role: RuntimeProviderRole;
  nextProvider: string | null;
}): { draft: RuntimeSettingsDraft; memory: RuntimeProviderModelMemory } {
  const fieldConfig = ROLE_FIELD_CONFIG[input.role];
  const previousProvider = normalizeProviderValue(input.draft[fieldConfig.provider]);
  const normalizedNextProvider = normalizeProviderValue(input.nextProvider);

  const nextDraft: RuntimeSettingsDraft = { ...input.draft };
  const nextMemory = cloneMemory(input.memory);

  if (previousProvider) {
    nextMemory[input.role][previousProvider] = captureRoleModels(input.draft, input.role);
  }

  nextDraft[fieldConfig.provider] = normalizedNextProvider;
  if (!normalizedNextProvider) {
    nextDraft[fieldConfig.simpleModel] = null;
    nextDraft[fieldConfig.complexModel] = null;
    return { draft: nextDraft, memory: nextMemory };
  }

  const existingModels = nextMemory[input.role][normalizedNextProvider];
  nextDraft[fieldConfig.simpleModel] = existingModels?.simple ?? null;
  nextDraft[fieldConfig.complexModel] = existingModels?.complex ?? null;

  return { draft: nextDraft, memory: nextMemory };
}

function isRuntimeModelField(key: RuntimeSettingsFieldKey): key is RuntimeModelField {
  return key in MODEL_FIELD_TO_ROLE;
}

export function applyModelFieldUpdate(input: {
  draft: RuntimeSettingsDraft;
  memory: RuntimeProviderModelMemory;
  field: RuntimeSettingsFieldKey;
  value: string | null;
}): { draft: RuntimeSettingsDraft; memory: RuntimeProviderModelMemory } {
  const nextDraft: RuntimeSettingsDraft = {
    ...input.draft,
    [input.field]: input.value,
  };

  if (!isRuntimeModelField(input.field)) {
    return { draft: nextDraft, memory: input.memory };
  }

  const role = MODEL_FIELD_TO_ROLE[input.field];
  const fieldConfig = ROLE_FIELD_CONFIG[role];
  const provider = normalizeProviderValue(nextDraft[fieldConfig.provider]);

  if (!provider) {
    return { draft: nextDraft, memory: input.memory };
  }

  const nextMemory = cloneMemory(input.memory);
  nextMemory[role][provider] = captureRoleModels(nextDraft, role);

  return { draft: nextDraft, memory: nextMemory };
}
