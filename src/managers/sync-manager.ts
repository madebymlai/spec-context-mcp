import * as fs from 'fs';
import type { Context } from '../core/context.js';
import type { SnapshotManager } from './snapshot-manager.js';
import { FileSynchronizer } from '../core/sync/synchronizer.js';

export class SyncManager {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private isSyncing: boolean = false;
    private syncInterval: NodeJS.Timeout | null = null;

    constructor(context: Context, snapshotManager: SnapshotManager) {
        this.context = context;
        this.snapshotManager = snapshotManager;
    }

    public async handleSyncIndex(): Promise<{ added: number; removed: number; modified: number }> {
        const startTime = Date.now();
        console.log(`[SyncManager] Starting sync at ${new Date().toISOString()}`);

        const indexedCodebases = this.snapshotManager.getIndexedCodebases();

        if (indexedCodebases.length === 0) {
            console.log('[SyncManager] No codebases indexed. Skipping sync.');
            return { added: 0, removed: 0, modified: 0 };
        }

        if (this.isSyncing) {
            console.log('[SyncManager] Sync already in progress. Skipping.');
            return { added: 0, removed: 0, modified: 0 };
        }

        this.isSyncing = true;
        console.log(`[SyncManager] Syncing ${indexedCodebases.length} codebases...`);

        const totalStats = { added: 0, removed: 0, modified: 0 };

        try {
            for (let i = 0; i < indexedCodebases.length; i++) {
                const codebasePath = indexedCodebases[i];
                console.log(`[SyncManager] [${i + 1}/${indexedCodebases.length}] Syncing: ${codebasePath}`);

                if (!fs.existsSync(codebasePath)) {
                    console.warn(`[SyncManager] Codebase no longer exists: ${codebasePath}`);
                    this.snapshotManager.removeCodebase(codebasePath);
                    continue;
                }

                try {
                    const stats = await this.context.syncCodebase(codebasePath);

                    totalStats.added += stats.added;
                    totalStats.removed += stats.removed;
                    totalStats.modified += stats.modified;

                    if (stats.added > 0 || stats.removed > 0 || stats.modified > 0) {
                        console.log(`[SyncManager] Changes for ${codebasePath}: +${stats.added} -${stats.removed} ~${stats.modified}`);
                    } else {
                        console.log(`[SyncManager] No changes for ${codebasePath}`);
                    }
                } catch (error) {
                    console.error(`[SyncManager] Error syncing ${codebasePath}:`, error);

                    // If collection doesn't exist, clean up
                    const message = error instanceof Error ? error.message : String(error);
                    if (message.includes('not found') || message.includes('does not exist')) {
                        await FileSynchronizer.deleteSnapshot(codebasePath);
                        this.snapshotManager.removeCodebase(codebasePath);
                    }
                }
            }

            const elapsed = Date.now() - startTime;
            console.log(`[SyncManager] Sync completed in ${elapsed}ms. Total: +${totalStats.added} -${totalStats.removed} ~${totalStats.modified}`);
        } finally {
            this.isSyncing = false;
        }

        return totalStats;
    }

    public startBackgroundSync(intervalMs: number = 5 * 60 * 1000): void {
        console.log(`[SyncManager] Starting background sync every ${intervalMs / 1000}s`);

        // Initial sync after 5 seconds
        setTimeout(async () => {
            console.log('[SyncManager] Running initial sync...');
            try {
                await this.handleSyncIndex();
            } catch (error) {
                console.error('[SyncManager] Initial sync failed:', error);
            }
        }, 5000);

        // Periodic sync
        this.syncInterval = setInterval(() => {
            console.log('[SyncManager] Running periodic sync...');
            this.handleSyncIndex().catch((error) => {
                console.error('[SyncManager] Periodic sync failed:', error);
            });
        }, intervalMs);
    }

    public stopBackgroundSync(): void {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
            console.log('[SyncManager] Background sync stopped.');
        }
    }
}
