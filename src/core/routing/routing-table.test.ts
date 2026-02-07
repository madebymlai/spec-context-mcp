import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoutingTable } from './routing-table.js';

describe('RoutingTable', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SPEC_CONTEXT_ROUTE_SIMPLE;
    delete process.env.SPEC_CONTEXT_ROUTE_COMPLEX;
    delete process.env.SPEC_CONTEXT_IMPLEMENTER;
    delete process.env.SPEC_CONTEXT_REVIEWER;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('fails loud when neither route vars nor role vars provide routing defaults', () => {
    expect(() => RoutingTable.fromEnvOrDefault()).toThrow(
      'Routing for simple complexity is not configured; set SPEC_CONTEXT_ROUTE_SIMPLE or SPEC_CONTEXT_REVIEWER'
    );
  });

  it('inherits simple/complex providers from reviewer/implementer role env when route vars are unset', () => {
    process.env.SPEC_CONTEXT_REVIEWER = 'opencode';
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'gemini';

    const table = RoutingTable.fromEnvOrDefault();
    expect(table.resolve('simple', 'implementer').provider).toBe('opencode');
    expect(table.resolve('complex', 'reviewer').provider).toBe('gemini');
  });

  it('supports env-based provider overrides', () => {
    process.env.SPEC_CONTEXT_ROUTE_SIMPLE = 'opencode';
    process.env.SPEC_CONTEXT_ROUTE_COMPLEX = 'codex';

    const table = RoutingTable.fromEnvOrDefault();
    expect(table.resolve('simple', 'implementer').provider).toBe('opencode');
    expect(table.resolve('complex', 'reviewer').provider).toBe('codex');
  });

  it('fails loud on unknown provider names', () => {
    process.env.SPEC_CONTEXT_ROUTE_SIMPLE = 'unknown-provider';
    expect(() => RoutingTable.fromEnvOrDefault()).toThrow(
      'SPEC_CONTEXT_ROUTE_SIMPLE must reference a known provider'
    );
  });

  it('fails loud when inherited role env contains unknown provider', () => {
    process.env.SPEC_CONTEXT_REVIEWER = 'unknown-provider';
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'claude';
    expect(() => RoutingTable.fromEnvOrDefault()).toThrow(
      'SPEC_CONTEXT_REVIEWER must reference a known provider'
    );
  });

  it('returns cli command for configured provider/role without additional resolution', () => {
    const table = new RoutingTable({
      simple: 'codex',
      complex: 'claude',
    });
    expect(table.resolve('simple', 'reviewer')).toEqual({
      provider: 'codex',
      cli: 'codex exec --sandbox read-only',
      role: 'reviewer',
    });
  });
});
