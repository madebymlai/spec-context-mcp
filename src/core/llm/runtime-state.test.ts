import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';
import { RuntimeEventStream } from './runtime-event-stream.js';
import { RuntimeSnapshotStore } from './runtime-snapshot-store.js';

describe('Runtime state contracts', () => {
    it('assigns monotonic per-partition sequences with idempotency', () => {
        const stream = new RuntimeEventStream({ disablePersistence: true });
        const first = stream.publish({
            idempotency_key: 'key-1',
            partition_key: 'run-1',
            run_id: 'run-1',
            step_id: 's1',
            agent_id: 'a1',
            type: 'LLM_REQUEST',
            payload: {},
        });
        const duplicate = stream.publish({
            idempotency_key: 'key-1',
            partition_key: 'run-1',
            run_id: 'run-1',
            step_id: 's1',
            agent_id: 'a1',
            type: 'LLM_REQUEST',
            payload: {},
        });
        const second = stream.publish({
            partition_key: 'run-1',
            run_id: 'run-1',
            step_id: 's2',
            agent_id: 'a1',
            type: 'LLM_RESPONSE',
            payload: {},
        });

        expect(first.sequence).toBe(1);
        expect(duplicate.sequence).toBe(1);
        expect(second.sequence).toBe(2);
    });

    it('stores lineage and pending writes in snapshot schema', async () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'runtime-snapshot-test-'));
        const path = join(tempDir, 'snapshots.json');
        const store = new RuntimeSnapshotStore(path);

        const first = await store.upsert({
            runId: 'run-2',
            goal: 'test-goal',
            status: 'running',
            facts: [{ k: 'f1', v: 'v1', confidence: 1 }],
            pendingWrites: [{ channel: 'c1', task_id: 't1', value: { ok: true } }],
            tokenBudget: { remaining_input: 1000, remaining_output: 500 },
            appliedOffset: { partition_key: 'run-2', sequence: 2 },
        });

        const second = await store.upsert({
            runId: 'run-2',
            goal: 'test-goal',
            status: 'done',
            facts: [{ k: 'f2', v: 'v2', confidence: 1 }],
            pendingWrites: [{ channel: 'c1', task_id: 't2', value: { ok: false } }],
            tokenBudget: { remaining_input: 900, remaining_output: 400 },
            appliedOffset: { partition_key: 'run-2', sequence: 3 },
        });

        expect(first.parent_config.checkpoint_id).toBe('run-2:root');
        expect(second.parent_config.checkpoint_id).toBe('run-2:rev:1');
        expect(second.pending_writes[0]?.task_id).toBe('t2');
        expect(second.applied_offsets[0]?.sequence).toBe(3);

        await store.flush();
        rmSync(tempDir, { recursive: true, force: true });
    });
});
