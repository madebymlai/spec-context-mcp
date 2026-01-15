# Issue: Spec-workflow integration

## Summary

Integrate the 5 spec-workflow tools and 7 prompts from spec-workflow-mcp after Phase 1 (code search) is working.

## Context

The two source repos have different assumptions about project structure:

- **claude-context**: Expects a codebase path, indexes files, stores in vector DB
- **spec-workflow-mcp**: Expects `.spec-workflow/` directory with specs, approvals, templates

These need to work together seamlessly.

## Tasks

- [ ] Copy workflow core files from spec-workflow-mcp
- [ ] Copy 5 workflow tools
- [ ] Copy 7 prompts
- [ ] Adapt import paths to new structure
- [ ] Test tool handlers with real project
- [ ] Ensure `.spec-workflow/` initialization works
- [ ] Test approval workflow
- [ ] Test implementation logging

## Potential Issues

1. **Project path handling** - Both systems need to agree on what "project" means
2. **Template bundling** - Templates need to be bundled with the npm package
3. **Dashboard removal** - spec-workflow has dashboard code that we're not copying - ensure no broken imports
4. **Global directory** - spec-workflow uses a global dir for cross-project state - may need adjustment

## Dependencies

- Phase 1 complete (code search working)
- Qdrant adapter working
- OpenRouter embeddings working

## Files to Copy

```
src/tools/workflow/
├── spec-workflow-guide.ts
├── steering-guide.ts
├── spec-status.ts
├── approvals.ts
└── log-implementation.ts

src/prompts/
├── index.ts
├── types.ts
├── create-spec.ts
├── create-steering-doc.ts
├── implement-task.ts
├── inject-spec-workflow-guide.ts
├── inject-steering-guide.ts
├── refresh-tasks.ts
└── spec-status.ts

src/workflow/
├── parser.ts
├── task-parser.ts
├── task-validator.ts
├── path-utils.ts
├── workspace-initializer.ts
├── global-dir.ts
├── archive-service.ts
├── project-registry.ts
├── security-utils.ts
└── implementation-log-migrator.ts

templates/
├── requirements-template.md
├── design-template.md
├── tasks-template.md
├── product-template.md
├── tech-template.md
└── structure-template.md
```

## Priority

Medium - After Phase 1 is complete
