import type { CanonicalProvider, DispatchRole } from '../../config/discipline.js';

export type ComplexityLevel = 'simple' | 'moderate' | 'complex';

export interface TaskClassificationInput {
  taskDescription: string;
  fileCount?: number;
  estimatedScope?: 'single-file' | 'multi-file' | 'cross-module';
  taskId?: string;
  specName?: string;
  hints?: Record<string, string>;
}

export interface ClassificationFeature {
  name: string;
  value: string | number | boolean;
  weight: number;
}

export interface ClassificationResult {
  level: ComplexityLevel;
  confidence: number;
  features: ClassificationFeature[];
  classifierId: string;
}

export interface ITaskComplexityClassifier {
  classify(input: TaskClassificationInput): ClassificationResult;
}

export interface RoutingTableConfig {
  simple: CanonicalProvider;
  moderate: CanonicalProvider;
  complex: CanonicalProvider;
}

export interface RoutingTableEntry {
  provider: CanonicalProvider;
  cli: string;
  role: DispatchRole;
}
