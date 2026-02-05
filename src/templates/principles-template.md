# Coding Principles

> For coding standards and principles, see principles.md

## Architecture Rules

[Define the architectural boundaries and rules for your project]

1. **[Rule Name]** — [Brief description]
   - [Detailed explanation of the rule]
   - Ask: "[Question to verify compliance]"

2. **[Rule Name]** — [Brief description]
   - [Detailed explanation of the rule]
   - Ask: "[Question to verify compliance]"

## Coding Standards

### SOLID Principles

1. **Single Responsibility (SRP)** — One class, one reason to change
   - Each class does exactly one job. If you're adding unrelated logic, create a new class.
   - Ask: "What is the single reason this class would need to change?"
   - Ask: "Can I describe this class's purpose without using 'and'?"

2. **Open/Closed (OCP)** — Extend behavior without modifying existing code
   - Add new implementations by creating new classes, not by editing existing ones.
   - If adding a feature requires touching multiple files, the abstraction is wrong.
   - Ask: "Can I add this behavior without changing existing code?"
   - Ask: "Am I editing a switch/if-else chain to add this?"

3. **Liskov Substitution (LSP)** — Implementations are interchangeable
   - Any implementation of an interface must work anywhere that interface is used.
   - Tests using mocks must behave identically to tests using real implementations.
   - Ask: "Would swapping this implementation break callers?"
   - Ask: "Does this implementation honor all contracts of the interface?"

4. **Interface Segregation (ISP)** — Small, focused interfaces
   - Split large interfaces into smaller ones. No class should implement methods it doesn't need.
   - If an implementation leaves methods empty or raises "not supported", the interface is too broad.
   - Ask: "Does this class use every method it's forced to implement?"
   - Ask: "Would a new implementation need to stub out methods?"

5. **Dependency Inversion (DIP)** — Depend on abstractions
   - Import interfaces, never concrete implementations.
   - All external I/O (network, files, databases) must go through an interface.
   - Ask: "Am I importing a concrete class or an interface?"
   - Ask: "Can I swap this dependency without changing this file?"

### Additional Standards

1. **KISS** — Simplest solution that works
   - No cleverness for its own sake. Boring code is good code.
   - Ask: "Is there a simpler way to do this?"
   - Ask: "Would a junior developer understand this immediately?"

2. **DRY** — Extract repeated logic
   - If you write the same logic twice, extract it.
   - Ask: "Have I written this pattern elsewhere in the codebase?"
   - Ask: "Would changing this require updating multiple places?"

3. **[Add project-specific standards]**
   - [Explanation]
   - Ask: "[Verification question]"

## Design Patterns

[List the design patterns preferred or required in this project]

1. **[Pattern Name]**: [When to use and brief description]

2. **[Pattern Name]**: [When to use and brief description]

3. **[Pattern Name]**: [When to use and brief description]

## Quality Gates

[Define the quality checks that must pass before code is accepted]

### Code Review Checklist

- [ ] Follows architecture rules defined above
- [ ] Adheres to SOLID principles
- [ ] No code duplication (DRY)
- [ ] Simple and readable (KISS)
- [ ] Tests written and passing
- [ ] [Add project-specific checks]

### Automated Checks

- [ ] Linting passes
- [ ] Type checking passes
- [ ] All tests pass
- [ ] [Add project-specific automated checks]
