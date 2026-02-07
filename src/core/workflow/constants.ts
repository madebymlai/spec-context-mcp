import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const DEFAULT_DASHBOARD_PORT = 3000;
export const DEFAULT_DASHBOARD_URL = `http://localhost:${DEFAULT_DASHBOARD_PORT}`;

let cachedVersion: string | null = null;

export function getPackageVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const packageJsonPath = join(__dirname, '..', '..', '..', 'package.json');
  const content = readFileSync(packageJsonPath, 'utf-8');
  const parsed = JSON.parse(content) as { version?: string };
  if (!parsed.version) {
    throw new Error(`package.json at ${packageJsonPath} is missing a version field`);
  }
  cachedVersion = parsed.version;
  return cachedVersion;
}
