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

function estimateTokensFromChars(value: string, charsPerToken = 4): number {
  return Math.ceil(value.length / Math.max(1, charsPerToken));
}

const DEFAULT_MAX_INPUT_TOKENS_IMPLEMENTER = 4800;
const DEFAULT_MAX_INPUT_TOKENS_REVIEWER = 4000;
const DEFAULT_TOKEN_CHARS_PER_TOKEN = 4;
const MAX_DELTA_VALUE_CHARS = 240;
const STAGE_B_HEAD_LINES = 18;
const STAGE_B_TAIL_LINES = 8;
const STAGE_B_OBJECTIVE_CHARS = 900;
const STAGE_C_OBJECTIVE_CHARS = 420;

type DispatchCompactionStage = 'none' | 'stage_a_prune' | 'stage_b_prompt' | 'stage_c_fallback';

interface DispatchCompactionPolicy {
  auto: boolean;
  prune: boolean;
  maxInputTokensImplementer: number;
  maxInputTokensReviewer: number;
  tokenCharsPerToken: number;
}

interface DispatchCompactionTrace {
  stage: DispatchCompactionStage | 'initial';
  promptTokens: number;
}

interface CompiledDispatchPrompt {
  prompt: string;
  stablePrefixHash: string;
  fullPromptHash: string;
  deltaPacket: Record<string, unknown>;
  maxOutputTokens: number;
  guideMode: 'full' | 'compact';
  guideCacheKey: string;
  promptTokens: number;
}

function boolFromEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function intFromEnv(raw: string | undefined, defaultValue: number): number {
  if (!raw) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return defaultValue;
  }
  return Math.floor(value);
}

function clipText(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 3)}...`;
}

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

function normalizePromptText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function uniqueNonEmptyLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const normalized = normalizeLine(line);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function containsCriticalConstraint(line: string): boolean {
  return /(must|required|do not|never|task[_ -]?id|branch|contract|BEGIN_DISPATCH_RESULT|END_DISPATCH_RESULT|json)/i.test(line);
}

function compactTaskPromptStageB(input: {
  taskPrompt: string;
  taskId: string;
  maxOutputTokens: number;
  compactionContext?: string[];
}): string {
  const normalizedPrompt = normalizePromptText(input.taskPrompt);
  if (!normalizedPrompt) {
    return input.taskPrompt;
  }

  const lines = normalizedPrompt.split('\n').map(line => line.trim());
  const nonEmpty = lines.filter(Boolean);
  const head = nonEmpty.slice(0, STAGE_B_HEAD_LINES);
  const tail = nonEmpty.slice(Math.max(0, nonEmpty.length - STAGE_B_TAIL_LINES));
  const critical = uniqueNonEmptyLines(nonEmpty.filter(containsCriticalConstraint)).slice(0, 16);
  const objective = clipText(nonEmpty.join(' '), STAGE_B_OBJECTIVE_CHARS);
  const contextLines = uniqueNonEmptyLines(input.compactionContext ?? []).slice(0, 8);

  const sections: string[] = [
    'Task prompt compacted due to input token budget pressure.',
    `Task ID: ${input.taskId}`,
    `Max output tokens: ${input.maxOutputTokens}`,
    `Objective: ${objective}`,
  ];

  if (critical.length > 0) {
    sections.push(`Critical constraints:\n- ${critical.join('\n- ')}`);
  }
  if (head.length > 0) {
    sections.push(`Leading context:\n${head.join('\n')}`);
  }
  if (tail.length > 0) {
    sections.push(`Recent context:\n${tail.join('\n')}`);
  }
  if (contextLines.length > 0) {
    sections.push(`Compaction context:\n- ${contextLines.join('\n- ')}`);
  }

  return sections.join('\n\n');
}

function compactTaskPromptStageC(input: {
  taskPrompt: string;
  taskId: string;
  maxOutputTokens: number;
  compactionContext?: string[];
  compactionPromptOverride?: string;
}): string {
  const normalizedPrompt = normalizePromptText(input.taskPrompt);
  const objective = clipText(normalizeLine(normalizedPrompt), STAGE_C_OBJECTIVE_CHARS);
  const critical = uniqueNonEmptyLines(
    normalizedPrompt
      .split('\n')
      .map(line => line.trim())
      .filter(containsCriticalConstraint)
  ).slice(0, 8);
  const contextLines = uniqueNonEmptyLines(input.compactionContext ?? []).slice(0, 4);

  const sections: string[] = [];
  if (input.compactionPromptOverride?.trim()) {
    sections.push(input.compactionPromptOverride.trim());
  } else {
    sections.push('Task prompt emergency compaction applied to stay within token budget.');
  }
  sections.push(`Task ID: ${input.taskId}`);
  sections.push(`Goal: ${objective}`);
  sections.push(`Output budget: ${input.maxOutputTokens} tokens`);

  if (critical.length > 0) {
    sections.push(`Non-negotiable constraints: ${critical.join(' | ')}`);
  }
  if (contextLines.length > 0) {
    sections.push(`Compaction context: ${contextLines.join(' | ')}`);
  }

  return sections.join('\n');
}

function pruneDeltaPacket(deltaPacket: Record<string, unknown>): Record<string, unknown> {
  const allowedKeys = [
    'task_id',
    'previous_implementer_summary',
    'previous_reviewer_assessment',
    'previous_reviewer_issue_count',
    'guide_mode',
    'guide_cache_key',
  ];
  const compacted: Record<string, unknown> = {};

  for (const key of allowedKeys) {
    if (!(key in deltaPacket)) {
      continue;
    }
    const value = deltaPacket[key];
    if (value === null || value === undefined || value === '') {
      continue;
    }
    if (typeof value === 'string') {
      compacted[key] = clipText(normalizeLine(value), MAX_DELTA_VALUE_CHARS);
      continue;
    }
    compacted[key] = value;
  }

  compacted.compaction_applied = true;
  return compacted;
}

function resolveDispatchCompactionPolicy(): DispatchCompactionPolicy {
  return {
    auto: boolFromEnv(process.env.SPEC_CONTEXT_DISPATCH_COMPACTION_AUTO, true),
    prune: boolFromEnv(process.env.SPEC_CONTEXT_DISPATCH_COMPACTION_PRUNE, true),
    maxInputTokensImplementer: intFromEnv(
      process.env.SPEC_CONTEXT_DISPATCH_MAX_INPUT_TOKENS_IMPLEMENTER,
      DEFAULT_MAX_INPUT_TOKENS_IMPLEMENTER
    ),
    maxInputTokensReviewer: intFromEnv(
      process.env.SPEC_CONTEXT_DISPATCH_MAX_INPUT_TOKENS_REVIEWER,
      DEFAULT_MAX_INPUT_TOKENS_REVIEWER
    ),
    tokenCharsPerToken: intFromEnv(
      process.env.SPEC_CONTEXT_DISPATCH_TOKEN_CHARS_PER_TOKEN,
      DEFAULT_TOKEN_CHARS_PER_TOKEN
    ),
  };
}

interface DispatchTelemetrySnapshot {
  dispatch_count: number;
  total_output_tokens: number;
  avg_output_tokens: number;
  schema_invalid_retries: number;
  approval_loops: number;
  compaction_count: number;
  compaction_auto_count: number;
  compaction_prompt_tokens_before: number;
  compaction_prompt_tokens_after: number;
  compaction_ratio: number;
  compaction_stage_distribution: Record<DispatchCompactionStage, number>;
  overflow_terminal_count: number;
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
    tokenCharsPerToken?: number;
  }): CompiledDispatchPrompt {
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
      promptTokens: estimateTokensFromChars(
        compiled.text,
        input.tokenCharsPerToken ?? DEFAULT_TOKEN_CHARS_PER_TOKEN
      ),
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
  private readonly compactionPolicy = resolveDispatchCompactionPolicy();
  private telemetry: DispatchTelemetrySnapshot = {
    dispatch_count: 0,
    total_output_tokens: 0,
    avg_output_tokens: 0,
    schema_invalid_retries: 0,
    approval_loops: 0,
    compaction_count: 0,
    compaction_auto_count: 0,
    compaction_prompt_tokens_before: 0,
    compaction_prompt_tokens_after: 0,
    compaction_ratio: 1,
    compaction_stage_distribution: {
      none: 0,
      stage_a_prune: 0,
      stage_b_prompt: 0,
      stage_c_fallback: 0,
    },
    overflow_terminal_count: 0,
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
    const outputTokens = estimateTokensFromChars(args.outputContent, this.compactionPolicy.tokenCharsPerToken);
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
    compactionContext?: string[];
    compactionPromptOverride?: string;
    compactionAuto?: boolean;
  }): Promise<{
    prompt: string;
    stablePrefixHash: string;
    fullPromptHash: string;
    deltaPacket: Record<string, unknown>;
    maxOutputTokens: number;
    guideMode: 'full' | 'compact';
    guideCacheKey: string;
    promptTokensBefore: number;
    promptTokensAfter: number;
    promptTokenBudget: number;
    compactionApplied: boolean;
    compactionStage: DispatchCompactionStage;
    compactionTrace: DispatchCompactionTrace[];
  }> {
    const snapshot = await this.assertRunBinding(args.runId, args.taskId);
    const facts = new Map((snapshot.facts ?? []).map(fact => [fact.k, fact.v]));
    const guideMode = this.nextGuideMode(args.runId, args.role);
    const guideCacheKey = `${args.role}:${args.runId}`;
    let deltaPacket: Record<string, unknown> = {
      task_id: args.taskId,
      previous_implementer_summary: facts.get('implementer_summary') ?? null,
      previous_reviewer_assessment: facts.get('reviewer_assessment') ?? null,
      previous_reviewer_issue_count: facts.get('reviewer_issue_count') ?? null,
      guide_mode: guideMode,
      guide_cache_key: guideCacheKey,
    };
    let taskPrompt = args.taskPrompt;

    const promptBudget = this.resolvePromptInputBudget(args.role, args.maxOutputTokens);
    const autoCompaction = args.compactionAuto ?? this.compactionPolicy.auto;
    const compactionTrace: DispatchCompactionTrace[] = [];

    let compiled = this.promptCompiler.compile({
      runId: args.runId,
      role: args.role,
      taskPrompt,
      taskId: args.taskId,
      maxOutputTokens: args.maxOutputTokens,
      deltaPacket,
      guideMode,
      guideCacheKey,
      tokenCharsPerToken: this.compactionPolicy.tokenCharsPerToken,
    });
    const promptTokensBefore = compiled.promptTokens;
    compactionTrace.push({ stage: 'initial', promptTokens: compiled.promptTokens });

    let compactionStage: DispatchCompactionStage = 'none';

    if (compiled.promptTokens > promptBudget) {
      if (!autoCompaction) {
        this.bumpOverflowTerminalTelemetry();
        throw new Error(
          `dispatch_prompt_overflow_terminal: estimated=${compiled.promptTokens}, budget=${promptBudget}, role=${args.role}`
        );
      }

      if (this.compactionPolicy.prune) {
        deltaPacket = pruneDeltaPacket(deltaPacket);
        const stageACompiled = this.promptCompiler.compile({
          runId: args.runId,
          role: args.role,
          taskPrompt,
          taskId: args.taskId,
          maxOutputTokens: args.maxOutputTokens,
          deltaPacket,
          guideMode,
          guideCacheKey,
          tokenCharsPerToken: this.compactionPolicy.tokenCharsPerToken,
        });
        if (stageACompiled.promptTokens <= compiled.promptTokens) {
          compiled = stageACompiled;
          compactionStage = 'stage_a_prune';
        }
        compactionTrace.push({ stage: 'stage_a_prune', promptTokens: compiled.promptTokens });
      }

      if (compiled.promptTokens > promptBudget) {
        taskPrompt = compactTaskPromptStageB({
          taskPrompt,
          taskId: args.taskId,
          maxOutputTokens: args.maxOutputTokens,
          compactionContext: args.compactionContext,
        });
        const stageBCompiled = this.promptCompiler.compile({
          runId: args.runId,
          role: args.role,
          taskPrompt,
          taskId: args.taskId,
          maxOutputTokens: args.maxOutputTokens,
          deltaPacket,
          guideMode,
          guideCacheKey,
          tokenCharsPerToken: this.compactionPolicy.tokenCharsPerToken,
        });
        if (stageBCompiled.promptTokens <= compiled.promptTokens) {
          compiled = stageBCompiled;
          compactionStage = 'stage_b_prompt';
        }
        compactionTrace.push({ stage: 'stage_b_prompt', promptTokens: compiled.promptTokens });
      }

      if (compiled.promptTokens > promptBudget) {
        taskPrompt = compactTaskPromptStageC({
          taskPrompt,
          taskId: args.taskId,
          maxOutputTokens: args.maxOutputTokens,
          compactionContext: args.compactionContext,
          compactionPromptOverride: args.compactionPromptOverride,
        });
        const stageCCompiled = this.promptCompiler.compile({
          runId: args.runId,
          role: args.role,
          taskPrompt,
          taskId: args.taskId,
          maxOutputTokens: args.maxOutputTokens,
          deltaPacket,
          guideMode,
          guideCacheKey,
          tokenCharsPerToken: this.compactionPolicy.tokenCharsPerToken,
        });
        if (stageCCompiled.promptTokens <= compiled.promptTokens) {
          compiled = stageCCompiled;
          compactionStage = 'stage_c_fallback';
        }
        compactionTrace.push({ stage: 'stage_c_fallback', promptTokens: compiled.promptTokens });
      }
    }

    if (compiled.promptTokens > promptBudget) {
      this.bumpOverflowTerminalTelemetry();
      throw new Error(
        `dispatch_prompt_overflow_terminal: estimated=${compiled.promptTokens}, budget=${promptBudget}, role=${args.role}, stage=${compactionStage}`
      );
    }

    if (compactionStage !== 'none') {
      this.bumpCompactionTelemetry({
        beforeTokens: promptTokensBefore,
        afterTokens: compiled.promptTokens,
        stage: compactionStage,
        autoCompaction,
      });

      const compactionEvent = await this.publishEvent({
        partition_key: args.runId,
        run_id: args.runId,
        step_id: args.taskId,
        agent_id: 'orchestrator',
        type: 'STATE_DELTA',
        payload: {
          role: args.role,
          task_id: args.taskId,
          dispatch_compaction_stage: compactionStage,
          prompt_tokens_before: promptTokensBefore,
          prompt_tokens_after: compiled.promptTokens,
          prompt_token_budget: promptBudget,
        },
      });
      await this.updateSnapshot(
        args.runId,
        compactionEvent,
        [
          { k: `dispatch_compacted:${args.role}`, v: 'true', confidence: 1 },
          { k: `dispatch_compaction_stage:${args.role}`, v: compactionStage, confidence: 1 },
          { k: `dispatch_prompt_tokens_before:${args.role}`, v: String(promptTokensBefore), confidence: 1 },
          { k: `dispatch_prompt_tokens_after:${args.role}`, v: String(compiled.promptTokens), confidence: 1 },
          { k: `dispatch_prompt_token_budget:${args.role}`, v: String(promptBudget), confidence: 1 },
        ],
        args.taskId,
        snapshot.status
      );
    }

    return {
      prompt: compiled.prompt,
      stablePrefixHash: compiled.stablePrefixHash,
      fullPromptHash: compiled.fullPromptHash,
      deltaPacket: compiled.deltaPacket,
      maxOutputTokens: compiled.maxOutputTokens,
      guideMode: compiled.guideMode,
      guideCacheKey: compiled.guideCacheKey,
      promptTokensBefore,
      promptTokensAfter: compiled.promptTokens,
      promptTokenBudget: promptBudget,
      compactionApplied: compactionStage !== 'none',
      compactionStage,
      compactionTrace,
    };
  }

  getTelemetrySnapshot(): DispatchTelemetrySnapshot {
    return {
      ...this.telemetry,
      compaction_stage_distribution: { ...this.telemetry.compaction_stage_distribution },
    };
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

  private resolvePromptInputBudget(role: DispatchRole, maxOutputTokens: number): number {
    const roleCap = role === 'implementer'
      ? this.compactionPolicy.maxInputTokensImplementer
      : this.compactionPolicy.maxInputTokensReviewer;
    const reserveOutput = Math.min(roleCap - 1, Math.max(1, Math.floor(maxOutputTokens)));
    return Math.max(1, roleCap - reserveOutput);
  }

  private bumpCompactionTelemetry(args: {
    beforeTokens: number;
    afterTokens: number;
    stage: DispatchCompactionStage;
    autoCompaction: boolean;
  }): void {
    this.telemetry.compaction_count += 1;
    if (args.autoCompaction) {
      this.telemetry.compaction_auto_count += 1;
    }
    this.telemetry.compaction_prompt_tokens_before += args.beforeTokens;
    this.telemetry.compaction_prompt_tokens_after += args.afterTokens;
    this.telemetry.compaction_stage_distribution[args.stage] += 1;
    this.telemetry.compaction_ratio = this.telemetry.compaction_prompt_tokens_before > 0
      ? this.telemetry.compaction_prompt_tokens_after / this.telemetry.compaction_prompt_tokens_before
      : 1;
  }

  private bumpOverflowTerminalTelemetry(): void {
    this.telemetry.overflow_terminal_count += 1;
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

function errorCodeFromMessage(
  message: string
): 'run_not_initialized' | 'run_task_mismatch' | 'dispatch_prompt_overflow_terminal' | null {
  if (message.startsWith('run_not_initialized:')) {
    return 'run_not_initialized';
  }
  if (message.startsWith('run_task_mismatch:')) {
    return 'run_task_mismatch';
  }
  if (message.startsWith('dispatch_prompt_overflow_terminal:')) {
    return 'dispatch_prompt_overflow_terminal';
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
      compactionContext: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional compaction context lines used when compile_prompt needs aggressive prompt reduction',
      },
      compactionPromptOverride: {
        type: 'string',
        description: 'Optional emergency compaction instruction override for compile_prompt stage C',
      },
      compactionAuto: {
        type: 'boolean',
        description: 'Optional override for SPEC_CONTEXT_DISPATCH_COMPACTION_AUTO during compile_prompt',
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
      message: `${action} requires role (implementer|reviewer) and taskId`,
    };
  }

  if (action === 'compile_prompt') {
    const taskPrompt = String(args.taskPrompt || '').trim();
    const maxOutputTokens = Number(args.maxOutputTokens ?? 1200);
    const compactionContext = Array.isArray(args.compactionContext)
      ? args.compactionContext
        .filter(item => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean)
      : undefined;
    const compactionPromptOverride = typeof args.compactionPromptOverride === 'string'
      ? args.compactionPromptOverride.trim()
      : undefined;
    let compactionAuto: boolean | undefined;
    if (args.compactionAuto !== undefined) {
      if (typeof args.compactionAuto === 'boolean') {
        compactionAuto = args.compactionAuto;
      } else if (typeof args.compactionAuto === 'string') {
        const normalized = args.compactionAuto.trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(normalized)) {
          compactionAuto = true;
        } else if (['0', 'false', 'no', 'off'].includes(normalized)) {
          compactionAuto = false;
        } else {
          return {
            success: false,
            message: 'compile_prompt compactionAuto must be boolean-like',
          };
        }
      } else {
        return {
          success: false,
          message: 'compile_prompt compactionAuto must be boolean-like',
        };
      }
    }

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
        compactionContext,
        compactionPromptOverride,
        compactionAuto,
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
