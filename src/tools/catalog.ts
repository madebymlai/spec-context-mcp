export const TOOL_CATALOG_ORDER = [
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
] as const;

export type ToolName = typeof TOOL_CATALOG_ORDER[number];

export const ENTRY_POINT_MODE_MAP = {
  'spec-workflow-guide': 'orchestrator',
  'steering-guide': 'orchestrator',
  'get-brainstorm-guide': 'orchestrator',
  'get-implementer-guide': 'implementer',
  'get-reviewer-guide': 'reviewer',
} as const;

export const TOOL_TIERS_BY_MODE = {
  undetermined: {
    1: [
      'spec-workflow-guide',
      'steering-guide',
      'get-brainstorm-guide',
      'get-implementer-guide',
      'get-reviewer-guide',
      'spec-status',
    ],
    2: [
      'spec-workflow-guide',
      'steering-guide',
      'get-brainstorm-guide',
      'get-implementer-guide',
      'get-reviewer-guide',
      'spec-status',
    ],
    3: TOOL_CATALOG_ORDER,
  },
  orchestrator: {
    1: [
      'spec-workflow-guide',
      'steering-guide',
      'get-brainstorm-guide',
      'spec-status',
      'approvals',
      'wait-for-approval',
      'dispatch-runtime',
      'search',
      'code_research',
    ],
    2: [
      'spec-workflow-guide',
      'steering-guide',
      'get-brainstorm-guide',
      'spec-status',
      'approvals',
      'wait-for-approval',
      'dispatch-runtime',
      'search',
      'code_research',
    ],
    3: TOOL_CATALOG_ORDER,
  },
  implementer: {
    1: [
      'get-implementer-guide',
      'spec-status',
      'search',
    ],
    2: [
      'get-implementer-guide',
      'spec-status',
      'search',
      'code_research',
    ],
    3: TOOL_CATALOG_ORDER,
  },
  reviewer: {
    1: [
      'get-reviewer-guide',
      'search',
    ],
    2: [
      'get-reviewer-guide',
      'search',
      'code_research',
      'spec-status',
    ],
    3: TOOL_CATALOG_ORDER,
  },
} as const;
