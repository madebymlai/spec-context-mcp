import { describe, expect, it } from 'vitest';
import { dispatchRuntimeHandler } from './dispatch-runtime.js';

const context = {
  projectPath: process.cwd(),
  dashboardUrl: undefined,
};

describe('dispatch-runtime tool', () => {
  it('rejects compile_prompt when run is not initialized', async () => {
    const result = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId: 'missing-run-compile',
        role: 'implementer',
        taskId: '9.1',
        taskPrompt: 'Implement missing run check',
        maxOutputTokens: 400,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('run_not_initialized');
    expect(result.data?.errorCode).toBe('run_not_initialized');
  });

  it('rejects ingest_output when run is not initialized', async () => {
    const result = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'missing-run-ingest',
        role: 'implementer',
        taskId: '9.2',
        outputContent: `BEGIN_DISPATCH_RESULT
{"task_id":"9.2","status":"completed","summary":"Done","files_changed":[],"tests":[{"command":"npm test --run","passed":true}],"follow_up_actions":[]}
END_DISPATCH_RESULT`,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('run_not_initialized');
    expect(result.data?.errorCode).toBe('run_not_initialized');
  });

  it('rejects compile_prompt when taskId does not match initialized run task', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-mismatch-compile',
        specName: 'feature-mismatch',
        taskId: '10.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId: 'test-run-mismatch-compile',
        role: 'implementer',
        taskId: '10.2',
        taskPrompt: 'Wrong task id prompt',
        maxOutputTokens: 400,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('run_task_mismatch');
    expect(result.data?.errorCode).toBe('run_task_mismatch');
  });

  it('rejects ingest_output when taskId does not match initialized run task', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-mismatch-ingest',
        specName: 'feature-mismatch',
        taskId: '11.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'test-run-mismatch-ingest',
        role: 'implementer',
        taskId: '11.2',
        outputContent: `BEGIN_DISPATCH_RESULT
{"task_id":"11.2","status":"completed","summary":"Done","files_changed":[],"tests":[{"command":"npm test --run","passed":true}],"follow_up_actions":[]}
END_DISPATCH_RESULT`,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('run_task_mismatch');
    expect(result.data?.errorCode).toBe('run_task_mismatch');
  });

  it('initializes a run and returns snapshot state', async () => {
    const result = await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-init',
        specName: 'feature-a',
        taskId: '1.1',
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.runId).toBe('test-run-init');
    expect(result.data?.snapshot?.goal).toContain('dispatch_task');
  });

  it('ingests implementer output using strict JSON contract', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-implementer',
        specName: 'feature-b',
        taskId: '2.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'test-run-implementer',
        role: 'implementer',
        taskId: '2.1',
        outputContent: `BEGIN_DISPATCH_RESULT
{"task_id":"2.1","status":"completed","summary":"Done","files_changed":["src/a.ts"],"tests":[{"command":"npm test --run","passed":true}],"follow_up_actions":[]}
END_DISPATCH_RESULT`,
        maxOutputTokens: 400,
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.nextAction).toBe('dispatch_reviewer');
    expect(result.data?.result?.status).toBe('completed');
  });

  it('rejects invalid reviewer schema', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-reviewer-invalid',
        specName: 'feature-c',
        taskId: '3.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'test-run-reviewer-invalid',
        role: 'reviewer',
        taskId: '3.1',
        outputContent: `BEGIN_DISPATCH_RESULT
{"task_id":"3.1","assessment":"approved"}
END_DISPATCH_RESULT`,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.data?.nextAction).toBe('retry_once_schema_invalid');
  });

  it('halts after one schema-invalid retry', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-schema-terminal',
        specName: 'feature-e',
        taskId: '5.1',
      },
      context
    );

    const invalidPayload = `BEGIN_DISPATCH_RESULT
{"task_id":"5.1","assessment":"approved"}
END_DISPATCH_RESULT`;

    const first = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'test-run-schema-terminal',
        role: 'reviewer',
        taskId: '5.1',
        outputContent: invalidPayload,
      },
      context
    );
    const second = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'test-run-schema-terminal',
        role: 'reviewer',
        taskId: '5.1',
        outputContent: invalidPayload,
      },
      context
    );

    expect(first.success).toBe(false);
    expect(first.data?.nextAction).toBe('retry_once_schema_invalid');
    expect(second.success).toBe(false);
    expect(second.data?.nextAction).toBe('halt_schema_invalid_terminal');
  });

  it('rejects extra prose outside dispatch contract markers', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-prose-reject',
        specName: 'feature-g',
        taskId: '7.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'test-run-prose-reject',
        role: 'implementer',
        taskId: '7.1',
        outputContent: `Some prose first
BEGIN_DISPATCH_RESULT
{"task_id":"7.1","status":"completed","summary":"Done","files_changed":[],"tests":[{"command":"npm test --run","passed":true}],"follow_up_actions":[]}
END_DISPATCH_RESULT`,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('must start with BEGIN_DISPATCH_RESULT');
  });

  it('compiles dispatch prompt with stable hashes and delta packet', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-compile',
        specName: 'feature-f',
        taskId: '6.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId: 'test-run-compile',
        role: 'implementer',
        taskId: '6.1',
        taskPrompt: 'Implement parser changes',
        maxOutputTokens: 800,
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.stablePrefixHash).toHaveLength(64);
    expect(result.data?.fullPromptHash).toHaveLength(64);
    expect(result.data?.maxOutputTokens).toBe(800);
    expect(result.data?.guideMode).toBe('full');
    expect(result.data?.guideCacheKey).toBe('implementer:test-run-compile');
    expect(result.data?.deltaPacket?.guide_mode).toBe('full');

    const second = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId: 'test-run-compile',
        role: 'implementer',
        taskId: '6.1',
        taskPrompt: 'Implement parser changes again',
        maxOutputTokens: 800,
      },
      context
    );
    expect(second.success).toBe(true);
    expect(second.data?.guideMode).toBe('compact');
    expect(second.data?.deltaPacket?.guide_mode).toBe('compact');
  });

  it('keeps stable prefix hash constant when dynamic tail changes and keeps task prompt last', async () => {
    const runId = 'test-run-stable-hash-dynamic-tail';
    const taskId = '6.2';
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId,
        specName: 'feature-prefix-stability',
        taskId,
      },
      context
    );

    const firstPrompt = 'Implement parser changes';
    const first = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId,
        role: 'implementer',
        taskId,
        taskPrompt: firstPrompt,
        maxOutputTokens: 800,
      },
      context
    );

    const secondPrompt = 'Implement parser follow-up';
    const second = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId,
        role: 'implementer',
        taskId,
        taskPrompt: secondPrompt,
        maxOutputTokens: 800,
      },
      context
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.data?.stablePrefixHash).toBe(second.data?.stablePrefixHash);
    expect(first.data?.fullPromptHash).not.toBe(second.data?.fullPromptHash);

    const promptText = String(second.data?.prompt ?? '');
    expect((promptText.match(/Task prompt:/g) ?? []).length).toBe(1);
    expect(promptText.endsWith(`Task prompt:\n${secondPrompt}`)).toBe(true);
  });

  it('changes stable prefix hash when dispatch role changes', async () => {
    const runId = 'test-run-stable-hash-role-switch';
    const taskId = '6.3';
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId,
        specName: 'feature-prefix-stability',
        taskId,
      },
      context
    );

    const implementer = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId,
        role: 'implementer',
        taskId,
        taskPrompt: 'Implement role-sensitive behavior',
        maxOutputTokens: 800,
      },
      context
    );
    const reviewer = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId,
        role: 'reviewer',
        taskId,
        taskPrompt: 'Review role-sensitive behavior',
        maxOutputTokens: 800,
      },
      context
    );

    expect(implementer.success).toBe(true);
    expect(reviewer.success).toBe(true);
    expect(implementer.data?.stablePrefixHash).not.toBe(reviewer.data?.stablePrefixHash);
  });

  it('compacts overflowed prompts when auto compaction is enabled', async () => {
    const runId = 'test-run-compaction-auto';
    const taskId = '8.1';
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId,
        specName: 'feature-compaction',
        taskId,
      },
      context
    );

    const oversizedPrompt = `Implement task ${taskId}\n${'MUST preserve branch-critical constraints and strict JSON output.\n'.repeat(1200)}`;
    const result = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId,
        role: 'implementer',
        taskId,
        taskPrompt: oversizedPrompt,
        maxOutputTokens: 800,
        compactionAuto: true,
        compactionContext: ['Preserve task_id', 'Preserve output contract markers'],
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.compactionApplied).toBe(true);
    expect(result.data?.compactionStage).not.toBe('none');
    expect(Number(result.data?.promptTokensAfter)).toBeLessThanOrEqual(Number(result.data?.promptTokenBudget));
    expect(String(result.data?.prompt)).toContain(`Task ID: ${taskId}`);
    expect(String(result.data?.prompt)).toContain('BEGIN_DISPATCH_RESULT');

    const trace = result.data?.compactionTrace as Array<{ promptTokens: number }> | undefined;
    expect(Array.isArray(trace)).toBe(true);
    expect((trace?.length ?? 0)).toBeGreaterThan(1);
    for (let i = 1; i < (trace?.length ?? 0); i += 1) {
      expect((trace as Array<{ promptTokens: number }>)[i].promptTokens).toBeLessThanOrEqual(
        (trace as Array<{ promptTokens: number }>)[i - 1].promptTokens
      );
    }

    const snapshot = await dispatchRuntimeHandler(
      {
        action: 'get_snapshot',
        runId,
      },
      context
    );
    const facts = (snapshot.data?.snapshot?.facts ?? []) as Array<{ k: string; v: string }>;
    expect(facts.find(fact => fact.k === 'dispatch_compacted:implementer')?.v).toBe('true');
    expect(facts.find(fact => fact.k === 'dispatch_compaction_stage:implementer')?.v).toBeTruthy();
  });

  it('returns terminal overflow error when auto compaction is disabled', async () => {
    const runId = 'test-run-compaction-terminal';
    const taskId = '8.2';
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId,
        specName: 'feature-compaction',
        taskId,
      },
      context
    );

    const oversizedPrompt = `Implement task ${taskId}\n${'MUST preserve branch-critical constraints and strict JSON output.\n'.repeat(1200)}`;
    const result = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId,
        role: 'implementer',
        taskId,
        taskPrompt: oversizedPrompt,
        maxOutputTokens: 800,
        compactionAuto: false,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('dispatch_prompt_overflow_terminal');
    expect(result.data?.errorCode).toBe('dispatch_prompt_overflow_terminal');
  });

  it('returns snapshot for existing run', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-snapshot',
        specName: 'feature-d',
        taskId: '4.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'get_snapshot',
        runId: 'test-run-snapshot',
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.snapshot?.run_id).toBe('test-run-snapshot');
  });
});
