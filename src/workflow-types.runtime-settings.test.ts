import { describe, expect, it } from 'vitest';
import type { GlobalSettings, RuntimeSettings } from './workflow-types.js';

describe('workflow runtime settings types', () => {
  it('allows runtimeSettings on GlobalSettings', () => {
    const runtimeSettings: RuntimeSettings = {
      discipline: 'standard',
      implementer: 'codex',
      reviewer: 'claude',
      implementerModelSimple: 'gpt-5-mini',
      implementerModelComplex: 'gpt-5',
      reviewerModelSimple: 'claude-sonnet',
      reviewerModelComplex: 'claude-opus',
      dashboardUrl: 'http://localhost:3000',
    };

    const settings: GlobalSettings = {
      automationJobs: [],
      runtimeSettings,
    };

    expect(settings.runtimeSettings?.discipline).toBe('standard');
  });
});
