import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsManager } from '../dashboard/settings-manager.js';
import { SPEC_WORKFLOW_HOME_ENV } from '../core/workflow/global-dir.js';
import { resolveRuntimeSettings } from './runtime-settings.js';

describe('runtime settings resolution', () => {
  const originalEnv = process.env;
  const runtimeEnvKeys = [
    'SPEC_CONTEXT_DISCIPLINE',
    'SPEC_CONTEXT_IMPLEMENTER',
    'SPEC_CONTEXT_REVIEWER',
    'SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE',
    'SPEC_CONTEXT_IMPLEMENTER_MODEL_COMPLEX',
    'SPEC_CONTEXT_REVIEWER_MODEL_SIMPLE',
    'SPEC_CONTEXT_REVIEWER_MODEL_COMPLEX',
    'SPEC_CONTEXT_IMPLEMENTER_REASONING_EFFORT',
    'SPEC_CONTEXT_REVIEWER_REASONING_EFFORT',
    'DASHBOARD_URL',
  ] as const;

  let workflowHomeDir: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    for (const key of runtimeEnvKeys) {
      delete process.env[key];
    }

    workflowHomeDir = join(tmpdir(), `spec-context-resolved-runtime-settings-${Date.now()}-${Math.random()}`);
    process.env[SPEC_WORKFLOW_HOME_ENV] = workflowHomeDir;
    await fs.mkdir(workflowHomeDir, { recursive: true });
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(workflowHomeDir, { recursive: true, force: true });
  });

  it('uses hardcoded defaults when json and env are unset', async () => {
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

  it('uses env settings when json values are unset', async () => {
    process.env.SPEC_CONTEXT_DISCIPLINE = 'standard';
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'codex';
    process.env.SPEC_CONTEXT_REVIEWER = 'claude';
    process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE = 'model-simple-1';
    process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_COMPLEX = 'model-complex-1';
    process.env.SPEC_CONTEXT_REVIEWER_MODEL_SIMPLE = 'model-simple-2';
    process.env.SPEC_CONTEXT_REVIEWER_MODEL_COMPLEX = 'model-complex-2';
    process.env.SPEC_CONTEXT_IMPLEMENTER_REASONING_EFFORT = 'low';
    process.env.SPEC_CONTEXT_REVIEWER_REASONING_EFFORT = 'high';
    process.env.DASHBOARD_URL = 'http://env.localhost:3210';

    await expect(resolveRuntimeSettings()).resolves.toEqual({
      discipline: { value: 'standard', source: 'env' },
      implementer: { value: 'codex', source: 'env' },
      reviewer: { value: 'claude', source: 'env' },
      implementerModelSimple: { value: 'model-simple-1', source: 'env' },
      implementerModelComplex: { value: 'model-complex-1', source: 'env' },
      reviewerModelSimple: { value: 'model-simple-2', source: 'env' },
      reviewerModelComplex: { value: 'model-complex-2', source: 'env' },
      implementerReasoningEffort: { value: 'low', source: 'env' },
      reviewerReasoningEffort: { value: 'high', source: 'env' },
      dashboardUrl: { value: 'http://env.localhost:3210', source: 'env' },
    });
  });

  it('resolves values in json > env > default priority order', async () => {
    process.env.SPEC_CONTEXT_DISCIPLINE = 'standard';
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'codex';
    process.env.SPEC_CONTEXT_REVIEWER = 'gemini';
    process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE = 'env-simple';
    process.env.SPEC_CONTEXT_IMPLEMENTER_REASONING_EFFORT = 'medium';
    process.env.DASHBOARD_URL = 'http://env.localhost:3001';

    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({
      discipline: 'minimal',
      implementer: 'claude',
      reviewerModelComplex: 'json-reviewer-complex',
      dashboardUrl: 'http://json.localhost:3002',
    });

    await expect(resolveRuntimeSettings()).resolves.toEqual({
      discipline: { value: 'minimal', source: 'json' },
      implementer: { value: 'claude', source: 'json' },
      reviewer: { value: 'gemini', source: 'env' },
      implementerModelSimple: { value: 'env-simple', source: 'env' },
      implementerModelComplex: { value: null, source: 'default' },
      reviewerModelSimple: { value: null, source: 'default' },
      reviewerModelComplex: { value: 'json-reviewer-complex', source: 'json' },
      implementerReasoningEffort: { value: 'medium', source: 'env' },
      reviewerReasoningEffort: { value: null, source: 'default' },
      dashboardUrl: { value: 'http://json.localhost:3002', source: 'json' },
    });
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
