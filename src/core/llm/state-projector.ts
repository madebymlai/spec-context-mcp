import type { RuntimeEventEnvelope, StateSnapshot, StateSnapshotFact } from './types.js';

function statusFromEvent(event: RuntimeEventEnvelope): StateSnapshot['status'] {
    switch (event.type) {
        case 'ERROR':
            return 'failed';
        case 'BUDGET_DECISION': {
            const decision = String((event.payload as any)?.decision ?? 'allow');
            return decision === 'deny' ? 'blocked' : 'running';
        }
        case 'LLM_RESPONSE':
            return 'done';
        default:
            return 'running';
    }
}

function factFromEvent(event: RuntimeEventEnvelope): StateSnapshotFact {
    return {
        k: `event:${event.type.toLowerCase()}`,
        v: JSON.stringify(event.payload),
        confidence: 1,
    };
}

export interface ProjectedSnapshotInput {
    event: RuntimeEventEnvelope;
    previous: StateSnapshot | null;
}

export interface ProjectedSnapshot {
    runId: string;
    goal: string;
    status: StateSnapshot['status'];
    facts: StateSnapshotFact[];
    pendingWrites: StateSnapshot['pending_writes'];
    tokenBudget: StateSnapshot['token_budget'];
    appliedOffset: StateSnapshot['applied_offsets'][number];
}

export class StateProjector {
    apply({ event, previous }: ProjectedSnapshotInput): ProjectedSnapshot {
        const facts = previous ? [...previous.facts] : [];
        facts.push(factFromEvent(event));

        return {
            runId: event.run_id,
            goal: previous?.goal ?? `${event.agent_id}:${event.step_id}`,
            status: statusFromEvent(event),
            facts,
            pendingWrites: [
                {
                    channel: 'runtime-events',
                    task_id: event.step_id,
                    value: event.payload,
                },
            ],
            tokenBudget: previous?.token_budget ?? {
                remaining_input: 0,
                remaining_output: 0,
            },
            appliedOffset: {
                partition_key: event.partition_key,
                sequence: event.sequence,
            },
        };
    }
}
