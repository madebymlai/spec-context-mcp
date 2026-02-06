import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { promises as fs } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import {
  RuntimeEventStream,
  RuntimeSnapshotStore,
  SchemaRegistry,
  StateProjector,
  InMemoryEventBusAdapter,
  PromptTemplateRegistry,
  PromptPrefixCompiler,
} from '../../core/llm/index.js';
import type {
  RuntimeEventDraft,
  RuntimeEventEnvelope,
  StateSnapshot,
  StateSnapshotFact,
} from '../../core/llm/index.js';
import { ToolContext, ToolResponse } from '../../workflow-types.js';

type DispatchAction = 'init_run' | 'ingest_output' | 'get_snapshot' | 'compile_prompt' | 'get_telemetry';
type DispatchRole = 'implementer' | 'reviewer';

const DISPATCH_RESULT_BEGIN = 'BEGIN_DISPATCH_RESULT';
const DISPATCH_RESULT_END = 'END_DISPATCH_RESULT';

interface ImplementerResult {
  task_id: string;
  status: 'completed' | 'blocked' | 'failed';
  summary: string;
  files_changed: string[];
  tests: Array<{
    command: string;
    passed: boolean;
    failures?: string[];
  }>;
  follow_up_actions: string[];
}

interface ReviewerIssue {
  severity: 'critical' | 'important' | 'minor';
  file?: string;
  message: string;
  fix: string;
}

interface ReviewerResult {
  task_id: string;
  assessment: 'approved' | 'needs_changes' | 'blocked';
  strengths: string[];
  issues: ReviewerIssue[];
  required_fixes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isImplementerResult(value: unknown): value is ImplementerResult {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.task_id !== 'string') {
    return false;
  }
  if (!['completed', 'blocked', 'failed'].includes(String(value.status))) {
    return false;
  }
  if (typeof value.summary !== 'string') {
    return false;
  }
  if (!isStringArray(value.files_changed)) {
    return false;
  }
  if (!isStringArray(value.follow_up_actions)) {
    return false;
  }
  if (!Array.isArray(value.tests)) {
    return false;
  }

  return value.tests.every(test => {
    if (!isRecord(test)) {
      return false;
    }
    if (typeof test.command !== 'string' || typeof test.passed !== 'boolean') {
      return false;
    }
    if (typeof test.failures !== 'undefined' && !isStringArray(test.failures)) {
      return false;
    }
    return true;
  });
}

function isReviewerIssue(value: unknown): value is ReviewerIssue {
  if (!isRecord(value)) {
    return false;
  }
  if (!['critical', 'important', 'minor'].includes(String(value.severity))) {
    return false;
  }
  if (typeof value.message !== 'string' || typeof value.fix !== 'string') {
    return false;
  }
  if (typeof value.file !== 'undefined' && typeof value.file !== 'string') {
    return false;
  }
  return true;
}

function isReviewerResult(value: unknown): value is ReviewerResult {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.task_id !== 'string') {
    return false;
  }
  if (!['approved', 'needs_changes', 'blocked'].includes(String(value.assessment))) {
    return false;
  }
  if (!isStringArray(value.strengths) || !isStringArray(value.required_fixes)) {
    return false;
  }
  if (!Array.isArray(value.issues) || !value.issues.every(isReviewerIssue)) {
    return false;
  }
  return true;
}

function extractStructuredJson(rawOutput: string): unknown {
  const trimmed = rawOutput.trim();
  const beginCount = (trimmed.match(new RegExp(DISPATCH_RESULT_BEGIN, 'g')) ?? []).length;
  const endCount = (trimmed.match(new RegExp(DISPATCH_RESULT_END, 'g')) ?? []).length;

  if (beginCount !== 1 || endCount !== 1) {
    throw new Error(`Invalid dispatch contract markers; expected exactly one ${DISPATCH_RESULT_BEGIN}/${DISPATCH_RESULT_END} block`);
  }

  if (!trimmed.startsWith(DISPATCH_RESULT_BEGIN)) {
    throw new Error('Dispatch result must start with BEGIN_DISPATCH_RESULT marker');
  }
  if (!trimmed.endsWith(DISPATCH_RESULT_END)) {
    throw new Error('Dispatch result must end with END_DISPATCH_RESULT marker');
  }

  const jsonBody = trimmed
    .slice(DISPATCH_RESULT_BEGIN.length, trimmed.length - DISPATCH_RESULT_END.length)
    .trim();

  if (!jsonBody) {
    throw new Error('Dispatch result JSON body is empty');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBody);
  } catch {
    throw new Error('Dispatch result JSON is invalid');
  }

  if (!isRecord(parsed)) {
    throw new Error('Dispatch result JSON must be an object');
  }
  return parsed;
}

function nextActionForImplementer(result: ImplementerResult): string {
  if (result.status === 'completed') {
    return 'dispatch_reviewer';
  }
  if (result.status === 'blocked') {
    return 'retry_implementer_with_constraints';
  }
  return 'retry_implementer';
}

function nextActionForReviewer(result: ReviewerResult): string {
  if (result.assessment === 'approved') {
    return 'advance_to_next_task';
  }
  if (result.assessment === 'needs_changes') {
    return 'dispatch_implementer_fixes';
  }
  return 'halt_and_escalate';
}

function statusForImplementer(result: ImplementerResult): StateSnapshot['status'] {
  if (result.status === 'completed') {
    return 'running';
  }
  if (result.status === 'blocked') {
    return 'blocked';
  }
  return 'failed';
}

function statusForReviewer(result: ReviewerResult): StateSnapshot['status'] {
  if (result.assessment === 'approved') {
    return 'done';
  }
  if (result.assessment === 'needs_changes') {
    return 'blocked';
  }
  return 'failed';
}

function estimateTokensFromChars(value: string): number {
  return Math.ceil(value.length / 4);
}

interface DispatchTelemetrySnapshot {
  dispatch_count: number;
  total_output_tokens: number;
  avg_output_tokens: number;
  schema_invalid_retries: number;
  approval_loops: number;
}

class DispatchPromptCompiler {
  private readonly registry = new PromptTemplateRegistry();
  private readonly prefixCompiler = new PromptPrefixCompiler();
  private readonly version = 'v1';

  constructor() {
    this.registry.register({
      templateId: 'dispatch_implementer',
      version: this.version,
      segments: [
        {
          kind: 'system',
          stable: true,
          content: `You are an implementer agent. Output only the strict dispatch contract block:
${DISPATCH_RESULT_BEGIN}
{...valid JSON object...}
${DISPATCH_RESULT_END}`,
        },
      ],
    });

    this.registry.register({
      templateId: 'dispatch_reviewer',
      version: this.version,
      segments: [
        {
          kind: 'system',
          stable: true,
          content: `You are a reviewer agent. Output only the strict dispatch contract block:
${DISPATCH_RESULT_BEGIN}
{...valid JSON object...}
${DISPATCH_RESULT_END}`,
        },
      ],
    });
  }

  compile(input: {
    runId: string;
    role: DispatchRole;
    taskPrompt: string;
    taskId: string;
    maxOutputTokens: number;
    deltaPacket: Record<string, unknown>;
    guideMode: 'full' | 'compact';
    guideCacheKey: string;
  }) {
    const templateId = input.role === 'implementer' ? 'dispatch_implementer' : 'dispatch_reviewer';
    const guideToolName = input.role === 'implementer' ? 'get-implementer-guide' : 'get-reviewer-guide';
    const guideInstruction = input.guideMode === 'full'
      ? `Guide policy: first dispatch for this role in run ${input.runId}. Call ${guideToolName} with {"mode":"full","runId":"${input.runId}"} exactly once before coding/reviewing.`
      : `Guide policy: guide already loaded in this run. Do not reload full guide. Reuse cached rules and call ${guideToolName} with {"mode":"compact","runId":"${input.runId}"} if you need a reminder.`;
    const dynamicTail = `Task ID: ${input.taskId}
Max output tokens: ${input.maxOutputTokens}
Delta context: ${JSON.stringify(input.deltaPacket)}
Guide cache key: ${input.guideCacheKey}
${guideInstruction}
Task prompt:
${input.taskPrompt}`;

    const compiled = this.registry.compile(templateId, this.version, dynamicTail);
    const prefixCompile = this.prefixCompiler.compile({
      model: `${input.role}-dispatch`,
      messages: [
        { role: 'system', content: compiled.stablePrefix },
        { role: 'user', content: dynamicTail },
      ],
      jsonMode: true,
      dynamicTailMessages: 1,
    });

    return {
      prompt: compiled.text,
      stablePrefixHash: prefixCompile.stablePrefixHash,
      fullPromptHash: prefixCompile.cacheKey,
      deltaPacket: input.deltaPacket,
      maxOutputTokens: input.maxOutputTokens,
      guideMode: input.guideMode,
      guideCacheKey: input.guideCacheKey,
    };
  }
}

class DispatchRuntimeManager {
  private readonly eventStream = new RuntimeEventStream();
  private readonly snapshotStore = new RuntimeSnapshotStore();
  private readonly schemaRegistry = new SchemaRegistry();
  private readonly stateProjector = new StateProjector();
  private readonly eventBus = new InMemoryEventBusAdapter<RuntimeEventEnvelope>();
  private readonly promptCompiler = new DispatchPromptCompiler();
  private readonly guidePromptCounts = new Map<string, number>();
  private telemetry: DispatchTelemetrySnapshot = {
    dispatch_count: 0,
    total_output_tokens: 0,
    avg_output_tokens: 0,
    schema_invalid_retries: 0,
    approval_loops: 0,
  };

  constructor() {
    this.registerSchemas();
  }

  async initRun(runId: string, specName: string, taskId: string): Promise<StateSnapshot> {
    this.guidePromptCounts.delete(`${runId}:implementer`);
    this.guidePromptCounts.delete(`${runId}:reviewer`);
    const initEvent = await this.publishEvent({
      partition_key: runId,
      run_id: runId,
      step_id: 'dispatch-init',
      agent_id: 'orchestrator',
      type: 'STATE_DELTA',
      payload: {
        spec_name: specName,
        task_id: taskId,
        dispatch_status: 'running',
      },
    });

    await this.snapshotStore.upsert({
      runId,
      goal: `dispatch_task:${specName}:${taskId}`,
      status: 'running',
      facts: [
        { k: 'spec_name', v: specName, confidence: 1 },
        { k: 'task_id', v: taskId, confidence: 1 },
      ],
      pendingWrites: [
        {
          channel: 'dispatch-runtime',
          task_id: taskId,
          value: {
            initialized: true,
          },
        },
      ],
      tokenBudget: {
        remaining_input: 0,
        remaining_output: 0,
      },
      appliedOffset: {
        partition_key: runId,
        sequence: initEvent.sequence,
      },
    });

    const snapshot = await this.snapshotStore.get(runId);
    if (!snapshot) {
      throw new Error(`Failed to initialize runtime snapshot for run ${runId}`);
    }
    return snapshot;
  }

  async ingestOutput(args: {
    runId: string;
    role: DispatchRole;
    taskId: string;
    outputContent: string;
    maxOutputTokens?: number;
  }): Promise<{
    result: ImplementerResult | ReviewerResult;
    snapshot: StateSnapshot;
    nextAction: string;
    outputTokens: number;
  }> {
    await this.assertRunBinding(args.runId, args.taskId);
    const parsed = extractStructuredJson(args.outputContent);
    const outputTokens = estimateTokensFromChars(args.outputContent);
    if (typeof args.maxOutputTokens === 'number' && outputTokens > args.maxOutputTokens) {
      throw new Error(`output_token_budget_exceeded: estimated=${outputTokens}, max=${args.maxOutputTokens}`);
    }

    if (args.role === 'implementer') {
      this.schemaRegistry.assert('dispatch.result.implementer', parsed, 'v1');
      const result = parsed as ImplementerResult;
      const responseEvent = await this.publishEvent({
        partition_key: args.runId,
        run_id: args.runId,
        step_id: args.taskId,
        agent_id: 'implementer',
        type: 'LLM_RESPONSE',
        payload: {
          role: args.role,
          result,
        },
      });

      const facts: StateSnapshotFact[] = [
        { k: 'implementer_status', v: result.status, confidence: 1 },
        { k: 'implementer_summary', v: result.summary, confidence: 0.9 },
        { k: 'output_tokens:last', v: String(outputTokens), confidence: 1 },
        { k: 'task_id', v: result.task_id, confidence: 1 },
      ];
      await this.updateSnapshot(args.runId, responseEvent, facts, result.task_id, statusForImplementer(result));
      this.bumpDispatchTelemetry(outputTokens, false);
      const snapshot = await this.requireSnapshot(args.runId);

      return {
        result,
        snapshot,
        nextAction: nextActionForImplementer(result),
        outputTokens,
      };
    }

    this.schemaRegistry.assert('dispatch.result.reviewer', parsed, 'v1');
    const result = parsed as ReviewerResult;
    const responseEvent = await this.publishEvent({
      partition_key: args.runId,
      run_id: args.runId,
      step_id: args.taskId,
      agent_id: 'reviewer',
      type: 'LLM_RESPONSE',
      payload: {
        role: args.role,
        result,
      },
    });

    const facts: StateSnapshotFact[] = [
      { k: 'reviewer_assessment', v: result.assessment, confidence: 1 },
      { k: 'reviewer_issue_count', v: String(result.issues.length), confidence: 1 },
      { k: 'output_tokens:last', v: String(outputTokens), confidence: 1 },
      { k: 'task_id', v: result.task_id, confidence: 1 },
    ];
    await this.updateSnapshot(args.runId, responseEvent, facts, result.task_id, statusForReviewer(result));
    this.bumpDispatchTelemetry(outputTokens, result.assessment === 'needs_changes');
    const snapshot = await this.requireSnapshot(args.runId);

    return {
      result,
      snapshot,
      nextAction: nextActionForReviewer(result),
      outputTokens,
    };
  }

  async getSnapshot(runId: string): Promise<StateSnapshot | null> {
    return this.snapshotStore.get(runId);
  }

  async compilePrompt(args: {
    runId: string;
    role: DispatchRole;
    taskId: string;
    taskPrompt: string;
    maxOutputTokens: number;
  }): Promise<{
    prompt: string;
    stablePrefixHash: string;
    fullPromptHash: string;
    deltaPacket: Record<string, unknown>;
    maxOutputTokens: number;
    guideMode: 'full' | 'compact';
    guideCacheKey: string;
  }> {
    const snapshot = await this.assertRunBinding(args.runId, args.taskId);
    const facts = new Map((snapshot?.facts ?? []).map(fact => [fact.k, fact.v]));
    const guideMode = this.nextGuideMode(args.runId, args.role);
    const guideCacheKey = `${args.role}:${args.runId}`;
    const deltaPacket = {
      task_id: args.taskId,
      previous_implementer_summary: facts.get('implementer_summary') ?? null,
      previous_reviewer_assessment: facts.get('reviewer_assessment') ?? null,
      previous_reviewer_issue_count: facts.get('reviewer_issue_count') ?? null,
      guide_mode: guideMode,
      guide_cache_key: guideCacheKey,
    };

    return this.promptCompiler.compile({
      runId: args.runId,
      role: args.role,
      taskPrompt: args.taskPrompt,
      taskId: args.taskId,
      maxOutputTokens: args.maxOutputTokens,
      deltaPacket,
      guideMode,
      guideCacheKey,
    });
  }

  getTelemetrySnapshot(): DispatchTelemetrySnapshot {
    return { ...this.telemetry };
  }

  async recordSchemaInvalidRetry(args: {
    runId: string;
    role: DispatchRole;
    taskId: string;
    errorMessage: string;
  }): Promise<{
    retryCount: number;
    terminal: boolean;
    snapshot: StateSnapshot;
  }> {
    const snapshot = await this.requireSnapshot(args.runId);
    const retriesKey = `schema_invalid_retries:${args.role}:${args.taskId}`;
    const existingRetryValue = Number(snapshot.facts.find(f => f.k === retriesKey)?.v ?? '0');
    const retryCount = existingRetryValue + 1;
    this.telemetry.schema_invalid_retries += 1;

    const errorEvent = await this.publishEvent({
      partition_key: args.runId,
      run_id: args.runId,
      step_id: args.taskId,
      agent_id: args.role,
      type: 'ERROR',
      payload: {
        code: 'schema_invalid',
        role: args.role,
        task_id: args.taskId,
        retry_count: retryCount,
        message: args.errorMessage,
      },
    });

    const updatedFacts = this.mergeFacts(snapshot.facts, [
      { k: retriesKey, v: String(retryCount), confidence: 1 },
    ]);

    const terminal = retryCount >= 2;
    await this.updateSnapshot(
      args.runId,
      errorEvent,
      updatedFacts,
      args.taskId,
      terminal ? 'failed' : 'blocked'
    );

    return {
      retryCount,
      terminal,
      snapshot: await this.requireSnapshot(args.runId),
    };
  }

  private async publishEvent(draft: RuntimeEventDraft): Promise<RuntimeEventEnvelope> {
    const envelope = this.eventStream.publish(draft);
    await this.eventBus.publish(envelope);
    return envelope;
  }

  private async updateSnapshot(
    runId: string,
    event: RuntimeEventEnvelope,
    newFacts: StateSnapshotFact[],
    taskId: string,
    statusOverride?: StateSnapshot['status']
  ): Promise<void> {
    const previous = await this.snapshotStore.get(runId);
    const projected = this.stateProjector.apply({ event, previous });
    const facts = this.mergeFacts(previous?.facts ?? [], newFacts);
    await this.snapshotStore.upsert({
      runId,
      goal: previous?.goal ?? projected.goal,
      status: statusOverride ?? projected.status,
      facts,
      pendingWrites: [
        {
          channel: 'dispatch-runtime',
          task_id: taskId,
          value: event.payload,
        },
      ],
      tokenBudget: previous?.token_budget ?? {
        remaining_input: 0,
        remaining_output: 0,
      },
      appliedOffset: projected.appliedOffset,
    });
  }

  private bumpDispatchTelemetry(outputTokens: number, approvalLoop: boolean): void {
    this.telemetry.dispatch_count += 1;
    this.telemetry.total_output_tokens += outputTokens;
    this.telemetry.avg_output_tokens = this.telemetry.dispatch_count > 0
      ? this.telemetry.total_output_tokens / this.telemetry.dispatch_count
      : 0;
    if (approvalLoop) {
      this.telemetry.approval_loops += 1;
    }
  }

  private nextGuideMode(runId: string, role: DispatchRole): 'full' | 'compact' {
    const key = `${runId}:${role}`;
    const count = this.guidePromptCounts.get(key) ?? 0;
    this.guidePromptCounts.set(key, count + 1);
    return count === 0 ? 'full' : 'compact';
  }

  private async assertRunBinding(runId: string, taskId: string): Promise<StateSnapshot> {
    const snapshot = await this.snapshotStore.get(runId);
    if (!snapshot) {
      throw new Error(`run_not_initialized: runId ${runId} is not initialized; call init_run first`);
    }

    const boundTaskId = snapshot.facts.find(fact => fact.k === 'task_id')?.v;
    if (!boundTaskId) {
      throw new Error(`run_not_initialized: runId ${runId} is missing task binding; call init_run first`);
    }

    if (boundTaskId !== taskId) {
      throw new Error(
        `run_task_mismatch: runId ${runId} is bound to task_id ${boundTaskId} but received taskId ${taskId}`
      );
    }

    return snapshot;
  }

  private mergeFacts(existing: StateSnapshotFact[], incoming: StateSnapshotFact[]): StateSnapshotFact[] {
    const map = new Map<string, StateSnapshotFact>();
    for (const fact of existing) {
      map.set(fact.k, fact);
    }
    for (const fact of incoming) {
      map.set(fact.k, fact);
    }
    return Array.from(map.values());
  }

  private async requireSnapshot(runId: string): Promise<StateSnapshot> {
    const snapshot = await this.snapshotStore.get(runId);
    if (!snapshot) {
      throw new Error(`Snapshot not found for run: ${runId}`);
    }
    return snapshot;
  }

  private registerSchemas(): void {
    this.schemaRegistry.register(
      'dispatch.result.implementer',
      'dispatch_result_implementer',
      'v1',
      isImplementerResult
    );
    this.schemaRegistry.register(
      'dispatch.result.reviewer',
      'dispatch_result_reviewer',
      'v1',
      isReviewerResult
    );
  }
}

const dispatchRuntimeManager = new DispatchRuntimeManager();

function errorCodeFromMessage(message: string): 'run_not_initialized' | 'run_task_mismatch' | null {
  if (message.startsWith('run_not_initialized:')) {
    return 'run_not_initialized';
  }
  if (message.startsWith('run_task_mismatch:')) {
    return 'run_task_mismatch';
  }
  return null;
}

export const dispatchRuntimeTool: Tool = {
  name: 'dispatch-runtime',
  description: `Runtime state/contracts for orchestrator CLI sub-agent dispatch.

Use this tool instead of reading raw logs for orchestration decisions.
It validates implementer/reviewer structured output, compiles delta prompts with stable prefix hashes,
updates runtime events/snapshots, enforces output token budgets, and returns deterministic next actions.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['init_run', 'ingest_output', 'get_snapshot', 'compile_prompt', 'get_telemetry'],
        description: 'Runtime action',
      },
      runId: {
        type: 'string',
        description: 'Stable run/task orchestration id',
      },
      specName: {
        type: 'string',
        description: 'Spec name (required for init_run)',
      },
      taskId: {
        type: 'string',
        description: 'Task id',
      },
      role: {
        type: 'string',
        enum: ['implementer', 'reviewer'],
        description: 'Agent role for ingest_output',
      },
      outputFilePath: {
        type: 'string',
        description: 'Path to CLI output file (absolute or project-relative)',
      },
      outputContent: {
        type: 'string',
        description: 'Raw CLI output content if file path not used',
      },
      taskPrompt: {
        type: 'string',
        description: 'Task prompt body for compile_prompt',
      },
      maxOutputTokens: {
        type: 'number',
        description: 'Maximum output token budget for compile_prompt/ingest_output',
      },
    },
    required: ['action'],
  },
};

export async function dispatchRuntimeHandler(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResponse> {
  const action = String(args.action || '') as DispatchAction;

  if (!['init_run', 'ingest_output', 'get_snapshot', 'compile_prompt', 'get_telemetry'].includes(action)) {
    return {
      success: false,
      message: 'action must be one of: init_run, ingest_output, get_snapshot, compile_prompt, get_telemetry',
    };
  }

  if (action === 'init_run') {
    const specName = String(args.specName || '').trim();
    const taskId = String(args.taskId || '').trim();
    if (!specName || !taskId) {
      return {
        success: false,
        message: 'init_run requires specName and taskId',
      };
    }
    const runId = String(args.runId || '').trim() || `${specName}:${taskId}:${randomUUID()}`;
    const snapshot = await dispatchRuntimeManager.initRun(runId, specName, taskId);
    return {
      success: true,
      message: 'Dispatch runtime initialized',
      data: {
        runId,
        snapshot,
      },
    };
  }

  const runId = String(args.runId || '').trim();
  if (!runId) {
    return {
      success: false,
      message: `${action} requires runId`,
    };
  }

  if (action === 'get_snapshot') {
    const snapshot = await dispatchRuntimeManager.getSnapshot(runId);
    if (!snapshot) {
      return {
        success: false,
        message: `No snapshot found for runId: ${runId}`,
      };
    }
    return {
      success: true,
      message: 'Snapshot loaded',
      data: {
        runId,
        snapshot,
      },
    };
  }

  if (action === 'get_telemetry') {
    return {
      success: true,
      message: 'Dispatch runtime telemetry loaded',
      data: dispatchRuntimeManager.getTelemetrySnapshot(),
    };
  }

  const role = String(args.role || '').trim() as DispatchRole;
  const taskId = String(args.taskId || '').trim();
  if (!['implementer', 'reviewer'].includes(role) || !taskId) {
    return {
      success: false,
      message: 'ingest_output requires role (implementer|reviewer) and taskId',
    };
  }

  if (action === 'compile_prompt') {
    const taskPrompt = String(args.taskPrompt || '').trim();
    const maxOutputTokens = Number(args.maxOutputTokens ?? 1200);
    if (!taskPrompt) {
      return {
        success: false,
        message: 'compile_prompt requires taskPrompt',
      };
    }
    if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
      return {
        success: false,
        message: 'compile_prompt requires positive maxOutputTokens',
      };
    }

    try {
      const compiled = await dispatchRuntimeManager.compilePrompt({
        runId,
        role,
        taskId,
        taskPrompt,
        maxOutputTokens,
      });
      return {
        success: true,
        message: 'Dispatch prompt compiled',
        data: {
          runId,
          role,
          taskId,
          ...compiled,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = errorCodeFromMessage(message);
      return {
        success: false,
        message,
        data: {
          runId,
          role,
          taskId,
          errorCode,
        },
      };
    }
  }

  let outputContent = String(args.outputContent || '').trim();
  const outputFilePath = String(args.outputFilePath || '').trim();
  if (!outputContent && outputFilePath) {
    const resolved = outputFilePath.startsWith('/')
      ? outputFilePath
      : resolve(context.projectPath, outputFilePath);
    outputContent = await fs.readFile(resolved, 'utf-8');
  }

  if (!outputContent) {
    return {
      success: false,
      message: 'ingest_output requires outputContent or outputFilePath',
    };
  }

  const maxOutputTokens = args.maxOutputTokens === undefined
    ? undefined
    : Number(args.maxOutputTokens);
  if (args.maxOutputTokens !== undefined && (!Number.isFinite(maxOutputTokens) || (maxOutputTokens as number) <= 0)) {
    return {
      success: false,
      message: 'ingest_output maxOutputTokens must be a positive number',
    };
  }

  try {
    const result = await dispatchRuntimeManager.ingestOutput({
      runId,
      role,
      taskId,
      outputContent,
      maxOutputTokens,
    });

    return {
      success: true,
      message: 'Dispatch output ingested and validated',
      data: {
        runId,
        role,
        nextAction: result.nextAction,
        result: result.result,
        snapshot: result.snapshot,
        outputTokens: result.outputTokens,
        telemetry: dispatchRuntimeManager.getTelemetrySnapshot(),
      },
      nextSteps: [
        `Follow next action: ${result.nextAction}`,
        'Use get_snapshot for latest runtime status before dispatching next agent call',
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = errorCodeFromMessage(message);
    const isSchemaInvalid =
      message.includes('Schema validation failed') ||
      message.includes('Dispatch result') ||
      message.includes('No valid JSON');

    if (isSchemaInvalid) {
      try {
        const retry = await dispatchRuntimeManager.recordSchemaInvalidRetry({
          runId,
          role,
          taskId,
          errorMessage: message,
        });
        const nextAction = retry.terminal
          ? 'halt_schema_invalid_terminal'
          : 'retry_once_schema_invalid';
        return {
          success: false,
          message,
          data: {
            runId,
            role,
            taskId,
            retryCount: retry.retryCount,
            nextAction,
            snapshot: retry.snapshot,
            telemetry: dispatchRuntimeManager.getTelemetrySnapshot(),
          },
        };
      } catch {
        return {
          success: false,
          message,
          data: {
            runId,
            role,
            taskId,
            nextAction: 'halt_schema_invalid_terminal',
            telemetry: dispatchRuntimeManager.getTelemetrySnapshot(),
          },
        };
      }
    }

    return {
      success: false,
      message,
      data: {
        runId,
        role,
        taskId,
        errorCode,
      },
    };
  }
}
