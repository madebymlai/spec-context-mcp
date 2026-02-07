/**
 * Shared steering document loader
 * Loads specific steering docs on demand
 */

import { access, readFile } from 'fs/promises';
import { join } from 'path';
import {
  areFileFingerprintsEqual,
  type FileContentFingerprint,
  type IFileContentCache,
} from '../../core/cache/file-content-cache.js';

export type SteeringDocType = 'product' | 'tech' | 'structure' | 'principles';
export const GUIDE_STEERING_DOCS = ['tech', 'principles'] as const;
export type GuideSteeringDocType = (typeof GUIDE_STEERING_DOCS)[number];

export type SteeringDocsResult = {
  [K in SteeringDocType]?: string;
};

export type SteeringFingerprintMap = Partial<Record<SteeringDocType, FileContentFingerprint>>;

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * Load specific steering documents from the project's steering directory.
 *
 * @param projectPath - The project root path
 * @param docs - Array of document types to load
 * @returns Object with requested docs (only those that exist), or null if steering dir missing
 */
export async function getSteeringDocs(
  projectPath: string,
  docs: SteeringDocType[],
  cache?: IFileContentCache
): Promise<SteeringDocsResult | null> {
  const result: SteeringDocsResult = {};

  for (const doc of docs) {
    const docPath = buildSteeringDocPath(projectPath, doc);
    try {
      if (cache) {
        const cached = await cache.get(docPath, { namespace: 'steering' });
        if (cached !== null) {
          result[doc] = cached;
        }
      } else {
        result[doc] = await readFile(docPath, 'utf-8');
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

export function buildSteeringDocPath(projectPath: string, doc: SteeringDocType): string {
  return join(projectPath, '.spec-context', 'steering', `${doc}.md`);
}

export function collectSteeringFingerprints(
  projectPath: string,
  docs: readonly SteeringDocType[],
  fileContentCache: IFileContentCache
): SteeringFingerprintMap {
  const fingerprints: SteeringFingerprintMap = {};
  for (const doc of docs) {
    const fingerprint = fileContentCache.getFingerprint(buildSteeringDocPath(projectPath, doc));
    if (fingerprint) {
      fingerprints[doc] = fingerprint;
    }
  }
  return fingerprints;
}

export function hasSteeringFingerprintMismatch(
  args: {
    projectPath: string;
    docs: readonly SteeringDocType[];
    previous: SteeringFingerprintMap;
    fileContentCache: IFileContentCache;
  }
): boolean {
  for (const doc of args.docs) {
    const current = args.fileContentCache.getFingerprint(buildSteeringDocPath(args.projectPath, doc));
    const previous = args.previous[doc];
    if (!current || !previous) {
      return true;
    }
    if (!areFileFingerprintsEqual(current, previous)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if required steering docs exist.
 * Returns list of missing docs.
 */
export async function getMissingSteeringDocs(
  projectPath: string,
  required: SteeringDocType[]
): Promise<SteeringDocType[]> {
  const steeringDir = join(projectPath, '.spec-context', 'steering');
  const missing: SteeringDocType[] = [];

  for (const doc of required) {
    const docPath = join(steeringDir, `${doc}.md`);
    try {
      await access(docPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        missing.push(doc);
      } else {
        throw error;
      }
    }
  }

  return missing;
}
