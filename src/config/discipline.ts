/**
 * Discipline configuration module
 * Reads SPEC_CONTEXT_DISCIPLINE and CLI dispatch env vars
 */

export type DisciplineMode = 'full' | 'standard' | 'minimal';
export type DispatchRole = 'implementer' | 'reviewer' | 'brainstorm';

const VALID_MODES: DisciplineMode[] = ['full', 'standard', 'minimal'];
const DEFAULT_MODE: DisciplineMode = 'full';

const ENV_VARS: Record<DispatchRole, string> = {
  implementer: 'SPEC_CONTEXT_IMPLEMENTER',
  reviewer: 'SPEC_CONTEXT_REVIEWER',
  brainstorm: 'SPEC_CONTEXT_BRAINSTORM',
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
 * Get the CLI command for a dispatch role.
 * Returns null if not configured.
 */
export function getDispatchCli(role: DispatchRole): string | null {
  const envVar = ENV_VARS[role];
  const value = process.env[envVar];

  // Return null for empty or unset values
  if (!value || value.trim() === '') {
    return null;
  }

  return value;
}
