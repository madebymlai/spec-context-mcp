import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { specWorkflowGuideHandler } from './spec-workflow-guide.js';
import { TestFileContentCache } from './test-file-content-cache.js';

const ORIGINAL_IMPLEMENTER = process.env.SPEC_CONTEXT_IMPLEMENTER;
const ORIGINAL_REVIEWER = process.env.SPEC_CONTEXT_REVIEWER;
const ORIGINAL_DISPATCH_RUNTIME_V2 = process.env.SPEC_CONTEXT_DISPATCH_RUNTIME_V2;
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
    process.env.SPEC_CONTEXT_DISPATCH_RUNTIME_V2 = '1';
    process.env.SPEC_CONTEXT_DISCIPLINE = 'full';
  });

  afterEach(() => {
    restoreEnvVar('SPEC_CONTEXT_IMPLEMENTER', ORIGINAL_IMPLEMENTER);
    restoreEnvVar('SPEC_CONTEXT_REVIEWER', ORIGINAL_REVIEWER);
    restoreEnvVar('SPEC_CONTEXT_DISPATCH_RUNTIME_V2', ORIGINAL_DISPATCH_RUNTIME_V2);
    restoreEnvVar('SPEC_CONTEXT_DISCIPLINE', ORIGINAL_DISCIPLINE);
  });

  it('uses ledger-backed compile_prompt guidance and keeps reviewer git diff steps explicit', async () => {
    const result = await specWorkflowGuideHandler({}, createContext());
    expect(result.success).toBe(true);

    const guide = String(result.data?.guide ?? '');
    expect(guide).toContain('Omit `taskPrompt` to use runtime ledger task prompt (fail fast if missing).');
    expect(guide).toContain('Reviewer context remains explicit here: use base SHA and run `git diff {base-sha}..HEAD` before/while reviewing.');
    expect(guide).toContain('`outputFilePath: "{contractOutputPath}"`');
    expect(guide).toContain('1>"{contractOutputPath}" 2>"{debugOutputPath}"');
    expect(guide).not.toContain('`taskPrompt: "{task prompt content}"`');
    expect(guide).not.toContain('`taskPrompt: "{review prompt + base SHA + diff scope}"`');
    expect(guide).not.toContain('/tmp/spec-impl.log 2>&1');
  });

  it('uses runtime reviewer dispatch guidance when SPEC_CONTEXT_REVIEWER is unset', async () => {
    delete process.env.SPEC_CONTEXT_REVIEWER;

    const result = await specWorkflowGuideHandler({}, createContext());
    expect(result.success).toBe(true);

    const guide = String(result.data?.guide ?? '');
    expect(guide).toContain('{dispatch_cli from reviewer compile_prompt}');
    expect(guide).not.toContain('Review implementation<br/>directly');
    expect(guide).not.toContain('review yourself');
  });

  it('fails fast in guide when runtime v2 is disabled and reviewer is missing', async () => {
    process.env.SPEC_CONTEXT_DISPATCH_RUNTIME_V2 = '0';
    delete process.env.SPEC_CONTEXT_REVIEWER;

    const result = await specWorkflowGuideHandler({}, createContext());
    expect(result.success).toBe(true);

    const guide = String(result.data?.guide ?? '');
    expect(guide).toContain('**⛔ BLOCKED: SPEC_CONTEXT_REVIEWER is not set.**');
    expect(guide).toContain('STOP and configure reviewer dispatch before implementation.');
  });
});
