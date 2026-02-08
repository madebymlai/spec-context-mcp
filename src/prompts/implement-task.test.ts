import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { implementTaskPrompt } from './implement-task.js';

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

describe('implement-task prompt', () => {
  const context = {
    projectPath: '/tmp/test-project',
    dashboardUrl: 'http://localhost:3000',
  };

  beforeEach(() => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'claude';
    process.env.SPEC_CONTEXT_REVIEWER = 'gemini';
    process.env.SPEC_CONTEXT_DISCIPLINE = 'full';
  });

  afterEach(() => {
    restoreEnvVar('SPEC_CONTEXT_IMPLEMENTER', ORIGINAL_IMPLEMENTER);
    restoreEnvVar('SPEC_CONTEXT_REVIEWER', ORIGINAL_REVIEWER);
    restoreEnvVar('SPEC_CONTEXT_DISCIPLINE', ORIGINAL_DISCIPLINE);
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

  it('uses runtime dispatch_and_ingest for reviewer even when SPEC_CONTEXT_REVIEWER is unset', async () => {
    delete process.env.SPEC_CONTEXT_REVIEWER;

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
    process.env.SPEC_CONTEXT_DISCIPLINE = 'minimal';

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
