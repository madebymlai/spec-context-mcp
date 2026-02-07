import { describe, expect, it } from 'vitest';
import { createFactId } from './types.js';

describe('createFactId', () => {
  it('returns deterministic ids for the same triple', () => {
    const idA = createFactId('task:1', 'summary', 'implemented parser');
    const idB = createFactId('task:1', 'summary', 'implemented parser');
    expect(idA).toBe(idB);
    expect(idA).toHaveLength(16);
  });

  it('changes when any triple part changes', () => {
    const base = createFactId('task:1', 'summary', 'implemented parser');
    const changedSubject = createFactId('task:2', 'summary', 'implemented parser');
    const changedRelation = createFactId('task:1', 'requires', 'implemented parser');
    const changedObject = createFactId('task:1', 'summary', 'implemented retriever');

    expect(changedSubject).not.toBe(base);
    expect(changedRelation).not.toBe(base);
    expect(changedObject).not.toBe(base);
  });
});
