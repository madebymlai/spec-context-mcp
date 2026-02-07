/**
 * Shared spec template loader
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

export type TemplateSource = 'server';

export interface SpecTemplatePayload {
  content: string;
  source: TemplateSource;
  path: string;
}

export type SpecTemplateResult = Partial<Record<SpecTemplateType, SpecTemplatePayload>>;
export type TemplateFingerprintMap = Partial<Record<SpecTemplateType, FileContentFingerprint>>;

export function buildBundledTemplatePath(template: SpecTemplateType): string {
  return join(__dirname, '..', '..', 'templates', `${template}-template.md`);
}

export async function getSpecTemplates(
  templates: readonly SpecTemplateType[],
  cache?: IFileContentCache
): Promise<SpecTemplateResult | null> {
  const result: SpecTemplateResult = {};

  for (const template of templates) {
    const resolved = await resolveTemplate(template, cache);
    if (resolved) {
      result[template] = resolved;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

export function collectTemplateFingerprints(
  templates: readonly SpecTemplateType[],
  fileContentCache: IFileContentCache
): TemplateFingerprintMap {
  const fingerprints: TemplateFingerprintMap = {};
  for (const template of templates) {
    const fingerprint = fileContentCache.getFingerprint(buildBundledTemplatePath(template));
    if (fingerprint) {
      fingerprints[template] = fingerprint;
    }
  }
  return fingerprints;
}

export function hasTemplateFingerprintMismatch(
  args: {
    templates: readonly SpecTemplateType[];
    previous: TemplateFingerprintMap;
    fileContentCache: IFileContentCache;
  }
): boolean {
  for (const template of args.templates) {
    const current = args.fileContentCache.getFingerprint(buildBundledTemplatePath(template));
    const previous = args.previous[template];
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
  template: SpecTemplateType,
  cache?: IFileContentCache
): Promise<SpecTemplatePayload | null> {
  const path = buildBundledTemplatePath(template);
  const content = cache
    ? await cache.get(path, { namespace: 'templates.server' })
    : await readFileSafe(path);

  if (content !== null) {
    return {
      content,
      source: 'server',
      path,
    };
  }

  return null;
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
