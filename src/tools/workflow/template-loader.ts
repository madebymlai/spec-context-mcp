/**
 * Shared workflow template loader
 * Loads server-bundled templates only.
 */

import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  areFileFingerprintsEqual,
  type FileContentFingerprint,
  type IFileContentCache,
} from '../../core/cache/file-content-cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type SpecTemplateType = 'requirements' | 'design' | 'tasks';
export const SPEC_WORKFLOW_TEMPLATES = ['requirements', 'design', 'tasks'] as const;
export type SteeringTemplateType = 'product' | 'tech' | 'structure' | 'principles';
export const STEERING_WORKFLOW_TEMPLATES = ['product', 'tech', 'structure', 'principles'] as const;
type WorkflowTemplateType = SpecTemplateType | SteeringTemplateType;

export type TemplateSource = 'server';

export interface WorkflowTemplatePayload {
  content: string;
  source: TemplateSource;
  path: string;
}

export type SpecTemplatePayload = WorkflowTemplatePayload;
export type SteeringTemplatePayload = WorkflowTemplatePayload;

export type SpecTemplateResult = Partial<Record<SpecTemplateType, SpecTemplatePayload>>;
export type SteeringTemplateResult = Partial<Record<SteeringTemplateType, SteeringTemplatePayload>>;
export type TemplateFingerprintMap = Partial<Record<SpecTemplateType, FileContentFingerprint>>;
export type SteeringTemplateFingerprintMap = Partial<Record<SteeringTemplateType, FileContentFingerprint>>;

export function buildBundledTemplatePath(template: WorkflowTemplateType): string {
  return join(__dirname, '..', '..', 'templates', `${template}-template.md`);
}

export async function getSpecTemplates(
  templates: readonly SpecTemplateType[],
  cache?: IFileContentCache
): Promise<SpecTemplateResult> {
  return resolveTemplates(templates, cache);
}

export async function getSteeringTemplates(
  templates: readonly SteeringTemplateType[],
  cache?: IFileContentCache
): Promise<SteeringTemplateResult> {
  return resolveTemplates(templates, cache);
}

export function collectTemplateFingerprints(
  templates: readonly SpecTemplateType[],
  fileContentCache: IFileContentCache
): TemplateFingerprintMap {
  return collectFingerprints(templates, fileContentCache);
}

export function collectSteeringTemplateFingerprints(
  templates: readonly SteeringTemplateType[],
  fileContentCache: IFileContentCache
): SteeringTemplateFingerprintMap {
  return collectFingerprints(templates, fileContentCache);
}

export function hasTemplateFingerprintMismatch(
  args: {
    templates: readonly SpecTemplateType[];
    previous: TemplateFingerprintMap;
    fileContentCache: IFileContentCache;
  }
): boolean {
  return hasFingerprintMismatch(args.templates, args.previous, args.fileContentCache);
}

export function hasSteeringTemplateFingerprintMismatch(
  args: {
    templates: readonly SteeringTemplateType[];
    previous: SteeringTemplateFingerprintMap;
    fileContentCache: IFileContentCache;
  }
): boolean {
  return hasFingerprintMismatch(args.templates, args.previous, args.fileContentCache);
}

async function resolveTemplates<T extends WorkflowTemplateType>(
  templates: readonly T[],
  cache?: IFileContentCache
): Promise<Partial<Record<T, WorkflowTemplatePayload>>> {
  const result: Partial<Record<T, WorkflowTemplatePayload>> = {};

  for (const template of templates) {
    const resolved = await resolveTemplate(template, cache);
    result[template] = resolved;
  }

  return result;
}

function collectFingerprints<T extends WorkflowTemplateType>(
  templates: readonly T[],
  fileContentCache: IFileContentCache
): Partial<Record<T, FileContentFingerprint>> {
  const fingerprints: Partial<Record<T, FileContentFingerprint>> = {};
  for (const template of templates) {
    const fingerprint = fileContentCache.getFingerprint(buildBundledTemplatePath(template));
    if (fingerprint) {
      fingerprints[template] = fingerprint;
    }
  }
  return fingerprints;
}

function hasFingerprintMismatch<T extends WorkflowTemplateType>(
  templates: readonly T[],
  previousFingerprints: Partial<Record<T, FileContentFingerprint>>,
  fileContentCache: IFileContentCache
): boolean {
  for (const template of templates) {
    const current = fileContentCache.getFingerprint(buildBundledTemplatePath(template));
    const previous = previousFingerprints[template];
    if (!current || !previous) {
      return true;
    }
    if (!areFileFingerprintsEqual(current, previous)) {
      return true;
    }
  }
  return false;
}

async function resolveTemplate(
  template: WorkflowTemplateType,
  cache?: IFileContentCache
): Promise<WorkflowTemplatePayload> {
  const path = buildBundledTemplatePath(template);
  const content = cache
    ? await cache.get(path, { namespace: 'templates.server' })
    : await readFileSafe(path);

  if (content === null) {
    throw new Error(`Bundled template missing: ${path}`);
  }

  return {
    content,
    source: 'server',
    path,
  };
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
