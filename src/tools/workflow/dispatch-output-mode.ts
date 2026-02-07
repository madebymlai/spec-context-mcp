import type { DispatchRole } from '../../config/discipline.js';

export type DispatchOutputMode = 'schema_constrained';
export type DispatchOutputModeDecision = 'schema_constrained' | 'unsupported';
export type DispatchOutputModeErrorCode = 'mode_unsupported' | 'provider_not_configured';
export type SupportedDispatchProvider = 'claude' | 'codex' | 'gemini' | 'opencode';

const ROLE_ENV_VARS: Record<DispatchRole, string> = {
  implementer: 'SPEC_CONTEXT_IMPLEMENTER',
  reviewer: 'SPEC_CONTEXT_REVIEWER',
};

const PROVIDER_ALIASES: Record<string, SupportedDispatchProvider> = {
  claude: 'claude',
  'claude-code': 'claude',
  'claude-code-cli': 'claude',
  codex: 'codex',
  'codex-cli': 'codex',
  gemini: 'gemini',
  'gemini-cli': 'gemini',
  opencode: 'opencode',
  'opencode-cli': 'opencode',
};

const SCHEMA_CONSTRAINED_PROVIDERS = new Set<SupportedDispatchProvider>([
  'claude',
  'codex',
  'gemini',
  'opencode',
]);

export interface DispatchOutputModeResolution {
  decision: DispatchOutputModeDecision;
  provider: SupportedDispatchProvider | null;
  mode: DispatchOutputMode | null;
  errorCode: DispatchOutputModeErrorCode | null;
}

function firstToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  const [token] = trimmed.split(/\s+/);
  return token.toLowerCase();
}

export function resolveDispatchProvider(value: string): SupportedDispatchProvider | null {
  const token = firstToken(value);
  if (!token) {
    return null;
  }
  return PROVIDER_ALIASES[token] ?? null;
}

export function resolveDispatchOutputMode(args: {
  role: DispatchRole;
  env?: NodeJS.ProcessEnv;
}): DispatchOutputModeResolution {
  const env = args.env ?? process.env;
  const raw = env[ROLE_ENV_VARS[args.role]];
  if (!raw || !raw.trim()) {
    return {
      decision: 'unsupported',
      provider: null,
      mode: null,
      errorCode: 'provider_not_configured',
    };
  }

  const provider = resolveDispatchProvider(raw);
  if (!provider || !SCHEMA_CONSTRAINED_PROVIDERS.has(provider)) {
    return {
      decision: 'unsupported',
      provider: provider ?? null,
      mode: null,
      errorCode: 'mode_unsupported',
    };
  }

  return {
    decision: 'schema_constrained',
    provider,
    mode: 'schema_constrained',
    errorCode: null,
  };
}

