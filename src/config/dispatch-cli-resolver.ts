import {
  type CanonicalProvider,
  type DispatchRole,
  type DispatchCommandTemplate,
  getProviderCommandTemplate,
  resolveDispatchProvider,
} from './discipline.js';
import type { ComplexityLevel } from '../core/routing/types.js';

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

function appendModelArgs(args: {
  baseTemplate: DispatchCommandTemplate;
  provider: CanonicalProvider;
  role: DispatchRole;
  complexity: ComplexityLevel;
}): DispatchExecutionCommand {
  const commandArgs = [...args.baseTemplate.args];
  const model = readOptionalEnvVar(modelEnvVarFor(args.role, args.complexity));
  const reasoningRaw = readOptionalEnvVar(reasoningGlobalEnvVarFor(args.role))?.toLowerCase() ?? null;
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
    role: args.role,
    complexity: args.complexity,
    baseTemplate: getProviderCommandTemplate(args.provider, args.role),
  });
}

export function getDispatchCommandForComplexity(role: DispatchRole, complexity: ComplexityLevel): DispatchExecutionCommand | null {
  const configuredValue = process.env[ROLE_ENV_VAR[role]];
  if (!configuredValue || !configuredValue.trim()) {
    return null;
  }

  const provider = resolveDispatchProvider(configuredValue);
  if (!provider) {
    throw new Error(`${ROLE_ENV_VAR[role]} must reference a known provider; received "${configuredValue}"`);
  }

  return resolveDispatchCommandForProvider({
    provider,
    role,
    complexity,
  });
}
