import { randomUUID } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import type { RuntimeEventEnvelope, RuntimeEventDraft } from './types.js';
import type { RuntimeEventStorage } from './runtime-event-storage.js';

export interface RuntimeEventStreamOptions {
    persistPath?: string;
    maxEventsPerPartition?: number;
    maxIdempotencyEntries?: number;
    disablePersistence?: boolean;
    storage?: RuntimeEventStorage;
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
    private readonly storage: RuntimeEventStorage | null;

    private persistQueue: string[] = [];
    private persistScheduled = false;
    private persistInFlight: Promise<void> | null = null;

    constructor(options: RuntimeEventStreamOptions = {}) {
        this.maxEventsPerPartition = options.maxEventsPerPartition ?? DEFAULT_MAX_EVENTS_PER_PARTITION;
        this.maxIdempotencyEntries = options.maxIdempotencyEntries ?? DEFAULT_MAX_IDEMPOTENCY_ENTRIES;
        this.persistPath = options.disablePersistence ? null : (options.persistPath ?? DEFAULT_PERSIST_PATH);
        this.storage = this.persistPath ? (options.storage ?? null) : null;
        if (this.persistPath && !this.storage) {
            throw new Error('RuntimeEventStream requires a storage implementation when persistence is enabled');
        }
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
        const persistPath = this.persistPath;
        const storage = this.storage;
        if (!persistPath || !storage || !storage.exists(persistPath)) {
            return;
        }

        const raw = storage.readFile(persistPath);
        const lines = raw.split('\n').filter(line => line.trim().length > 0);

        for (const [lineNumber, line] of lines.entries()) {
            const event = this.parsePersistedEvent(line, lineNumber + 1);
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
        const persistPath = this.persistPath;
        const storage = this.storage;
        if (!persistPath || !storage || this.persistQueue.length === 0) {
            return;
        }
        if (this.persistInFlight) {
            await this.persistInFlight;
            return;
        }

        const lines = this.persistQueue.splice(0, this.persistQueue.length);
        const payload = `${lines.join('\n')}\n`;
        this.persistInFlight = (async () => {
            await storage.ensureDirectory(persistPath);
            await storage.appendFile(persistPath, payload);
        })()
            .finally(() => {
                this.persistInFlight = null;
                if (this.persistQueue.length > 0) {
                    void this.flushPersistQueue();
                }
            });

        await this.persistInFlight;
    }

    private parsePersistedEvent(line: string, lineNumber: number): RuntimeEventEnvelope {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object') {
            throw new Error(`Invalid runtime event payload at ${this.persistPath}:${lineNumber}`);
        }
        const event = parsed as RuntimeEventEnvelope;
        if (!event.partition_key || typeof event.partition_key !== 'string') {
            throw new Error(`Missing partition_key in runtime event at ${this.persistPath}:${lineNumber}`);
        }
        if (typeof event.sequence !== 'number') {
            throw new Error(`Missing sequence in runtime event at ${this.persistPath}:${lineNumber}`);
        }
        if (!event.idempotency_key || typeof event.idempotency_key !== 'string') {
            throw new Error(`Missing idempotency_key in runtime event at ${this.persistPath}:${lineNumber}`);
        }
        return event;
    }
}
