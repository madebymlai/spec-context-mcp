import { describe, it, expect, beforeEach } from 'vitest';
import {
  filterVisibleTools,
  processToolCall,
  resetRegistry,
  getSessionMode,
  getVisibilityTier,
  escalateTier,
  isToolVisible,
  ensureTierAtLeast,
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
  'dispatch-runtime',
];

const ALL_TOOLS = stubTools(ALL_TOOL_NAMES);

describe('registry', () => {
  beforeEach(() => {
    resetRegistry();
    delete process.env.SPEC_CONTEXT_DISPATCH_RUNTIME_V2;
  });

  describe('initial state', () => {
    it('starts in undetermined mode', () => {
      expect(getSessionMode()).toBe('undetermined');
    });

    it('starts at tier 1', () => {
      expect(getVisibilityTier()).toBe(1);
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

    it('hides search, code_research, approvals, wait-for-approval, dispatch-runtime', () => {
      const visible = filterVisibleTools(ALL_TOOLS).map(t => t.name);
      expect(visible).not.toContain('search');
      expect(visible).not.toContain('code_research');
      expect(visible).not.toContain('approvals');
      expect(visible).not.toContain('wait-for-approval');
      expect(visible).not.toContain('dispatch-runtime');
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

    it('shows 8 orchestrator tools when dispatch runtime v2 is disabled', () => {
      processToolCall('spec-workflow-guide');
      const visible = filterVisibleTools(ALL_TOOLS).map(t => t.name);
      expect(visible).toHaveLength(8);
      expect(visible).toContain('spec-workflow-guide');
      expect(visible).toContain('steering-guide');
      expect(visible).toContain('get-brainstorm-guide');
      expect(visible).toContain('spec-status');
      expect(visible).toContain('approvals');
      expect(visible).toContain('wait-for-approval');
      expect(visible).not.toContain('dispatch-runtime');
      expect(visible).toContain('search');
      expect(visible).toContain('code_research');
    });

    it('shows dispatch-runtime when v2 flag is enabled', () => {
      process.env.SPEC_CONTEXT_DISPATCH_RUNTIME_V2 = '1';
      processToolCall('spec-workflow-guide');
      const visible = filterVisibleTools(ALL_TOOLS).map(t => t.name);
      expect(visible).toHaveLength(9);
      expect(visible).toContain('dispatch-runtime');
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

    it('shows 3 implementer tools at L1', () => {
      processToolCall('get-implementer-guide');
      expect(getVisibilityTier()).toBe(1);
      const visible = filterVisibleTools(ALL_TOOLS).map(t => t.name);
      expect(visible).toHaveLength(3);
      expect(visible).toContain('get-implementer-guide');
      expect(visible).toContain('spec-status');
      expect(visible).toContain('search');
      expect(visible).not.toContain('code_research');
    });

    it('shows 4 implementer tools at L2', () => {
      processToolCall('get-implementer-guide');
      escalateTier();
      expect(getVisibilityTier()).toBe(2);
      const visible = filterVisibleTools(ALL_TOOLS).map(t => t.name);
      expect(visible).toHaveLength(4);
      expect(visible).toContain('get-implementer-guide');
      expect(visible).toContain('spec-status');
      expect(visible).toContain('search');
      expect(visible).toContain('code_research');
    });

    it('shows all tools at L3', () => {
      processToolCall('get-implementer-guide');
      escalateTier();
      escalateTier();
      expect(getVisibilityTier()).toBe(3);
      const visible = filterVisibleTools(ALL_TOOLS).map(t => t.name);
      // L3 = all tools minus dispatch-runtime when v2 disabled
      expect(visible).toHaveLength(10);
      expect(visible).toContain('code_research');
      expect(visible).toContain('approvals');
      expect(visible).toContain('get-reviewer-guide');
    });
  });

  describe('reviewer mode', () => {
    it('triggers on get-reviewer-guide', () => {
      const changed = processToolCall('get-reviewer-guide');
      expect(changed).toBe(true);
      expect(getSessionMode()).toBe('reviewer');
    });

    it('shows 2 reviewer tools at L1', () => {
      processToolCall('get-reviewer-guide');
      const visible = filterVisibleTools(ALL_TOOLS).map(t => t.name);
      expect(visible).toHaveLength(2);
      expect(visible).toContain('get-reviewer-guide');
      expect(visible).toContain('search');
      expect(visible).not.toContain('code_research');
    });

    it('shows 4 reviewer tools at L2', () => {
      processToolCall('get-reviewer-guide');
      escalateTier();
      expect(getVisibilityTier()).toBe(2);
      const visible = filterVisibleTools(ALL_TOOLS).map(t => t.name);
      expect(visible).toHaveLength(4);
      expect(visible).toContain('get-reviewer-guide');
      expect(visible).toContain('search');
      expect(visible).toContain('code_research');
      expect(visible).toContain('spec-status');
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
      'dispatch-runtime',
    ])('%s does not trigger mode transition or tier change', (toolName) => {
      const changed = processToolCall(toolName);
      expect(changed).toBe(false);
      expect(getSessionMode()).toBe('undetermined');
      expect(getVisibilityTier()).toBe(1);
    });
  });

  describe('isToolVisible', () => {
    it('returns true for tools in current tier', () => {
      processToolCall('get-implementer-guide');
      expect(isToolVisible('search')).toBe(true);
      expect(isToolVisible('spec-status')).toBe(true);
      expect(isToolVisible('get-implementer-guide')).toBe(true);
    });

    it('returns false for tools outside current tier', () => {
      processToolCall('get-implementer-guide');
      expect(isToolVisible('code_research')).toBe(false);
      expect(isToolVisible('approvals')).toBe(false);
    });

    it('returns true after tier escalation exposes the tool', () => {
      processToolCall('get-implementer-guide');
      expect(isToolVisible('code_research')).toBe(false);
      escalateTier();
      expect(isToolVisible('code_research')).toBe(true);
    });

    it('rejects hidden tools in undetermined mode', () => {
      expect(isToolVisible('search')).toBe(false);
      expect(isToolVisible('code_research')).toBe(false);
      expect(isToolVisible('approvals')).toBe(false);
    });

    it('allows initial tools in undetermined mode', () => {
      expect(isToolVisible('spec-workflow-guide')).toBe(true);
      expect(isToolVisible('get-implementer-guide')).toBe(true);
      expect(isToolVisible('spec-status')).toBe(true);
    });
  });

  describe('tier escalation', () => {
    it('escalateTier advances L1 → L2 → L3', () => {
      processToolCall('get-implementer-guide');
      expect(getVisibilityTier()).toBe(1);

      expect(escalateTier()).toBe(true);
      expect(getVisibilityTier()).toBe(2);

      expect(escalateTier()).toBe(true);
      expect(getVisibilityTier()).toBe(3);
    });

    it('escalateTier returns false at L3', () => {
      processToolCall('get-implementer-guide');
      escalateTier();
      escalateTier();
      expect(escalateTier()).toBe(false);
      expect(getVisibilityTier()).toBe(3);
    });

    it('resetRegistry resets tier to 1', () => {
      processToolCall('get-implementer-guide');
      escalateTier();
      expect(getVisibilityTier()).toBe(2);
      resetRegistry();
      expect(getVisibilityTier()).toBe(1);
    });

    it('advances exactly one level per call (no tier skipping)', () => {
      processToolCall('get-implementer-guide');
      escalateTier();
      // Even though L2 doesn't have 'approvals', escalateTier only goes one step
      expect(getVisibilityTier()).toBe(2);
      expect(isToolVisible('approvals')).toBe(false);
      escalateTier();
      expect(getVisibilityTier()).toBe(3);
      expect(isToolVisible('approvals')).toBe(true);
    });

    it('ensureTierAtLeast(2) promotes L1 to L2 without jumping to L3', () => {
      processToolCall('get-implementer-guide');
      expect(getVisibilityTier()).toBe(1);
      expect(ensureTierAtLeast(2)).toBe(true);
      expect(getVisibilityTier()).toBe(2);
      expect(ensureTierAtLeast(2)).toBe(false);
      expect(getVisibilityTier()).toBe(2);
    });
  });
});
