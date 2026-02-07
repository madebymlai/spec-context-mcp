import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RoutingTable, type ITaskComplexityClassifier } from '../../core/routing/index.js';

const SPEC_NAME = 'dispatch-task-progress-ledgers';
const SPEC_DIR = join(process.cwd(), '.spec-context', 'specs', SPEC_NAME);

const context = {
  projectPath: process.cwd(),
  dashboardUrl: undefined,
};

const ORIGINAL_IMPLEMENTER = process.env.SPEC_CONTEXT_IMPLEMENTER;
const ORIGINAL_REVIEWER = process.env.SPEC_CONTEXT_REVIEWER;
const ORIGINAL_IMPLEMENTER_MODEL_SIMPLE = process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE;
const ORIGINAL_IMPLEMENTER_MODEL_COMPLEX = process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_COMPLEX;
const ORIGINAL_REVIEWER_MODEL_SIMPLE = process.env.SPEC_CONTEXT_REVIEWER_MODEL_SIMPLE;
const ORIGINAL_REVIEWER_MODEL_COMPLEX = process.env.SPEC_CONTEXT_REVIEWER_MODEL_COMPLEX;
const ORIGINAL_REVIEWER_REASONING_EFFORT = process.env.SPEC_CONTEXT_REVIEWER_REASONING_EFFORT;
let dispatchRuntimeHandler: (args: Record<string, unknown>, context: any) => Promise<any>;
let DispatchRuntimeManagerClass: typeof import('./dispatch-runtime.js').DispatchRuntimeManager;

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

describe('dispatch-runtime tool', () => {
  beforeAll(async () => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = process.env.SPEC_CONTEXT_IMPLEMENTER || 'claude';
    process.env.SPEC_CONTEXT_REVIEWER = process.env.SPEC_CONTEXT_REVIEWER || 'codex';
    const module = await import('./dispatch-runtime.js');
    dispatchRuntimeHandler = module.dispatchRuntimeHandler;
    DispatchRuntimeManagerClass = module.DispatchRuntimeManager;

    await mkdir(SPEC_DIR, { recursive: true });
    await writeFile(
      join(SPEC_DIR, 'tasks.md'),
      `# Tasks

- [-] 1. Root compile task
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement root compile task_
- [ ] 1.1 Init task fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement task 1.1_
- [ ] 2.1 Implementer fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement task 2.1_
- [ ] 2.9 Stalled fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement task 2.9_
- [ ] 3.1 Reviewer fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement task 3.1_
- [ ] 4.1 Snapshot fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement task 4.1_
- [ ] 5.1 Terminal fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement task 5.1_
- [ ] 6.1 Provider gate fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement task 6.1_
- [ ] 8.1 Simple routing fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Fix typo in README.md_
- [ ] 9.1 Classifier fallback fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement task 9.1_
`,
      'utf8'
    );
  });

  afterAll(async () => {
    await rm(SPEC_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'claude';
    process.env.SPEC_CONTEXT_REVIEWER = 'codex';
    delete process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE;
    delete process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_COMPLEX;
    delete process.env.SPEC_CONTEXT_REVIEWER_MODEL_SIMPLE;
    delete process.env.SPEC_CONTEXT_REVIEWER_MODEL_COMPLEX;
    delete process.env.SPEC_CONTEXT_REVIEWER_REASONING_EFFORT;
  });

  afterEach(() => {
    restoreEnvVar('SPEC_CONTEXT_IMPLEMENTER', ORIGINAL_IMPLEMENTER);
    restoreEnvVar('SPEC_CONTEXT_REVIEWER', ORIGINAL_REVIEWER);
    restoreEnvVar('SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE', ORIGINAL_IMPLEMENTER_MODEL_SIMPLE);
    restoreEnvVar('SPEC_CONTEXT_IMPLEMENTER_MODEL_COMPLEX', ORIGINAL_IMPLEMENTER_MODEL_COMPLEX);
    restoreEnvVar('SPEC_CONTEXT_REVIEWER_MODEL_SIMPLE', ORIGINAL_REVIEWER_MODEL_SIMPLE);
    restoreEnvVar('SPEC_CONTEXT_REVIEWER_MODEL_COMPLEX', ORIGINAL_REVIEWER_MODEL_COMPLEX);
    restoreEnvVar('SPEC_CONTEXT_REVIEWER_REASONING_EFFORT', ORIGINAL_REVIEWER_REASONING_EFFORT);
  });

  it('returns typed error when init_run cannot find tasks.md', async () => {
    const result = await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-missing-tasks',
        specName: 'spec-that-does-not-exist',
        taskId: '1',
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.data?.errorCode).toBe('progress_ledger_missing_tasks');
  });

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
        specName: SPEC_NAME,
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
        specName: SPEC_NAME,
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
        specName: SPEC_NAME,
        taskId: '1.1',
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.runId).toBe('test-run-init');
    expect(result.data?.snapshot?.goal).toContain('dispatch_task');
    expect(result.data?.classification_level).toBeTypeOf('string');
    expect(result.data?.selected_provider).toBeTypeOf('string');
    expect(result.data?.dispatch_cli).toBeTypeOf('string');
  });

  it('classifies simple tasks and selects the mapped provider during init_run', async () => {
    process.env.SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE = 'sonnet-4.5';

    const result = await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-init-simple-routing',
        specName: SPEC_NAME,
        taskId: '8.1',
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.classification_level).toBe('simple');
    expect(result.data?.selected_provider).toBe('codex');
    const facts = (result.data?.snapshot?.facts ?? []) as Array<{ k: string; v: string }>;
    expect(facts.find(fact => fact.k === 'classification_level')?.v).toBe('simple');
    expect(facts.find(fact => fact.k === 'selected_provider')?.v).toBe('codex');
    expect(result.data?.dispatch_cli).toContain('--model sonnet-4.5');
    expect(facts.find(fact => fact.k === 'dispatch_cli')?.v).toContain('--model sonnet-4.5');
    expect(facts.find(fact => fact.k === 'classification_features')?.v).toContain('keyword_match');
  });

  it('defaults classification to complex when classifier strategy throws', async () => {
    const classifier: ITaskComplexityClassifier = {
      classify: () => {
        throw new Error('classifier failure');
      },
    };
    const manager = new DispatchRuntimeManagerClass(
      classifier,
      new RoutingTable({
        simple: 'codex',
        complex: 'claude',
      }),
    );

    const snapshot = await manager.initRun(
      'test-run-classifier-fallback',
      SPEC_NAME,
      '9.1',
      context.projectPath
    );

    const facts = snapshot.facts as Array<{ k: string; v: string }>;
    expect(facts.find(fact => fact.k === 'classification_level')?.v).toBe('complex');
    expect(facts.find(fact => fact.k === 'selected_provider')?.v).toBe('claude');
    expect(facts.find(fact => fact.k === 'classification_classifier_id')?.v).toBe('fallback');
  });

  it('ingests implementer output using strict JSON contract', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-implementer',
        specName: SPEC_NAME,
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

  it('tracks stalled counters and resets after progress', async () => {
    const runId = 'test-run-stalled-counters';
    const taskId = '2.9';
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId,
        specName: SPEC_NAME,
        taskId,
      },
      context
    );

    const blockedOnce = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId,
        role: 'implementer',
        taskId,
        outputContent: `BEGIN_DISPATCH_RESULT
{"task_id":"${taskId}","status":"blocked","summary":"Need dependency","files_changed":[],"tests":[{"command":"npm test --run","passed":false}],"follow_up_actions":["wait for dependency"]}
END_DISPATCH_RESULT`,
      },
      context
    );
    const blockedFacts = (blockedOnce.data?.snapshot?.facts ?? []) as Array<{ k: string; v: string }>;
    expect(blockedFacts.find(fact => fact.k === 'ledger.task.stalled_count')?.v).toBe('1');
    expect(blockedFacts.find(fact => fact.k === 'ledger.task.stalled_flagged')?.v).toBe('false');

    const blockedTwice = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId,
        role: 'reviewer',
        taskId,
        outputContent: `BEGIN_DISPATCH_RESULT
{"task_id":"${taskId}","assessment":"blocked","strengths":[],"issues":[{"severity":"important","message":"Still blocked","fix":"Resolve dependency"}],"required_fixes":["Resolve dependency"]}
END_DISPATCH_RESULT`,
      },
      context
    );
    const blockedTwiceFacts = (blockedTwice.data?.snapshot?.facts ?? []) as Array<{ k: string; v: string }>;
    expect(blockedTwiceFacts.find(fact => fact.k === 'ledger.task.stalled_count')?.v).toBe('2');
    expect(blockedTwiceFacts.find(fact => fact.k === 'ledger.task.stalled_flagged')?.v).toBe('true');
    expect(blockedTwiceFacts.find(fact => fact.k === 'ledger.task.replan_hint')?.v).toContain('Stalled');

    const recovered = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId,
        role: 'implementer',
        taskId,
        outputContent: `BEGIN_DISPATCH_RESULT
{"task_id":"${taskId}","status":"completed","summary":"Dependency fixed","files_changed":[],"tests":[{"command":"npm test --run","passed":true}],"follow_up_actions":[]}
END_DISPATCH_RESULT`,
      },
      context
    );
    const recoveredFacts = (recovered.data?.snapshot?.facts ?? []) as Array<{ k: string; v: string }>;
    expect(recoveredFacts.find(fact => fact.k === 'ledger.task.stalled_count')?.v).toBe('0');
    expect(recoveredFacts.find(fact => fact.k === 'ledger.task.stalled_flagged')?.v).toBe('false');
  });

  it('rejects invalid reviewer schema', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-reviewer-invalid',
        specName: SPEC_NAME,
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
    expect(result.data?.errorCode).toBe('schema_invalid');
    expect(result.data?.nextAction).toBe('halt_schema_invalid_terminal');
    expect(result.data?.snapshot?.status).toBe('failed');
  });

  it('treats schema-invalid output as terminal on first attempt', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-schema-terminal',
        specName: SPEC_NAME,
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
    expect(first.data?.errorCode).toBe('schema_invalid');
    expect(first.data?.nextAction).toBe('halt_schema_invalid_terminal');
    expect(second.success).toBe(false);
    expect(second.data?.errorCode).toBe('schema_invalid');
    expect(second.data?.nextAction).toBe('halt_schema_invalid_terminal');
  });

  it('compiles prompt even when implementer provider command is custom', async () => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'custom-provider --json';
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-unsupported-provider',
        specName: SPEC_NAME,
        taskId: '6.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId: 'test-run-unsupported-provider',
        role: 'implementer',
        taskId: '6.1',
        taskPrompt: 'Implement provider gate enforcement',
        maxOutputTokens: 600,
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.prompt).toContain('Task ID: 6.1');
  });

  it('rejects extra prose outside dispatch contract markers', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-prose-reject',
        specName: SPEC_NAME,
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
        specName: SPEC_NAME,
        taskId: '1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId: 'test-run-compile',
        role: 'implementer',
        taskId: '1',
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
    expect(result.data?.dispatch_cli).toBeTypeOf('string');

    const second = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId: 'test-run-compile',
        role: 'implementer',
        taskId: '1',
        taskPrompt: 'Implement parser changes again',
        maxOutputTokens: 800,
      },
      context
    );
    expect(second.success).toBe(true);
    expect(second.data?.guideMode).toBe('compact');
    expect(second.data?.deltaPacket?.guide_mode).toBe('compact');
  });

  it('returns role-specific dispatch_cli with complexity model flags', async () => {
    process.env.SPEC_CONTEXT_REVIEWER_MODEL_SIMPLE = 'codex-5.3';
    process.env.SPEC_CONTEXT_REVIEWER_REASONING_EFFORT = 'medium';

    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-compile-reviewer-cli-tier',
        specName: SPEC_NAME,
        taskId: '8.1',
      },
      context
    );

    const compile = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId: 'test-run-compile-reviewer-cli-tier',
        role: 'reviewer',
        taskId: '8.1',
        taskPrompt: 'Review simple routing fixture',
        maxOutputTokens: 700,
      },
      context
    );

    expect(compile.success).toBe(true);
    expect(compile.data?.dispatch_cli).toContain('codex exec --sandbox read-only');
    expect(compile.data?.dispatch_cli).toContain('--model codex-5.3');
    expect(compile.data?.dispatch_cli).toContain('model_reasoning_effort=medium');
  });

  it('keeps stable prefix hash constant and preserves explicit task prompt override', async () => {
    const runId = 'test-run-stable-hash-dynamic-tail';
    const taskId = '1';
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId,
        specName: SPEC_NAME,
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
    const taskId = '1';
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId,
        specName: SPEC_NAME,
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
    const taskId = '1';
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId,
        specName: SPEC_NAME,
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
    const taskId = '1';
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId,
        specName: SPEC_NAME,
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
        specName: SPEC_NAME,
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
