import type { CanonicalProvider, DispatchRole } from '../../config/discipline.js';

export type ComplexityLevel = 'simple' | 'complex';

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
  complex: CanonicalProvider;
}

export interface RoutingTableEntry {
  provider: CanonicalProvider;
  role: DispatchRole;
}

export interface IRoutingTable {
  resolve(level: ComplexityLevel, role: DispatchRole): RoutingTableEntry;
}
