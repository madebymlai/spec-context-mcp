import { describe, expect, it } from 'vitest';
import { HeuristicComplexityClassifier } from './heuristic-classifier.js';

describe('HeuristicComplexityClassifier', () => {
  const classifier = new HeuristicComplexityClassifier();

  it('classifies simple mechanical tasks as simple', () => {
    expect(classifier.classify({ taskDescription: 'Add test stub for UserService' }).level).toBe('simple');
    expect(classifier.classify({ taskDescription: 'Fix typo in README.md' }).level).toBe('simple');
    expect(classifier.classify({ taskDescription: 'Rename variable from foo to bar' }).level).toBe('simple');
  });

  it('classifies complex implementation and refactor tasks as complex', () => {
    expect(classifier.classify({ taskDescription: 'Implement OAuth2 flow with PKCE' }).level).toBe('complex');
    expect(classifier.classify({ taskDescription: 'Refactor auth module to use strategy pattern' }).level).toBe('complex');
  });

  it('classifies ambiguous work as complex', () => {
    const result = classifier.classify({ taskDescription: 'Add error handling to API endpoints' });
    expect(result.level).toBe('complex');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.classifierId).toBe('heuristic-v1');
  });

  it('defaults to complex with zero confidence when no features match', () => {
    const result = classifier.classify({ taskDescription: '' });
    expect(result.level).toBe('complex');
    expect(result.confidence).toBe(0);
    expect(result.features).toEqual([]);
  });

  it('uses metadata hints to shift classification', () => {
    const result = classifier.classify({
      taskDescription: 'Update release notes',
      fileCount: 4,
      estimatedScope: 'cross-module',
      hints: { policy: 'complex' },
    });
    expect(result.level).toBe('complex');
    expect(result.features.some(feature => feature.name === 'file_count')).toBe(true);
    expect(result.features.some(feature => feature.name === 'scope_hint')).toBe(true);
    expect(result.features.some(feature => feature.name === 'hint:policy')).toBe(true);
  });

  it('classifies long high-scope prompts as complex', () => {
    const description = `Implement auth redesign with cross-module integration.
${'Refactor token handling and integrate new interface boundaries. '.repeat(20)}`;
    expect(classifier.classify({ taskDescription: description }).level).toBe('complex');
  });

  it('is deterministic for identical input', () => {
    const input = { taskDescription: 'Fix typo in README.md' };
    expect(classifier.classify(input)).toEqual(classifier.classify(input));
  });
});
