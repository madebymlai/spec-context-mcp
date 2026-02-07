import {
  type CanonicalProvider,
  type DispatchRole,
  getDispatchCli,
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

function modelEnvVarFor(role: DispatchRole, complexity: ComplexityLevel): string {
  return `${ROLE_ENV_VAR[role]}_MODEL_${complexity.toUpperCase()}`;
}

function reasoningEnvVarFor(role: DispatchRole, complexity: ComplexityLevel): string {
  return `${ROLE_ENV_VAR[role]}_REASONING_EFFORT_${complexity.toUpperCase()}`;
}

function readOptionalEnvVar(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) {
    return null;
  }
  return value;
}

function shellToken(value: string): string {
  if (/^[A-Za-z0-9._/:=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function appendModelFlags(args: {
  baseCli: string;
  provider: CanonicalProvider;
  model: string | null;
  codexReasoningEffort: CodexReasoningEffort | null;
}): string {
  let command = args.baseCli;
  if (args.model) {
    command += ` --model ${shellToken(args.model)}`;
  }
  if (args.provider === 'codex' && args.codexReasoningEffort) {
    command += ` -c model_reasoning_effort=${shellToken(args.codexReasoningEffort)}`;
  }
  return command;
}

export function getDispatchCliForComplexity(role: DispatchRole, complexity: ComplexityLevel): string | null {
  const baseCli = getDispatchCli(role);
  if (!baseCli) {
    return null;
  }

  const configuredValue = process.env[ROLE_ENV_VAR[role]];
  if (!configuredValue || !configuredValue.trim()) {
    return baseCli;
  }

  const provider = resolveDispatchProvider(configuredValue);
  if (!provider) {
    return baseCli;
  }

  const model = readOptionalEnvVar(modelEnvVarFor(role, complexity));
  const reasoningRaw = readOptionalEnvVar(reasoningEnvVarFor(role, complexity))?.toLowerCase() ?? null;
  const codexReasoningEffort = reasoningRaw && CODEX_REASONING_EFFORT_VALUES.has(reasoningRaw as CodexReasoningEffort)
    ? (reasoningRaw as CodexReasoningEffort)
    : null;

  if (!model && !codexReasoningEffort) {
    return baseCli;
  }

  return appendModelFlags({
    baseCli,
    provider,
    model,
    codexReasoningEffort,
  });
}
