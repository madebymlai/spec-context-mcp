import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getDisciplineMode,
  getDispatchCli,
  KNOWN_AGENTS,
  PROVIDER_CAPABILITIES,
  resolveAgentCli,
  resolveDispatchProvider,
} from './discipline.js';

describe('discipline config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SPEC_CONTEXT_DISCIPLINE;
    delete process.env.SPEC_CONTEXT_IMPLEMENTER;
    delete process.env.SPEC_CONTEXT_REVIEWER;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getDisciplineMode', () => {
    it('returns "full" by default when not set', () => {
      expect(getDisciplineMode()).toBe('full');
    });

    it('returns "full" when set to "full"', () => {
      process.env.SPEC_CONTEXT_DISCIPLINE = 'full';
      expect(getDisciplineMode()).toBe('full');
    });

    it('returns "standard" when set to "standard"', () => {
      process.env.SPEC_CONTEXT_DISCIPLINE = 'standard';
      expect(getDisciplineMode()).toBe('standard');
    });

    it('returns "minimal" when set to "minimal"', () => {
      process.env.SPEC_CONTEXT_DISCIPLINE = 'minimal';
      expect(getDisciplineMode()).toBe('minimal');
    });

    it('handles case insensitivity', () => {
      process.env.SPEC_CONTEXT_DISCIPLINE = 'FULL';
      expect(getDisciplineMode()).toBe('full');

      process.env.SPEC_CONTEXT_DISCIPLINE = 'Standard';
      expect(getDisciplineMode()).toBe('standard');

      process.env.SPEC_CONTEXT_DISCIPLINE = 'MINIMAL';
      expect(getDisciplineMode()).toBe('minimal');
    });

    it('returns "full" and logs warning for invalid value', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      process.env.SPEC_CONTEXT_DISCIPLINE = 'invalid';
      expect(getDisciplineMode()).toBe('full');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid SPEC_CONTEXT_DISCIPLINE value')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('resolveAgentCli', () => {
    it('resolves claude implementer', () => {
      expect(resolveAgentCli('claude', 'implementer')).toBe(
        'claude -p --dangerously-skip-permissions --allowedTools "Bash Read Write Edit Glob Grep mcp__*__get-implementer-guide mcp__*__search mcp__*__spec-status" --'
      );
    });

    it('resolves claude reviewer', () => {
      expect(resolveAgentCli('claude', 'reviewer')).toBe(
        'claude -p --allowedTools "Bash Read Glob Grep mcp__*__get-reviewer-guide mcp__*__search" --'
      );
    });

    it('resolves codex implementer', () => {
      expect(resolveAgentCli('codex', 'implementer')).toBe('codex exec --full-auto');
    });

    it('resolves codex reviewer', () => {
      expect(resolveAgentCli('codex', 'reviewer')).toBe('codex exec --sandbox read-only');
    });

    it('resolves gemini implementer', () => {
      expect(resolveAgentCli('gemini', 'implementer')).toBe('gemini --yolo');
    });

    it('resolves gemini reviewer', () => {
      expect(resolveAgentCli('gemini', 'reviewer')).toBe('gemini --plan');
    });

    it('resolves opencode implementer', () => {
      expect(resolveAgentCli('opencode', 'implementer')).toBe('opencode run');
    });

    it('resolves opencode reviewer', () => {
      expect(resolveAgentCli('opencode', 'reviewer')).toBe('opencode run');
    });

    it('resolves known aliases', () => {
      expect(resolveAgentCli('claude-code', 'reviewer')).toBe(
        'claude -p --allowedTools "Bash Read Glob Grep mcp__*__get-reviewer-guide mcp__*__search" --'
      );
      expect(resolveAgentCli('codex-cli', 'implementer')).toBe('codex exec --full-auto');
      expect(resolveAgentCli('gemini-cli', 'reviewer')).toBe('gemini --plan');
      expect(resolveAgentCli('opencode-cli', 'implementer')).toBe('opencode run');
    });

    it('is case-insensitive', () => {
      expect(resolveAgentCli('Claude', 'implementer')).toBe(
        'claude -p --dangerously-skip-permissions --allowedTools "Bash Read Write Edit Glob Grep mcp__*__get-implementer-guide mcp__*__search mcp__*__spec-status" --'
      );
      expect(resolveAgentCli('CODEX', 'reviewer')).toBe('codex exec --sandbox read-only');
      expect(resolveAgentCli('OpEnCoDe', 'reviewer')).toBe('opencode run');
    });

    it('passes through unknown values as-is', () => {
      expect(resolveAgentCli('my-custom-agent --flag', 'implementer')).toBe('my-custom-agent --flag');
    });

    it('trims whitespace', () => {
      expect(resolveAgentCli('  claude  ', 'reviewer')).toBe(
        'claude -p --allowedTools "Bash Read Glob Grep mcp__*__get-reviewer-guide mcp__*__search" --'
      );
    });
  });

  describe('getDispatchCli', () => {
    it('returns null when implementer CLI not set', () => {
      expect(getDispatchCli('implementer')).toBeNull();
    });

    it('returns null when reviewer CLI not set', () => {
      expect(getDispatchCli('reviewer')).toBeNull();
    });

    it('resolves known agent for implementer', () => {
      process.env.SPEC_CONTEXT_IMPLEMENTER = 'claude';
      expect(getDispatchCli('implementer')).toBe(
        'claude -p --dangerously-skip-permissions --allowedTools "Bash Read Write Edit Glob Grep mcp__*__get-implementer-guide mcp__*__search mcp__*__spec-status" --'
      );
    });

    it('resolves known agent for reviewer', () => {
      process.env.SPEC_CONTEXT_REVIEWER = 'codex';
      expect(getDispatchCli('reviewer')).toBe('codex exec --sandbox read-only');
    });

    it('passes through custom commands', () => {
      process.env.SPEC_CONTEXT_IMPLEMENTER = 'my-agent --headless';
      expect(getDispatchCli('implementer')).toBe('my-agent --headless');
    });

    it('returns null for empty string', () => {
      process.env.SPEC_CONTEXT_IMPLEMENTER = '';
      expect(getDispatchCli('implementer')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      process.env.SPEC_CONTEXT_IMPLEMENTER = '   ';
      expect(getDispatchCli('implementer')).toBeNull();
    });
  });

  describe('KNOWN_AGENTS', () => {
    it('exports known agent names', () => {
      expect(KNOWN_AGENTS).toContain('claude');
      expect(KNOWN_AGENTS).toContain('codex');
      expect(KNOWN_AGENTS).toContain('gemini');
      expect(KNOWN_AGENTS).toContain('opencode');
    });
  });

  describe('resolveDispatchProvider', () => {
    it('resolves canonical provider from command text', () => {
      expect(resolveDispatchProvider('claude -p --foo')).toBe('claude');
      expect(resolveDispatchProvider('codex exec --full-auto')).toBe('codex');
    });

    it('returns null for unknown command', () => {
      expect(resolveDispatchProvider('custom-agent --run')).toBeNull();
    });
  });

  describe('PROVIDER_CAPABILITIES', () => {
    it('declares schema constrained capability for all catalog providers', () => {
      expect(PROVIDER_CAPABILITIES.claude.schemaConstrained).toBe(true);
      expect(PROVIDER_CAPABILITIES.codex.schemaConstrained).toBe(true);
      expect(PROVIDER_CAPABILITIES.gemini.schemaConstrained).toBe(true);
      expect(PROVIDER_CAPABILITIES.opencode.schemaConstrained).toBe(true);
    });
  });
});
