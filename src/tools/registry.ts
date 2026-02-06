/**
 * Session mode registry with 3-level tool visibility fallback.
 *
 * MCP stdio = one session per process, so module-level state is safe.
 * The first "entry-point" tool call locks the session into a mode,
 * and subsequent tools/list requests return tools for that mode + tier.
 *
 * Tier model (inspired by "Less-is-More", arXiv:2411.15399):
 *   L1 (strict):   Tight role-specific set — default after mode lock.
 *   L2 (extended):  Role tools + commonly needed extras (code_research).
 *   L3 (all):       Full tool set — safety-net fallback.
 *
 * Escalation triggers:
 *   - Programmatic: tool handlers / dispatch-runtime call escalateTier().
 *   - Pre-check gate: server rejects calls to non-visible tools (isToolVisible).
 */
import type { Tool } from './index.js';
import { isDispatchRuntimeV2Enabled } from '../config/dispatch-runtime.js';

export type SessionMode = 'undetermined' | 'orchestrator' | 'implementer' | 'reviewer';
export type VisibilityTier = 1 | 2 | 3;

// --- Tool sets ---

const ALL_TOOLS: ReadonlySet<string> = new Set([
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
]);

const INITIAL_TOOLS: ReadonlySet<string> = new Set([
  'spec-workflow-guide',
  'steering-guide',
  'get-brainstorm-guide',
  'get-implementer-guide',
  'get-reviewer-guide',
  'spec-status',
]);

// Orchestrator: already broad, L1 = L2
const ORCHESTRATOR_L1: ReadonlySet<string> = new Set([
  'spec-workflow-guide',
  'steering-guide',
  'get-brainstorm-guide',
  'spec-status',
  'approvals',
  'wait-for-approval',
  'dispatch-runtime',
  'search',
  'code_research',
]);

// Implementer: L1 tight, L2 adds code_research
const IMPLEMENTER_L1: ReadonlySet<string> = new Set([
  'get-implementer-guide',
  'spec-status',
  'search',
]);

const IMPLEMENTER_L2: ReadonlySet<string> = new Set([
  ...IMPLEMENTER_L1,
  'code_research',
]);

// Reviewer: L1 tight, L2 adds code_research + spec-status
const REVIEWER_L1: ReadonlySet<string> = new Set([
  'get-reviewer-guide',
  'search',
]);

const REVIEWER_L2: ReadonlySet<string> = new Set([
  ...REVIEWER_L1,
  'code_research',
  'spec-status',
]);

type TierSets = readonly [ReadonlySet<string>, ReadonlySet<string>, ReadonlySet<string>];

const MODE_TIERS: Record<SessionMode, TierSets> = {
  undetermined: [INITIAL_TOOLS, INITIAL_TOOLS, ALL_TOOLS],
  orchestrator: [ORCHESTRATOR_L1, ORCHESTRATOR_L1, ALL_TOOLS],
  implementer: [IMPLEMENTER_L1, IMPLEMENTER_L2, ALL_TOOLS],
  reviewer: [REVIEWER_L1, REVIEWER_L2, ALL_TOOLS],
};

/** Maps entry-point tool names to the mode they trigger. */
const ENTRY_POINT_MAP: Record<string, SessionMode> = {
  'spec-workflow-guide': 'orchestrator',
  'steering-guide': 'orchestrator',
  'get-brainstorm-guide': 'orchestrator',
  'get-implementer-guide': 'implementer',
  'get-reviewer-guide': 'reviewer',
};

let currentMode: SessionMode = 'undetermined';
let currentTier: VisibilityTier = 1;

/** Get the current session mode. */
export function getSessionMode(): SessionMode {
  return currentMode;
}

/** Get the current visibility tier (1 = strict, 2 = extended, 3 = all). */
export function getVisibilityTier(): VisibilityTier {
  return currentTier;
}

/**
 * Check whether a tool name is visible in the current mode + tier.
 * Used by server.ts to gate execution before dispatch.
 */
export function isToolVisible(name: string): boolean {
  const visible = MODE_TIERS[currentMode][currentTier - 1];
  if (!visible.has(name)) {
    return false;
  }
  if (name === 'dispatch-runtime' && !isDispatchRuntimeV2Enabled()) {
    return false;
  }
  return true;
}

/** Filter an array of tools to only those visible in the current mode and tier. */
export function filterVisibleTools(allTools: Tool[]): Tool[] {
  return allTools.filter(t => isToolVisible(t.name));
}

/**
 * Programmatically escalate to the next visibility tier.
 * Always advances exactly one level (L1→L2 or L2→L3).
 * Returns true if tier changed (caller should notify client).
 */
export function escalateTier(): boolean {
  if (currentTier >= 3) {
    return false;
  }
  const prev = currentTier;
  currentTier = (currentTier + 1) as VisibilityTier;
  console.error(`[registry] tier escalation: ${currentMode} L${prev} → L${currentTier} (programmatic)`);
  return true;
}

/**
 * Ensure visibility is at least the requested tier.
 * Does not downshift. Returns true only when a tier increase happened.
 */
export function ensureTierAtLeast(minTier: VisibilityTier): boolean {
  const target = Math.max(1, Math.min(3, minTier)) as VisibilityTier;
  if (currentTier >= target) {
    return false;
  }
  const prev = currentTier;
  currentTier = target;
  console.error(`[registry] tier escalation: ${currentMode} L${prev} → L${currentTier} (ensure>=L${target})`);
  return true;
}

/**
 * Process a tool call for mode transition.
 *
 * Mode transition: If undetermined and tool is an entry-point, locks mode.
 * No reactive tier escalation — tiers advance only via escalateTier().
 *
 * Returns true if visibility changed (caller should notify client).
 */
export function processToolCall(name: string): boolean {
  if (currentMode !== 'undetermined') {
    return false;
  }
  const targetMode = ENTRY_POINT_MAP[name];
  if (!targetMode) {
    return false;
  }
  currentMode = targetMode;
  currentTier = 1;
  return true;
}

/** Reset registry state (for test isolation). */
export function resetRegistry(): void {
  currentMode = 'undetermined';
  currentTier = 1;
}
