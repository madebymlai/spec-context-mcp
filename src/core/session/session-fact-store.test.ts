import { describe, expect, it } from 'vitest';
import { InMemorySessionFactStore } from './session-fact-store.js';
import { createFactId, SessionFact, SessionFactTag } from './types.js';

function buildFact(input: {
  subject: string;
  relation: string;
  object: string;
  tags: SessionFactTag[];
  sourceTaskId: string;
  sourceRole?: 'implementer' | 'reviewer';
  at: string;
}): SessionFact {
  return {
    id: createFactId(input.subject, input.relation, input.object),
    subject: input.subject,
    relation: input.relation,
    object: input.object,
    tags: input.tags,
    validFrom: new Date(input.at),
    validTo: undefined,
    sourceTaskId: input.sourceTaskId,
    sourceRole: input.sourceRole ?? 'implementer',
    confidence: 1,
  };
}

describe('InMemorySessionFactStore', () => {
  it('stores and returns valid facts', () => {
    const store = new InMemorySessionFactStore();
    const fact = buildFact({
      subject: 'task:1',
      relation: 'summary',
      object: 'Implemented parser',
      tags: ['decision'],
      sourceTaskId: '1',
      at: '2025-01-01T00:00:00.000Z',
    });
    store.add([fact]);

    expect(store.count()).toBe(1);
    expect(store.getValid()).toEqual([fact]);
  });

  it('auto-invalidates prior valid facts with the same subject and relation', () => {
    const store = new InMemorySessionFactStore();
    const oldFact = buildFact({
      subject: 'task:2',
      relation: 'completed_with',
      object: 'blocked',
      tags: ['decision'],
      sourceTaskId: '2',
      at: '2025-01-01T00:00:00.000Z',
    });
    const newFact = buildFact({
      subject: 'task:2',
      relation: 'completed_with',
      object: 'completed',
      tags: ['decision'],
      sourceTaskId: '2',
      at: '2025-01-02T00:00:00.000Z',
    });

    store.add([oldFact]);
    store.add([newFact]);

    expect(store.count()).toBe(1);
    expect(store.getValid()).toEqual([newFact]);
  });

  it('invalidates by subject and relation', () => {
    const store = new InMemorySessionFactStore();
    const fact = buildFact({
      subject: 'src/a.ts',
      relation: 'modified_by',
      object: 'task:3',
      tags: ['file_change'],
      sourceTaskId: '3',
      at: '2025-01-03T00:00:00.000Z',
    });

    store.add([fact]);
    store.invalidate('src/a.ts', 'modified_by');

    expect(store.count()).toBe(0);
    expect(store.getValid()).toEqual([]);
  });

  it('filters valid facts by tags', () => {
    const store = new InMemorySessionFactStore();
    const fileFact = buildFact({
      subject: 'src/a.ts',
      relation: 'modified_by',
      object: 'task:4',
      tags: ['file_change'],
      sourceTaskId: '4',
      at: '2025-01-01T00:00:00.000Z',
    });
    const decisionFact = buildFact({
      subject: 'task:4',
      relation: 'summary',
      object: 'Refactored store',
      tags: ['decision'],
      sourceTaskId: '4',
      at: '2025-01-01T00:00:01.000Z',
    });
    store.add([fileFact, decisionFact]);

    expect(store.getValidByTags(['decision'])).toEqual([decisionFact]);
    expect(store.getValidByTags(['file_change'])).toEqual([fileFact]);
  });

  it('compacts by removing invalidated first, then oldest valid facts', () => {
    const store = new InMemorySessionFactStore();
    const first = buildFact({
      subject: 'src/x.ts',
      relation: 'modified_by',
      object: 'task:1',
      tags: ['file_change'],
      sourceTaskId: '1',
      at: '2025-01-01T00:00:00.000Z',
    });
    const second = buildFact({
      subject: 'src/x.ts',
      relation: 'modified_by',
      object: 'task:2',
      tags: ['file_change'],
      sourceTaskId: '2',
      at: '2025-01-02T00:00:00.000Z',
    });
    const third = buildFact({
      subject: 'task:3',
      relation: 'summary',
      object: 'Task 3 done',
      tags: ['decision'],
      sourceTaskId: '3',
      at: '2025-01-03T00:00:00.000Z',
    });
    const fourth = buildFact({
      subject: 'task:4',
      relation: 'summary',
      object: 'Task 4 done',
      tags: ['decision'],
      sourceTaskId: '4',
      at: '2025-01-04T00:00:00.000Z',
    });
    const fifth = buildFact({
      subject: 'task:5',
      relation: 'summary',
      object: 'Task 5 done',
      tags: ['decision'],
      sourceTaskId: '5',
      at: '2025-01-05T00:00:00.000Z',
    });

    store.add([first, second, third, fourth, fifth]);
    store.compact(3);

    const valid = store.getValid();
    expect(valid).toHaveLength(3);
    expect(valid.some(fact => fact.object === 'task:2')).toBe(false);
    expect(valid.map(fact => fact.sourceTaskId).sort()).toEqual(['3', '4', '5']);
  });

  it('silently skips malformed facts', () => {
    const store = new InMemorySessionFactStore();
    const malformed = {
      id: '',
      subject: '',
      relation: 'summary',
      object: 'bad',
      tags: ['decision'],
      validFrom: new Date('bad-date'),
      validTo: undefined,
      sourceTaskId: '',
      sourceRole: 'implementer',
      confidence: 1,
    } as unknown as SessionFact;

    store.add([malformed]);

    expect(store.count()).toBe(0);
    expect(store.getValid()).toEqual([]);
  });
});
