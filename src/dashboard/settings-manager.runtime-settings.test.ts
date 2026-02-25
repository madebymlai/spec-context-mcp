import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsManager } from './settings-manager.js';
import { SPEC_WORKFLOW_HOME_ENV } from '../core/workflow/global-dir.js';
import type { RuntimeSettings } from '../workflow-types.js';

describe('SettingsManager runtime settings', () => {
  const originalWorkflowHome = process.env[SPEC_WORKFLOW_HOME_ENV];
  let workflowHomeDir: string;
  let manager: SettingsManager;

  beforeEach(async () => {
    workflowHomeDir = join(tmpdir(), `spec-context-runtime-settings-${Date.now()}-${Math.random()}`);
    process.env[SPEC_WORKFLOW_HOME_ENV] = workflowHomeDir;
    await fs.mkdir(workflowHomeDir, { recursive: true });
    manager = new SettingsManager();
  });

  afterEach(async () => {
    if (originalWorkflowHome === undefined) {
      delete process.env[SPEC_WORKFLOW_HOME_ENV];
    } else {
      process.env[SPEC_WORKFLOW_HOME_ENV] = originalWorkflowHome;
    }

    await fs.rm(workflowHomeDir, { recursive: true, force: true });
  });

  it('returns an empty object when runtime settings are not present', async () => {
    await expect(manager.getRuntimeSettings()).resolves.toEqual({});
  });

  it('returns stored runtime settings', async () => {
    const settings = await manager.loadSettings();
    settings.runtimeSettings = {
      discipline: 'standard',
      implementer: 'codex',
    };
    await manager.saveSettings(settings);

    await expect(manager.getRuntimeSettings()).resolves.toEqual({
      discipline: 'standard',
      implementer: 'codex',
    });
  });

  it('merges runtime setting updates into stored settings', async () => {
    const settings = await manager.loadSettings();
    settings.runtimeSettings = {
      discipline: 'full',
      implementer: 'claude',
    };
    await manager.saveSettings(settings);

    await manager.updateRuntimeSettings({ reviewer: 'codex' });

    await expect(manager.getRuntimeSettings()).resolves.toEqual({
      discipline: 'full',
      implementer: 'claude',
      reviewer: 'codex',
    });
  });

  it('deletes runtime settings keys when updates contain null values', async () => {
    const settings = await manager.loadSettings();
    settings.runtimeSettings = {
      implementer: 'claude',
      reviewer: 'codex',
    };
    await manager.saveSettings(settings);

    await manager.updateRuntimeSettings({
      implementer: null as unknown as RuntimeSettings['implementer'],
      reviewer: 'gemini',
    });

    await expect(manager.getRuntimeSettings()).resolves.toEqual({
      reviewer: 'gemini',
    });
  });
});
