import { dirname, join } from 'path';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import type { AppliedOffset, StateSnapshot, StateSnapshotFact, StateSnapshotPendingWrite } from './types.js';

interface SnapshotFileShape {
    formatVersion: 'v2';
    snapshots: Record<string, StateSnapshot>;
    lastUpdated: string;
}

export interface SnapshotUpdateInput {
    runId: string;
    goal: string;
    status: StateSnapshot['status'];
    facts: StateSnapshotFact[];
    pendingWrites: StateSnapshotPendingWrite[];
    tokenBudget: StateSnapshot['token_budget'];
    appliedOffset: AppliedOffset;
}

export interface RuntimeSnapshotStoreOptions {
    snapshotPath?: string;
    flushDelayMs?: number;
}

const DEFAULT_FLUSH_DELAY_MS = 35;

function isNotFoundError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === 'ENOENT';
}

export class RuntimeSnapshotStore {
    private readonly snapshotPath: string;
    private readonly flushDelayMs: number;
    private loaded = false;
    private snapshots = new Map<string, StateSnapshot>();
    private dirty = false;
    private flushTimer: NodeJS.Timeout | null = null;
    private persistInFlight: Promise<void> | null = null;
    private lastPersistError: Error | null = null;

    constructor(snapshotPathOrOptions?: string | RuntimeSnapshotStoreOptions) {
        if (typeof snapshotPathOrOptions === 'string') {
            this.snapshotPath = snapshotPathOrOptions;
            this.flushDelayMs = DEFAULT_FLUSH_DELAY_MS;
            return;
        }

        const options = snapshotPathOrOptions ?? {};
        this.snapshotPath = options.snapshotPath ?? join(homedir(), '.spec-context-mcp', 'runtime-snapshots-v2.json');
        this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    }

    async get(runId: string): Promise<StateSnapshot | null> {
        await this.ensureLoaded();
        return this.snapshots.get(runId) ?? null;
    }

    async upsert(update: SnapshotUpdateInput): Promise<StateSnapshot> {
        await this.ensureLoaded();
        const previous = this.snapshots.get(update.runId);
        const revision = previous ? previous.revision + 1 : 1;
        const now = new Date().toISOString();

        const appliedOffsetsByPartition = new Map<string, AppliedOffset>();
        if (previous) {
            for (const offset of previous.applied_offsets) {
                appliedOffsetsByPartition.set(offset.partition_key, offset);
            }
        }

        const current = appliedOffsetsByPartition.get(update.appliedOffset.partition_key);
        if (!current || current.sequence < update.appliedOffset.sequence) {
            appliedOffsetsByPartition.set(update.appliedOffset.partition_key, update.appliedOffset);
        }

        const snapshot: StateSnapshot = {
            run_id: update.runId,
            revision,
            projector_version: 'v2',
            applied_offsets: Array.from(appliedOffsetsByPartition.values()),
            parent_config: {
                checkpoint_id: previous ? `${update.runId}:rev:${previous.revision}` : `${update.runId}:root`,
                thread_id: update.runId,
            },
            pending_writes: update.pendingWrites,
            status: update.status,
            goal: update.goal,
            facts: update.facts,
            token_budget: update.tokenBudget,
            updated_at: now,
        };

        this.snapshots.set(update.runId, snapshot);
        this.schedulePersist();
        return snapshot;
    }

    async flush(): Promise<void> {
        await this.ensureLoaded();

        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        await this.persistDirty();
        if (this.persistInFlight) {
            await this.persistInFlight;
        }

        if (this.lastPersistError) {
            throw this.lastPersistError;
        }
    }

    private schedulePersist(): void {
        this.dirty = true;
        if (this.flushTimer) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.persistDirty();
        }, this.flushDelayMs);
        this.flushTimer.unref?.();
    }

    private async persistDirty(): Promise<void> {
        if (!this.dirty) {
            return;
        }
        if (this.persistInFlight) {
            await this.persistInFlight;
            return;
        }

        this.dirty = false;
        const payload: SnapshotFileShape = {
            formatVersion: 'v2',
            snapshots: Object.fromEntries(this.snapshots.entries()),
            lastUpdated: new Date().toISOString(),
        };

        this.persistInFlight = (async () => {
            await fs.mkdir(dirname(this.snapshotPath), { recursive: true });
            const tempPath = `${this.snapshotPath}.tmp`;
            await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
            await fs.rename(tempPath, this.snapshotPath);
            this.lastPersistError = null;
        })()
            .catch(error => {
                this.lastPersistError = error as Error;
            })
            .finally(() => {
                this.persistInFlight = null;
                if (this.dirty) {
                    void this.persistDirty();
                }
            });

        await this.persistInFlight;
    }

    private async ensureLoaded(): Promise<void> {
        if (this.loaded) {
            return;
        }

        this.loaded = true;
        try {
            const content = await fs.readFile(this.snapshotPath, 'utf-8');
            const parsed = JSON.parse(content) as SnapshotFileShape;
            if (parsed.formatVersion !== 'v2') {
                return;
            }
            for (const [runId, snapshot] of Object.entries(parsed.snapshots)) {
                this.snapshots.set(runId, snapshot);
            }
        } catch (error) {
            if (!isNotFoundError(error)) {
                throw error;
            }
        }
    }
}
