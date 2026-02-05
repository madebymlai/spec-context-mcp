/**
 * Shared steering document loader
 * Loads specific steering docs on demand
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type SteeringDocType = 'product' | 'tech' | 'structure' | 'principles';

export type SteeringDocsResult = {
  [K in SteeringDocType]?: string;
};

/**
 * Load specific steering documents from the project's steering directory.
 *
 * @param projectPath - The project root path
 * @param docs - Array of document types to load
 * @returns Object with requested docs (only those that exist), or null if steering dir missing
 */
export function getSteeringDocs(
  projectPath: string,
  docs: SteeringDocType[]
): SteeringDocsResult | null {
  const steeringDir = join(projectPath, '.spec-context', 'steering');

  if (!existsSync(steeringDir)) {
    return null;
  }

  const result: SteeringDocsResult = {};

  for (const doc of docs) {
    const docPath = join(steeringDir, `${doc}.md`);
    if (existsSync(docPath)) {
      try {
        result[doc] = readFileSync(docPath, 'utf-8');
      } catch {
        // Skip if can't read
      }
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Check if required steering docs exist.
 * Returns list of missing docs.
 */
export function getMissingSteeringDocs(
  projectPath: string,
  required: SteeringDocType[]
): SteeringDocType[] {
  const steeringDir = join(projectPath, '.spec-context', 'steering');
  const missing: SteeringDocType[] = [];

  for (const doc of required) {
    const docPath = join(steeringDir, `${doc}.md`);
    if (!existsSync(docPath)) {
      missing.push(doc);
    }
  }

  return missing;
}
