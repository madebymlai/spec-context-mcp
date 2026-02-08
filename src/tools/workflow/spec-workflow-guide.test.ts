import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { specWorkflowGuideHandler } from './spec-workflow-guide.js';
import { TestFileContentCache } from './test-file-content-cache.js';

const ORIGINAL_IMPLEMENTER = process.env.SPEC_CONTEXT_IMPLEMENTER;
const ORIGINAL_REVIEWER = process.env.SPEC_CONTEXT_REVIEWER;
const ORIGINAL_DISCIPLINE = process.env.SPEC_CONTEXT_DISCIPLINE;

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

describe('spec-workflow-guide', () => {
  const createContext = () => ({
    projectPath: join(tmpdir(), 'spec-workflow-guide-test'),
    dashboardUrl: 'http://localhost:3000',
    fileContentCache: new TestFileContentCache(),
  });

  beforeEach(() => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'claude';
    process.env.SPEC_CONTEXT_REVIEWER = 'opencode';
    process.env.SPEC_CONTEXT_DISCIPLINE = 'full';
  });

  afterEach(() => {
    restoreEnvVar('SPEC_CONTEXT_IMPLEMENTER', ORIGINAL_IMPLEMENTER);
    restoreEnvVar('SPEC_CONTEXT_REVIEWER', ORIGINAL_REVIEWER);
    restoreEnvVar('SPEC_CONTEXT_DISCIPLINE', ORIGINAL_DISCIPLINE);
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

  it('uses runtime reviewer dispatch_and_ingest guidance when SPEC_CONTEXT_REVIEWER is unset', async () => {
    delete process.env.SPEC_CONTEXT_REVIEWER;

    const result = await specWorkflowGuideHandler({}, createContext());
    expect(result.success).toBe(true);

    const guide = String(result.data?.guide ?? '');
    expect(guide).toContain('`action: "dispatch_and_ingest"`');
    expect(guide).not.toContain('Review implementation<br/>directly');
    expect(guide).not.toContain('review yourself');
  });

  it('shows review-disabled copy only in minimal mode', async () => {
    process.env.SPEC_CONTEXT_DISCIPLINE = 'minimal';

    const result = await specWorkflowGuideHandler({}, createContext());
    expect(result.success).toBe(true);

    const guide = String(result.data?.guide ?? '');
    expect(guide).toContain('Reviews are disabled in minimal mode.');
    expect(guide).toContain('Review dispatch is skipped in minimal mode');
    expect(guide).not.toContain('You DISPATCH reviews through \\`dispatch-runtime\\` single-action orchestration.');
  });
});
