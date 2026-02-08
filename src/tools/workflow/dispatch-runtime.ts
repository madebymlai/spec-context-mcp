import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { tmpdir } from 'os';
import { join } from 'path';
import type {
  RuntimeEventDraft,
  RuntimeEventEnvelope,
  StateSnapshot,
  StateSnapshotFact,
} from '../../core/llm/index.js';
import { ToolContext, ToolResponse } from '../../workflow-types.js';
import type { DispatchRole } from '../../config/discipline.js';
import { getDispatchCliForComplexity } from '../../config/dispatch-cli-resolver.js';
import {
  type LedgerMode,
  DispatchLedgerError,
  applyOutcomeToTaskLedger,
  assertCompleteProgressLedger,
  buildLedgerDeltaPacket,
  buildLedgerTaskPrompt,
  extractProgressLedger,
  isProgressLedgerStale,
  progressLedgerFromFacts,
  progressLedgerToFacts,
  resolveTasksFilePath,
  taskLedgerFromFacts,
  taskLedgerToFacts,
} from './dispatch-ledger.js';
import {
  DISPATCH_CONTRACT_SCHEMA_VERSION,
  registerDispatchContractSchemas,
  type ImplementerResult,
  type ReviewerResult,
} from './dispatch-contract-schemas.js';
import {
  type ComplexityLevel,
  type IRoutingTable,
  type ITaskComplexityClassifier,
} from '../../core/routing/index.js';
import {
  IFactExtractor,
  IFactRetriever,
  ISessionFactStore,
  formatSessionFacts,
} from '../../core/session/index.js';

const DISPATCH_ACTIONS = ['init_run', 'ingest_output', 'get_snapshot', 'compile_prompt', 'get_telemetry'] as const;
type DispatchAction = typeof DISPATCH_ACTIONS[number];
const DISPATCH_ROLES = ['implementer', 'reviewer'] as const;

function isDispatchAction(value: string): value is DispatchAction {
  return (DISPATCH_ACTIONS as readonly string[]).includes(value);
}

function isDispatchRole(value: string): value is DispatchRole {
  return (DISPATCH_ROLES as readonly string[]).includes(value);
}

const DISPATCH_CLASSIFICATION_FACT_KEYS = {
  level: 'classification_level',
  selectedProvider: 'selected_provider',
  dispatchCli: 'dispatch_cli',
  features: 'classification_features',
  classifierId: 'classification_classifier_id',
} as const;

export const DISPATCH_RESULT_MARKERS = {
  begin: 'BEGIN_DISPATCH_RESULT',
  end: 'END_DISPATCH_RESULT',
} as const;

function getFactValue(snapshot: StateSnapshot, key: string): string | undefined {
  return snapshot.facts.find(fact => fact.k === key)?.v;
}

function normalizeDispatchComplexity(value: string | undefined): ComplexityLevel {
  return value === 'simple' ? 'simple' : 'complex';
}

const DISPATCH_RESULT_BEGIN = DISPATCH_RESULT_MARKERS.begin;
const DISPATCH_RESULT_END = DISPATCH_RESULT_MARKERS.end;

type DispatchContractErrorCode =
  | 'marker_missing'
  | 'json_parse_failed'
  | 'schema_invalid';

class DispatchContractError extends Error {
  constructor(
    public readonly code: DispatchContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DispatchContractError';
  }
}

type DispatchRuntimeErrorCode =
  | 'run_not_initialized'
  | 'run_task_mismatch'
  | 'dispatch_prompt_overflow_terminal'
  | 'output_token_budget_exceeded';

class DispatchRuntimeError extends Error {
  constructor(
    public readonly code: DispatchRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DispatchRuntimeError';
  }
}

function extractStructuredJson(rawOutput: string): unknown {
  const trimmed = rawOutput.trim();
  const beginCount = (trimmed.match(new RegExp(DISPATCH_RESULT_BEGIN, 'g')) ?? []).length;
  const endCount = (trimmed.match(new RegExp(DISPATCH_RESULT_END, 'g')) ?? []).length;

  if (beginCount !== 1 || endCount !== 1) {
    throw new DispatchContractError(
      'marker_missing',
      `Invalid dispatch contract markers; expected exactly one ${DISPATCH_RESULT_BEGIN}/${DISPATCH_RESULT_END} block`,
    );
  }

  if (!trimmed.startsWith(DISPATCH_RESULT_BEGIN)) {
    throw new DispatchContractError('marker_missing', 'Dispatch result must start with BEGIN_DISPATCH_RESULT marker');
  }
  if (!trimmed.endsWith(DISPATCH_RESULT_END)) {
    throw new DispatchContractError('marker_missing', 'Dispatch result must end with END_DISPATCH_RESULT marker');
  }

  const jsonBody = trimmed
    .slice(DISPATCH_RESULT_BEGIN.length, trimmed.length - DISPATCH_RESULT_END.length)
    .trim();

  if (!jsonBody) {
    throw new DispatchContractError('json_parse_failed', 'Dispatch result JSON body is empty');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBody);
  } catch (error) {
    throw new DispatchContractError('json_parse_failed', `Dispatch result JSON is invalid: ${String(error)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new DispatchContractError('schema_invalid', 'Dispatch result JSON must be an object');
  }
  return parsed;
}

const IMPLEMENTER_NEXT_ACTION_BY_STATUS: Record<ImplementerResult['status'], string> = {
  completed: 'dispatch_reviewer',
  blocked: 'retry_implementer_with_constraints',
  failed: 'retry_implementer',
};

const REVIEWER_NEXT_ACTION_BY_ASSESSMENT: Record<ReviewerResult['assessment'], string> = {
  approved: 'advance_to_next_task',
  needs_changes: 'dispatch_implementer_fixes',
  blocked: 'halt_and_escalate',
};

const SNAPSHOT_STATUS_BY_IMPLEMENTER_STATUS: Record<ImplementerResult['status'], StateSnapshot['status']> = {
  completed: 'running',
  blocked: 'blocked',
  failed: 'failed',
};

const SNAPSHOT_STATUS_BY_REVIEWER_ASSESSMENT: Record<ReviewerResult['assessment'], StateSnapshot['status']> = {
  approved: 'done',
  needs_changes: 'blocked',
  blocked: 'failed',
};

function nextActionForImplementer(result: ImplementerResult): string {
  return IMPLEMENTER_NEXT_ACTION_BY_STATUS[result.status];
}

function nextActionForReviewer(result: ReviewerResult): string {
  return REVIEWER_NEXT_ACTION_BY_ASSESSMENT[result.assessment];
}

function statusForImplementer(result: ImplementerResult): StateSnapshot['status'] {
  return SNAPSHOT_STATUS_BY_IMPLEMENTER_STATUS[result.status];
}

function statusForReviewer(result: ReviewerResult): StateSnapshot['status'] {
  return SNAPSHOT_STATUS_BY_REVIEWER_ASSESSMENT[result.assessment];
}

function estimateTokensFromChars(value: string, charsPerToken = 4): number {
  return Math.ceil(value.length / Math.max(1, charsPerToken));
}

const DEFAULT_MAX_INPUT_TOKENS_IMPLEMENTER = 4800;
const DEFAULT_MAX_INPUT_TOKENS_REVIEWER = 4000;
const DEFAULT_TOKEN_CHARS_PER_TOKEN = 4;
const DEFAULT_STALLED_THRESHOLD = 2;
const MAX_DELTA_VALUE_CHARS = 240;
const STAGE_B_HEAD_LINES = 18;
const STAGE_B_TAIL_LINES = 8;
const STAGE_B_OBJECTIVE_CHARS = 900;
const STAGE_C_OBJECTIVE_CHARS = 420;

type DispatchCompactionStage = 'none' | 'stage_a_prune' | 'stage_b_prompt' | 'stage_c_fallback';

export interface DispatchCompactionPolicy {
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

export interface CompiledDispatchPrompt {
  prompt: string;
  stablePrefixHash: string;
  fullPromptHash: string;
  deltaPacket: Record<string, unknown>;
  maxOutputTokens: number;
  guideMode: 'full' | 'compact';
  guideCacheKey: string;
  promptTokens: number;
}

function boolFromEnv(raw: string | undefined, defaultValue: boolean, envVarName: string): boolean {
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
  throw new Error(`${envVarName} must be a boolean-like value (1/0/true/false/yes/no/on/off)`);
}

function intFromEnv(raw: string | undefined, defaultValue: number, envVarName: string): number {
  if (!raw) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${envVarName} must be a positive number`);
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

function sanitizeDispatchPathToken(value: string, maxLen = 48): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!sanitized) {
    return 'na';
  }
  return sanitized.slice(0, maxLen);
}

function buildDispatchOutputPaths(input: {
  runId: string;
  role: DispatchRole;
  taskId: string;
}): {
  contractOutputPath: string;
  debugOutputPath: string;
} {
  const runToken = sanitizeDispatchPathToken(input.runId);
  const taskToken = sanitizeDispatchPathToken(input.taskId);
  const roleToken = sanitizeDispatchPathToken(input.role, 16);
  const fileStem = `spec-context-dispatch-${roleToken}-${runToken}-${taskToken}`;
  return {
    contractOutputPath: join(tmpdir(), `${fileStem}.contract.log`),
    debugOutputPath: join(tmpdir(), `${fileStem}.debug.log`),
  };
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
    'guide_mode',
    'guide_cache_key',
    'ledger_active_task_id',
    'ledger_summary',
    'ledger_reviewer_assessment',
    'ledger_reviewer_issue_count',
    'ledger_stalled_count',
    'ledger_stalled_flagged',
    'ledger_replan_hint',
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

export function resolveDispatchCompactionPolicyFromEnv(): DispatchCompactionPolicy {
  return {
    auto: boolFromEnv(process.env.SPEC_CONTEXT_DISPATCH_COMPACTION_AUTO, true, 'SPEC_CONTEXT_DISPATCH_COMPACTION_AUTO'),
    prune: boolFromEnv(process.env.SPEC_CONTEXT_DISPATCH_COMPACTION_PRUNE, true, 'SPEC_CONTEXT_DISPATCH_COMPACTION_PRUNE'),
    maxInputTokensImplementer: intFromEnv(
      process.env.SPEC_CONTEXT_DISPATCH_MAX_INPUT_TOKENS_IMPLEMENTER,
      DEFAULT_MAX_INPUT_TOKENS_IMPLEMENTER,
      'SPEC_CONTEXT_DISPATCH_MAX_INPUT_TOKENS_IMPLEMENTER',
    ),
    maxInputTokensReviewer: intFromEnv(
      process.env.SPEC_CONTEXT_DISPATCH_MAX_INPUT_TOKENS_REVIEWER,
      DEFAULT_MAX_INPUT_TOKENS_REVIEWER,
      'SPEC_CONTEXT_DISPATCH_MAX_INPUT_TOKENS_REVIEWER',
    ),
    tokenCharsPerToken: intFromEnv(
      process.env.SPEC_CONTEXT_DISPATCH_TOKEN_CHARS_PER_TOKEN,
      DEFAULT_TOKEN_CHARS_PER_TOKEN,
      'SPEC_CONTEXT_DISPATCH_TOKEN_CHARS_PER_TOKEN',
    ),
  };
}

export function resolveDispatchStalledThresholdFromEnv(): number {
  return intFromEnv(
    process.env.SPEC_CONTEXT_DISPATCH_STALLED_THRESHOLD,
    DEFAULT_STALLED_THRESHOLD,
    'SPEC_CONTEXT_DISPATCH_STALLED_THRESHOLD',
  );
}

interface DispatchCoreTelemetry {
  dispatch_count: number;
  total_output_tokens: number;
  avg_output_tokens: number;
  approval_loops: number;
}

interface DispatchCompactionTelemetry {
  compaction_count: number;
  compaction_auto_count: number;
  compaction_prompt_tokens_before: number;
  compaction_prompt_tokens_after: number;
  compaction_ratio: number;
  compaction_stage_distribution: Record<DispatchCompactionStage, number>;
  overflow_terminal_count: number;
}

interface DispatchLedgerTelemetry {
  ledger_mode_usage: Record<LedgerMode, number>;
  ledger_rebuild_count: number;
  ledger_prompt_tokens_baseline: number;
  ledger_prompt_tokens_actual: number;
  ledger_prompt_token_delta: number;
}

interface DispatchSchemaTelemetry {
  schema_error_counts: Record<DispatchContractErrorCode, number>;
  schema_version_counts: Record<string, number>;
}

type DispatchTelemetrySnapshot =
  & DispatchCoreTelemetry
  & DispatchCompactionTelemetry
  & DispatchLedgerTelemetry
  & DispatchSchemaTelemetry;

interface SnapshotStoreUpsertInput {
  runId: string;
  goal: string;
  status: StateSnapshot['status'];
  facts: StateSnapshotFact[];
  pendingWrites: StateSnapshot['pending_writes'];
  tokenBudget: StateSnapshot['token_budget'];
  appliedOffset: StateSnapshot['applied_offsets'][number];
}

interface StateProjectorApplyInput {
  event: RuntimeEventEnvelope;
  previous: StateSnapshot | null;
}

interface StateProjectorApplyOutput {
  runId: string;
  goal: string;
  status: StateSnapshot['status'];
  facts: StateSnapshotFact[];
  pendingWrites: StateSnapshot['pending_writes'];
  tokenBudget: StateSnapshot['token_budget'];
  appliedOffset: StateSnapshot['applied_offsets'][number];
}

export interface DispatchRuntimeEventStream {
  publish(draft: RuntimeEventDraft): RuntimeEventEnvelope;
}

export interface DispatchRuntimeSnapshotStore {
  get(runId: string): Promise<StateSnapshot | null>;
  upsert(update: SnapshotStoreUpsertInput): Promise<StateSnapshot>;
}

export interface DispatchRuntimeSchemaRegistry {
  register<T>(type: string, schemaId: string, schemaVersion: string, validate: (payload: unknown) => payload is T): void;
  assert(type: string, payload: unknown, schemaVersion?: string): void;
}

export interface DispatchRuntimeStateProjector {
  apply(input: StateProjectorApplyInput): StateProjectorApplyOutput;
}

export interface DispatchRuntimeEventBus {
  publish(event: RuntimeEventEnvelope): Promise<void>;
}

export interface DispatchRuntimePromptCompiler {
  compile(input: {
    runId: string;
    role: DispatchRole;
    taskPrompt: string;
    taskId: string;
    maxOutputTokens: number;
    deltaPacket: Record<string, unknown>;
    guideMode: 'full' | 'compact';
    guideCacheKey: string;
    sessionContext?: string;
    tokenCharsPerToken?: number;
  }): CompiledDispatchPrompt;
}

export interface DispatchRuntimeManagerDependencies {
  eventStream: DispatchRuntimeEventStream;
  snapshotStore: DispatchRuntimeSnapshotStore;
  schemaRegistry: DispatchRuntimeSchemaRegistry;
  stateProjector: DispatchRuntimeStateProjector;
  eventBus: DispatchRuntimeEventBus;
  promptCompiler: DispatchRuntimePromptCompiler;
  compactionPolicy: DispatchCompactionPolicy;
  stalledThreshold: number;
}

export class DispatchRuntimeManager {
  private readonly eventStream: DispatchRuntimeEventStream;
  private readonly snapshotStore: DispatchRuntimeSnapshotStore;
  private readonly schemaRegistry: DispatchRuntimeSchemaRegistry;
  private readonly stateProjector: DispatchRuntimeStateProjector;
  private readonly eventBus: DispatchRuntimeEventBus;
  private readonly promptCompiler: DispatchRuntimePromptCompiler;
  private readonly guidePromptCounts = new Map<string, number>();
  private readonly compactionPolicy: DispatchCompactionPolicy;
  private readonly stalledThreshold: number;
  private telemetry: DispatchTelemetrySnapshot = {
    dispatch_count: 0,
    total_output_tokens: 0,
    avg_output_tokens: 0,
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
    ledger_mode_usage: {
      ledger_only: 0,
    },
    ledger_rebuild_count: 0,
    ledger_prompt_tokens_baseline: 0,
    ledger_prompt_tokens_actual: 0,
    ledger_prompt_token_delta: 0,
    schema_error_counts: {
      marker_missing: 0,
      json_parse_failed: 0,
      schema_invalid: 0,
    },
    schema_version_counts: {},
  };

  constructor(
    private readonly classifier: ITaskComplexityClassifier,
    private readonly routingTable: IRoutingTable,
    private readonly factStore: ISessionFactStore,
    private readonly factExtractor: IFactExtractor,
    private readonly factRetriever: IFactRetriever,
    dependencies: DispatchRuntimeManagerDependencies,
  ) {
    this.eventStream = dependencies.eventStream;
    this.snapshotStore = dependencies.snapshotStore;
    this.schemaRegistry = dependencies.schemaRegistry;
    this.stateProjector = dependencies.stateProjector;
    this.eventBus = dependencies.eventBus;
    this.promptCompiler = dependencies.promptCompiler;
    this.compactionPolicy = dependencies.compactionPolicy;
    this.stalledThreshold = dependencies.stalledThreshold;
    this.registerSchemas();
  }

  async initRun(runId: string, specName: string, taskId: string, projectPath: string): Promise<StateSnapshot> {
    const progressLedger = await extractProgressLedger({
      specName,
      taskId,
      sourcePath: resolveTasksFilePath(projectPath, specName),
    });
    const taskLedger = taskLedgerFromFacts({
      runId,
      taskId,
      facts: [],
      stalledThreshold: this.stalledThreshold,
    });

    this.guidePromptCounts.delete(`${runId}:implementer`);
    this.guidePromptCounts.delete(`${runId}:reviewer`);

    const taskDescription = progressLedger.currentTask?.prompt?.trim()
      || progressLedger.currentTask?.description?.trim()
      || '';
    const classification = this.classifier.classify({
      taskDescription,
      taskId,
      specName,
    });
    const routingEntry = this.routingTable.resolve(classification.level, 'implementer');
    const dispatchCli = getDispatchCliForComplexity('implementer', classification.level) ?? routingEntry.cli;

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
        ledger_progress_totals: progressLedger.totals,
        ledger_progress_active_task_id: progressLedger.activeTaskId,
        classification_level: classification.level,
        selected_provider: routingEntry.provider,
        dispatch_cli: dispatchCli,
      },
    });

    await this.snapshotStore.upsert({
      runId,
      goal: `dispatch_task:${specName}:${taskId}`,
      status: 'running',
      facts: [
        { k: 'spec_name', v: specName, confidence: 1 },
        { k: 'task_id', v: taskId, confidence: 1 },
        { k: DISPATCH_CLASSIFICATION_FACT_KEYS.level, v: classification.level, confidence: classification.confidence },
        { k: DISPATCH_CLASSIFICATION_FACT_KEYS.selectedProvider, v: routingEntry.provider, confidence: 1 },
        { k: DISPATCH_CLASSIFICATION_FACT_KEYS.dispatchCli, v: dispatchCli, confidence: 1 },
        {
          k: DISPATCH_CLASSIFICATION_FACT_KEYS.features,
          v: JSON.stringify(classification.features),
          confidence: 1,
        },
        { k: DISPATCH_CLASSIFICATION_FACT_KEYS.classifierId, v: classification.classifierId, confidence: 1 },
        ...progressLedgerToFacts(progressLedger),
        ...taskLedgerToFacts(taskLedger),
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
    const snapshotBefore = await this.assertRunBinding(args.runId, args.taskId);
    const parsed = extractStructuredJson(args.outputContent);
    const outputTokens = estimateTokensFromChars(args.outputContent, this.compactionPolicy.tokenCharsPerToken);
    if (typeof args.maxOutputTokens === 'number' && outputTokens > args.maxOutputTokens) {
      throw new DispatchRuntimeError(
        'output_token_budget_exceeded',
        `output_token_budget_exceeded: estimated=${outputTokens}, max=${args.maxOutputTokens}`
      );
    }

    const handlerByRole: Record<DispatchRole, () => Promise<{
      result: ImplementerResult | ReviewerResult;
      snapshot: StateSnapshot;
      nextAction: string;
      outputTokens: number;
    }>> = {
      implementer: () => this.ingestImplementerOutput(args, snapshotBefore, parsed, outputTokens),
      reviewer: () => this.ingestReviewerOutput(args, snapshotBefore, parsed, outputTokens),
    };

    return handlerByRole[args.role]();
  }

  private async ingestImplementerOutput(
    args: {
      runId: string;
      role: DispatchRole;
      taskId: string;
    },
    snapshotBefore: StateSnapshot,
    parsed: unknown,
    outputTokens: number,
  ): Promise<{
    result: ImplementerResult;
    snapshot: StateSnapshot;
    nextAction: string;
    outputTokens: number;
  }> {
    try {
      this.schemaRegistry.assert('dispatch.result.implementer', parsed, DISPATCH_CONTRACT_SCHEMA_VERSION);
    } catch (error) {
      throw new DispatchContractError('schema_invalid', `Implementer dispatch result failed schema validation: ${String(error)}`);
    }
    const result = parsed as ImplementerResult;
    const extractedFacts = this.factExtractor.extractFromImplementer(result, args.taskId);
    this.factStore.add(extractedFacts);
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

    const taskLedger = applyOutcomeToTaskLedger(
      taskLedgerFromFacts({
        runId: args.runId,
        taskId: args.taskId,
        facts: snapshotBefore.facts ?? [],
        stalledThreshold: this.stalledThreshold,
      }),
      {
        role: 'implementer',
        status: result.status,
        summary: result.summary,
        followUpActions: result.follow_up_actions,
      }
    );

    const facts: StateSnapshotFact[] = [
      { k: 'implementer_status', v: result.status, confidence: 1 },
      { k: 'implementer_summary', v: result.summary, confidence: 0.9 },
      { k: 'output_tokens:last', v: String(outputTokens), confidence: 1 },
      { k: 'task_id', v: result.task_id, confidence: 1 },
      ...taskLedgerToFacts(taskLedger),
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

  private async ingestReviewerOutput(
    args: {
      runId: string;
      role: DispatchRole;
      taskId: string;
    },
    snapshotBefore: StateSnapshot,
    parsed: unknown,
    outputTokens: number,
  ): Promise<{
    result: ReviewerResult;
    snapshot: StateSnapshot;
    nextAction: string;
    outputTokens: number;
  }> {
    try {
      this.schemaRegistry.assert('dispatch.result.reviewer', parsed, DISPATCH_CONTRACT_SCHEMA_VERSION);
    } catch (error) {
      throw new DispatchContractError('schema_invalid', `Reviewer dispatch result failed schema validation: ${String(error)}`);
    }
    const result = parsed as ReviewerResult;
    const extractedFacts = this.factExtractor.extractFromReviewer(result, args.taskId);
    this.factStore.add(extractedFacts);
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

    const taskLedger = applyOutcomeToTaskLedger(
      taskLedgerFromFacts({
        runId: args.runId,
        taskId: args.taskId,
        facts: snapshotBefore.facts ?? [],
        stalledThreshold: this.stalledThreshold,
      }),
      {
        role: 'reviewer',
        assessment: result.assessment,
        issues: result.issues.map(issue => ({
          severity: issue.severity,
          message: issue.message,
          file: issue.file,
        })),
        requiredFixes: result.required_fixes,
      }
    );

    const facts: StateSnapshotFact[] = [
      { k: 'reviewer_assessment', v: result.assessment, confidence: 1 },
      { k: 'reviewer_issue_count', v: String(result.issues.length), confidence: 1 },
      { k: 'output_tokens:last', v: String(outputTokens), confidence: 1 },
      { k: 'task_id', v: result.task_id, confidence: 1 },
      ...taskLedgerToFacts(taskLedger),
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
    projectPath: string;
    taskPrompt?: string;
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
    dispatchCli: string;
    contractOutputPath: string;
    debugOutputPath: string;
  }> {
    let snapshot = await this.assertRunBinding(args.runId, args.taskId);
    this.bumpSchemaVersionTelemetry(DISPATCH_CONTRACT_SCHEMA_VERSION);

    const snapshotFactMap = new Map((snapshot.facts ?? []).map(fact => [fact.k, fact.v]));
    const dispatchComplexity = normalizeDispatchComplexity(
      snapshotFactMap.get(DISPATCH_CLASSIFICATION_FACT_KEYS.level)
    );
    const dispatchCli = getDispatchCliForComplexity(args.role, dispatchComplexity)
      ?? this.routingTable.resolve(dispatchComplexity, args.role).cli;
    let progressLedger = progressLedgerFromFacts(snapshot.facts ?? []);
    const missingProgressLedger = !progressLedger;
    const staleProgressLedger = progressLedger ? await isProgressLedgerStale(progressLedger) : false;

    if (missingProgressLedger || staleProgressLedger) {
      const specName = snapshotFactMap.get('spec_name');
      if (!specName) {
        throw new DispatchLedgerError(
          'progress_ledger_incomplete',
          'Cannot rebuild progress ledger because spec_name fact is missing'
        );
      }

      const sourcePath = progressLedger?.sourcePath ?? resolveTasksFilePath(args.projectPath, specName);
      const rebuilt = await extractProgressLedger({
        specName,
        taskId: args.taskId,
        sourcePath,
      });
      progressLedger = rebuilt;
      this.telemetry.ledger_rebuild_count += 1;

      const rebuildEvent = await this.publishEvent({
        partition_key: args.runId,
        run_id: args.runId,
        step_id: args.taskId,
        agent_id: 'orchestrator',
        type: 'STATE_DELTA',
        payload: {
          task_id: args.taskId,
          ledger_rebuild: true,
          ledger_source_path: rebuilt.sourcePath,
          ledger_source_fingerprint: rebuilt.sourceFingerprint,
        },
      });

      await this.updateSnapshot(
        args.runId,
        rebuildEvent,
        progressLedgerToFacts(rebuilt),
        args.taskId,
        snapshot.status
      );
      snapshot = await this.requireSnapshot(args.runId);
    }

    const ensuredProgressLedger = assertCompleteProgressLedger(progressLedger);
    const ledgerPrompt = buildLedgerTaskPrompt(ensuredProgressLedger);
    if (ledgerPrompt.missing.length > 0) {
      throw new DispatchLedgerError(
        'progress_ledger_incomplete',
        `Progress ledger missing required fields: ${ledgerPrompt.missing.join(', ')}`
      );
    }

    const guideMode = this.nextGuideMode(args.runId, args.role);
    const guideCacheKey = `${args.role}:${args.runId}`;
    const taskLedger = taskLedgerFromFacts({
      runId: args.runId,
      taskId: args.taskId,
      facts: snapshot.facts ?? [],
      stalledThreshold: this.stalledThreshold,
    });
    let deltaPacket: Record<string, unknown> = buildLedgerDeltaPacket({
      taskId: args.taskId,
      guideMode,
      guideCacheKey,
      taskLedger,
      progressLedger: ensuredProgressLedger,
    });
    let taskPrompt = args.taskPrompt?.trim()
      ? args.taskPrompt.trim()
      : ledgerPrompt.prompt;
    const relevantFacts = this.factRetriever.retrieve({
      taskDescription: taskPrompt,
      taskId: args.taskId,
      tags: undefined,
      maxFacts: 10,
      maxTokens: 500,
      tokenCharsPerToken: this.compactionPolicy.tokenCharsPerToken,
    });
    const sessionContext = formatSessionFacts(relevantFacts);

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
      sessionContext,
      tokenCharsPerToken: this.compactionPolicy.tokenCharsPerToken,
    });
    const promptTokensBefore = compiled.promptTokens;
    compactionTrace.push({ stage: 'initial', promptTokens: compiled.promptTokens });

    let compactionStage: DispatchCompactionStage = 'none';

    if (compiled.promptTokens > promptBudget) {
      if (!autoCompaction) {
        this.bumpOverflowTerminalTelemetry();
        throw new DispatchRuntimeError(
          'dispatch_prompt_overflow_terminal',
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
          sessionContext,
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
          sessionContext,
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
          sessionContext,
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
      throw new DispatchRuntimeError(
        'dispatch_prompt_overflow_terminal',
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

    this.bumpLedgerCompileTelemetry('ledger_only', promptTokensBefore, compiled.promptTokens);
    const outputPaths = buildDispatchOutputPaths({
      runId: args.runId,
      role: args.role,
      taskId: args.taskId,
    });

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
      dispatchCli,
      contractOutputPath: outputPaths.contractOutputPath,
      debugOutputPath: outputPaths.debugOutputPath,
    };
  }

  getTelemetrySnapshot(): DispatchTelemetrySnapshot {
    return {
      ...this.telemetry,
      compaction_stage_distribution: { ...this.telemetry.compaction_stage_distribution },
      ledger_mode_usage: { ...this.telemetry.ledger_mode_usage },
      schema_error_counts: { ...this.telemetry.schema_error_counts },
      schema_version_counts: { ...this.telemetry.schema_version_counts },
    };
  }

  async recordTerminalContractFailure(args: {
    runId: string;
    role: DispatchRole;
    taskId: string;
    errorCode: DispatchContractErrorCode;
    errorMessage: string;
  }): Promise<StateSnapshot | null> {
    this.bumpSchemaErrorTelemetry(args.errorCode);
    const snapshot = await this.snapshotStore.get(args.runId);
    if (!snapshot) {
      return null;
    }
    const errorEvent = await this.publishEvent({
      partition_key: args.runId,
      run_id: args.runId,
      step_id: args.taskId,
      agent_id: args.role,
      type: 'ERROR',
      payload: {
        code: args.errorCode,
        role: args.role,
        task_id: args.taskId,
        message: args.errorMessage,
      },
    });
    await this.updateSnapshot(
      args.runId,
      errorEvent,
      [
        {
          k: `schema_contract_failure:last`,
          v: args.errorCode,
          confidence: 1,
        },
      ],
      args.taskId,
      'failed',
    );
    return this.requireSnapshot(args.runId);
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

  private bumpLedgerCompileTelemetry(mode: LedgerMode, baselineTokens: number, actualTokens: number): void {
    this.telemetry.ledger_mode_usage[mode] += 1;
    this.telemetry.ledger_prompt_tokens_baseline += baselineTokens;
    this.telemetry.ledger_prompt_tokens_actual += actualTokens;
    this.telemetry.ledger_prompt_token_delta =
      this.telemetry.ledger_prompt_tokens_actual - this.telemetry.ledger_prompt_tokens_baseline;
  }

  private bumpSchemaErrorTelemetry(errorCode: DispatchContractErrorCode): void {
    this.telemetry.schema_error_counts[errorCode] += 1;
  }

  private bumpSchemaVersionTelemetry(schemaVersion: string): void {
    this.telemetry.schema_version_counts[schemaVersion] =
      (this.telemetry.schema_version_counts[schemaVersion] ?? 0) + 1;
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
      throw new DispatchRuntimeError(
        'run_not_initialized',
        `run_not_initialized: runId ${runId} is not initialized; call init_run first`
      );
    }

    const boundTaskId = snapshot.facts.find(fact => fact.k === 'task_id')?.v;
    if (!boundTaskId) {
      throw new DispatchRuntimeError(
        'run_not_initialized',
        `run_not_initialized: runId ${runId} is missing task binding; call init_run first`
      );
    }

    if (boundTaskId !== taskId) {
      throw new DispatchRuntimeError(
        'run_task_mismatch',
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
    registerDispatchContractSchemas(this.schemaRegistry);
  }
}

export interface DispatchRunIdFactory {
  create(specName: string, taskId: string): string;
}

export interface DispatchOutputResolver {
  resolve(args: {
    outputContent: unknown;
    outputFilePath: unknown;
    projectPath: string;
  }): Promise<string>;
}

export type DispatchFileContentCacheTelemetry = unknown;

export interface DispatchRuntimeHandlerDependencies {
  runtimeManager: DispatchRuntimeManager;
  runIdFactory: DispatchRunIdFactory;
  outputResolver: DispatchOutputResolver;
  fileContentCacheTelemetry: () => DispatchFileContentCacheTelemetry;
}

type DispatchToolErrorCode =
  | DispatchRuntimeErrorCode
  | DispatchContractErrorCode
  | 'progress_ledger_missing_tasks'
  | 'progress_ledger_parse_failed'
  | 'progress_ledger_incomplete';

function toDispatchToolErrorCode(error: unknown): DispatchToolErrorCode | null {
  if (error instanceof DispatchRuntimeError) {
    return error.code;
  }
  if (error instanceof DispatchContractError) {
    return error.code;
  }
  if (error instanceof DispatchLedgerError) {
    return error.code;
  }
  return null;
}

function failure(message: string, data?: Record<string, unknown>): ToolResponse {
  return { success: false, message, ...(data ? { data } : {}) };
}

type InitRunCommand = {
  action: 'init_run';
  runId: string;
  specName: string;
  taskId: string;
  projectPath: string;
};

type GetSnapshotCommand = {
  action: 'get_snapshot';
  runId: string;
};

type GetTelemetryCommand = {
  action: 'get_telemetry';
};

type CompilePromptCommand = {
  action: 'compile_prompt';
  runId: string;
  role: DispatchRole;
  taskId: string;
  projectPath: string;
  taskPrompt?: string;
  maxOutputTokens: number;
  compactionContext?: string[];
  compactionPromptOverride?: string;
  compactionAuto?: boolean;
};

type IngestOutputCommand = {
  action: 'ingest_output';
  runId: string;
  role: DispatchRole;
  taskId: string;
  outputContent: string;
  maxOutputTokens?: number;
};

type DispatchToolCommand =
  | InitRunCommand
  | GetSnapshotCommand
  | GetTelemetryCommand
  | CompilePromptCommand
  | IngestOutputCommand;

type DispatchCommandParseResult =
  | { ok: true; command: DispatchToolCommand }
  | { ok: false; response: ToolResponse };

function parseRunId(args: Record<string, unknown>): string {
  return String(args.runId || '').trim();
}

function parseRoleTask(
  action: DispatchAction,
  args: Record<string, unknown>,
): { ok: true; role: DispatchRole; taskId: string } | { ok: false; response: ToolResponse } {
  const roleRaw = String(args.role || '').trim();
  const taskId = String(args.taskId || '').trim();
  if (!isDispatchRole(roleRaw) || !taskId) {
    return {
      ok: false,
      response: failure(`${action} requires role (implementer|reviewer) and taskId`),
    };
  }
  return {
    ok: true,
    role: roleRaw,
    taskId,
  };
}

function parseCompactionAuto(value: unknown): { ok: true; value?: boolean } | { ok: false; response: ToolResponse } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value === 'boolean') {
    return { ok: true, value };
  }
  if (typeof value !== 'string') {
    return {
      ok: false,
      response: failure('compile_prompt compactionAuto must be boolean-like'),
    };
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return { ok: true, value: true };
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return { ok: true, value: false };
  }
  return {
    ok: false,
    response: failure('compile_prompt compactionAuto must be boolean-like'),
  };
}

async function parseInitRunCommand(
  args: Record<string, unknown>,
  context: ToolContext,
  dependencies: DispatchRuntimeHandlerDependencies,
): Promise<DispatchCommandParseResult> {
  const specName = String(args.specName || '').trim();
  const taskId = String(args.taskId || '').trim();
  if (!specName || !taskId) {
    return { ok: false, response: failure('init_run requires specName and taskId') };
  }

  const runId = parseRunId(args) || dependencies.runIdFactory.create(specName, taskId);
  return {
    ok: true,
    command: {
      action: 'init_run',
      runId,
      specName,
      taskId,
      projectPath: context.projectPath,
    },
  };
}

function parseGetSnapshotCommand(args: Record<string, unknown>): DispatchCommandParseResult {
  const runId = parseRunId(args);
  if (!runId) {
    return { ok: false, response: failure('get_snapshot requires runId') };
  }
  return {
    ok: true,
    command: {
      action: 'get_snapshot',
      runId,
    },
  };
}

async function parseCompilePromptCommand(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<DispatchCommandParseResult> {
  const runId = parseRunId(args);
  if (!runId) {
    return { ok: false, response: failure('compile_prompt requires runId') };
  }

  const roleTask = parseRoleTask('compile_prompt', args);
  if (!roleTask.ok) {
    return roleTask;
  }

  const maxOutputTokens = Number(args.maxOutputTokens ?? 1200);
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    return { ok: false, response: failure('compile_prompt requires positive maxOutputTokens') };
  }

  const compactionAuto = parseCompactionAuto(args.compactionAuto);
  if (!compactionAuto.ok) {
    return compactionAuto;
  }

  return {
    ok: true,
    command: {
      action: 'compile_prompt',
      runId,
      role: roleTask.role,
      taskId: roleTask.taskId,
      projectPath: context.projectPath,
      taskPrompt: typeof args.taskPrompt === 'string' ? args.taskPrompt.trim() : undefined,
      maxOutputTokens,
      compactionContext: Array.isArray(args.compactionContext)
        ? args.compactionContext
          .filter(item => typeof item === 'string')
          .map(item => item.trim())
          .filter(Boolean)
        : undefined,
      compactionPromptOverride: typeof args.compactionPromptOverride === 'string'
        ? args.compactionPromptOverride.trim()
        : undefined,
      compactionAuto: compactionAuto.value,
    },
  };
}

async function parseIngestOutputCommand(
  args: Record<string, unknown>,
  context: ToolContext,
  dependencies: DispatchRuntimeHandlerDependencies,
): Promise<DispatchCommandParseResult> {
  const runId = parseRunId(args);
  if (!runId) {
    return { ok: false, response: failure('ingest_output requires runId') };
  }

  const roleTask = parseRoleTask('ingest_output', args);
  if (!roleTask.ok) {
    return roleTask;
  }

  const outputContent = await dependencies.outputResolver.resolve({
    outputContent: args.outputContent,
    outputFilePath: args.outputFilePath,
    projectPath: context.projectPath,
  });
  if (!outputContent) {
    return { ok: false, response: failure('ingest_output requires outputContent or outputFilePath') };
  }

  const maxOutputTokens = args.maxOutputTokens === undefined
    ? undefined
    : Number(args.maxOutputTokens);
  if (args.maxOutputTokens !== undefined && (!Number.isFinite(maxOutputTokens) || (maxOutputTokens as number) <= 0)) {
    return { ok: false, response: failure('ingest_output maxOutputTokens must be a positive number') };
  }

  return {
    ok: true,
    command: {
      action: 'ingest_output',
      runId,
      role: roleTask.role,
      taskId: roleTask.taskId,
      outputContent,
      maxOutputTokens,
    },
  };
}

type DispatchCommandParser = (
  args: Record<string, unknown>,
  context: ToolContext,
  dependencies: DispatchRuntimeHandlerDependencies,
) => Promise<DispatchCommandParseResult>;

const DISPATCH_COMMAND_PARSERS: Record<DispatchAction, DispatchCommandParser> = {
  init_run: parseInitRunCommand,
  get_snapshot: async args => parseGetSnapshotCommand(args),
  get_telemetry: async () => ({
    ok: true,
    command: { action: 'get_telemetry' },
  }),
  compile_prompt: async (args, context) => parseCompilePromptCommand(args, context),
  ingest_output: parseIngestOutputCommand,
};

type DispatchCommandExecutor<K extends DispatchToolCommand['action']> = (
  command: Extract<DispatchToolCommand, { action: K }>,
  dependencies: DispatchRuntimeHandlerDependencies,
) => Promise<ToolResponse>;

type DispatchCommandExecutorMap = {
  [K in DispatchToolCommand['action']]: DispatchCommandExecutor<K>;
};

const DISPATCH_COMMAND_EXECUTORS: DispatchCommandExecutorMap = {
  async init_run(command, dependencies) {
    try {
      const snapshot = await dependencies.runtimeManager.initRun(
        command.runId,
        command.specName,
        command.taskId,
        command.projectPath
      );
      return {
        success: true,
        message: 'Dispatch runtime initialized',
        data: {
          runId: command.runId,
          snapshot,
          selected_provider: getFactValue(snapshot, DISPATCH_CLASSIFICATION_FACT_KEYS.selectedProvider),
          classification_level: getFactValue(snapshot, DISPATCH_CLASSIFICATION_FACT_KEYS.level),
          dispatch_cli: getFactValue(snapshot, DISPATCH_CLASSIFICATION_FACT_KEYS.dispatchCli),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = toDispatchToolErrorCode(error);
      return {
        success: false,
        message,
        data: {
          runId: command.runId,
          taskId: command.taskId,
          errorCode,
        },
      };
    }
  },

  async get_snapshot(command, dependencies) {
    const snapshot = await dependencies.runtimeManager.getSnapshot(command.runId);
    if (!snapshot) {
      return {
        success: false,
        message: `No snapshot found for runId: ${command.runId}`,
      };
    }
    return {
      success: true,
      message: 'Snapshot loaded',
      data: {
        runId: command.runId,
        snapshot,
      },
    };
  },

  async get_telemetry(_command, dependencies) {
    return {
      success: true,
      message: 'Dispatch runtime telemetry loaded',
      data: {
        ...dependencies.runtimeManager.getTelemetrySnapshot(),
        file_content_cache: dependencies.fileContentCacheTelemetry(),
      },
    };
  },

  async compile_prompt(command, dependencies) {
    try {
      const compiled = await dependencies.runtimeManager.compilePrompt({
        runId: command.runId,
        role: command.role,
        taskId: command.taskId,
        projectPath: command.projectPath,
        taskPrompt: command.taskPrompt,
        maxOutputTokens: command.maxOutputTokens,
        compactionContext: command.compactionContext,
        compactionPromptOverride: command.compactionPromptOverride,
        compactionAuto: command.compactionAuto,
      });
      return {
        success: true,
        message: 'Dispatch prompt compiled',
        data: {
          runId: command.runId,
          role: command.role,
          taskId: command.taskId,
          ...compiled,
          dispatch_cli: compiled.dispatchCli,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = toDispatchToolErrorCode(error);
      return {
        success: false,
        message,
        data: {
          runId: command.runId,
          role: command.role,
          taskId: command.taskId,
          errorCode,
        },
      };
    }
  },

  async ingest_output(command, dependencies) {
    try {
      const result = await dependencies.runtimeManager.ingestOutput({
        runId: command.runId,
        role: command.role,
        taskId: command.taskId,
        outputContent: command.outputContent,
        maxOutputTokens: command.maxOutputTokens,
      });

      return {
        success: true,
        message: 'Dispatch output ingested and validated',
        data: {
          runId: command.runId,
          role: command.role,
          nextAction: result.nextAction,
          result: result.result,
          snapshot: result.snapshot,
          outputTokens: result.outputTokens,
          telemetry: dependencies.runtimeManager.getTelemetrySnapshot(),
        },
        nextSteps: [
          `Follow next action: ${result.nextAction}`,
          'Use get_snapshot for latest runtime status before dispatching next agent call',
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof DispatchContractError) {
        const snapshot = await dependencies.runtimeManager.recordTerminalContractFailure({
          runId: command.runId,
          role: command.role,
          taskId: command.taskId,
          errorCode: error.code,
          errorMessage: message,
        });
        return {
          success: false,
          message,
          data: {
            runId: command.runId,
            role: command.role,
            taskId: command.taskId,
            errorCode: error.code,
            nextAction: 'halt_schema_invalid_terminal',
            snapshot,
            telemetry: dependencies.runtimeManager.getTelemetrySnapshot(),
          },
        };
      }

      const errorCode = toDispatchToolErrorCode(error);
      return {
        success: false,
        message,
        data: {
          runId: command.runId,
          role: command.role,
          taskId: command.taskId,
          errorCode,
        },
      };
    }
  },
};

async function parseDispatchCommand(
  args: Record<string, unknown>,
  context: ToolContext,
  dependencies: DispatchRuntimeHandlerDependencies,
): Promise<DispatchCommandParseResult> {
  const actionRaw = String(args.action || '').trim();
  if (!isDispatchAction(actionRaw)) {
    return {
      ok: false,
      response: failure('action must be one of: init_run, ingest_output, get_snapshot, compile_prompt, get_telemetry'),
    };
  }
  const parser = DISPATCH_COMMAND_PARSERS[actionRaw];
  return parser(args, context, dependencies);
}

async function executeDispatchCommand(
  command: DispatchToolCommand,
  dependencies: DispatchRuntimeHandlerDependencies,
): Promise<ToolResponse> {
  const executor = DISPATCH_COMMAND_EXECUTORS[command.action] as (
    command: DispatchToolCommand,
    dependencies: DispatchRuntimeHandlerDependencies,
  ) => Promise<ToolResponse>;
  return executor(command, dependencies);
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
        description: 'Optional compile_prompt override; defaults to ledger task prompt.',
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

export function createDispatchRuntimeHandler(
  dependencies: DispatchRuntimeHandlerDependencies,
): (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResponse> {
  return async (args: Record<string, unknown>, context: ToolContext): Promise<ToolResponse> => {
    const parsed = await parseDispatchCommand(args, context, dependencies);
    if (!parsed.ok) {
      return parsed.response;
    }
    return executeDispatchCommand(parsed.command, dependencies);
  };
}
