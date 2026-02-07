import { describe, expect, it } from 'vitest';
import { KeywordFactRetriever } from './fact-retriever.js';
import { InMemorySessionFactStore } from './session-fact-store.js';
import { createFactId, SessionFact, SessionFactTag } from './types.js';

function buildFact(input: {
  subject: string;
  relation: string;
  object: string;
  tags: SessionFactTag[];
  sourceTaskId: string;
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
    sourceRole: 'implementer',
    confidence: 1,
  };
}

describe('KeywordFactRetriever', () => {
  it('returns empty array for an empty store', () => {
    const store = new InMemorySessionFactStore();
    const retriever = new KeywordFactRetriever(store);

    const facts = retriever.retrieve({
      taskDescription: 'update parser',
      taskId: '1',
      tags: undefined,
      maxFacts: 10,
      maxTokens: 500,
    });

    expect(facts).toEqual([]);
  });

  it('filters by tags and excludes same-task facts', () => {
    const store = new InMemorySessionFactStore();
    const retriever = new KeywordFactRetriever(store);
    const decisionFact = buildFact({
      subject: 'task:2',
      relation: 'summary',
      object: 'Implemented parser changes',
      tags: ['decision'],
      sourceTaskId: '2',
      at: '2025-01-01T00:00:00.000Z',
    });
    const fileFact = buildFact({
      subject: 'src/parser.ts',
      relation: 'modified_by',
      object: 'task:3',
      tags: ['file_change'],
      sourceTaskId: '3',
      at: '2025-01-01T00:00:01.000Z',
    });
    const sameTaskFact = buildFact({
      subject: 'task:4',
      relation: 'summary',
      object: 'Current task context',
      tags: ['decision'],
      sourceTaskId: '4',
      at: '2025-01-01T00:00:02.000Z',
    });
    store.add([decisionFact, fileFact, sameTaskFact]);

    const facts = retriever.retrieve({
      taskDescription: 'review parser updates',
      taskId: '4',
      tags: ['decision'],
      maxFacts: 10,
      maxTokens: 500,
    });

    expect(facts).toEqual([decisionFact]);
  });

  it('ranks higher-overlap facts ahead of lower-overlap facts', () => {
    const store = new InMemorySessionFactStore();
    const retriever = new KeywordFactRetriever(store);
    const highOverlap = buildFact({
      subject: 'src/core/session/fact-retriever.ts',
      relation: 'modified_by',
      object: 'task:2 keyword retriever scoring',
      tags: ['file_change'],
      sourceTaskId: '2',
      at: '2025-01-02T00:00:00.000Z',
    });
    const lowOverlap = buildFact({
      subject: 'docs/notes.md',
      relation: 'summary',
      object: 'minor docs update',
      tags: ['decision'],
      sourceTaskId: '1',
      at: '2025-01-03T00:00:00.000Z',
    });
    store.add([lowOverlap, highOverlap]);

    const facts = retriever.retrieve({
      taskDescription: 'implement keyword retriever scoring for session facts',
      taskId: '5',
      tags: undefined,
      maxFacts: 10,
      maxTokens: 500,
    });

    expect(facts[0]).toEqual(highOverlap);
  });

  it('uses recency ordering when overlap scores are tied', () => {
    const store = new InMemorySessionFactStore();
    const retriever = new KeywordFactRetriever(store);
    const older = buildFact({
      subject: 'task:10',
      relation: 'summary',
      object: 'unrelated note',
      tags: ['decision'],
      sourceTaskId: '10',
      at: '2025-01-01T00:00:00.000Z',
    });
    const newer = buildFact({
      subject: 'task:11',
      relation: 'summary',
      object: 'another unrelated note',
      tags: ['decision'],
      sourceTaskId: '11',
      at: '2025-01-02T00:00:00.000Z',
    });
    store.add([older, newer]);

    const facts = retriever.retrieve({
      taskDescription: 'completely different words',
      taskId: '12',
      tags: undefined,
      maxFacts: 10,
      maxTokens: 500,
    });

    expect(facts[0]).toEqual(newer);
    expect(facts[1]).toEqual(older);
  });

  it('truncates results to stay within token budget', () => {
    const store = new InMemorySessionFactStore();
    const retriever = new KeywordFactRetriever(store);
    const first = buildFact({
      subject: 'src/core/session/very-long-file-name-one.ts',
      relation: 'modified_by',
      object: 'task:1 very long object text to consume token budget quickly',
      tags: ['file_change'],
      sourceTaskId: '1',
      at: '2025-01-02T00:00:00.000Z',
    });
    const second = buildFact({
      subject: 'src/core/session/very-long-file-name-two.ts',
      relation: 'modified_by',
      object: 'task:2 very long object text to consume token budget quickly',
      tags: ['file_change'],
      sourceTaskId: '2',
      at: '2025-01-03T00:00:00.000Z',
    });
    store.add([first, second]);

    const facts = retriever.retrieve({
      taskDescription: 'very long file name',
      taskId: '9',
      tags: undefined,
      maxFacts: 10,
      maxTokens: 40,
    });

    expect(facts).toHaveLength(1);
  });
});
