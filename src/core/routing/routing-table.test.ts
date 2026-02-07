import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../../config/discipline.js';
import { RoutingTable } from './routing-table.js';

describe('RoutingTable', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SPEC_CONTEXT_ROUTE_SIMPLE;
    delete process.env.SPEC_CONTEXT_ROUTE_MODERATE;
    delete process.env.SPEC_CONTEXT_ROUTE_COMPLEX;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses default mapping when env vars are unset', () => {
    const table = RoutingTable.fromEnvOrDefault();

    expect(table.resolve('simple', 'implementer').provider).toBe('codex');
    expect(table.resolve('moderate', 'implementer').provider).toBe('claude');
    expect(table.resolve('complex', 'implementer').provider).toBe('claude');

    expect(table.resolve('simple', 'reviewer').cli).toBe('codex exec --sandbox read-only');
  });

  it('supports env-based provider overrides', () => {
    process.env.SPEC_CONTEXT_ROUTE_SIMPLE = 'opencode';
    process.env.SPEC_CONTEXT_ROUTE_MODERATE = 'codex';
    process.env.SPEC_CONTEXT_ROUTE_COMPLEX = 'claude';

    const table = RoutingTable.fromEnvOrDefault();
    expect(table.resolve('simple', 'implementer').provider).toBe('opencode');
    expect(table.resolve('moderate', 'reviewer').provider).toBe('codex');
  });

  it('fails loud on unknown provider names', () => {
    process.env.SPEC_CONTEXT_ROUTE_SIMPLE = 'unknown-provider';
    expect(() => RoutingTable.fromEnvOrDefault()).toThrow(
      'SPEC_CONTEXT_ROUTE_SIMPLE must reference a known provider'
    );
  });

  it('falls back to next tier up when selected provider is unavailable for role', () => {
    const originalReviewer = PROVIDER_CATALOG.codex.reviewer;
    (PROVIDER_CATALOG as Record<string, Record<string, string | undefined>>).codex.reviewer = '';
    try {
      const table = new RoutingTable({
        simple: 'codex',
        moderate: 'claude',
        complex: 'claude',
      });
      const resolved = table.resolve('simple', 'reviewer');
      expect(resolved.provider).toBe('claude');
      expect(resolved.cli).toContain('claude -p');
    } finally {
      (PROVIDER_CATALOG as Record<string, Record<string, string | undefined>>).codex.reviewer = originalReviewer;
    }
  });
});
