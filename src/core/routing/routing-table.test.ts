import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RoutingTable } from './routing-table.js';
import { SettingsManager } from '../../dashboard/settings-manager.js';
import { SPEC_WORKFLOW_HOME_ENV } from '../workflow/global-dir.js';

describe('RoutingTable', () => {
  const originalEnv = process.env;
  let workflowHomeDir: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    workflowHomeDir = join(tmpdir(), `routing-table-test-${Date.now()}-${Math.random()}`);
    await fs.mkdir(workflowHomeDir, { recursive: true });
    process.env[SPEC_WORKFLOW_HOME_ENV] = workflowHomeDir;
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(workflowHomeDir, { recursive: true, force: true });
  });

  it('fails loud when neither reviewer nor implementer are configured', async () => {
    await expect(RoutingTable.fromSettings()).rejects.toThrow(
      'Routing for simple complexity is not configured; set reviewer in dashboard settings'
    );
  });

  it('inherits simple from reviewer and complex from implementer', async () => {
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({ reviewer: 'opencode', implementer: 'gemini' });

    const table = await RoutingTable.fromSettings();
    expect(table.resolve('simple', 'implementer').provider).toBe('opencode');
    expect(table.resolve('complex', 'reviewer').provider).toBe('gemini');
  });

  it('fails loud on unknown provider names', async () => {
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({ reviewer: 'unknown-provider', implementer: 'claude' });

    await expect(RoutingTable.fromSettings()).rejects.toThrow(
      'reviewer must reference a known provider'
    );
  });

  it('returns provider/role tuple for configured routing target', () => {
    const table = new RoutingTable({
      simple: 'codex',
      complex: 'claude',
    });
    expect(table.resolve('simple', 'reviewer')).toEqual({
      provider: 'codex',
      role: 'reviewer',
    });
  });
});
