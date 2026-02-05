# Tasks Document: Discipline Workflow

> Tasks follow TDD - tests are written as part of each task, not as separate tasks.
> Test files: colocate with source as `*.test.ts` (e.g., `src/config/discipline.test.ts`)

- [x] 1. Add discipline configuration module
  - File: src/config/discipline.ts (create src/config/ directory)
  - Read SPEC_CONTEXT_DISCIPLINE from environment (default: 'full')
  - Read SPEC_CONTEXT_IMPLEMENTER, SPEC_CONTEXT_REVIEWER, SPEC_CONTEXT_BRAINSTORM
  - Export getDisciplineMode() and getDispatchCli() functions
  - Purpose: Centralize discipline configuration reading
  - _Leverage: src/server.ts for env var patterns_
  - _Requirements: 1, 2_
  - _Prompt: |
      Implement the task for spec discipline-workflow, first run spec-workflow-guide to get the workflow guide then implement the task:

      Role: TypeScript Developer specializing in configuration management

      Task: Create discipline configuration module:
      1. Create src/config/ directory
      2. Create src/config/discipline.ts
      3. Read SPEC_CONTEXT_DISCIPLINE (full|standard|minimal, default full)
      4. Read SPEC_CONTEXT_IMPLEMENTER/REVIEWER/BRAINSTORM env vars
      5. Export getDisciplineMode() returning the mode
      6. Export getDispatchCli(role) returning the CLI for a role or null

      Restrictions:
      - Do not add validation beyond the three valid modes
      - Return null for unset CLI vars (not empty string)
      - Keep it simple - no classes, just pure functions

      Success:
      - src/config/ directory created
      - getDisciplineMode() returns 'full' | 'standard' | 'minimal'
      - getDispatchCli('implementer') returns string or null
      - Invalid mode logs warning and defaults to 'full'
      - Unit tests cover all modes and CLI scenarios

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [x] 2. Create principles-template.md
  - File: src/templates/principles-template.md
  - Add SOLID principles section with "Ask yourself" questions
  - Add Architecture Rules section
  - Add Design Patterns section
  - Add Quality Gates section
  - Purpose: Template for new principles.md steering doc
  - _Leverage: aegis-trader/.spec-context/steering/tech.md for Key Principles format_
  - _Requirements: 6_
  - _Prompt: |
      Implement the task for spec discipline-workflow, first run spec-workflow-guide to get the workflow guide then implement the task:

      Role: Technical Writer specializing in developer documentation

      Task: Create principles-template.md with sections for Architecture Rules, Coding Standards (including SOLID with "Ask yourself" questions), Design Patterns, and Quality Gates. Use the format from aegis-trader's tech.md Key Principles section as reference.

      Restrictions:
      - Follow existing template format patterns
      - Include placeholder text showing what to fill in
      - Do not include project-specific content

      Success:
      - Template has all four sections
      - SOLID principles have "Ask:" questions
      - Placeholders guide users on what to add

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [x] 3. Update tech-template.md to reference principles.md
  - File: src/templates/tech-template.md
  - Add note referencing principles.md for coding standards
  - Purpose: Direct users to principles.md for coding rules
  - _Leverage: src/templates/tech-template.md_
  - _Requirements: 6_
  - _Prompt: |
      Implement the task for spec discipline-workflow, first run spec-workflow-guide to get the workflow guide then implement the task:

      Role: Technical Writer

      Task: Update tech-template.md to add a note near the top: "For coding standards and principles, see principles.md".

      Restrictions:
      - Do not remove any existing content
      - Add the note in an appropriate location (e.g., after the title or in a new section)

      Success:
      - Reference to principles.md added
      - All existing content preserved

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [x] 4. Extract steering loader to shared module with selective loading
  - File: src/tools/workflow/steering-loader.ts (new), src/tools/workflow/spec-workflow-guide.ts
  - Extract to new steering-loader.ts with getSteeringDocs(projectPath, docs[]) signature
  - Support 'product', 'tech', 'structure', 'principles' doc types
  - Update spec-workflow-guide.ts to import and request all four docs
  - Purpose: Shared utility where each tool loads only the docs it needs
  - _Leverage: src/tools/workflow/spec-workflow-guide.ts getSteeringDocsContent()_
  - _Requirements: 3, 4, 6_
  - _Prompt: |
      Implement the task for spec discipline-workflow, first run spec-workflow-guide to get the workflow guide then implement the task:

      Role: TypeScript Developer

      Task: Extract steering doc loading to a shared module with selective loading:
      1. Create src/tools/workflow/steering-loader.ts
      2. Export getSteeringDocs(projectPath: string, docs: SteeringDocType[]) function
      3. SteeringDocType = 'product' | 'tech' | 'structure' | 'principles'
      4. Returns object with only requested docs (or null if steering dir missing)
      5. Update spec-workflow-guide.ts to import and call getSteeringDocs(path, ['product', 'tech', 'structure', 'principles'])

      Restrictions:
      - Only load docs that are requested
      - Graceful handling when individual docs don't exist
      - Keep backwards compatible behavior for spec-workflow-guide

      Success:
      - steering-loader.ts exports getSteeringDocs() with selective loading
      - Calling with ['tech', 'principles'] only reads those two files
      - spec-workflow-guide.ts works unchanged (requests all four)
      - Unit test verifies selective loading

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [x] 5. Create get-implementer-guide tool
  - File: src/tools/workflow/get-implementer-guide.ts
  - Define tool with inputSchema (no required args)
  - Handler returns guide based on discipline mode
  - Include TDD content from superpowers/test-driven-development (full mode only)
  - Include verification content from superpowers/verification-before-completion (all modes)
  - Include feedback handling from superpowers/receiving-code-review
  - Auto-import tech.md and principles.md content
  - Include search tool guidance
  - Fail fast if required steering docs missing
  - Purpose: Provide implementer agents with discipline-specific guidance
  - _Leverage: src/tools/workflow/spec-workflow-guide.ts for tool pattern, superpowers skills for content_
  - _Requirements: 3_
  - _Prompt: |
      Implement the task for spec discipline-workflow, first run spec-workflow-guide to get the workflow guide then implement the task:

      Role: TypeScript Developer specializing in MCP tools

      Task: Create get-implementer-guide MCP tool. Return discipline-specific guidance:
      - full mode: TDD rules + verification + feedback handling + steering docs
      - standard/minimal: verification + feedback handling + steering docs

      Copy and adapt content from superpowers skills, making it LLM-agnostic. Include search tool guidance for discovering patterns.

      Restrictions:
      - Follow existing tool pattern from spec-workflow-guide.ts
      - Fail with error if tech.md or principles.md missing
      - No Claude-specific language

      Success:
      - Tool returns different content based on SPEC_CONTEXT_DISCIPLINE
      - Steering doc content embedded in response
      - Error returned when required docs missing
      - Unit tests for each discipline mode

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 6. Create get-reviewer-guide tool
  - File: src/tools/workflow/get-reviewer-guide.ts
  - Define tool with inputSchema (no required args)
  - Handler returns review checklist and criteria
  - Include content from superpowers/requesting-code-review
  - Auto-import tech.md and principles.md content
  - Include search tool guidance for checking duplicates
  - Only active in full and standard modes
  - Fail fast if required steering docs missing
  - Purpose: Provide reviewer agents with review criteria
  - _Leverage: src/tools/workflow/spec-workflow-guide.ts for tool pattern, superpowers skills for content_
  - _Requirements: 4_
  - _Prompt: |
      Implement the task for spec discipline-workflow, first run spec-workflow-guide to get the workflow guide then implement the task:

      Role: TypeScript Developer specializing in MCP tools

      Task: Create get-reviewer-guide MCP tool. Return review checklist with:
      - Spec compliance checks
      - Code quality checks
      - Principles compliance checks
      - Severity levels (critical/important/minor)
      - Search guidance for checking duplicates

      Copy and adapt content from superpowers/requesting-code-review. Auto-import tech.md and principles.md.

      Restrictions:
      - Return error in minimal mode (reviews not active)
      - Fail with error if tech.md or principles.md missing
      - No Claude-specific language

      Success:
      - Tool returns review criteria with steering content
      - Error returned in minimal mode
      - Error returned when required docs missing
      - Unit tests cover all scenarios

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 7. Create get-brainstorm-guide tool
  - File: src/tools/workflow/get-brainstorm-guide.ts
  - Define tool with inputSchema (no required args)
  - Handler returns brainstorming methodology
  - Include content from superpowers/brainstorming skill
  - Do NOT include steering docs (orchestrator already has context)
  - Purpose: Provide brainstorming guidance for pre-spec ideation
  - _Leverage: src/tools/workflow/spec-workflow-guide.ts for tool pattern, superpowers/brainstorming for content_
  - _Requirements: 5_
  - _Prompt: |
      Implement the task for spec discipline-workflow, first run spec-workflow-guide to get the workflow guide then implement the task:

      Role: TypeScript Developer specializing in MCP tools

      Task: Create get-brainstorm-guide MCP tool. Return brainstorming methodology:
      - Question-driven exploration
      - Multiple choice preference
      - Present 2-3 options with trade-offs
      - When to proceed to formal spec

      Copy and adapt content from superpowers/brainstorming.

      Restrictions:
      - Do NOT include steering docs (internal use - orchestrator has context)
      - Do NOT include search guidance (orchestrator handles)
      - Keep methodology focused and concise

      Success:
      - Tool returns brainstorming methodology
      - No steering doc content in response
      - Unit tests verify content

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 8. Update spec-workflow-guide with brainstorm option and discipline
  - File: src/tools/workflow/spec-workflow-guide.ts
  - Add brainstorm option to workflow start
  - Include discipline mode in response
  - Update guide text to mention brainstorm choice
  - Add review workflow content for full/standard modes
  - Purpose: Orchestrator knows discipline mode and can offer brainstorm
  - _Leverage: src/tools/workflow/spec-workflow-guide.ts_
  - _Requirements: 8_
  - _Prompt: |
      Implement the task for spec discipline-workflow, first run spec-workflow-guide to get the workflow guide then implement the task:

      Role: TypeScript Developer

      Task: Update spec-workflow-guide to:
      1. Include discipline mode in response data
      2. Add workflow text: "Recap understanding, then ask: Clear enough for spec, or brainstorm first?"
      3. Add review workflow content for full/standard modes
      4. Include principles.md in steering docs

      Restrictions:
      - Don't break existing functionality
      - Keep backwards compatible

      Success:
      - Response includes disciplineMode field
      - Guide text mentions brainstorm option
      - Review workflow documented for applicable modes
      - Unit tests updated

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 9. Update steering-guide to include principles.md
  - File: src/tools/workflow/steering-guide.ts
  - Add Phase 4: Principles Document to workflow
  - Update workflow diagram
  - Add process steps for principles.md creation
  - Purpose: Enable creation of principles.md via steering workflow
  - _Leverage: src/tools/workflow/steering-guide.ts_
  - _Requirements: 6_
  - _Prompt: |
      Implement the task for spec discipline-workflow, first run spec-workflow-guide to get the workflow guide then implement the task:

      Role: TypeScript Developer

      Task: Update steering-guide to include principles.md as Phase 4:
      1. Add Phase 4 to workflow diagram (after structure.md)
      2. Add process steps for principles.md creation
      3. Update file structure section

      Restrictions:
      - Follow existing phase pattern exactly
      - Don't reorder existing phases

      Success:
      - Principles.md is Phase 4 in workflow
      - Diagram shows new phase
      - Process steps documented
      - Unit tests updated

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 10. Register new tools in index files
  - Files: src/tools/workflow/index.ts, src/tools/index.ts
  - Export get-implementer-guide, get-reviewer-guide, get-brainstorm-guide
  - Register tools in server tool list
  - Purpose: Make new tools available via MCP
  - _Leverage: src/tools/workflow/index.ts, src/tools/index.ts_
  - _Requirements: 3, 4, 5_
  - _Prompt: |
      Implement the task for spec discipline-workflow, first run spec-workflow-guide to get the workflow guide then implement the task:

      Role: TypeScript Developer

      Task: Register the three new guide tools:
      1. Export from src/tools/workflow/index.ts
      2. Add to tool registration in src/tools/index.ts

      Restrictions:
      - Follow existing export/registration patterns
      - Maintain alphabetical ordering if used

      Success:
      - All three tools exported from workflow/index.ts
      - All three tools registered in tools/index.ts
      - Server starts without errors

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 11. Update README with new configuration
  - File: README.md
  - Add SPEC_CONTEXT_DISCIPLINE to environment variables table
  - Add SPEC_CONTEXT_IMPLEMENTER, REVIEWER, BRAINSTORM to table
  - Document the three discipline modes
  - Add new tools to Tools table
  - Purpose: Document new features for users
  - _Leverage: README.md_
  - _Requirements: 1, 2, 3, 4, 5_
  - _Prompt: |
      Implement the task for spec discipline-workflow, first run spec-workflow-guide to get the workflow guide then implement the task:

      Role: Technical Writer

      Task: Update README.md:
      1. Add SPEC_CONTEXT_DISCIPLINE to env vars (default: full, options: full|standard|minimal)
      2. Add SPEC_CONTEXT_IMPLEMENTER/REVIEWER/BRAINSTORM to env vars
      3. Add brief explanation of discipline modes
      4. Add get-implementer-guide, get-reviewer-guide, get-brainstorm-guide to Tools table

      Restrictions:
      - Follow existing README format
      - Keep descriptions concise

      Success:
      - All new env vars documented
      - Discipline modes explained
      - New tools listed

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [ ] 12. Update .env.example with new environment variables
  - File: .env.example
  - Add SPEC_CONTEXT_DISCIPLINE with default value and comment
  - Add SPEC_CONTEXT_IMPLEMENTER, REVIEWER, BRAINSTORM with comments
  - Purpose: Provide template for new configuration options
  - _Leverage: .env.example_
  - _Requirements: 1, 2_
  - _Prompt: |
      Implement the task for spec discipline-workflow, first run spec-workflow-guide to get the workflow guide then implement the task:

      Role: DevOps/Configuration Specialist

      Task: Update .env.example with new environment variables:
      1. Add SPEC_CONTEXT_DISCIPLINE=full with comment explaining options (full|standard|minimal)
      2. Add commented-out SPEC_CONTEXT_IMPLEMENTER, SPEC_CONTEXT_REVIEWER, SPEC_CONTEXT_BRAINSTORM
      3. Add brief comments explaining each variable's purpose

      Restrictions:
      - Follow existing .env.example format
      - Use comments to explain, not inline documentation
      - Keep CLI vars commented out (optional config)

      Success:
      - All new env vars present in .env.example
      - Clear comments explain purpose and options
      - DISCIPLINE has default, CLI vars are commented

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_
