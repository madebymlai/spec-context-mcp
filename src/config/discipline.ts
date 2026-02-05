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
 * Non-interactive CLI flags per agent per role.
 * Maps short agent names to their headless invocation.
 * If the env var value isn't a known agent, it's used as-is (custom command).
 */
const AGENT_FLAGS: Record<string, Record<DispatchRole, string>> = {
  claude: {
    implementer: 'claude -p --dangerously-skip-permissions',
    reviewer: 'claude -p',
  },
  codex: {
    implementer: 'codex exec --full-auto',
    reviewer: 'codex exec --sandbox read-only',
  },
  gemini: {
    implementer: 'gemini --yolo',
    reviewer: 'gemini --plan',
  },
};

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
 * Known agent names (claude, codex, gemini) get mapped to proper flags.
 * Anything else is returned as-is (custom command).
 */
export function resolveAgentCli(value: string, role: DispatchRole): string {
  const key = value.trim().toLowerCase();
  return AGENT_FLAGS[key]?.[role] ?? value.trim();
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
export const KNOWN_AGENTS = Object.keys(AGENT_FLAGS);
