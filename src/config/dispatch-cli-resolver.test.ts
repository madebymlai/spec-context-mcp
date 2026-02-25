import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getDispatchCommandForComplexity } from './dispatch-cli-resolver.js';
import { SettingsManager } from '../dashboard/settings-manager.js';
import { SPEC_WORKFLOW_HOME_ENV } from '../core/workflow/global-dir.js';

describe('dispatch-cli-resolver', () => {
  const originalEnv = process.env;
  let workflowHomeDir: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    workflowHomeDir = join(tmpdir(), `spec-context-dispatch-cli-resolver-${Date.now()}-${Math.random()}`);
    process.env[SPEC_WORKFLOW_HOME_ENV] = workflowHomeDir;
    await fs.mkdir(workflowHomeDir, { recursive: true });
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(workflowHomeDir, { recursive: true, force: true });
  });

  it('returns null when no provider configured', async () => {
    const result = await getDispatchCommandForComplexity('implementer', 'simple');
    expect(result).toBeNull();
  });

  it('appends model flags for claude tiers', async () => {
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({
      implementer: 'claude',
      implementerModelSimple: 'sonnet-4.5',
      implementerModelComplex: 'opus-4.6',
    });

    const simple = await getDispatchCommandForComplexity('implementer', 'simple');
    const complex = await getDispatchCommandForComplexity('implementer', 'complex');
    expect(simple?.args).toContain('sonnet-4.5');
    expect(complex?.args).toContain('opus-4.6');
  });

  it('appends model and reasoning effort for codex tiers', async () => {
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({
      reviewer: 'codex',
      reviewerModelSimple: 'codex-5.3',
      reviewerReasoningEffort: 'medium',
    });

    const command = await getDispatchCommandForComplexity('reviewer', 'simple');
    expect(command?.args).toContain('codex-5.3');
    expect(command?.args).toContain('model_reasoning_effort=medium');
  });

  it('uses non-tiered reasoning effort when set', async () => {
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({
      reviewer: 'codex',
      reviewerModelComplex: 'codex-5.3',
      reviewerReasoningEffort: 'xhigh',
    });

    const command = await getDispatchCommandForComplexity('reviewer', 'complex');
    expect(command?.args).toContain('codex-5.3');
    expect(command?.args).toContain('model_reasoning_effort=xhigh');
  });

  it('fails loud when provider is not a known agent', async () => {
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({ implementer: 'my-agent --headless' });
    await expect(getDispatchCommandForComplexity('implementer', 'simple')).rejects.toThrow(
      'implementer provider must reference a known provider; received "my-agent --headless"'
    );
  });

  it('ignores env vars — only reads from settings.json', async () => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'gemini';
    process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE = 'env-model-simple';

    const result = await getDispatchCommandForComplexity('implementer', 'simple');
    expect(result).toBeNull();
  });
});
