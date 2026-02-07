# Aegis Trader - Coding Principles

## SOLID Principles

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
   - Ask: "Am I using `isinstance` to decide behavior?" (If yes, the abstraction is leaking)
   - Ask: "Am I casting/downcasting to a concrete type?" (If yes, the interface is incomplete)

4. **Interface Segregation (ISP)** — Small, focused interfaces
   - Split large interfaces into smaller ones. No class should implement methods it doesn't need.
   - If an implementation leaves methods empty or raises "not supported", the interface is too broad.
   - Ask: "Does this class use every method it's forced to implement?"
   - Ask: "Would a new implementation need to stub out methods?"

5. **Dependency Inversion (DIP)** — Depend on abstractions
   - Import interfaces, never concrete implementations.
   - All external I/O (network, files, databases) must go through an interface.
   - Wire implementations to abstractions in the DI container, nowhere else.
   - Ask: "Am I importing a concrete class or an interface?"
   - Ask: "Can I swap this dependency without changing this file?"

## Additional Principles

1. **No Defensive Garbage** — Let bugs surface, don't hide them
   - No fallbacks for impossible cases. No `else` branches "just in case."
   - Trust your contracts - if something shouldn't happen, let it fail loud.
   - Ask: "Am I adding a fallback that hides bugs instead of surfacing them?"
   - Ask: "Is this try/catch swallowing errors silently?"
   - Ask: "Am I writing `if x is not None` everywhere instead of fixing the source?"
   - Ask: "Does this 'safe' default make debugging impossible?"
   - Ask: "Is this a dead branch that never executes but adds cognitive load?"

2. **KISS** — Simplest solution that works
   - No cleverness for its own sake. Boring code is good code.
   - Ask: "Is there a simpler way to do this?"
   - Ask: "Would a junior developer understand this immediately?"

3. **Domain is Pure** — No I/O in domain layer
   - The `domain/` layer contains only entities, value objects, and business logic.
   - Ask: "Does this domain code import anything from infrastructure?"
   - Ask: "Does this domain code do any I/O (network, files, database)?"

4. **DRY** — Extract repeated logic
   - If you write the same logic twice, extract it.
   - Ask: "Have I written this pattern elsewhere in the codebase?"
   - Ask: "Would changing this require updating multiple places?"

5. **Composition over Inheritance** — Combine behaviors, don't extend them
   - Use decorators, aggregators, and delegation instead of class hierarchies.
   - Ask: "Am I inheriting just to reuse code?" (Use composition instead)
   - Ask: "Is this class hierarchy deeper than 2 levels?"

6. **Async Everything** — All I/O uses async/await
   - No blocking calls in async code paths.
   - Ask: "Is this I/O operation blocking the event loop?"

7. **Event-Driven** — Decouple via events
   - Cross-component communication goes through `IEventBus`.
   - Ask: "Am I directly calling another component that doesn't need to know about me?"

8. **Make Invalid States Unrepresentable** — Model choices, not flag combinations
   - Prefer a single enum/union over multiple booleans.
   - Prefer table-driven dispatch over nested `if/elif`.
   - Ask: "Can this be expressed as one enum instead of multiple flags?"
   - Ask: "Would adding a new variant require editing multiple conditionals?"
   - Ask: "Is control flow compensating for a missing type/state model?"

9. **Tell, Don't Ask** — Move decisions to the object that owns the data
   - Prefer `object.do()` over `if object.is_x(): ...`.
   - Push branching into polymorphic implementations (strategy).
   - Ask: "Am I inspecting state to choose behavior instead of delegating?"

## Design Patterns

1. **Fluent Interface**: For configuring objects with optional fields
3. **Strategy Pattern**: Swappable algorithms via interfaces
4. **Result Pattern** (Rust): Explicit error handling `Result<T, E>`
5. **Replace Conditional with Polymorphism**: Move branching logic behind an interface; avoid type checks in callers
