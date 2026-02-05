import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDisciplineMode, getDispatchCli } from './discipline.js';

describe('discipline config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset process.env before each test
    process.env = { ...originalEnv };
    // Clear any discipline-related env vars
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

  describe('getDispatchCli', () => {
    it('returns null when implementer CLI not set', () => {
      expect(getDispatchCli('implementer')).toBeNull();
    });

    it('returns null when reviewer CLI not set', () => {
      expect(getDispatchCli('reviewer')).toBeNull();
    });

    it('returns CLI value when implementer is set', () => {
      process.env.SPEC_CONTEXT_IMPLEMENTER = 'claude';
      expect(getDispatchCli('implementer')).toBe('claude');
    });

    it('returns CLI value when reviewer is set', () => {
      process.env.SPEC_CONTEXT_REVIEWER = 'codex';
      expect(getDispatchCli('reviewer')).toBe('codex');
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
});
