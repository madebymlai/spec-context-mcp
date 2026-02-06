/**
 * Session mode registry for lazy tool visibility.
 *
 * MCP stdio = one session per process, so module-level state is safe.
 * The first "entry-point" tool call locks the session into a mode,
 * and subsequent tools/list requests only return the tools for that mode.
 */
import type { Tool } from './index.js';
import { isDispatchRuntimeV2Enabled } from '../config/dispatch-runtime.js';

export type SessionMode = 'undetermined' | 'orchestrator' | 'implementer' | 'reviewer';

const INITIAL_TOOLS: ReadonlySet<string> = new Set([
  'spec-workflow-guide',
  'steering-guide',
  'get-brainstorm-guide',
  'get-implementer-guide',
  'get-reviewer-guide',
  'spec-status',
]);

const ORCHESTRATOR_TOOLS: ReadonlySet<string> = new Set([
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

const IMPLEMENTER_TOOLS: ReadonlySet<string> = new Set([
  'get-implementer-guide',
  'spec-status',
  'search',
]);

const REVIEWER_TOOLS: ReadonlySet<string> = new Set([
  'get-reviewer-guide',
  'search',
]);

const MODE_TOOLS: Record<SessionMode, ReadonlySet<string>> = {
  undetermined: INITIAL_TOOLS,
  orchestrator: ORCHESTRATOR_TOOLS,
  implementer: IMPLEMENTER_TOOLS,
  reviewer: REVIEWER_TOOLS,
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

/** Get the current session mode. */
export function getSessionMode(): SessionMode {
  return currentMode;
}

/** Filter an array of tools to only those visible in the current mode. */
export function filterVisibleTools(allTools: Tool[]): Tool[] {
  const visible = MODE_TOOLS[currentMode];
  return allTools.filter(t => {
    if (!visible.has(t.name)) {
      return false;
    }
    if (t.name === 'dispatch-runtime' && !isDispatchRuntimeV2Enabled()) {
      return false;
    }
    return true;
  });
}

/**
 * Process a tool call for mode transition.
 * If the session is undetermined and the tool is an entry-point,
 * locks the mode and returns true (caller should notify client).
 * Returns false if no transition occurred.
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
  return true;
}

/** Reset registry state (for test isolation). */
export function resetRegistry(): void {
  currentMode = 'undetermined';
}
