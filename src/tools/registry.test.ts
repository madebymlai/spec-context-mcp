import { describe, it, expect, beforeEach } from 'vitest';
import {
  filterVisibleTools,
  processToolCall,
  resetRegistry,
  getSessionMode,
} from './registry.js';
import type { Tool } from './index.js';

/** Minimal stubs — only name matters for filtering. */
function stubTools(names: string[]): Tool[] {
  return names.map(name => ({
    name,
    description: '',
    inputSchema: { type: 'object' as const, properties: {} },
  }));
}

const ALL_TOOL_NAMES = [
  'search',
  'code_research',
  'spec-workflow-guide',
  'steering-guide',
  'spec-status',
  'approvals',
  'wait-for-approval',
  'get-implementer-guide',
  'get-reviewer-guide',
  'get-brainstorm-guide',
];

const ALL_TOOLS = stubTools(ALL_TOOL_NAMES);

describe('registry', () => {
  beforeEach(() => {
    resetRegistry();
  });

  describe('initial state', () => {
    it('starts in undetermined mode', () => {
      expect(getSessionMode()).toBe('undetermined');
    });

    it('shows 6 initial tools', () => {
      const visible = filterVisibleTools(ALL_TOOLS).map(t => t.name);
      expect(visible).toHaveLength(6);
      expect(visible).toContain('spec-workflow-guide');
      expect(visible).toContain('steering-guide');
      expect(visible).toContain('get-brainstorm-guide');
      expect(visible).toContain('get-implementer-guide');
      expect(visible).toContain('get-reviewer-guide');
      expect(visible).toContain('spec-status');
    });

    it('hides search, code_research, approvals, wait-for-approval', () => {
      const visible = filterVisibleTools(ALL_TOOLS).map(t => t.name);
      expect(visible).not.toContain('search');
      expect(visible).not.toContain('code_research');
      expect(visible).not.toContain('approvals');
      expect(visible).not.toContain('wait-for-approval');
    });
  });

  describe('orchestrator mode', () => {
    it.each([
      'spec-workflow-guide',
      'steering-guide',
      'get-brainstorm-guide',
    ])('triggers on %s', (toolName) => {
      const changed = processToolCall(toolName);
      expect(changed).toBe(true);
      expect(getSessionMode()).toBe('orchestrator');
    });

    it('shows 8 orchestrator tools', () => {
      processToolCall('spec-workflow-guide');
      const visible = filterVisibleTools(ALL_TOOLS).map(t => t.name);
      expect(visible).toHaveLength(8);
      expect(visible).toContain('spec-workflow-guide');
      expect(visible).toContain('steering-guide');
      expect(visible).toContain('get-brainstorm-guide');
      expect(visible).toContain('spec-status');
      expect(visible).toContain('approvals');
      expect(visible).toContain('wait-for-approval');
      expect(visible).toContain('search');
      expect(visible).toContain('code_research');
    });

    it('hides implementer and reviewer guide tools', () => {
      processToolCall('spec-workflow-guide');
      const visible = filterVisibleTools(ALL_TOOLS).map(t => t.name);
      expect(visible).not.toContain('get-implementer-guide');
      expect(visible).not.toContain('get-reviewer-guide');
    });
  });

  describe('implementer mode', () => {
    it('triggers on get-implementer-guide', () => {
      const changed = processToolCall('get-implementer-guide');
      expect(changed).toBe(true);
      expect(getSessionMode()).toBe('implementer');
    });

    it('shows 4 implementer tools', () => {
      processToolCall('get-implementer-guide');
      const visible = filterVisibleTools(ALL_TOOLS).map(t => t.name);
      expect(visible).toHaveLength(4);
      expect(visible).toContain('get-implementer-guide');
      expect(visible).toContain('spec-status');
      expect(visible).toContain('search');
      expect(visible).toContain('code_research');
    });
  });

  describe('reviewer mode', () => {
    it('triggers on get-reviewer-guide', () => {
      const changed = processToolCall('get-reviewer-guide');
      expect(changed).toBe(true);
      expect(getSessionMode()).toBe('reviewer');
    });

    it('shows 3 reviewer tools', () => {
      processToolCall('get-reviewer-guide');
      const visible = filterVisibleTools(ALL_TOOLS).map(t => t.name);
      expect(visible).toHaveLength(3);
      expect(visible).toContain('get-reviewer-guide');
      expect(visible).toContain('search');
      expect(visible).toContain('code_research');
    });
  });

  describe('mode locking', () => {
    it('does not change mode after first transition', () => {
      processToolCall('spec-workflow-guide');
      expect(getSessionMode()).toBe('orchestrator');

      const changed = processToolCall('get-implementer-guide');
      expect(changed).toBe(false);
      expect(getSessionMode()).toBe('orchestrator');
    });
  });

  describe('non-entry tools', () => {
    it.each([
      'spec-status',
      'search',
      'code_research',
      'approvals',
      'wait-for-approval',
    ])('%s does not trigger a mode transition', (toolName) => {
      const changed = processToolCall(toolName);
      expect(changed).toBe(false);
      expect(getSessionMode()).toBe('undetermined');
    });
  });
});
