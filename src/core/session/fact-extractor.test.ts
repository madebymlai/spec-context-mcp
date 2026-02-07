import { describe, expect, it, vi } from 'vitest';
import type { ImplementerResult, ReviewerResult } from '../../tools/workflow/dispatch-contract-schemas.js';
import { RuleBasedFactExtractor } from './fact-extractor.js';

describe('RuleBasedFactExtractor', () => {
  it('extracts deterministic facts from implementer results', () => {
    const extractor = new RuleBasedFactExtractor();
    const result: ImplementerResult = {
      task_id: '1',
      status: 'completed',
      summary: 'Implemented session fact tracking for dispatch runtime.',
      files_changed: ['src/core/session/types.ts', 'src/core/session/fact-extractor.ts'],
      tests: [{ command: 'npm test -- src/core/session --run', passed: true }],
      follow_up_actions: ['Run integration tests', 'Update documentation'],
    };

    const facts = extractor.extractFromImplementer(result, '1');

    expect(facts).toHaveLength(6);
    expect(facts.every(fact => fact.sourceRole === 'implementer')).toBe(true);
    expect(facts.find(fact => fact.relation === 'completed_with')?.object).toBe('completed');
    expect(facts.filter(fact => fact.relation === 'modified_by').map(fact => fact.subject))
      .toEqual(result.files_changed);
    expect(facts.filter(fact => fact.relation === 'requires')).toHaveLength(2);
  });

  it('extracts reviewer assessment, issues, required fixes, and convention references', () => {
    const extractor = new RuleBasedFactExtractor();
    const result: ReviewerResult = {
      task_id: '2',
      assessment: 'needs_changes',
      strengths: ['Clear architecture'],
      issues: [
        {
          severity: 'important',
          file: 'src/core/session/fact-extractor.ts',
          message: 'Naming convention mismatch in relation labels',
          fix: 'Apply naming convention used in existing reducers',
        },
        {
          severity: 'minor',
          message: 'Add an additional test for clipping behavior',
          fix: 'Extend extractor tests',
        },
      ],
      required_fixes: ['Use stable naming conventions for extracted relations'],
    };

    const facts = extractor.extractFromReviewer(result, '2');

    expect(facts).toHaveLength(5);
    expect(facts.every(fact => fact.sourceRole === 'reviewer')).toBe(true);
    expect(facts.find(fact => fact.relation === 'reviewed_as')?.object).toBe('needs_changes');
    expect(facts.filter(fact => fact.relation === 'issue')).toHaveLength(2);
    expect(facts.filter(fact => fact.relation === 'must_fix')).toHaveLength(1);
    expect(facts.filter(fact => fact.relation === 'convention')).toHaveLength(1);
  });

  it('skips malformed optional arrays without throwing', () => {
    const extractor = new RuleBasedFactExtractor();
    const malformed = {
      task_id: '3',
      status: 'blocked',
      summary: 'Waiting on dependency',
      files_changed: 'src/core/session/a.ts',
      tests: [],
      follow_up_actions: null,
    } as unknown as ImplementerResult;

    const facts = extractor.extractFromImplementer(malformed, '3');

    expect(facts.find(fact => fact.relation === 'completed_with')?.object).toBe('blocked');
    expect(facts.find(fact => fact.relation === 'summary')).toBeTruthy();
    expect(facts.find(fact => fact.relation === 'modified_by')).toBeUndefined();
    expect(facts.find(fact => fact.relation === 'requires')).toBeUndefined();
  });

  it('continues rule execution when one rule throws', () => {
    const extractor = new RuleBasedFactExtractor();
    const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const throwingResult: any = {
      task_id: '4',
      status: 'completed',
      files_changed: ['src/a.ts'],
      tests: [],
      follow_up_actions: ['Run checks'],
    };
    Object.defineProperty(throwingResult, 'summary', {
      enumerable: true,
      get: () => {
        throw new Error('broken summary field');
      },
    });

    const facts = extractor.extractFromImplementer(throwingResult as ImplementerResult, '4');

    expect(facts.find(fact => fact.relation === 'completed_with')).toBeTruthy();
    expect(facts.find(fact => fact.relation === 'summary')).toBeUndefined();
    expect(facts.find(fact => fact.relation === 'modified_by')).toBeTruthy();
    expect(facts.find(fact => fact.relation === 'requires')).toBeTruthy();
    expect(warningSpy).toHaveBeenCalledTimes(1);

    warningSpy.mockRestore();
  });
});
