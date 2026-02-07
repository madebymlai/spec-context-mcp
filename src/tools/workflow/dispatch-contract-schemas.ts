interface JsonSchemaObject {
  type: 'object';
  additionalProperties: boolean;
  required: string[];
  properties: Record<string, unknown>;
}

export const DISPATCH_CONTRACT_SCHEMA_VERSION = 'v1';

export const DISPATCH_IMPLEMENTER_SCHEMA_ID = 'dispatch_result_implementer';
export const DISPATCH_REVIEWER_SCHEMA_ID = 'dispatch_result_reviewer';

export interface ImplementerResult {
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

export interface ReviewerIssue {
  severity: 'critical' | 'important' | 'minor';
  file?: string;
  message: string;
  fix: string;
}

export interface ReviewerResult {
  task_id: string;
  assessment: 'approved' | 'needs_changes' | 'blocked';
  strengths: string[];
  issues: ReviewerIssue[];
  required_fixes: string[];
}

export const DISPATCH_IMPLEMENTER_SCHEMA: JsonSchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['task_id', 'status', 'summary', 'files_changed', 'tests', 'follow_up_actions'],
  properties: {
    task_id: { type: 'string' },
    status: {
      type: 'string',
      enum: ['completed', 'blocked', 'failed'],
    },
    summary: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    tests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'passed'],
        properties: {
          command: { type: 'string' },
          passed: { type: 'boolean' },
          failures: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    follow_up_actions: { type: 'array', items: { type: 'string' } },
  },
};

export const DISPATCH_REVIEWER_SCHEMA: JsonSchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['task_id', 'assessment', 'strengths', 'issues', 'required_fixes'],
  properties: {
    task_id: { type: 'string' },
    assessment: {
      type: 'string',
      enum: ['approved', 'needs_changes', 'blocked'],
    },
    strengths: { type: 'array', items: { type: 'string' } },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'message', 'fix'],
        properties: {
          severity: {
            type: 'string',
            enum: ['critical', 'important', 'minor'],
          },
          file: { type: 'string' },
          message: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
    required_fixes: { type: 'array', items: { type: 'string' } },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

export function isImplementerResult(value: unknown): value is ImplementerResult {
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

export function isReviewerIssue(value: unknown): value is ReviewerIssue {
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

export function isReviewerResult(value: unknown): value is ReviewerResult {
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

