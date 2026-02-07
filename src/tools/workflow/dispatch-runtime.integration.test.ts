import { randomUUID } from 'crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleToolCall } from '../index.js';
import type { ToolResponse } from '../../workflow-types.js';

async function createTempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dispatch-runtime-int-'));
}

async function ensureSpecTasks(
  projectPath: string,
  specName: string,
  taskId: string
): Promise<void> {
  const specDir = join(projectPath, '.spec-context', 'specs', specName);
  await mkdir(specDir, { recursive: true });
  await writeFile(
    join(specDir, 'tasks.md'),
    `# Tasks\n\n- [-] ${taskId}. Integration task for ${specName}\n  - _Requirements: 1_\n  - _Prompt: Role: TypeScript Developer | Task: Implement ${taskId}_\n- [ ] ${taskId}.1 Follow-up`,
    'utf8'
  );
}

async function callDispatch(
  projectPath: string,
  args: Record<string, unknown>
): Promise<ToolResponse> {
  const result = await handleToolCall(
    'dispatch-runtime',
    args,
    { projectPath, dashboardUrl: undefined }
  );
  return result as ToolResponse;
}

function findFact(response: ToolResponse, key: string): string | undefined {
  const facts = response.data?.snapshot?.facts as Array<{ k: string; v: string }> | undefined;
  return facts?.find(fact => fact.k === key)?.v;
}

const ORIGINAL_IMPLEMENTER = process.env.SPEC_CONTEXT_IMPLEMENTER;
const ORIGINAL_REVIEWER = process.env.SPEC_CONTEXT_REVIEWER;

describe('dispatch-runtime integration (no mocks)', () => {
  beforeEach(() => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'claude';
    process.env.SPEC_CONTEXT_REVIEWER = 'codex';
  });

  afterEach(() => {
    if (ORIGINAL_IMPLEMENTER === undefined) {
      delete process.env.SPEC_CONTEXT_IMPLEMENTER;
    } else {
      process.env.SPEC_CONTEXT_IMPLEMENTER = ORIGINAL_IMPLEMENTER;
    }

    if (ORIGINAL_REVIEWER === undefined) {
      delete process.env.SPEC_CONTEXT_REVIEWER;
    } else {
      process.env.SPEC_CONTEXT_REVIEWER = ORIGINAL_REVIEWER;
    }
  });

  it('runs init -> compile -> ingest implementer/reviewer using real output files', async () => {
    const projectPath = await createTempProject();
    try {
      const runId = `int-${randomUUID()}`;
      const taskId = '1.1';

      const telemetryBefore = await callDispatch(projectPath, {
        action: 'get_telemetry',
        runId,
      });
      const dispatchBefore = Number(telemetryBefore.data?.dispatch_count ?? 0);
      const loopsBefore = Number(telemetryBefore.data?.approval_loops ?? 0);

      await ensureSpecTasks(projectPath, 'feature-integration', taskId);
      const init = await callDispatch(projectPath, {
        action: 'init_run',
        runId,
        specName: 'feature-integration',
        taskId,
      });
      expect(init.success).toBe(true);
      expect(findFact(init, 'ledger.progress.active_task_id')).toBe(taskId);
      expect(init.data?.selected_provider).toBeTypeOf('string');
      expect(init.data?.classification_level).toBeTypeOf('string');

      const compileImplementer = await callDispatch(projectPath, {
        action: 'compile_prompt',
        runId,
        role: 'implementer',
        taskId,
        taskPrompt: 'Implement parser behavior',
        maxOutputTokens: 500,
      });
      expect(compileImplementer.success).toBe(true);
      expect(compileImplementer.data?.stablePrefixHash).toHaveLength(64);
      expect(compileImplementer.data?.guideMode).toBe('full');
      expect(compileImplementer.data?.prompt).toContain('"mode":"full"');

      const implementerOutputPath = join(projectPath, 'impl.log');
      await writeFile(
        implementerOutputPath,
        `BEGIN_DISPATCH_RESULT
{"task_id":"${taskId}","status":"completed","summary":"Parser implemented","files_changed":["src/parser.ts"],"tests":[{"command":"npm test --run","passed":true}],"follow_up_actions":[]}
END_DISPATCH_RESULT`,
        'utf8'
      );

      const implementerIngest = await callDispatch(projectPath, {
        action: 'ingest_output',
        runId,
        role: 'implementer',
        taskId,
        outputFilePath: 'impl.log',
        maxOutputTokens: 500,
      });
      expect(implementerIngest.success).toBe(true);
      expect(implementerIngest.data?.nextAction).toBe('dispatch_reviewer');
      expect(implementerIngest.data?.snapshot?.status).toBe('running');
      expect(findFact(implementerIngest, 'implementer_status')).toBe('completed');

      const compileReviewer = await callDispatch(projectPath, {
        action: 'compile_prompt',
        runId,
        role: 'reviewer',
        taskId,
        taskPrompt: 'Review parser behavior',
        maxOutputTokens: 500,
      });
      expect(compileReviewer.success).toBe(true);
      expect(compileReviewer.data?.deltaPacket?.ledger_summary).toBe('Parser implemented');
      expect(compileReviewer.data?.guideMode).toBe('full');
      expect(compileReviewer.data?.prompt).toContain('"mode":"full"');

      const reviewerOutputPath = join(projectPath, 'review.log');
      await writeFile(
        reviewerOutputPath,
        `BEGIN_DISPATCH_RESULT
{"task_id":"${taskId}","assessment":"needs_changes","strengths":["Good coverage"],"issues":[{"severity":"important","file":"src/parser.ts","message":"Edge case missing","fix":"Add branch for empty token"}],"required_fixes":["Handle empty token input"]}
END_DISPATCH_RESULT`,
        'utf8'
      );

      const reviewerIngest = await callDispatch(projectPath, {
        action: 'ingest_output',
        runId,
        role: 'reviewer',
        taskId,
        outputFilePath: 'review.log',
        maxOutputTokens: 500,
      });
      expect(reviewerIngest.success).toBe(true);
      expect(reviewerIngest.data?.nextAction).toBe('dispatch_implementer_fixes');
      expect(reviewerIngest.data?.snapshot?.status).toBe('blocked');
      expect(findFact(reviewerIngest, 'reviewer_assessment')).toBe('needs_changes');

      const telemetryAfter = await callDispatch(projectPath, {
        action: 'get_telemetry',
        runId,
      });
      expect(Number(telemetryAfter.data?.dispatch_count)).toBeGreaterThanOrEqual(dispatchBefore + 2);
      expect(Number(telemetryAfter.data?.approval_loops)).toBeGreaterThanOrEqual(loopsBefore + 1);
      expect(Number(telemetryAfter.data?.ledger_mode_usage?.ledger_only ?? 0)).toBeGreaterThanOrEqual(2);

      const compileImplementerAgain = await callDispatch(projectPath, {
        action: 'compile_prompt',
        runId,
        role: 'implementer',
        taskId,
        taskPrompt: 'Implement parser follow-up',
        maxOutputTokens: 500,
      });
      expect(compileImplementerAgain.success).toBe(true);
      expect(compileImplementerAgain.data?.guideMode).toBe('compact');
      expect(compileImplementerAgain.data?.prompt).toContain('"mode":"compact"');
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('enforces maxOutputTokens without recording contract schema failure', async () => {
    const projectPath = await createTempProject();
    try {
      const runId = `int-budget-${randomUUID()}`;
      const taskId = '2.1';
      await ensureSpecTasks(projectPath, 'feature-budget', taskId);
      await callDispatch(projectPath, {
        action: 'init_run',
        runId,
        specName: 'feature-budget',
        taskId,
      });

      const oversizedSummary = 'A'.repeat(2000);
      await writeFile(
        join(projectPath, 'oversized.log'),
        `BEGIN_DISPATCH_RESULT
{"task_id":"${taskId}","status":"completed","summary":"${oversizedSummary}","files_changed":[],"tests":[{"command":"npm test --run","passed":true}],"follow_up_actions":[]}
END_DISPATCH_RESULT`,
        'utf8'
      );

      const ingest = await callDispatch(projectPath, {
        action: 'ingest_output',
        runId,
        role: 'implementer',
        taskId,
        outputFilePath: 'oversized.log',
        maxOutputTokens: 20,
      });

      expect(ingest.success).toBe(false);
      expect(ingest.message).toContain('output_token_budget_exceeded');

      const snapshot = await callDispatch(projectPath, {
        action: 'get_snapshot',
        runId,
      });
      expect(snapshot.success).toBe(true);
      expect(snapshot.data?.snapshot?.status).toBe('running');
      expect(findFact(snapshot, 'schema_contract_failure:last')).toBeUndefined();
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('treats schema-invalid output as immediate terminal failure', async () => {
    const projectPath = await createTempProject();
    try {
      const runId = `int-schema-${randomUUID()}`;
      const taskId = '3.1';
      await ensureSpecTasks(projectPath, 'feature-schema', taskId);
      await callDispatch(projectPath, {
        action: 'init_run',
        runId,
        specName: 'feature-schema',
        taskId,
      });

      await writeFile(
        join(projectPath, 'invalid-review.log'),
        `BEGIN_DISPATCH_RESULT
{"task_id":"${taskId}","assessment":"approved"}
END_DISPATCH_RESULT`,
        'utf8'
      );

      const first = await callDispatch(projectPath, {
        action: 'ingest_output',
        runId,
        role: 'reviewer',
        taskId,
        outputFilePath: 'invalid-review.log',
      });
      expect(first.success).toBe(false);
      expect(first.data?.errorCode).toBe('schema_invalid');
      expect(first.data?.nextAction).toBe('halt_schema_invalid_terminal');
      expect(first.data?.snapshot?.status).toBe('failed');

      const second = await callDispatch(projectPath, {
        action: 'ingest_output',
        runId,
        role: 'reviewer',
        taskId,
        outputFilePath: 'invalid-review.log',
      });
      expect(second.success).toBe(false);
      expect(second.data?.errorCode).toBe('schema_invalid');
      expect(second.data?.nextAction).toBe('halt_schema_invalid_terminal');
      expect(second.data?.snapshot?.status).toBe('failed');
      expect(findFact(second, 'schema_contract_failure:last')).toBe('schema_invalid');
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('compiles prompt with unknown custom provider command', async () => {
    const projectPath = await createTempProject();
    try {
      process.env.SPEC_CONTEXT_IMPLEMENTER = 'custom-provider --json';
      const runId = `int-provider-${randomUUID()}`;
      const taskId = '3.2';
      await ensureSpecTasks(projectPath, 'feature-provider-gate', taskId);
      await callDispatch(projectPath, {
        action: 'init_run',
        runId,
        specName: 'feature-provider-gate',
        taskId,
      });

      const compile = await callDispatch(projectPath, {
        action: 'compile_prompt',
        runId,
        role: 'implementer',
        taskId,
        taskPrompt: 'Implement provider gate test',
        maxOutputTokens: 500,
      });

      expect(compile.success).toBe(true);
      expect(compile.data?.prompt).toContain(`Task ID: ${taskId}`);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('persists blocked and failed statuses from implementer contract payload', async () => {
    const projectPath = await createTempProject();
    try {
      const blockedRunId = `int-blocked-${randomUUID()}`;
      const taskId = '4.1';
      await ensureSpecTasks(projectPath, 'feature-status', taskId);
      await callDispatch(projectPath, {
        action: 'init_run',
        runId: blockedRunId,
        specName: 'feature-status',
        taskId,
      });
      const blocked = await callDispatch(projectPath, {
        action: 'ingest_output',
        runId: blockedRunId,
        role: 'implementer',
        taskId,
        outputContent: `BEGIN_DISPATCH_RESULT
{"task_id":"${taskId}","status":"blocked","summary":"Cannot proceed without API key","files_changed":[],"tests":[{"command":"npm test --run","passed":false,"failures":["missing key"]}],"follow_up_actions":["ask user for key"]}
END_DISPATCH_RESULT`,
      });
      expect(blocked.success).toBe(true);
      expect(blocked.data?.nextAction).toBe('retry_implementer_with_constraints');
      expect(blocked.data?.snapshot?.status).toBe('blocked');
      expect(findFact(blocked, 'implementer_status')).toBe('blocked');

      const failedRunId = `int-failed-${randomUUID()}`;
      await ensureSpecTasks(projectPath, 'feature-status', taskId);
      await callDispatch(projectPath, {
        action: 'init_run',
        runId: failedRunId,
        specName: 'feature-status',
        taskId,
      });
      const failed = await callDispatch(projectPath, {
        action: 'ingest_output',
        runId: failedRunId,
        role: 'implementer',
        taskId,
        outputContent: `BEGIN_DISPATCH_RESULT
{"task_id":"${taskId}","status":"failed","summary":"Build failed","files_changed":["src/a.ts"],"tests":[{"command":"npm test --run","passed":false,"failures":["compile error"]}],"follow_up_actions":["fix type errors"]}
END_DISPATCH_RESULT`,
      });
      expect(failed.success).toBe(true);
      expect(failed.data?.nextAction).toBe('retry_implementer');
      expect(failed.data?.snapshot?.status).toBe('failed');
      expect(findFact(failed, 'implementer_status')).toBe('failed');
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('preserves stable prefix hash across compaction variants for same role/template', async () => {
    const projectPath = await createTempProject();
    try {
      const runId = `int-prefix-${randomUUID()}`;
      const taskId = '5.1';
      await ensureSpecTasks(projectPath, 'feature-prefix-stability', taskId);
      await callDispatch(projectPath, {
        action: 'init_run',
        runId,
        specName: 'feature-prefix-stability',
        taskId,
      });

      const baseline = await callDispatch(projectPath, {
        action: 'compile_prompt',
        runId,
        role: 'implementer',
        taskId,
        taskPrompt: 'Implement baseline behavior',
        maxOutputTokens: 700,
        compactionAuto: true,
      });
      expect(baseline.success).toBe(true);
      expect(baseline.data?.compactionStage).toBe('none');

      const oversizedPrompt = `Implement task ${taskId}\n${'MUST preserve branch-critical constraints and strict JSON output.\n'.repeat(1200)}`;
      const compacted = await callDispatch(projectPath, {
        action: 'compile_prompt',
        runId,
        role: 'implementer',
        taskId,
        taskPrompt: oversizedPrompt,
        maxOutputTokens: 700,
        compactionAuto: true,
      });
      expect(compacted.success).toBe(true);
      expect(compacted.data?.compactionApplied).toBe(true);
      expect(compacted.data?.compactionStage).not.toBe('none');

      expect(compacted.data?.stablePrefixHash).toBe(baseline.data?.stablePrefixHash);
      expect(compacted.data?.fullPromptHash).not.toBe(baseline.data?.fullPromptHash);
      expect(Number(compacted.data?.promptTokensAfter)).toBeLessThanOrEqual(Number(compacted.data?.promptTokenBudget));
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('applies compile-time compaction and records telemetry for oversized prompts', async () => {
    const projectPath = await createTempProject();
    try {
      const runId = `int-compaction-${randomUUID()}`;
      const taskId = '5.1';
      await ensureSpecTasks(projectPath, 'feature-compaction', taskId);
      await callDispatch(projectPath, {
        action: 'init_run',
        runId,
        specName: 'feature-compaction',
        taskId,
      });

      const oversizedPrompt = `Implement task ${taskId}\n${'MUST preserve branch-critical constraints and strict JSON output.\n'.repeat(1200)}`;
      const compiled = await callDispatch(projectPath, {
        action: 'compile_prompt',
        runId,
        role: 'implementer',
        taskId,
        taskPrompt: oversizedPrompt,
        maxOutputTokens: 700,
        compactionAuto: true,
      });

      expect(compiled.success).toBe(true);
      expect(compiled.data?.compactionApplied).toBe(true);
      expect(Number(compiled.data?.promptTokensAfter)).toBeLessThanOrEqual(Number(compiled.data?.promptTokenBudget));

      const snapshot = await callDispatch(projectPath, {
        action: 'get_snapshot',
        runId,
      });
      expect(findFact(snapshot, 'dispatch_compacted:implementer')).toBe('true');

      const telemetry = await callDispatch(projectPath, {
        action: 'get_telemetry',
        runId,
      });
      expect(Number(telemetry.data?.compaction_count ?? 0)).toBeGreaterThan(0);
      expect(Number(telemetry.data?.compaction_prompt_tokens_before ?? 0)).toBeGreaterThanOrEqual(
        Number(telemetry.data?.compaction_prompt_tokens_after ?? 0)
      );
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});
