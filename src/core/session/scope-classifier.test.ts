import { describe, expect, it } from 'vitest';
import { ScopeClassifier } from './scope-classifier.js';
import { createFactId, type SessionFact, type SessionFactTag } from './types.js';

function buildFact(input: {
  subject: string;
  relation: string;
  object?: string;
  tags?: SessionFactTag[];
}): SessionFact {
  const object = input.object ?? 'value';
  return {
    id: createFactId(input.subject, input.relation, object),
    subject: input.subject,
    relation: input.relation,
    object,
    tags: input.tags ?? ['decision'],
    validFrom: new Date('2026-02-27T00:00:00.000Z'),
    validTo: undefined,
    sourceTaskId: '4',
    sourceRole: 'implementer',
    confidence: 1,
  };
}

describe('ScopeClassifier', () => {
  it('classifies convention-tagged facts as global', () => {
    const classifier = new ScopeClassifier();

    const scope = classifier.classify(
      buildFact({
        subject: 'src/core/session/types.ts',
        relation: 'modified_by',
        tags: ['convention'],
      }),
    );

    expect(scope).toBe('global');
  });

  it('classifies dependency-tagged facts as global', () => {
    const classifier = new ScopeClassifier();

    const scope = classifier.classify(
      buildFact({
        subject: 'src/core/session/index.ts',
        relation: 'summary',
        tags: ['dependency'],
      }),
    );

    expect(scope).toBe('global');
  });

  it.each([
    'package.json',
    'tsconfig.json',
    '.eslintrc',
    '.eslintrc.cjs',
    '.prettierrc',
    '.prettierrc.json',
    'jest.config.ts',
    'vitest.config.mts',
    'webpack.config.js',
    'vite.config.ts',
    '.env',
    '.env.local',
    'Dockerfile',
    'docker-compose.yml',
    'docker-compose.override.yaml',
  ])('classifies config file facts as global for %s', configPath => {
    const classifier = new ScopeClassifier();

    const scope = classifier.classify(
      buildFact({
        subject: `config/${configPath}`,
        relation: 'modified_by',
        tags: ['file_change'],
      }),
    );

    expect(scope).toBe('global');
  });

  it('classifies convention relation facts as global', () => {
    const classifier = new ScopeClassifier();

    const scope = classifier.classify(
      buildFact({
        subject: 'src/core/session/types.ts',
        relation: 'convention',
        tags: ['decision'],
      }),
    );

    expect(scope).toBe('global');
  });

  it('classifies uses_pattern relation facts as global', () => {
    const classifier = new ScopeClassifier();

    const scope = classifier.classify(
      buildFact({
        subject: 'src/core/session/types.ts',
        relation: 'uses_pattern',
        tags: ['decision'],
      }),
    );

    expect(scope).toBe('global');
  });

  it('classifies regular implementation facts as local', () => {
    const classifier = new ScopeClassifier();

    const scope = classifier.classify(
      buildFact({
        subject: 'src/core/session/graph-session-fact-store.ts',
        relation: 'modified_by',
        tags: ['file_change'],
      }),
    );

    expect(scope).toBe('local');
  });
});
