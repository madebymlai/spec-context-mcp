import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { implementTaskPrompt } from './implement-task.js';

const ORIGINAL_IMPLEMENTER = process.env.SPEC_CONTEXT_IMPLEMENTER;
const ORIGINAL_REVIEWER = process.env.SPEC_CONTEXT_REVIEWER;
const ORIGINAL_DISPATCH_RUNTIME_V2 = process.env.SPEC_CONTEXT_DISPATCH_RUNTIME_V2;

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
    process.env.SPEC_CONTEXT_DISPATCH_RUNTIME_V2 = '1';
  });

  afterEach(() => {
    restoreEnvVar('SPEC_CONTEXT_IMPLEMENTER', ORIGINAL_IMPLEMENTER);
    restoreEnvVar('SPEC_CONTEXT_REVIEWER', ORIGINAL_REVIEWER);
    restoreEnvVar('SPEC_CONTEXT_DISPATCH_RUNTIME_V2', ORIGINAL_DISPATCH_RUNTIME_V2);
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
    expect(text).toContain('`outputFilePath: "{contractOutputPath from step 5}"`');
    expect(text).toContain('1>"{contractOutputPath from step 5}" 2>"{debugOutputPath from step 5}"');
    expect(text).not.toContain('`taskPrompt: "{_Prompt content}"`');
    expect(text).not.toContain('`taskPrompt: "{review prompt + base SHA + diff scope}"`');
    expect(text).not.toContain('/tmp/spec-impl.log 2>&1');
  });
});
