import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { promises as fs } from 'fs';
import type { RuntimeEventEnvelope, RuntimeEventDraft } from './types.js';

export interface RuntimeEventStreamOptions {
    persistPath?: string;
    maxEventsPerPartition?: number;
    maxIdempotencyEntries?: number;
    disablePersistence?: boolean;
}

const DEFAULT_MAX_EVENTS_PER_PARTITION = 2000;
const DEFAULT_MAX_IDEMPOTENCY_ENTRIES = 10000;
const DEFAULT_PERSIST_PATH = join(homedir(), '.spec-context-mcp', 'runtime-events-v2.jsonl');

export class RuntimeEventStream {
    private readonly byPartition = new Map<string, RuntimeEventEnvelope[]>();
    private readonly idempotencyIndex = new Map<string, RuntimeEventEnvelope>();
    private readonly sequenceByPartition = new Map<string, number>();
    private readonly maxEventsPerPartition: number;
    private readonly maxIdempotencyEntries: number;
    private readonly persistPath: string | null;

    private persistQueue: string[] = [];
    private persistScheduled = false;
    private persistInFlight: Promise<void> | null = null;

    constructor(options: RuntimeEventStreamOptions = {}) {
        this.maxEventsPerPartition = options.maxEventsPerPartition ?? DEFAULT_MAX_EVENTS_PER_PARTITION;
        this.maxIdempotencyEntries = options.maxIdempotencyEntries ?? DEFAULT_MAX_IDEMPOTENCY_ENTRIES;
        this.persistPath = options.disablePersistence ? null : (options.persistPath ?? DEFAULT_PERSIST_PATH);
        this.loadPersistedEvents();
    }

    publish(draft: RuntimeEventDraft): RuntimeEventEnvelope {
        const idempotencyKey = draft.idempotency_key ?? randomUUID();
        const existing = this.idempotencyIndex.get(idempotencyKey);
        if (existing) {
            return existing;
        }

        const sequence = (this.sequenceByPartition.get(draft.partition_key) ?? 0) + 1;
        this.sequenceByPartition.set(draft.partition_key, sequence);

        const now = new Date().toISOString();
        const event: RuntimeEventEnvelope = {
            event_id: randomUUID(),
            idempotency_key: idempotencyKey,
            partition_key: draft.partition_key,
            sequence,
            causal_parent_event_id: draft.causal_parent_event_id ?? null,
            producer_ts: now,
            run_id: draft.run_id,
            step_id: draft.step_id,
            agent_id: draft.agent_id,
            type: draft.type,
            ts: now,
            payload: draft.payload,
            schema_version: 'v2',
        };

        const partitionEvents = this.byPartition.get(draft.partition_key) ?? [];
        partitionEvents.push(event);
        if (partitionEvents.length > this.maxEventsPerPartition) {
            partitionEvents.splice(0, partitionEvents.length - this.maxEventsPerPartition);
        }
        this.byPartition.set(draft.partition_key, partitionEvents);

        this.idempotencyIndex.set(idempotencyKey, event);
        this.trimIdempotencyIndex();

        this.enqueuePersist(event);
        return event;
    }

    readPartition(partitionKey: string, afterSequence: number = 0): RuntimeEventEnvelope[] {
        const events = this.byPartition.get(partitionKey) ?? [];
        if (afterSequence <= 0) {
            return [...events];
        }
        return events.filter(event => event.sequence > afterSequence);
    }

    latestOffset(partitionKey: string): number {
        return this.sequenceByPartition.get(partitionKey) ?? 0;
    }

    async flush(): Promise<void> {
        if (!this.persistPath) {
            return;
        }
        if (this.persistScheduled) {
            this.persistScheduled = false;
            await this.flushPersistQueue();
        }
        if (this.persistInFlight) {
            await this.persistInFlight;
        }
    }

    private trimIdempotencyIndex(): void {
        while (this.idempotencyIndex.size > this.maxIdempotencyEntries) {
            const oldestKey = this.idempotencyIndex.keys().next().value as string | undefined;
            if (!oldestKey) {
                return;
            }
            this.idempotencyIndex.delete(oldestKey);
        }
    }

    private loadPersistedEvents(): void {
        if (!this.persistPath || !existsSync(this.persistPath)) {
            return;
        }

        try {
            const raw = readFileSync(this.persistPath, 'utf-8');
            const lines = raw.split('\n').filter(line => line.trim().length > 0);

            for (const line of lines) {
                try {
                    const event = JSON.parse(line) as RuntimeEventEnvelope;
                    if (!event.partition_key || typeof event.sequence !== 'number') {
                        continue;
                    }

                    const partitionEvents = this.byPartition.get(event.partition_key) ?? [];
                    partitionEvents.push(event);
                    if (partitionEvents.length > this.maxEventsPerPartition) {
                        partitionEvents.splice(0, partitionEvents.length - this.maxEventsPerPartition);
                    }
                    this.byPartition.set(event.partition_key, partitionEvents);
                    this.sequenceByPartition.set(
                        event.partition_key,
                        Math.max(this.sequenceByPartition.get(event.partition_key) ?? 0, event.sequence)
                    );
                    this.idempotencyIndex.set(event.idempotency_key, event);
                    this.trimIdempotencyIndex();
                } catch {
                    // Ignore malformed lines and continue.
                }
            }
        } catch {
            // Persistence is best-effort; startup should not fail on read errors.
        }
    }

    private enqueuePersist(event: RuntimeEventEnvelope): void {
        if (!this.persistPath) {
            return;
        }
        this.persistQueue.push(JSON.stringify(event));
        if (this.persistScheduled) {
            return;
        }
        this.persistScheduled = true;
        setImmediate(() => {
            this.persistScheduled = false;
            void this.flushPersistQueue();
        });
    }

    private async flushPersistQueue(): Promise<void> {
        if (!this.persistPath || this.persistQueue.length === 0) {
            return;
        }
        if (this.persistInFlight) {
            await this.persistInFlight;
            return;
        }

        const lines = this.persistQueue.splice(0, this.persistQueue.length);
        const payload = `${lines.join('\n')}\n`;
        this.persistInFlight = (async () => {
            await fs.mkdir(dirname(this.persistPath as string), { recursive: true });
            await fs.appendFile(this.persistPath as string, payload, 'utf-8');
        })()
            .catch(() => {
                // Persistence failure should not break request handling.
            })
            .finally(() => {
                this.persistInFlight = null;
                if (this.persistQueue.length > 0) {
                    void this.flushPersistQueue();
                }
            });

        await this.persistInFlight;
    }
}
