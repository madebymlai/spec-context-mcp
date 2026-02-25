import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsManager } from '../dashboard/settings-manager.js';
import { SPEC_WORKFLOW_HOME_ENV } from '../core/workflow/global-dir.js';
import { resolveRuntimeSettings } from './runtime-settings.js';

describe('runtime settings resolution', () => {
  const originalEnv = process.env;
  let workflowHomeDir: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    workflowHomeDir = join(tmpdir(), `spec-context-resolved-runtime-settings-${Date.now()}-${Math.random()}`);
    process.env[SPEC_WORKFLOW_HOME_ENV] = workflowHomeDir;
    await fs.mkdir(workflowHomeDir, { recursive: true });
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(workflowHomeDir, { recursive: true, force: true });
  });

  it('uses hardcoded defaults when settings.json has no runtime settings', async () => {
    await expect(resolveRuntimeSettings()).resolves.toEqual({
      discipline: { value: 'full', source: 'default' },
      implementer: { value: null, source: 'default' },
      reviewer: { value: null, source: 'default' },
      implementerModelSimple: { value: null, source: 'default' },
      implementerModelComplex: { value: null, source: 'default' },
      reviewerModelSimple: { value: null, source: 'default' },
      reviewerModelComplex: { value: null, source: 'default' },
      implementerReasoningEffort: { value: null, source: 'default' },
      reviewerReasoningEffort: { value: null, source: 'default' },
      dashboardUrl: { value: 'http://localhost:3000', source: 'default' },
    });
  });

  it('ignores env vars — all settings come from json or default', async () => {
    process.env.SPEC_CONTEXT_DISCIPLINE = 'standard';
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'codex';
    process.env.SPEC_CONTEXT_REVIEWER = 'claude';
    process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE = 'model-simple-1';
    process.env.DASHBOARD_URL = 'http://env.localhost:3210';

    await expect(resolveRuntimeSettings()).resolves.toEqual({
      discipline: { value: 'full', source: 'default' },
      implementer: { value: null, source: 'default' },
      reviewer: { value: null, source: 'default' },
      implementerModelSimple: { value: null, source: 'default' },
      implementerModelComplex: { value: null, source: 'default' },
      reviewerModelSimple: { value: null, source: 'default' },
      reviewerModelComplex: { value: null, source: 'default' },
      implementerReasoningEffort: { value: null, source: 'default' },
      reviewerReasoningEffort: { value: null, source: 'default' },
      dashboardUrl: { value: 'http://localhost:3000', source: 'default' },
    });
  });

  it('resolves all fields from settings.json', async () => {
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({
      discipline: 'minimal',
      implementer: 'claude',
      reviewer: 'gemini',
      implementerModelSimple: 'json-simple',
      implementerModelComplex: 'json-complex',
      reviewerModelSimple: 'json-rev-simple',
      reviewerModelComplex: 'json-rev-complex',
      implementerReasoningEffort: 'medium',
      reviewerReasoningEffort: 'high',
      dashboardUrl: 'http://json.localhost:3002',
    });

    await expect(resolveRuntimeSettings()).resolves.toEqual({
      discipline: { value: 'minimal', source: 'json' },
      implementer: { value: 'claude', source: 'json' },
      reviewer: { value: 'gemini', source: 'json' },
      implementerModelSimple: { value: 'json-simple', source: 'json' },
      implementerModelComplex: { value: 'json-complex', source: 'json' },
      reviewerModelSimple: { value: 'json-rev-simple', source: 'json' },
      reviewerModelComplex: { value: 'json-rev-complex', source: 'json' },
      implementerReasoningEffort: { value: 'medium', source: 'json' },
      reviewerReasoningEffort: { value: 'high', source: 'json' },
      dashboardUrl: { value: 'http://json.localhost:3002', source: 'json' },
    });
  });

  it('throws on invalid discipline in settings.json', async () => {
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({ discipline: 'invalid' as any });
    await expect(resolveRuntimeSettings()).rejects.toThrow('Invalid discipline value in settings.json');
  });

  it('re-reads settings.json on each invocation', async () => {
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({ implementer: 'claude' });

    await expect(resolveRuntimeSettings()).resolves.toMatchObject({
      implementer: { value: 'claude', source: 'json' },
    });

    await manager.updateRuntimeSettings({ implementer: 'opencode' });

    await expect(resolveRuntimeSettings()).resolves.toMatchObject({
      implementer: { value: 'opencode', source: 'json' },
    });
  });
});
