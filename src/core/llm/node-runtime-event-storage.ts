import { dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { promises as fs } from 'fs';
import type { RuntimeEventStorage } from './runtime-event-storage.js';

export class NodeRuntimeEventStorage implements RuntimeEventStorage {
    exists(path: string): boolean {
        return existsSync(path);
    }

    readFile(path: string): string {
        return readFileSync(path, 'utf-8');
    }

    async ensureDirectory(path: string): Promise<void> {
        await fs.mkdir(dirname(path), { recursive: true });
    }

    async appendFile(path: string, content: string): Promise<void> {
        await fs.appendFile(path, content, 'utf-8');
    }
}
