import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { resolve } from 'path';
import type { StateSnapshotFact } from '../../core/llm/index.js';
import { parseTasksFromMarkdown } from '../../core/workflow/task-parser.js';

export type LedgerMode = 'ledger_only';

export interface SourceFingerprint {
  mtimeMs: number;
  hash: string;
}

export interface ProgressLedgerTask {
  id: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed';
  prompt?: string;
  requirements?: string[];
}

export interface ProgressLedger {
  specName: string;
  taskId: string;
  sourcePath: string;
  sourceFingerprint: SourceFingerprint;
  totals: {
    total: number;
    completed: number;
    inProgress: number;
    pending: number;
  };
  activeTaskId: string | null;
  currentTask?: ProgressLedgerTask;
}

export interface TaskLedgerIssue {
  severity: 'critical' | 'important' | 'minor';
  message: string;
  file?: string;
}

export interface TaskLedger {
  runId: string;
  taskId: string;
  planVersion: number;
  summary?: string;
  reviewerAssessment?: 'approved' | 'needs_changes' | 'blocked';
  reviewerIssues: TaskLedgerIssue[];
  blockers: string[];
  requiredFixes: string[];
  stalled: {
    consecutiveNonProgress: number;
    threshold: number;
    flagged: boolean;
  };
  replanHint?: string;
}

export interface StalledProgressState {
  consecutiveNonProgress: number;
  threshold: number;
  flagged: boolean;
}

export const DISPATCH_LEDGER_FACT_KEYS = {
  taskSummary: 'ledger.task.summary',
  taskReviewerAssessment: 'ledger.task.reviewer_assessment',
  taskReviewerIssues: 'ledger.task.reviewer_issues',
  taskBlockers: 'ledger.task.blockers',
  taskRequiredFixes: 'ledger.task.required_fixes',
  taskStalledCount: 'ledger.task.stalled_count',
  taskStalledThreshold: 'ledger.task.stalled_threshold',
  taskStalledFlagged: 'ledger.task.stalled_flagged',
  taskReplanHint: 'ledger.task.replan_hint',
  taskPlanVersion: 'ledger.task.plan_version',
  progressActiveTaskId: 'ledger.progress.active_task_id',
  progressTotals: 'ledger.progress.totals',
  progressSourceFingerprint: 'ledger.progress.source_fingerprint',
  progressSourcePath: 'ledger.progress.source_path',
  progressCurrentTask: 'ledger.progress.current_task',
  progressSpecName: 'ledger.progress.spec_name',
  progressTaskId: 'ledger.progress.task_id',
} as const;

export type ProgressLedgerErrorCode =
  | 'progress_ledger_missing_tasks'
  | 'progress_ledger_parse_failed'
  | 'progress_ledger_incomplete';

export class DispatchLedgerError extends Error {
  constructor(
    public readonly code: ProgressLedgerErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'DispatchLedgerError';
  }
}

export function resolveTasksFilePath(projectPath: string, specName: string): string {
  return resolve(projectPath, '.spec-context', 'specs', specName, 'tasks.md');
}

function parseJsonValue<T>(value: string | undefined): T | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function parseNumberValue(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return parsed;
}

function parseBooleanValue(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  return value.trim().toLowerCase() === 'true';
}

function hashText(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    deduped.push(trimmed);
  }
  return deduped;
}

export async function extractProgressLedger(args: {
  specName: string;
  taskId: string;
  sourcePath: string;
}): Promise<ProgressLedger> {
  let content: string;
  let mtimeMs: number;
  try {
    const stat = await fs.stat(args.sourcePath);
    mtimeMs = stat.mtimeMs;
    content = await fs.readFile(args.sourcePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DispatchLedgerError('progress_ledger_missing_tasks', `tasks.md not found at ${args.sourcePath}`);
    }
    throw error;
  }

  const parsed = parseTasksFromMarkdown(content);
  if (parsed.tasks.length === 0) {
    throw new DispatchLedgerError(
      'progress_ledger_parse_failed',
      `No parseable tasks with status markers in ${args.sourcePath}`
    );
  }

  const canonicalTask = parsed.tasks.find(task => task.id === args.taskId);
  const activeTask = parsed.tasks.find(task => task.id === parsed.inProgressTask);
  const currentTask = canonicalTask ?? activeTask;

  return {
    specName: args.specName,
    taskId: args.taskId,
    sourcePath: args.sourcePath,
    sourceFingerprint: {
      mtimeMs,
      hash: hashText(content),
    },
    totals: {
      total: parsed.summary.total,
      completed: parsed.summary.completed,
      inProgress: parsed.summary.inProgress,
      pending: parsed.summary.pending,
    },
    activeTaskId: parsed.inProgressTask,
    ...(currentTask
      ? {
        currentTask: {
          id: currentTask.id,
          description: currentTask.description,
          status: currentTask.status,
          ...(currentTask.prompt ? { prompt: currentTask.prompt } : {}),
          ...(currentTask.requirements ? { requirements: currentTask.requirements } : {}),
        },
      }
      : {}),
  };
}

export function progressLedgerToFacts(ledger: ProgressLedger): StateSnapshotFact[] {
  return [
    { k: DISPATCH_LEDGER_FACT_KEYS.progressSpecName, v: ledger.specName, confidence: 1 },
    { k: DISPATCH_LEDGER_FACT_KEYS.progressTaskId, v: ledger.taskId, confidence: 1 },
    { k: DISPATCH_LEDGER_FACT_KEYS.progressSourcePath, v: ledger.sourcePath, confidence: 1 },
    {
      k: DISPATCH_LEDGER_FACT_KEYS.progressSourceFingerprint,
      v: JSON.stringify(ledger.sourceFingerprint),
      confidence: 1,
    },
    {
      k: DISPATCH_LEDGER_FACT_KEYS.progressTotals,
      v: JSON.stringify(ledger.totals),
      confidence: 1,
    },
    {
      k: DISPATCH_LEDGER_FACT_KEYS.progressActiveTaskId,
      v: ledger.activeTaskId ?? '',
      confidence: 1,
    },
    ...(ledger.currentTask
      ? [{
        k: DISPATCH_LEDGER_FACT_KEYS.progressCurrentTask,
        v: JSON.stringify(ledger.currentTask),
        confidence: 0.95,
      }]
      : []),
  ];
}

export function progressLedgerFromFacts(facts: StateSnapshotFact[]): ProgressLedger | null {
  const factMap = new Map(facts.map(fact => [fact.k, fact.v]));
  const specName = factMap.get(DISPATCH_LEDGER_FACT_KEYS.progressSpecName);
  const taskId = factMap.get(DISPATCH_LEDGER_FACT_KEYS.progressTaskId);
  const sourcePath = factMap.get(DISPATCH_LEDGER_FACT_KEYS.progressSourcePath);
  const sourceFingerprint = parseJsonValue<SourceFingerprint>(
    factMap.get(DISPATCH_LEDGER_FACT_KEYS.progressSourceFingerprint)
  );
  const totals = parseJsonValue<ProgressLedger['totals']>(factMap.get(DISPATCH_LEDGER_FACT_KEYS.progressTotals));
  const currentTask = parseJsonValue<ProgressLedgerTask>(factMap.get(DISPATCH_LEDGER_FACT_KEYS.progressCurrentTask));

  if (!specName || !taskId || !sourcePath || !sourceFingerprint || !totals) {
    return null;
  }

  return {
    specName,
    taskId,
    sourcePath,
    sourceFingerprint,
    totals,
    activeTaskId: factMap.get(DISPATCH_LEDGER_FACT_KEYS.progressActiveTaskId) || null,
    ...(currentTask ? { currentTask } : {}),
  };
}

export async function isProgressLedgerStale(progressLedger: ProgressLedger): Promise<boolean> {
  try {
    const stat = await fs.stat(progressLedger.sourcePath);
    if (stat.mtimeMs !== progressLedger.sourceFingerprint.mtimeMs) {
      return true;
    }
    const content = await fs.readFile(progressLedger.sourcePath, 'utf8');
    return hashText(content) !== progressLedger.sourceFingerprint.hash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

export function taskLedgerFromFacts(args: {
  runId: string;
  taskId: string;
  facts: StateSnapshotFact[];
  stalledThreshold: number;
}): TaskLedger {
  const factMap = new Map(args.facts.map(fact => [fact.k, fact.v]));
  return {
    runId: args.runId,
    taskId: args.taskId,
    planVersion: parseNumberValue(factMap.get(DISPATCH_LEDGER_FACT_KEYS.taskPlanVersion), 1),
    summary: factMap.get(DISPATCH_LEDGER_FACT_KEYS.taskSummary) ?? undefined,
    reviewerAssessment: factMap.get(DISPATCH_LEDGER_FACT_KEYS.taskReviewerAssessment) as
      | TaskLedger['reviewerAssessment']
      | undefined,
    reviewerIssues: parseJsonValue<TaskLedgerIssue[]>(factMap.get(DISPATCH_LEDGER_FACT_KEYS.taskReviewerIssues)) ?? [],
    blockers: parseJsonValue<string[]>(factMap.get(DISPATCH_LEDGER_FACT_KEYS.taskBlockers)) ?? [],
    requiredFixes: parseJsonValue<string[]>(factMap.get(DISPATCH_LEDGER_FACT_KEYS.taskRequiredFixes)) ?? [],
    stalled: {
      consecutiveNonProgress: parseNumberValue(factMap.get(DISPATCH_LEDGER_FACT_KEYS.taskStalledCount), 0),
      threshold: parseNumberValue(
        factMap.get(DISPATCH_LEDGER_FACT_KEYS.taskStalledThreshold),
        args.stalledThreshold
      ),
      flagged: parseBooleanValue(factMap.get(DISPATCH_LEDGER_FACT_KEYS.taskStalledFlagged), false),
    },
    replanHint: factMap.get(DISPATCH_LEDGER_FACT_KEYS.taskReplanHint) || undefined,
  };
}

export function taskLedgerToFacts(taskLedger: TaskLedger): StateSnapshotFact[] {
  const facts: StateSnapshotFact[] = [
    { k: DISPATCH_LEDGER_FACT_KEYS.taskPlanVersion, v: String(taskLedger.planVersion), confidence: 1 },
    {
      k: DISPATCH_LEDGER_FACT_KEYS.taskStalledCount,
      v: String(taskLedger.stalled.consecutiveNonProgress),
      confidence: 1,
    },
    {
      k: DISPATCH_LEDGER_FACT_KEYS.taskStalledThreshold,
      v: String(taskLedger.stalled.threshold),
      confidence: 1,
    },
    {
      k: DISPATCH_LEDGER_FACT_KEYS.taskStalledFlagged,
      v: String(taskLedger.stalled.flagged),
      confidence: 1,
    },
    {
      k: DISPATCH_LEDGER_FACT_KEYS.taskReviewerIssues,
      v: JSON.stringify(taskLedger.reviewerIssues),
      confidence: 0.95,
    },
    {
      k: DISPATCH_LEDGER_FACT_KEYS.taskBlockers,
      v: JSON.stringify(taskLedger.blockers),
      confidence: 0.95,
    },
    {
      k: DISPATCH_LEDGER_FACT_KEYS.taskRequiredFixes,
      v: JSON.stringify(taskLedger.requiredFixes),
      confidence: 0.95,
    },
  ];

  if (taskLedger.summary) {
    facts.push({ k: DISPATCH_LEDGER_FACT_KEYS.taskSummary, v: taskLedger.summary, confidence: 0.95 });
  }
  if (taskLedger.reviewerAssessment) {
    facts.push({
      k: DISPATCH_LEDGER_FACT_KEYS.taskReviewerAssessment,
      v: taskLedger.reviewerAssessment,
      confidence: 1,
    });
  }
  if (taskLedger.replanHint) {
    facts.push({
      k: DISPATCH_LEDGER_FACT_KEYS.taskReplanHint,
      v: taskLedger.replanHint,
      confidence: 0.9,
    });
  }

  return facts;
}

export interface ImplementerLedgerOutcome {
  role: 'implementer';
  status: 'completed' | 'blocked' | 'failed';
  summary: string;
  followUpActions: string[];
}

export interface ReviewerLedgerOutcome {
  role: 'reviewer';
  assessment: 'approved' | 'needs_changes' | 'blocked';
  issues: TaskLedgerIssue[];
  requiredFixes: string[];
}

export type TaskLedgerOutcome = ImplementerLedgerOutcome | ReviewerLedgerOutcome;

export function updateStalledProgressState(
  previous: StalledProgressState,
  signal: 'progress' | 'non_progress' | 'neutral'
): StalledProgressState {
  if (signal === 'progress') {
    return {
      ...previous,
      consecutiveNonProgress: 0,
      flagged: false,
    };
  }
  if (signal === 'neutral') {
    return previous;
  }

  const nextCount = previous.consecutiveNonProgress + 1;
  return {
    ...previous,
    consecutiveNonProgress: nextCount,
    flagged: nextCount >= previous.threshold,
  };
}

function stalledSignalFromOutcome(outcome: TaskLedgerOutcome): 'progress' | 'non_progress' | 'neutral' {
  if (outcome.role === 'implementer') {
    return outcome.status === 'completed' ? 'progress' : 'non_progress';
  }
  if (outcome.assessment === 'approved') {
    return 'progress';
  }
  if (outcome.assessment === 'blocked') {
    return 'non_progress';
  }
  return 'neutral';
}

function buildReplanHint(stalledCount: number, threshold: number): string {
  return `Stalled after ${stalledCount} non-progress outcomes (threshold=${threshold}); split the task, relax constraints, or resolve missing dependencies before redispatch.`;
}

export function applyOutcomeToTaskLedger(
  currentLedger: TaskLedger,
  outcome: TaskLedgerOutcome
): TaskLedger {
  const nextLedger: TaskLedger = {
    ...currentLedger,
    planVersion: currentLedger.planVersion + 1,
    reviewerIssues: [...currentLedger.reviewerIssues],
    blockers: [...currentLedger.blockers],
    requiredFixes: [...currentLedger.requiredFixes],
    stalled: { ...currentLedger.stalled },
  };

  if (outcome.role === 'implementer') {
    nextLedger.summary = outcome.summary;
    if (outcome.status === 'completed') {
      nextLedger.blockers = [];
    } else {
      nextLedger.blockers = dedupeStrings([...nextLedger.blockers, ...outcome.followUpActions]);
    }
  } else {
    nextLedger.reviewerAssessment = outcome.assessment;
    nextLedger.reviewerIssues = [...outcome.issues];
    nextLedger.requiredFixes = dedupeStrings([...outcome.requiredFixes]);
    if (outcome.assessment === 'approved') {
      nextLedger.blockers = [];
      nextLedger.requiredFixes = [];
    } else if (outcome.assessment === 'blocked') {
      nextLedger.blockers = dedupeStrings([...nextLedger.blockers, ...outcome.requiredFixes]);
    }
  }

  const stalledSignal = stalledSignalFromOutcome(outcome);
  const stalledBefore = nextLedger.stalled;
  const stalledAfter = updateStalledProgressState(stalledBefore, stalledSignal);
  nextLedger.stalled = stalledAfter;

  if (stalledSignal === 'progress') {
    nextLedger.replanHint = undefined;
  } else if (stalledAfter.flagged && (!stalledBefore.flagged || !nextLedger.replanHint)) {
    nextLedger.replanHint = buildReplanHint(stalledAfter.consecutiveNonProgress, stalledAfter.threshold);
  }

  return nextLedger;
}

export function buildLedgerTaskPrompt(progressLedger: ProgressLedger | null): {
  prompt: string;
  missing: string[];
} {
  if (!progressLedger?.currentTask) {
    return { prompt: '', missing: ['missing_current_task'] };
  }

  const currentTask = progressLedger.currentTask;
  const missing: string[] = [];
  const sections = [
    'Use the loaded implementer/reviewer guide for global process rules; this section is task-specific context only.',
    `Task ${currentTask.id}: ${currentTask.description}`,
    `Task status: ${currentTask.status}`,
  ];

  if (currentTask.prompt?.trim()) {
    sections.push(`Task prompt:\n${currentTask.prompt.trim()}`);
  } else {
    missing.push('missing_task_prompt');
  }

  if (currentTask.requirements?.length) {
    sections.push(`Task requirements: ${currentTask.requirements.join(', ')}`);
  }

  return {
    prompt: sections.join('\n\n'),
    missing,
  };
}

export function buildLedgerDeltaPacket(args: {
  taskId: string;
  guideMode: 'full' | 'compact';
  guideCacheKey: string;
  taskLedger: TaskLedger;
  progressLedger: ProgressLedger;
}): Record<string, unknown> {
  return {
    task_id: args.taskId,
    guide_mode: args.guideMode,
    guide_cache_key: args.guideCacheKey,
    ledger_active_task_id: args.progressLedger.activeTaskId,
    ledger_task_totals: args.progressLedger.totals,
    ledger_summary: args.taskLedger.summary ?? null,
    ledger_reviewer_assessment: args.taskLedger.reviewerAssessment ?? null,
    ledger_reviewer_issue_count: args.taskLedger.reviewerIssues.length,
    ledger_required_fixes: args.taskLedger.requiredFixes,
    ledger_blockers: args.taskLedger.blockers,
    ledger_stalled_count: args.taskLedger.stalled.consecutiveNonProgress,
    ledger_stalled_flagged: args.taskLedger.stalled.flagged,
    ledger_replan_hint: args.taskLedger.replanHint ?? null,
  };
}

export function assertCompleteProgressLedger(progressLedger: ProgressLedger | null): ProgressLedger {
  if (!progressLedger) {
    throw new DispatchLedgerError('progress_ledger_incomplete', 'Missing progress ledger facts in snapshot');
  }
  if (!progressLedger.currentTask) {
    throw new DispatchLedgerError('progress_ledger_incomplete', 'Progress ledger missing current task details');
  }
  return progressLedger;
}
