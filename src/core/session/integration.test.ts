import { describe, expect, it } from 'vitest';
import type { ImplementerResult, ReviewerResult } from '../../tools/workflow/dispatch-contract-schemas.js';
import {
  InMemorySessionFactStore,
  KeywordFactRetriever,
  RuleBasedFactExtractor,
  formatSessionFacts,
} from './index.js';

function estimateTokens(subject: string, relation: string, object: string): number {
  return Math.ceil(`${subject}${relation}${object}`.length / 4);
}

describe('session fact tracker integration', () => {
  it('first task in session produces no session context', () => {
    const store = new InMemorySessionFactStore();
    const retriever = new KeywordFactRetriever(store);

    const facts = retriever.retrieve({
      taskDescription: 'implement session fact tracker',
      taskId: '1',
      tags: undefined,
      maxFacts: 10,
      maxTokens: 500,
    });
    const context = formatSessionFacts(facts);

    expect(facts).toEqual([]);
    expect(context).toBe('');
  });

  it('facts from task 1 appear in task 2 prompt', () => {
    const store = new InMemorySessionFactStore();
    const extractor = new RuleBasedFactExtractor();
    const retriever = new KeywordFactRetriever(store);

    const task1Result: ImplementerResult = {
      task_id: '1',
      status: 'completed',
      summary: 'Implemented session types and store for src/core/session/fact-retriever.ts',
      files_changed: ['src/core/session/fact-retriever.ts', 'src/core/session/types.ts'],
      tests: [{ command: 'npm test -- src/core/session --run', passed: true }],
      follow_up_actions: ['Add integration tests'],
    };
    store.add(extractor.extractFromImplementer(task1Result, '1'));

    const facts = retriever.retrieve({
      taskDescription: 'update retrieval in src/core/session/fact-retriever.ts',
      taskId: '2',
      tags: undefined,
      maxFacts: 10,
      maxTokens: 500,
    });
    const context = formatSessionFacts(facts);

    expect(facts.some(fact => fact.subject === 'src/core/session/fact-retriever.ts')).toBe(true);
    expect(context).toContain('[Session Context]');
    expect(context).toContain('src/core/session/fact-retriever.ts modified_by task:1 [task:1]');
  });

  it('reviewer conventions persist across tasks', () => {
    const store = new InMemorySessionFactStore();
    const extractor = new RuleBasedFactExtractor();
    const retriever = new KeywordFactRetriever(store);

    const task2Review: ReviewerResult = {
      task_id: '2',
      assessment: 'needs_changes',
      strengths: ['Clear extraction logic'],
      issues: [
        {
          severity: 'important',
          file: 'src/core/session/fact-extractor.ts',
          message: 'Follow naming convention for relation labels',
          fix: 'Use convention-aligned relation names',
        },
      ],
      required_fixes: ['Apply naming conventions for reviewer-extracted facts'],
    };
    store.add(extractor.extractFromReviewer(task2Review, '2'));

    const facts = retriever.retrieve({
      taskDescription: 'task 4 must enforce naming conventions in extractor',
      taskId: '4',
      tags: ['convention'],
      maxFacts: 10,
      maxTokens: 500,
    });

    expect(facts.length).toBeGreaterThan(0);
    expect(facts.some(fact => fact.relation === 'must_fix')).toBe(true);
    expect(facts.every(fact => fact.tags.includes('convention'))).toBe(true);
  });

  it('temporal invalidation excludes old facts', () => {
    const store = new InMemorySessionFactStore();
    const extractor = new RuleBasedFactExtractor();
    const retriever = new KeywordFactRetriever(store);

    const task1: ImplementerResult = {
      task_id: '1',
      status: 'completed',
      summary: 'First update',
      files_changed: ['src/shared/file.ts'],
      tests: [{ command: 'npm test -- file --run', passed: true }],
      follow_up_actions: [],
    };
    const task3: ImplementerResult = {
      task_id: '3',
      status: 'completed',
      summary: 'Second update',
      files_changed: ['src/shared/file.ts'],
      tests: [{ command: 'npm test -- file --run', passed: true }],
      follow_up_actions: [],
    };
    store.add(extractor.extractFromImplementer(task1, '1'));
    store.add(extractor.extractFromImplementer(task3, '3'));

    const facts = retriever.retrieve({
      taskDescription: 'work on src/shared/file.ts',
      taskId: '4',
      tags: ['file_change'],
      maxFacts: 10,
      maxTokens: 500,
    });

    expect(facts).toHaveLength(1);
    expect(facts[0].subject).toBe('src/shared/file.ts');
    expect(facts[0].sourceTaskId).toBe('3');
  });

  it('self-exclusion works', () => {
    const store = new InMemorySessionFactStore();
    const extractor = new RuleBasedFactExtractor();
    const retriever = new KeywordFactRetriever(store);

    const result: ImplementerResult = {
      task_id: '5',
      status: 'completed',
      summary: 'Implemented task 5',
      files_changed: ['src/task5.ts'],
      tests: [{ command: 'npm test -- task5 --run', passed: true }],
      follow_up_actions: ['Review task 5 output'],
    };
    store.add(extractor.extractFromImplementer(result, '5'));

    const facts = retriever.retrieve({
      taskDescription: 'continue task 5',
      taskId: '5',
      tags: undefined,
      maxFacts: 10,
      maxTokens: 500,
    });

    expect(facts).toEqual([]);
  });

  it('compaction preserves recent facts', () => {
    const store = new InMemorySessionFactStore(1000);
    const extractor = new RuleBasedFactExtractor();

    for (let index = 1; index <= 600; index += 1) {
      const taskId = String(index);
      const result: ImplementerResult = {
        task_id: taskId,
        status: 'completed',
        summary: `Completed task ${taskId}`,
        files_changed: [`src/file-${taskId}.ts`],
        tests: [{ command: `npm test -- file-${taskId} --run`, passed: true }],
        follow_up_actions: [],
      };
      store.add(extractor.extractFromImplementer(result, taskId));
    }

    store.compact(500);
    const valid = store.getValid();
    const taskIds = new Set(valid.map(fact => fact.sourceTaskId));

    expect(store.count()).toBe(500);
    expect(taskIds.has('600')).toBe(true);
    expect(taskIds.has('1')).toBe(false);
  });

  it('token budget truncation limits retrieved facts', () => {
    const store = new InMemorySessionFactStore();
    const extractor = new RuleBasedFactExtractor();
    const retriever = new KeywordFactRetriever(store);

    for (let index = 1; index <= 50; index += 1) {
      const taskId = String(index);
      const result: ImplementerResult = {
        task_id: taskId,
        status: 'completed',
        summary: `Retriever token budget sample ${index} with long detail text for scoring and truncation behavior`,
        files_changed: [`src/token-budget-file-${index}.ts`],
        tests: [{ command: `npm test -- token-budget-${index} --run`, passed: true }],
        follow_up_actions: [],
      };
      store.add(extractor.extractFromImplementer(result, taskId));
    }

    const facts = retriever.retrieve({
      taskDescription: 'token budget retriever sample',
      taskId: '999',
      tags: undefined,
      maxFacts: 50,
      maxTokens: 100,
    });

    const usedTokens = facts.reduce(
      (total, fact) => total + estimateTokens(fact.subject, fact.relation, fact.object),
      0
    );

    expect(facts.length).toBeGreaterThan(0);
    expect(facts.length).toBeLessThan(50);
    expect(usedTokens).toBeLessThanOrEqual(100);
  });
});
