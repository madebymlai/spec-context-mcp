import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getDisciplineMode,
  getDispatchCli,
  KNOWN_AGENTS,
  PROVIDER_CAPABILITIES,
  resolveAgentCli,
  resolveDispatchProvider,
} from './discipline.js';
import { SettingsManager } from '../dashboard/settings-manager.js';
import { SPEC_WORKFLOW_HOME_ENV } from '../core/workflow/global-dir.js';

describe('discipline config', () => {
  const originalEnv = process.env;
  let workflowHomeDir: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    delete process.env.SPEC_CONTEXT_DISCIPLINE;
    delete process.env.SPEC_CONTEXT_IMPLEMENTER;
    delete process.env.SPEC_CONTEXT_REVIEWER;
    workflowHomeDir = join(tmpdir(), `spec-context-discipline-config-${Date.now()}-${Math.random()}`);
    process.env[SPEC_WORKFLOW_HOME_ENV] = workflowHomeDir;
    await fs.mkdir(workflowHomeDir, { recursive: true });
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(workflowHomeDir, { recursive: true, force: true });
  });

  describe('getDisciplineMode', () => {
    it('returns "full" by default when not configured', async () => {
      await expect(getDisciplineMode()).resolves.toBe('full');
    });

    it('reads discipline from settings.json', async () => {
      const manager = new SettingsManager();
      await manager.updateRuntimeSettings({ discipline: 'standard' });
      await expect(getDisciplineMode()).resolves.toBe('standard');

      await manager.updateRuntimeSettings({ discipline: 'minimal' });
      await expect(getDisciplineMode()).resolves.toBe('minimal');

      await manager.updateRuntimeSettings({ discipline: 'full' });
      await expect(getDisciplineMode()).resolves.toBe('full');
    });

    it('ignores SPEC_CONTEXT_DISCIPLINE env var', async () => {
      process.env.SPEC_CONTEXT_DISCIPLINE = 'minimal';
      await expect(getDisciplineMode()).resolves.toBe('full');
    });

    it('throws on invalid discipline in settings.json', async () => {
      const manager = new SettingsManager();
      await manager.updateRuntimeSettings({ discipline: 'bogus' as any });
      await expect(getDisciplineMode()).rejects.toThrow('Invalid discipline value in settings.json');
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

    it('fails loud for unknown values', () => {
      expect(() => resolveAgentCli('my-custom-agent --flag', 'implementer')).toThrow(
        'Unknown provider "my-custom-agent --flag" for role implementer'
      );
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

    it('fails loud for custom commands', () => {
      process.env.SPEC_CONTEXT_IMPLEMENTER = 'my-agent --headless';
      expect(() => getDispatchCli('implementer')).toThrow(
        'Unknown provider "my-agent --headless" for role implementer'
      );
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
