import {
  type CanonicalProvider,
  type DispatchRole,
  type DispatchCommandTemplate,
  getProviderCommandTemplate,
  resolveDispatchProvider,
} from './discipline.js';
import type { ComplexityLevel } from '../core/routing/types.js';
import { resolveRuntimeSettings } from './runtime-settings.js';

export interface DispatchExecutionCommand {
  provider: CanonicalProvider;
  role: DispatchRole;
  command: string;
  args: string[];
  display: string;
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

function appendModelArgs(args: {
  baseTemplate: DispatchCommandTemplate;
  provider: CanonicalProvider;
  role: DispatchRole;
  modelOverride: string | null;
}): DispatchExecutionCommand {
  const commandArgs = [...args.baseTemplate.args];
  const model = normalizeOptionalValue(args.modelOverride);

  if (model) {
    commandArgs.push('--model', model);
  }

  return {
    provider: args.provider,
    role: args.role,
    command: args.baseTemplate.command,
    args: commandArgs,
    display: renderDisplay(args.baseTemplate.command, commandArgs),
  };
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
    throw new Error(`${role} provider must reference a known provider; received "${normalizedProvider}"`);
  }

  return appendModelArgs({
    provider,
    modelOverride: getModelOverride({ role, complexity, runtimeSettings }),
    role,
    baseTemplate: getProviderCommandTemplate(provider, role),
  });
}
