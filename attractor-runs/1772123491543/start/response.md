All tests are passing across all packages. Here's a summary of what's in this repository:

## Attractor — DOT-based AI Pipeline Runner

This is a monorepo (`pnpm`/`npm` workspaces) with **4 packages**, all tests green:

| Package | Tests | Description |
|---|---|---|
| `@attractor/llm` | 98 ✅ | Unified LLM client — Anthropic + OpenRouter adapters, streaming, retries |
| `@attractor/agent` | 26 ✅ | Coding agent loop — session management, tool registry, environment abstraction |
| `@attractor/attractor` | 87 ✅ | DOT-based pipeline runner — parser, engine, handlers, history, lint |
| `@attractor/mcp` | — | MCP server exposing Attractor as tools (no tests yet) |

### Key architecture
```
Attractor pipeline engine (DOT graph)
    ↓ uses
Coding Agent Loop (session, tools, profiles)
    ↓ uses
Unified LLM Client (Anthropic / OpenRouter)
```

The system is **on the `open-router` branch**, and recent work has included:
- History tracking (model, provider, cost, tool breakdowns, token usage)
- Comment handling in the DOT parser
- A Docker MTG model pipeline

---

What would you like to work on?