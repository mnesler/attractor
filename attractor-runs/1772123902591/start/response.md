Here's an overview of what I'm working with:

---

## Attractor — Codebase Overview

This is a **monorepo** implementing the Attractor DOT-based AI workflow pipeline runner. Here's the current state:

### Packages
| Package | Purpose |
|---------|---------|
| `@attractor/llm` | Unified LLM client — Anthropic & OpenRouter adapters, streaming, retry |
| `@attractor/agent` | Coding Agent Loop — agentic loop, tools, execution environments, profiles |
| `@attractor/attractor` | Pipeline runner — DOT parser, graph engine, node handlers, history, linting |
| `@attractor/attractor-mcp` | MCP server wrapper |

### Key Source Files
- **`packages/llm/src/`** — `client.ts`, `adapters/anthropic.ts`, `adapters/openrouter.ts`, `generate.ts`
- **`packages/agent/src/`** — `session.ts`, `tools/core.ts`, `profiles/openrouter.ts`, `environment/local.ts`
- **`packages/attractor/src/`** — `engine/runner.ts`, `parser/dot.ts`, `handlers/`, `history/`, `lint/`

### Pipeline Examples
- `pipelines/example.mts` — example pipeline
- `pipelines/test-and-fix.mts` — test-and-fix pipeline

### Current Branch
`open-router` — recent work includes OpenRouter support, history tracking (model/provider/cost/tool metrics), comment handling in the DOT parser, and a Docker MTG model pipeline.

---

What would you like to work on?