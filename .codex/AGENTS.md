# Aegis Trader - Instructions

## Steering Docs

Purpose: canonical context for product goals, architecture, and tech stack.

- `.spec-context/steering/product.md` (vision, goals, user needs)
- `.spec-context/steering/structure.md` (repo layout, major components)
- `.spec-context/steering/tech.md` (stack, tooling, constraints) - always loaded
- `.spec-context/steering/principles.md` (SOLID, design patterns, coding standards) - always loaded

## Spec Workflow

For new features or significant changes, call `spec-workflow-guide` MCP tool first and follow its output.

## Responsibilities

  - **YOU** are responsible for the quality of code you touch - never say "this can be revised later, so i will go on"
  - **YOU** are the final guardian against technical debt in your work
  - **YOUR** thoroughness prevents the "death by a thousand cuts" that degrades codebases over time

  **Note:** If you notice uncommitted changes in files you didn't modify, another developer is likely working on them.
  Leave those files alone.

Note: if you see changes in other files, it it probably another developer working on the project. **DO NOT EDIT OTHER'S WORK**

## Quick Reference

### Development

```bash
uv sync                           # Install dependencies
uv run aegis --help               # CLI help
uv run aegis train --help         # Training options
uv run aegis backtest --help      # Backtesting options
uv run aegis tune --help          # Hyperparameter tuning options
uv run aegis features --help      # Disable/Enable individual features
uv run pytest                     # Run tests
uv run mypy src/                  # Type checking
uv run ruff check src/            # Linting
uv run pre-commit run --all-files # All checks
```

## Servers

### Hetzner (Live Trading)
- **IP:** 46.224.203.242
- **User:** root
- **Purpose:** Live trading, Telegram bot
- **Code:** `/root/aegis-trader` (auto-syncs from GitHub on push)
- **Connect:** `ssh root@46.224.203.242`
