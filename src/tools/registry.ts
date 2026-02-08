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
import { ENTRY_POINT_MODE_MAP, TOOL_TIERS_BY_MODE, type ToolName } from './catalog.js';

export type SessionMode = 'undetermined' | 'orchestrator' | 'implementer' | 'reviewer';
export type VisibilityTier = 1 | 2 | 3;

type TierSets = readonly [ReadonlySet<string>, ReadonlySet<string>, ReadonlySet<string>];
type ToolTierMap = Record<1 | 2 | 3, readonly ToolName[]>;

function toTierSets(tiers: ToolTierMap): TierSets {
  return [
    new Set<string>(tiers[1]),
    new Set<string>(tiers[2]),
    new Set<string>(tiers[3]),
  ];
}

const MODE_TIERS: Record<SessionMode, TierSets> = {
  undetermined: toTierSets(TOOL_TIERS_BY_MODE.undetermined),
  orchestrator: toTierSets(TOOL_TIERS_BY_MODE.orchestrator),
  implementer: toTierSets(TOOL_TIERS_BY_MODE.implementer),
  reviewer: toTierSets(TOOL_TIERS_BY_MODE.reviewer),
};

/** Maps entry-point tool names to the mode they trigger. */
const ENTRY_POINT_MAP: Record<string, SessionMode> = ENTRY_POINT_MODE_MAP;

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
  return visible.has(name);
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
