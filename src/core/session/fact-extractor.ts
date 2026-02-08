import type { ImplementerResult, ReviewerResult } from '../../tools/workflow/dispatch-contract-schemas.js';
import { createFactId, IFactExtractor, SessionFact, SessionFactTag } from './types.js';

type ImplementerExtractionRule = (result: ImplementerResult, taskId: string) => SessionFact[];
type ReviewerExtractionRule = (result: ReviewerResult, taskId: string) => SessionFact[];

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

function createSessionFact(input: {
  subject: string;
  relation: string;
  object: string;
  tag: SessionFactTag;
  sourceTaskId: string;
  sourceRole: 'implementer' | 'reviewer';
}): SessionFact {
  return {
    id: createFactId(input.subject, input.relation, input.object),
    subject: input.subject,
    relation: input.relation,
    object: input.object,
    tags: [input.tag],
    validFrom: new Date(),
    validTo: undefined,
    sourceTaskId: input.sourceTaskId,
    sourceRole: input.sourceRole,
    confidence: 1,
  };
}

function hasConventionReference(issue: { message: string; fix: string }): boolean {
  return /(convention|pattern|naming|style|camelCase|snake_case|pascalcase|format)/i
    .test(`${issue.message} ${issue.fix}`);
}

const implementerRules: ReadonlyArray<ImplementerExtractionRule> = [
  (result, taskId) => [
    createSessionFact({
      subject: `task:${taskId}`,
      relation: 'completed_with',
      object: result.status,
      tag: 'decision',
      sourceTaskId: taskId,
      sourceRole: 'implementer',
    }),
  ],
  (result, taskId) => [
    createSessionFact({
      subject: `task:${taskId}`,
      relation: 'summary',
      object: clipText(result.summary, 120),
      tag: 'decision',
      sourceTaskId: taskId,
      sourceRole: 'implementer',
    }),
  ],
  (result, taskId) => {
    if (!Array.isArray(result.files_changed)) {
      return [];
    }
    return result.files_changed
      .filter((file): file is string => typeof file === 'string' && file.length > 0)
      .map(file => createSessionFact({
        subject: file,
        relation: 'modified_by',
        object: `task:${taskId}`,
        tag: 'file_change',
        sourceTaskId: taskId,
        sourceRole: 'implementer',
      }));
  },
  (result, taskId) => {
    if (!Array.isArray(result.follow_up_actions)) {
      return [];
    }
    return result.follow_up_actions
      .filter((action): action is string => typeof action === 'string' && action.length > 0)
      .map(action => createSessionFact({
        subject: `task:${taskId}`,
        relation: 'requires',
        object: clipText(action, 120),
        tag: 'dependency',
        sourceTaskId: taskId,
        sourceRole: 'implementer',
      }));
  },
];

const reviewerRules: ReadonlyArray<ReviewerExtractionRule> = [
  (result, taskId) => [
    createSessionFact({
      subject: `task:${taskId}`,
      relation: 'reviewed_as',
      object: result.assessment,
      tag: 'decision',
      sourceTaskId: taskId,
      sourceRole: 'reviewer',
    }),
  ],
  (result, taskId) => {
    if (!Array.isArray(result.issues)) {
      return [];
    }
    return result.issues.map(issue => createSessionFact({
      subject: issue.file ?? `task:${taskId}`,
      relation: 'issue',
      object: clipText(issue.message, 120),
      tag: 'error',
      sourceTaskId: taskId,
      sourceRole: 'reviewer',
    }));
  },
  (result, taskId) => {
    if (!Array.isArray(result.required_fixes)) {
      return [];
    }
    return result.required_fixes
      .filter((fix): fix is string => typeof fix === 'string' && fix.length > 0)
      .map(fix => createSessionFact({
        subject: `task:${taskId}`,
        relation: 'must_fix',
        object: clipText(fix, 120),
        tag: 'convention',
        sourceTaskId: taskId,
        sourceRole: 'reviewer',
      }));
  },
  (result, taskId) => {
    if (!Array.isArray(result.issues)) {
      return [];
    }
    return result.issues
      .filter(issue => hasConventionReference(issue))
      .map(issue => createSessionFact({
        subject: issue.file ?? `task:${taskId}`,
        relation: 'convention',
        object: clipText(issue.message, 120),
        tag: 'convention',
        sourceTaskId: taskId,
        sourceRole: 'reviewer',
      }));
  },
];

export class RuleBasedFactExtractor implements IFactExtractor {
  extractFromImplementer(result: ImplementerResult, taskId: string): SessionFact[] {
    return this.executeImplementerRules(result, taskId);
  }

  extractFromReviewer(result: ReviewerResult, taskId: string): SessionFact[] {
    return this.executeReviewerRules(result, taskId);
  }

  private executeImplementerRules(result: ImplementerResult, taskId: string): SessionFact[] {
    const facts: SessionFact[] = [];
    for (const rule of implementerRules) {
      try {
        facts.push(...rule(result, taskId));
      } catch (error) {
        console.warn('[session-fact-extractor] implementer rule failed', error);
      }
    }
    return facts;
  }

  private executeReviewerRules(result: ReviewerResult, taskId: string): SessionFact[] {
    const facts: SessionFact[] = [];
    for (const rule of reviewerRules) {
      try {
        facts.push(...rule(result, taskId));
      } catch (error) {
        console.warn('[session-fact-extractor] reviewer rule failed', error);
      }
    }
    return facts;
  }
}
