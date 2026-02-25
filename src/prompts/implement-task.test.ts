import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { implementTaskPrompt } from './implement-task.js';
import { SettingsManager } from '../dashboard/settings-manager.js';
import { SPEC_WORKFLOW_HOME_ENV } from '../core/workflow/global-dir.js';

describe('implement-task prompt', () => {
  let workflowHomeDir: string;
  const originalEnv = process.env;

  const context = {
    projectPath: '/tmp/test-project',
    dashboardUrl: 'http://localhost:3000',
  };

  beforeEach(async () => {
    process.env = { ...originalEnv };
    workflowHomeDir = join(tmpdir(), `implement-task-wfhome-${Date.now()}-${Math.random()}`);
    await fs.mkdir(workflowHomeDir, { recursive: true });
    process.env[SPEC_WORKFLOW_HOME_ENV] = workflowHomeDir;

    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({
      implementer: 'claude',
      reviewer: 'gemini',
    });
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(workflowHomeDir, { recursive: true, force: true });
  });

  it('uses ledger-backed compile_prompt flow and keeps explicit reviewer diff guidance', async () => {
    const messages = await implementTaskPrompt.handler(
      { specName: 'sample-spec', taskId: '1.1' },
      context as any
    );

    expect(messages).toHaveLength(1);
    const text = messages[0]?.content?.type === 'text' ? messages[0].content.text : '';

    expect(text).toContain('Omit `taskPrompt` to use the ledger/task prompt from runtime state (fail fast if missing).');
    expect(text).toContain('Reviewer context remains explicit in workflow steps: base SHA + `git diff {base-sha}..HEAD`.');
    expect(text).toContain('`action: "dispatch_and_ingest"`');
    expect(text).toContain('Runtime compiles prompt, executes provider, ingests strict contract, and returns deterministic `nextAction`.');
    expect(text).not.toContain('Reviews are disabled in minimal mode.');
    expect(text).not.toContain('`taskPrompt: "{_Prompt content}"`');
    expect(text).not.toContain('`taskPrompt: "{review prompt + base SHA + diff scope}"`');
    expect(text).not.toContain('{dispatch_cli from reviewer compile_prompt}');
  });

  it('uses runtime dispatch_and_ingest for reviewer even when reviewer is not configured', async () => {
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({ reviewer: null as any });

    const messages = await implementTaskPrompt.handler(
      { specName: 'sample-spec', taskId: '1.1' },
      context as any
    );

    const text = messages[0]?.content?.type === 'text' ? messages[0].content.text : '';
    expect(text).toContain('Reviewer Dispatch:** runtime-owned via `dispatch-runtime` (`dispatch_and_ingest`)');
    expect(text).toContain('`action: "dispatch_and_ingest"`');
    expect(text).not.toContain('review yourself');
    expect(text).not.toContain('No reviewer CLI configured');
  });

  it('shows minimal-mode review-disabled copy only in minimal mode', async () => {
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({ discipline: 'minimal' });

    const messages = await implementTaskPrompt.handler(
      { specName: 'sample-spec', taskId: '1.1' },
      context as any
    );

    const text = messages[0]?.content?.type === 'text' ? messages[0].content.text : '';
    expect(text).toContain('Skip Review (minimal mode)');
    expect(text).toContain('Skip review in minimal mode.');
    expect(text).not.toContain('Dispatch Review');
  });
});
