/**
 * Discipline configuration module
 * Reads SPEC_CONTEXT_DISCIPLINE and CLI dispatch env vars
 */

export type DisciplineMode = 'full' | 'standard' | 'minimal';
export type DispatchRole = 'implementer' | 'reviewer';

const VALID_MODES: DisciplineMode[] = ['full', 'standard', 'minimal'];
const DEFAULT_MODE: DisciplineMode = 'full';

const ENV_VARS: Record<DispatchRole, string> = {
  implementer: 'SPEC_CONTEXT_IMPLEMENTER',
  reviewer: 'SPEC_CONTEXT_REVIEWER',
};

/**
 * MCP tools each role is allowed to call.
 * Used for --allowedTools (Claude) and prompt-level restriction (others).
 */
const ROLE_TOOLS: Record<DispatchRole, string[]> = {
  implementer: ['get-implementer-guide', 'search', 'code_research', 'spec-status'],
  reviewer: ['get-reviewer-guide', 'search', 'code_research'],
};

const CLAUDE_ALLOWED_TOOLS = {
  implementer: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', ...ROLE_TOOLS.implementer.map(t => `mcp__*__${t}`)].join(' '),
  reviewer: ['Bash', 'Read', 'Glob', 'Grep', ...ROLE_TOOLS.reviewer.map(t => `mcp__*__${t}`)].join(' '),
} as const;

/**
 * Non-interactive CLI flags per agent per role.
 * Canonical agents map to per-role invocation templates.
 */
export const PROVIDER_CATALOG = {
  claude: {
    implementer: `claude -p --dangerously-skip-permissions --allowedTools "${CLAUDE_ALLOWED_TOOLS.implementer}"`,
    reviewer: `claude -p --allowedTools "${CLAUDE_ALLOWED_TOOLS.reviewer}"`,
  },
  codex: {
    implementer: 'codex exec --full-auto',
    reviewer: 'codex exec --sandbox read-only',
  },
  gemini: {
    implementer: 'gemini --yolo',
    reviewer: 'gemini --plan',
  },
  opencode: {
    implementer: 'opencode run',
    reviewer: 'opencode run',
  },
} as const satisfies Record<string, Record<DispatchRole, string>>;

const PROVIDER_ALIASES = {
  'claude-code': 'claude',
  'claude-code-cli': 'claude',
  'codex-cli': 'codex',
  'gemini-cli': 'gemini',
  'opencode-cli': 'opencode',
} as const;

type CanonicalProvider = keyof typeof PROVIDER_CATALOG;

function resolveCanonicalProvider(value: string): CanonicalProvider | null {
  const key = value.trim().toLowerCase();
  if (key in PROVIDER_CATALOG) {
    return key as CanonicalProvider;
  }
  const alias = PROVIDER_ALIASES[key as keyof typeof PROVIDER_ALIASES];
  if (!alias) {
    return null;
  }
  return alias as CanonicalProvider;
}

/**
 * Get the current discipline mode from environment.
 * Defaults to 'full' if not set or invalid.
 */
export function getDisciplineMode(): DisciplineMode {
  const value = process.env.SPEC_CONTEXT_DISCIPLINE?.toLowerCase();

  if (!value) {
    return DEFAULT_MODE;
  }

  if (VALID_MODES.includes(value as DisciplineMode)) {
    return value as DisciplineMode;
  }

  console.error(
    `[discipline] Invalid SPEC_CONTEXT_DISCIPLINE value: "${value}". ` +
    `Valid options: ${VALID_MODES.join(', ')}. Defaulting to "${DEFAULT_MODE}".`
  );
  return DEFAULT_MODE;
}

/**
 * Resolve an env var value to a full CLI command for the given role.
 * Known agent names (claude, codex, gemini, opencode) get mapped to proper flags.
 * Anything else is returned as-is (custom command).
 */
export function resolveAgentCli(value: string, role: DispatchRole): string {
  const canonicalProvider = resolveCanonicalProvider(value);
  if (!canonicalProvider) {
    return value.trim();
  }
  return PROVIDER_CATALOG[canonicalProvider][role];
}

/**
 * Get the CLI command for a dispatch role.
 * Returns null if not configured.
 */
export function getDispatchCli(role: DispatchRole): string | null {
  const envVar = ENV_VARS[role];
  const value = process.env[envVar];

  if (!value || value.trim() === '') {
    return null;
  }

  return resolveAgentCli(value, role);
}

/** Supported agent names for documentation/validation */
export const KNOWN_AGENTS = [
  ...Object.keys(PROVIDER_CATALOG),
  ...Object.keys(PROVIDER_ALIASES),
];
