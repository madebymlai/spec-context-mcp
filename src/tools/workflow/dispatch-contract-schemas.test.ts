import { describe, expect, it } from 'vitest';
import {
  DISPATCH_CONTRACT_SCHEMA_VERSION,
  DISPATCH_IMPLEMENTER_SCHEMA_ID,
  DISPATCH_REVIEWER_SCHEMA_ID,
  isImplementerResult,
  isReviewerResult,
  registerDispatchContractSchemas,
} from './dispatch-contract-schemas.js';

describe('dispatch-contract-schemas', () => {
  it('exports stable schema ids and version', () => {
    expect(DISPATCH_CONTRACT_SCHEMA_VERSION).toBe('v1');
    expect(DISPATCH_IMPLEMENTER_SCHEMA_ID).toBe('dispatch_result_implementer');
    expect(DISPATCH_REVIEWER_SCHEMA_ID).toBe('dispatch_result_reviewer');
  });

  it('validates implementer payloads', () => {
    const valid = {
      task_id: '1.1',
      status: 'completed',
      summary: 'Done',
      files_changed: ['src/a.ts'],
      tests: [{ command: 'npm test --run', passed: true }],
      follow_up_actions: [],
    };
    const invalid = {
      task_id: '1.1',
      status: 'completed',
      summary: 'Done',
      files_changed: ['src/a.ts'],
      follow_up_actions: [],
    };

    expect(isImplementerResult(valid)).toBe(true);
    expect(isImplementerResult(invalid)).toBe(false);
  });

  it('validates reviewer payloads', () => {
    const valid = {
      task_id: '1.1',
      assessment: 'needs_changes',
      strengths: ['good structure'],
      issues: [{ severity: 'important', message: 'Missing check', fix: 'Add guard' }],
      required_fixes: ['Add guard'],
    };
    const invalid = {
      task_id: '1.1',
      assessment: 'needs_changes',
      strengths: ['good structure'],
      issues: [{ severity: 'major', message: 'Missing check', fix: 'Add guard' }],
      required_fixes: ['Add guard'],
    };

    expect(isReviewerResult(valid)).toBe(true);
    expect(isReviewerResult(invalid)).toBe(false);
  });

  it('registers both canonical schemas through registry abstraction', () => {
    const calls: Array<{ type: string; schemaId: string; schemaVersion: string }> = [];
    const registry = {
      register<T>(type: string, schemaId: string, schemaVersion: string, _validate: (payload: unknown) => payload is T) {
        calls.push({ type, schemaId, schemaVersion });
      },
    };

    registerDispatchContractSchemas(registry);

    expect(calls).toEqual([
      {
        type: 'dispatch.result.implementer',
        schemaId: DISPATCH_IMPLEMENTER_SCHEMA_ID,
        schemaVersion: DISPATCH_CONTRACT_SCHEMA_VERSION,
      },
      {
        type: 'dispatch.result.reviewer',
        schemaId: DISPATCH_REVIEWER_SCHEMA_ID,
        schemaVersion: DISPATCH_CONTRACT_SCHEMA_VERSION,
      },
    ]);
  });
});
