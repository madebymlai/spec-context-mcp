/**
 * Tests for the visibility gate logic used in server.ts.
 *
 * The server's CallToolRequest handler runs:
 *   1. processToolCall(name)   — mode transition
 *   2. isToolVisible(name)     — pre-check gate (reject if not visible)
 *   3. handleToolCall(name, …) — execute
 *   4. tier before/after diff  — send tools/list_changed if changed
 *
 * These tests verify the gate logic at the registry level without
 * needing the full MCP SDK server harness.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  processToolCall,
  isToolVisible,
  getSessionMode,
  getVisibilityTier,
  resetRegistry,
  escalateTier,
} from './registry.js';

describe('visibility gate (server pre-check)', () => {
  beforeEach(() => {
    resetRegistry();
    delete process.env.SPEC_CONTEXT_DISPATCH_RUNTIME_V2;
  });

  describe('undetermined mode', () => {
    it('allows entry-point tools (triggers mode lock)', () => {
      // Simulate server flow: processToolCall → isToolVisible
      const changed = processToolCall('get-implementer-guide');
      expect(changed).toBe(true);
      expect(isToolVisible('get-implementer-guide')).toBe(true);
    });

    it('rejects non-entry tools that are not in initial set', () => {
      // No mode transition, search is not in INITIAL_TOOLS
      const changed = processToolCall('search');
      expect(changed).toBe(false);
      expect(isToolVisible('search')).toBe(false);
    });

    it('allows spec-status in undetermined mode (it is in initial set)', () => {
      expect(isToolVisible('spec-status')).toBe(true);
    });
  });

  describe('implementer mode gate', () => {
    beforeEach(() => {
      processToolCall('get-implementer-guide');
    });

    it('allows L1 tools: search, spec-status, get-implementer-guide', () => {
      expect(isToolVisible('search')).toBe(true);
      expect(isToolVisible('spec-status')).toBe(true);
      expect(isToolVisible('get-implementer-guide')).toBe(true);
    });

    it('rejects code_research at L1', () => {
      expect(isToolVisible('code_research')).toBe(false);
    });

    it('rejects orchestrator tools at L1', () => {
      expect(isToolVisible('approvals')).toBe(false);
      expect(isToolVisible('wait-for-approval')).toBe(false);
      expect(isToolVisible('dispatch-runtime')).toBe(false);
    });

    it('allows code_research after escalation to L2', () => {
      expect(isToolVisible('code_research')).toBe(false);
      escalateTier();
      expect(getVisibilityTier()).toBe(2);
      expect(isToolVisible('code_research')).toBe(true);
    });

    it('still rejects orchestrator tools at L2', () => {
      escalateTier();
      expect(isToolVisible('approvals')).toBe(false);
      expect(isToolVisible('dispatch-runtime')).toBe(false);
    });

    it('allows everything at L3', () => {
      escalateTier();
      escalateTier();
      expect(getVisibilityTier()).toBe(3);
      expect(isToolVisible('approvals')).toBe(true);
      expect(isToolVisible('get-reviewer-guide')).toBe(true);
      expect(isToolVisible('code_research')).toBe(true);
    });
  });

  describe('reviewer mode gate', () => {
    beforeEach(() => {
      processToolCall('get-reviewer-guide');
    });

    it('allows L1 tools: search, get-reviewer-guide', () => {
      expect(isToolVisible('search')).toBe(true);
      expect(isToolVisible('get-reviewer-guide')).toBe(true);
    });

    it('rejects spec-status and code_research at L1', () => {
      expect(isToolVisible('spec-status')).toBe(false);
      expect(isToolVisible('code_research')).toBe(false);
    });

    it('allows code_research and spec-status after escalation to L2', () => {
      escalateTier();
      expect(isToolVisible('code_research')).toBe(true);
      expect(isToolVisible('spec-status')).toBe(true);
    });
  });

  describe('orchestrator mode gate', () => {
    beforeEach(() => {
      processToolCall('spec-workflow-guide');
    });

    it('allows broad tool set at L1', () => {
      expect(isToolVisible('search')).toBe(true);
      expect(isToolVisible('code_research')).toBe(true);
      expect(isToolVisible('approvals')).toBe(true);
      expect(isToolVisible('spec-status')).toBe(true);
    });

    it('rejects sub-agent guide tools at L1', () => {
      expect(isToolVisible('get-implementer-guide')).toBe(false);
      expect(isToolVisible('get-reviewer-guide')).toBe(false);
    });
  });

  describe('tier change detection (for tools/list_changed)', () => {
    it('detects mode transition as visibility change', () => {
      const tierBefore = getVisibilityTier();
      const modeChanged = processToolCall('get-implementer-guide');
      const tierAfter = getVisibilityTier();

      // Server should notify: modeChanged is true
      expect(modeChanged).toBe(true);
      expect(tierBefore).toBe(tierAfter); // tier itself didn't change, but mode did
    });

    it('detects programmatic tier escalation as visibility change', () => {
      processToolCall('get-implementer-guide');
      const tierBefore = getVisibilityTier();
      escalateTier();
      const tierAfter = getVisibilityTier();

      expect(tierBefore).not.toBe(tierAfter);
    });

    it('no visibility change on regular L1 tool call', () => {
      processToolCall('get-implementer-guide');
      const tierBefore = getVisibilityTier();
      // Calling search (already in L1) doesn't change anything
      const changed = processToolCall('search');
      const tierAfter = getVisibilityTier();

      expect(changed).toBe(false);
      expect(tierBefore).toBe(tierAfter);
    });
  });
});
