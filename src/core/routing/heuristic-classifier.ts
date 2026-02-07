import type {
  ClassificationFeature,
  ClassificationResult,
  ComplexityLevel,
  ITaskComplexityClassifier,
  TaskClassificationInput,
} from './types.js';

const SIMPLE_KEYWORDS = [
  'test stub',
  'rename',
  'doc update',
  'fix typo',
  'move file',
  'update import',
];

const COMPLEX_KEYWORDS = [
  'refactor',
  'architect',
  'redesign',
  'new interface',
  'cross-module',
  'implement',
  'integrate',
];

const SIMPLE_ACTION_VERBS = new Set(['add', 'fix', 'move', 'rename', 'update']);
const COMPLEX_ACTION_VERBS = new Set(['implement', 'design', 'refactor', 'integrate']);

function normalizeDescription(taskDescription: string): string {
  return taskDescription.trim().toLowerCase();
}

function classifyScore(score: number): ComplexityLevel {
  if (score < -0.3) {
    return 'simple';
  }
  return 'complex';
}

function confidenceFromFeatures(score: number, featureCount: number): number {
  if (featureCount === 0) {
    return 0;
  }
  const magnitude = Math.min(1, Math.abs(score));
  const coverage = Math.min(0.3, featureCount * 0.06);
  return Math.min(1, 0.35 + (0.45 * magnitude) + coverage);
}

export class HeuristicComplexityClassifier implements ITaskComplexityClassifier {
  classify(input: TaskClassificationInput): ClassificationResult {
    const description = normalizeDescription(input.taskDescription);
    if (!description) {
      return {
        level: 'complex',
        confidence: 0,
        features: [],
        classifierId: 'heuristic-v1',
      };
    }

    const features: ClassificationFeature[] = [];

    for (const keyword of SIMPLE_KEYWORDS) {
      if (!description.includes(keyword)) {
        continue;
      }
      features.push({
        name: 'keyword_match',
        value: `simple:${keyword}`,
        weight: -0.45,
      });
    }
    for (const keyword of COMPLEX_KEYWORDS) {
      if (!description.includes(keyword)) {
        continue;
      }
      features.push({
        name: 'keyword_match',
        value: `complex:${keyword}`,
        weight: 0.55,
      });
    }

    if (typeof input.fileCount === 'number') {
      if (input.fileCount <= 1) {
        features.push({
          name: 'file_count',
          value: input.fileCount,
          weight: -0.25,
        });
      } else if (input.fileCount >= 3) {
        features.push({
          name: 'file_count',
          value: input.fileCount,
          weight: 0.35,
        });
      }
    }

    if (input.estimatedScope === 'single-file') {
      features.push({
        name: 'scope_hint',
        value: input.estimatedScope,
        weight: -0.3,
      });
    }
    if (input.estimatedScope === 'cross-module') {
      features.push({
        name: 'scope_hint',
        value: input.estimatedScope,
        weight: 0.35,
      });
    }

    if (description.length < 100) {
      features.push({
        name: 'description_length',
        value: description.length,
        weight: -0.05,
      });
    } else if (description.length > 500) {
      features.push({
        name: 'description_length',
        value: description.length,
        weight: 0.2,
      });
    }

    const firstWord = description.match(/^[a-z]+/)?.[0];
    if (firstWord && SIMPLE_ACTION_VERBS.has(firstWord)) {
      features.push({
        name: 'action_verb',
        value: firstWord,
        weight: -0.25,
      });
    } else if (firstWord && COMPLEX_ACTION_VERBS.has(firstWord)) {
      features.push({
        name: 'action_verb',
        value: firstWord,
        weight: 0.3,
      });
    }

    if (input.hints) {
      for (const [name, value] of Object.entries(input.hints)) {
        const normalizedHint = value.trim().toLowerCase();
        if (normalizedHint === 'simple') {
          features.push({
            name: `hint:${name}`,
            value,
            weight: -0.4,
          });
        } else if (normalizedHint === 'complex') {
          features.push({
            name: `hint:${name}`,
            value,
            weight: 0.4,
          });
        }
      }
    }

    if (features.length === 0) {
      return {
        level: 'complex',
        confidence: 0,
        features: [],
        classifierId: 'heuristic-v1',
      };
    }

    const score = features.reduce((sum, feature) => sum + feature.weight, 0);
    return {
      level: classifyScore(score),
      confidence: confidenceFromFeatures(score, features.length),
      features,
      classifierId: 'heuristic-v1',
    };
  }
}
