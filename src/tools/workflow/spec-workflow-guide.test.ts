import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { specWorkflowGuideHandler } from './spec-workflow-guide.js';
import { TestFileContentCache } from './test-file-content-cache.js';
import { SettingsManager } from '../../dashboard/settings-manager.js';
import { SPEC_WORKFLOW_HOME_ENV } from '../../core/workflow/global-dir.js';

describe('spec-workflow-guide', () => {
  let workflowHomeDir: string;
  const originalEnv = process.env;

  const createContext = () => ({
    projectPath: join(tmpdir(), 'spec-workflow-guide-test'),
    dashboardUrl: 'http://localhost:3000',
    fileContentCache: new TestFileContentCache(),
  });

  beforeEach(async () => {
    process.env = { ...originalEnv };
    workflowHomeDir = join(tmpdir(), `spec-wf-guide-wfhome-${Date.now()}-${Math.random()}`);
    await fs.mkdir(workflowHomeDir, { recursive: true });
    process.env[SPEC_WORKFLOW_HOME_ENV] = workflowHomeDir;

    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({
      implementer: 'claude',
      reviewer: 'opencode',
    });
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(workflowHomeDir, { recursive: true, force: true });
  });

  it('uses ledger-backed compile_prompt guidance and keeps reviewer git diff steps explicit', async () => {
    const result = await specWorkflowGuideHandler({}, createContext());
    expect(result.success).toBe(true);

    const guide = String(result.data?.guide ?? '');
    expect(guide).toContain('Omit `taskPrompt` to use runtime ledger task prompt (fail fast if missing).');
    expect(guide).toContain('Reviewer context remains explicit here: use base SHA and run `git diff {base-sha}..HEAD` before/while reviewing.');
    expect(guide).toContain('`action: "dispatch_and_ingest"`');
    expect(guide).toContain('Runtime compiles prompt, executes provider, validates strict contract, ingests output, and returns `nextAction`.');
    expect(guide).not.toContain('Reviews are disabled in minimal mode.');
    expect(guide).not.toContain('`taskPrompt: "{task prompt content}"`');
    expect(guide).not.toContain('`taskPrompt: "{review prompt + base SHA + diff scope}"`');
    expect(guide).not.toContain('{dispatch_cli from reviewer compile_prompt}');
  });

  it('uses runtime reviewer dispatch_and_ingest guidance when reviewer is not configured', async () => {
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({ reviewer: null as any });

    const result = await specWorkflowGuideHandler({}, createContext());
    expect(result.success).toBe(true);

    const guide = String(result.data?.guide ?? '');
    expect(guide).toContain('`action: "dispatch_and_ingest"`');
    expect(guide).not.toContain('Review implementation<br/>directly');
    expect(guide).not.toContain('review yourself');
  });

  it('shows review-disabled copy only in minimal mode', async () => {
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({ discipline: 'minimal' });

    const result = await specWorkflowGuideHandler({}, createContext());
    expect(result.success).toBe(true);

    const guide = String(result.data?.guide ?? '');
    expect(guide).toContain('Reviews are disabled in minimal mode.');
    expect(guide).toContain('Review dispatch is skipped in minimal mode');
    expect(guide).not.toContain('You DISPATCH reviews through \\`dispatch-runtime\\` single-action orchestration.');
  });
});
