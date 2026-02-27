import type { SessionFact } from './types.js';

export type ScopeClassification = 'local' | 'global';

export interface IScopeClassifier {
  classify(fact: SessionFact): ScopeClassification;
}

interface ScopeRule {
  readonly scope: ScopeClassification;
  readonly matches: (fact: SessionFact) => boolean;
}

const GLOBAL_RELATIONS = new Set(['convention', 'uses_pattern']);
const EXACT_CONFIG_FILENAMES = ['package.json', 'tsconfig.json', 'dockerfile'];
const PREFIX_CONFIG_FILENAMES = ['.eslintrc', '.prettierrc', '.env', 'docker-compose'];
const PREFIXED_CONFIG_FILENAMES = ['jest.config.', 'vitest.config.', 'webpack.config.', 'vite.config.'];

function getSubjectFileName(subject: string): string {
  const normalizedPath = subject.trim().split('\\').join('/').toLowerCase();
  const fileName = normalizedPath.split('/').at(-1);
  return fileName ?? normalizedPath;
}

function isConfigFileSubject(subject: string): boolean {
  const fileName = getSubjectFileName(subject);

  if (EXACT_CONFIG_FILENAMES.includes(fileName)) {
    return true;
  }
  if (PREFIX_CONFIG_FILENAMES.some(prefix => fileName.startsWith(prefix))) {
    return true;
  }

  return PREFIXED_CONFIG_FILENAMES.some(prefix => fileName.startsWith(prefix));
}

const SCOPE_RULES: ReadonlyArray<ScopeRule> = [
  {
    scope: 'global',
    matches: fact => fact.tags.includes('convention'),
  },
  {
    scope: 'global',
    matches: fact => fact.tags.includes('dependency'),
  },
  {
    scope: 'global',
    matches: fact => isConfigFileSubject(fact.subject),
  },
  {
    scope: 'global',
    matches: fact => GLOBAL_RELATIONS.has(fact.relation),
  },
];

export class ScopeClassifier implements IScopeClassifier {
  classify(fact: SessionFact): ScopeClassification {
    const matchingRule = SCOPE_RULES.find(rule => rule.matches(fact));
    return matchingRule?.scope ?? 'local';
  }
}
