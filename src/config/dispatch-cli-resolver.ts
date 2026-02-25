import {
  type CanonicalProvider,
  type DispatchRole,
  type DispatchCommandTemplate,
  getProviderCommandTemplate,
  resolveDispatchProvider,
} from './discipline.js';
import type { ComplexityLevel } from '../core/routing/types.js';
import { resolveRuntimeSettings } from './runtime-settings.js';

type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const ROLE_ENV_VAR: Record<DispatchRole, string> = {
  implementer: 'SPEC_CONTEXT_IMPLEMENTER',
  reviewer: 'SPEC_CONTEXT_REVIEWER',
};

const CODEX_REASONING_EFFORT_VALUES = new Set<CodexReasoningEffort>([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export interface DispatchExecutionCommand {
  provider: CanonicalProvider;
  role: DispatchRole;
  command: string;
  args: string[];
  display: string;
}

function modelEnvVarFor(role: DispatchRole, complexity: ComplexityLevel): string {
  return `${ROLE_ENV_VAR[role]}_MODEL_${complexity.toUpperCase()}`;
}

function reasoningGlobalEnvVarFor(role: DispatchRole): string {
  return `${ROLE_ENV_VAR[role]}_REASONING_EFFORT`;
}

function readOptionalEnvVar(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) {
    return null;
  }
  return value;
}

function renderToken(value: string): string {
  if (/^[A-Za-z0-9._/:=-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function renderDisplay(command: string, args: readonly string[]): string {
  return [command, ...args.map(renderToken)].join(' ');
}

function normalizeOptionalValue(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function getModelOverride(args: {
  role: DispatchRole;
  complexity: ComplexityLevel;
  runtimeSettings: Awaited<ReturnType<typeof resolveRuntimeSettings>>;
}): string | null {
  if (args.role === 'implementer') {
    return args.complexity === 'simple'
      ? args.runtimeSettings.implementerModelSimple.value
      : args.runtimeSettings.implementerModelComplex.value;
  }
  return args.complexity === 'simple'
    ? args.runtimeSettings.reviewerModelSimple.value
    : args.runtimeSettings.reviewerModelComplex.value;
}

function getReasoningEffort(role: DispatchRole, runtimeSettings: Awaited<ReturnType<typeof resolveRuntimeSettings>>): string | null {
  return role === 'implementer'
    ? runtimeSettings.implementerReasoningEffort.value
    : runtimeSettings.reviewerReasoningEffort.value;
}

function appendModelArgs(args: {
  baseTemplate: DispatchCommandTemplate;
  provider: CanonicalProvider;
  role: DispatchRole;
  modelOverride: string | null;
  reasoningEffort: string | null;
}): DispatchExecutionCommand {
  const commandArgs = [...args.baseTemplate.args];
  const model = normalizeOptionalValue(args.modelOverride);
  const reasoningRaw = normalizeOptionalValue(args.reasoningEffort)?.toLowerCase() ?? null;
  const codexReasoningEffort = reasoningRaw && CODEX_REASONING_EFFORT_VALUES.has(reasoningRaw as CodexReasoningEffort)
    ? (reasoningRaw as CodexReasoningEffort)
    : null;

  if (model) {
    commandArgs.push('--model', model);
  }
  if (args.provider === 'codex' && codexReasoningEffort) {
    commandArgs.push('-c', `model_reasoning_effort=${codexReasoningEffort}`);
  }

  return {
    provider: args.provider,
    role: args.role,
    command: args.baseTemplate.command,
    args: commandArgs,
    display: renderDisplay(args.baseTemplate.command, commandArgs),
  };
}

export function resolveDispatchCommandForProvider(args: {
  provider: CanonicalProvider;
  role: DispatchRole;
  complexity: ComplexityLevel;
}): DispatchExecutionCommand {
  return appendModelArgs({
    provider: args.provider,
    modelOverride: normalizeOptionalValue(readOptionalEnvVar(modelEnvVarFor(args.role, args.complexity))),
    reasoningEffort: normalizeOptionalValue(readOptionalEnvVar(reasoningGlobalEnvVarFor(args.role))),
    role: args.role,
    baseTemplate: getProviderCommandTemplate(args.provider, args.role),
  });
}

export async function getDispatchCommandForComplexity(
  role: DispatchRole,
  complexity: ComplexityLevel
): Promise<DispatchExecutionCommand | null> {
  const runtimeSettings = await resolveRuntimeSettings();
  const configuredValue = role === 'implementer'
    ? runtimeSettings.implementer.value
    : runtimeSettings.reviewer.value;
  const normalizedProvider = normalizeOptionalValue(configuredValue);
  if (!normalizedProvider) {
    return null;
  }

  const provider = resolveDispatchProvider(normalizedProvider);
  if (!provider) {
    throw new Error(`${ROLE_ENV_VAR[role]} must reference a known provider; received "${normalizedProvider}"`);
  }

  return appendModelArgs({
    provider,
    modelOverride: getModelOverride({
      role,
      complexity,
      runtimeSettings,
    }),
    reasoningEffort: getReasoningEffort(role, runtimeSettings),
    role,
    baseTemplate: getProviderCommandTemplate(provider, role),
  });
}
