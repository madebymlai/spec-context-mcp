import { describe, expect, it } from 'vitest';
import { formatSessionFacts } from './format.js';
import { createFactId, SessionFact } from './types.js';

function buildFact(input: {
  subject: string;
  relation: string;
  object: string;
  sourceTaskId: string;
}): SessionFact {
  return {
    id: createFactId(input.subject, input.relation, input.object),
    subject: input.subject,
    relation: input.relation,
    object: input.object,
    tags: ['decision'],
    validFrom: new Date('2025-01-01T00:00:00.000Z'),
    validTo: undefined,
    sourceTaskId: input.sourceTaskId,
    sourceRole: 'implementer',
    confidence: 1,
  };
}

describe('formatSessionFacts', () => {
  it('returns empty string for no facts', () => {
    expect(formatSessionFacts([])).toBe('');
  });

  it('formats facts as session context lines', () => {
    const formatted = formatSessionFacts([
      buildFact({
        subject: 'task:1',
        relation: 'completed_with',
        object: 'completed',
        sourceTaskId: '1',
      }),
      buildFact({
        subject: 'src/core/session/fact-retriever.ts',
        relation: 'modified_by',
        object: 'task:1',
        sourceTaskId: '1',
      }),
      buildFact({
        subject: 'task:2',
        relation: 'must_fix',
        object: 'enforce naming conventions',
        sourceTaskId: '2',
      }),
    ]);

    expect(formatted).toContain('[Session Context]');
    expect(formatted).toContain('- task:1 completed_with completed [task:1]');
    expect(formatted).toContain('- src/core/session/fact-retriever.ts modified_by task:1 [task:1]');
    expect(formatted).toContain('- task:2 must_fix enforce naming conventions [task:2]');
  });

  it('truncates long lines by clipping only the object portion', () => {
    const formatted = formatSessionFacts([
      buildFact({
        subject: 'task:3',
        relation: 'summary',
        object: 'x'.repeat(300),
        sourceTaskId: '3',
      }),
    ]);

    const line = formatted.split('\n')[1];
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.endsWith('[task:3]')).toBe(true);
    expect(line).toContain('...');
  });
});
