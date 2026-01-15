import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
    CodebaseInfo,
    CodebaseInfoIndexing,
    CodebaseInfoIndexed,
    CodebaseInfoIndexFailed,
    CodebaseSnapshot,
} from './snapshot-types.js';

export class SnapshotManager {
    private snapshotFilePath: string;
    private codebaseInfoMap: Map<string, CodebaseInfo> = new Map();

    constructor() {
        this.snapshotFilePath = path.join(os.homedir(), '.spec-context-mcp', 'codebase-snapshot.json');
    }

    public getIndexedCodebases(): string[] {
        return Array.from(this.codebaseInfoMap.entries())
            .filter(([_, info]) => info.status === 'indexed')
            .map(([path, _]) => path);
    }

    public getIndexingCodebases(): string[] {
        return Array.from(this.codebaseInfoMap.entries())
            .filter(([_, info]) => info.status === 'indexing')
            .map(([path, _]) => path);
    }

    public getFailedCodebases(): string[] {
        return Array.from(this.codebaseInfoMap.entries())
            .filter(([_, info]) => info.status === 'indexfailed')
            .map(([path, _]) => path);
    }

    public getCodebaseStatus(codebasePath: string): 'indexed' | 'indexing' | 'indexfailed' | 'not_found' {
        const info = this.codebaseInfoMap.get(codebasePath);
        if (!info) return 'not_found';
        return info.status;
    }

    public getCodebaseInfo(codebasePath: string): CodebaseInfo | undefined {
        return this.codebaseInfoMap.get(codebasePath);
    }

    public getIndexingProgress(codebasePath: string): number | undefined {
        const info = this.codebaseInfoMap.get(codebasePath);
        if (info && info.status === 'indexing') {
            return info.indexingPercentage;
        }
        return undefined;
    }

    public setCodebaseIndexing(codebasePath: string, progress: number = 0): void {
        const info: CodebaseInfoIndexing = {
            status: 'indexing',
            indexingPercentage: progress,
            lastUpdated: new Date().toISOString(),
        };
        this.codebaseInfoMap.set(codebasePath, info);
        this.saveSnapshot();
    }

    public setCodebaseIndexed(
        codebasePath: string,
        stats: { indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }
    ): void {
        const info: CodebaseInfoIndexed = {
            status: 'indexed',
            indexedFiles: stats.indexedFiles,
            totalChunks: stats.totalChunks,
            indexStatus: stats.status,
            lastUpdated: new Date().toISOString(),
        };
        this.codebaseInfoMap.set(codebasePath, info);
        this.saveSnapshot();
    }

    public setCodebaseIndexFailed(
        codebasePath: string,
        errorMessage: string,
        lastAttemptedPercentage?: number
    ): void {
        const info: CodebaseInfoIndexFailed = {
            status: 'indexfailed',
            errorMessage,
            lastAttemptedPercentage,
            lastUpdated: new Date().toISOString(),
        };
        this.codebaseInfoMap.set(codebasePath, info);
        this.saveSnapshot();
    }

    public removeCodebase(codebasePath: string): void {
        this.codebaseInfoMap.delete(codebasePath);
        this.saveSnapshot();
        console.log(`[SnapshotManager] Removed codebase: ${codebasePath}`);
    }

    public loadSnapshot(): void {
        console.log(`[SnapshotManager] Loading snapshot from: ${this.snapshotFilePath}`);

        try {
            if (!fs.existsSync(this.snapshotFilePath)) {
                console.log('[SnapshotManager] No snapshot file found. Starting fresh.');
                return;
            }

            const data = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const snapshot: CodebaseSnapshot = JSON.parse(data);

            // Validate codebases still exist
            for (const [codebasePath, info] of Object.entries(snapshot.codebases)) {
                if (fs.existsSync(codebasePath)) {
                    this.codebaseInfoMap.set(codebasePath, info);
                    console.log(`[SnapshotManager] Loaded codebase: ${codebasePath} (${info.status})`);
                } else {
                    console.warn(`[SnapshotManager] Codebase no longer exists: ${codebasePath}`);
                }
            }

            console.log(`[SnapshotManager] Loaded ${this.codebaseInfoMap.size} codebases.`);
        } catch (error) {
            console.error('[SnapshotManager] Error loading snapshot:', error);
        }
    }

    public saveSnapshot(): void {
        try {
            const snapshotDir = path.dirname(this.snapshotFilePath);
            if (!fs.existsSync(snapshotDir)) {
                fs.mkdirSync(snapshotDir, { recursive: true });
            }

            const codebases: Record<string, CodebaseInfo> = {};
            for (const [codebasePath, info] of this.codebaseInfoMap) {
                codebases[codebasePath] = info;
            }

            const snapshot: CodebaseSnapshot = {
                formatVersion: 'v2',
                codebases,
                lastUpdated: new Date().toISOString(),
            };

            fs.writeFileSync(this.snapshotFilePath, JSON.stringify(snapshot, null, 2));
            console.log(`[SnapshotManager] Saved snapshot with ${this.codebaseInfoMap.size} codebases.`);
        } catch (error) {
            console.error('[SnapshotManager] Error saving snapshot:', error);
        }
    }
}
