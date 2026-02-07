import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const DEFAULT_DASHBOARD_PORT = 3000;
export const DEFAULT_DASHBOARD_URL = `http://localhost:${DEFAULT_DASHBOARD_PORT}`;

let cachedVersion: string | null = null;

export function getPackageVersion(fallback = '1.0.0'): string {
  if (cachedVersion) {
    return cachedVersion;
  }

  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const packageJsonPath = join(__dirname, '..', '..', '..', 'package.json');
    const content = readFileSync(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(content) as { version?: string };
    cachedVersion = parsed.version || fallback;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') {
      cachedVersion = fallback;
    } else {
      throw error;
    }
  }

  return cachedVersion;
}
