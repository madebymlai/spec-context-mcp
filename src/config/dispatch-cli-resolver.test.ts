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
    delete process.env.SPEC_CONTEXT_IMPLEMENTER;
    delete process.env.SPEC_CONTEXT_REVIEWER;
    delete process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE;
    delete process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_COMPLEX;
    delete process.env.SPEC_CONTEXT_REVIEWER_MODEL_SIMPLE;
    delete process.env.SPEC_CONTEXT_REVIEWER_MODEL_COMPLEX;
    delete process.env.SPEC_CONTEXT_IMPLEMENTER_REASONING_EFFORT;
    delete process.env.SPEC_CONTEXT_REVIEWER_REASONING_EFFORT;
    workflowHomeDir = join(tmpdir(), `spec-context-dispatch-cli-resolver-${Date.now()}-${Math.random()}`);
    process.env[SPEC_WORKFLOW_HOME_ENV] = workflowHomeDir;
    await fs.mkdir(workflowHomeDir, { recursive: true });
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(workflowHomeDir, { recursive: true, force: true });
  });

  it('appends model flags for claude tiers', async () => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'claude';
    process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE = 'sonnet-4.5';
    process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_COMPLEX = 'opus-4.6';

    const simple = await getDispatchCommandForComplexity('implementer', 'simple');
    const complex = await getDispatchCommandForComplexity('implementer', 'complex');
    expect(simple?.args).toContain('sonnet-4.5');
    expect(complex?.args).toContain('opus-4.6');
  });

  it('appends model and reasoning effort for codex tiers', async () => {
    process.env.SPEC_CONTEXT_REVIEWER = 'codex';
    process.env.SPEC_CONTEXT_REVIEWER_MODEL_SIMPLE = 'codex-5.3';
    process.env.SPEC_CONTEXT_REVIEWER_REASONING_EFFORT = 'medium';

    const command = await getDispatchCommandForComplexity('reviewer', 'simple');
    expect(command?.args).toContain('codex-5.3');
    expect(command?.args).toContain('model_reasoning_effort=medium');
  });

  it('uses non-tiered reasoning effort when set', async () => {
    process.env.SPEC_CONTEXT_REVIEWER = 'codex';
    process.env.SPEC_CONTEXT_REVIEWER_MODEL_COMPLEX = 'codex-5.3';
    process.env.SPEC_CONTEXT_REVIEWER_REASONING_EFFORT = 'xhigh';

    const command = await getDispatchCommandForComplexity('reviewer', 'complex');
    expect(command?.args).toContain('codex-5.3');
    expect(command?.args).toContain('model_reasoning_effort=xhigh');
  });

  it('fails loud when role env does not resolve to known provider', async () => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'my-agent --headless';
    await expect(getDispatchCommandForComplexity('implementer', 'simple')).rejects.toThrow(
      'SPEC_CONTEXT_IMPLEMENTER must reference a known provider; received "my-agent --headless"'
    );
  });

  it('uses settings.json provider/model/reasoning ahead of env', async () => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'gemini';
    process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE = 'env-model-simple';
    process.env.SPEC_CONTEXT_IMPLEMENTER_REASONING_EFFORT = 'low';

    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({
      implementer: 'codex',
      implementerModelSimple: 'json-model-simple',
      implementerReasoningEffort: 'high',
    });

    const command = await getDispatchCommandForComplexity('implementer', 'simple');
    expect(command?.provider).toBe('codex');
    expect(command?.args).toContain('json-model-simple');
    expect(command?.args).toContain('model_reasoning_effort=high');
  });
});
