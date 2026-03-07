Here's a summary of what I see in this repository:

---

## Attractor — Repository Overview

This is a working implementation of the **Attractor** DOT-based AI pipeline runner, organized as a Node.js monorepo (`npm workspaces`).

### Structure

```
attractor/
├── attractor-spec/          # NLSpec markdown specs (the design docs)
│   ├── attractor-spec.md
│   ├── coding-agent-loop-spec.md
│   └── unified-llm-spec.md
├── packages/
│   ├── llm/                 # Unified LLM client (OpenRouter / Anthropic)
│   ├── agent/               # Coding agent loop (tools, profiles, events)
│   ├── attractor/           # Pipeline runner (parser, engine, handlers, history)
│   └── attractor-mcp/       # MCP server wrapper
├── pipelines/               # Pipeline .mts files (runnable examples)
│   └── example.mts          # Minimal 2-stage template
├── attractor-runs/          # Run output directories (checkpoints, logs)
├── frontend-test-pipeline.mts  # Example: wires a TCG app to a local Docker LLM
├── .env                     # OPENROUTER_API_KEY + ANTHROPIC_API_KEY
└── CLAUDE.md                # Guidance for coding agents in this repo
```

### Key Facts
- **Runtime:** TypeScript (`tsx` via `npx tsx`)
- **LLM backend:** OpenRouter (default model: `moonshotai/kimi-k2.5`) or Anthropic
- **Pipeline format:** Graphviz DOT digraphs — nodes are AI tasks, edges are transitions
- **Two prior runs** exist in `attractor-runs/`
- **API keys** are configured in `.env`

### What would you like to do?

Some natural starting points:
1. **Run a pipeline** — e.g. `npx tsx pipelines/example.mts` to see the system in action
2. **Write a new pipeline** — describe the workflow and I'll author the `.mts` file
3. **Explore the codebase** — dive into the engine, parser, agent loop, or LLM client
4. **Extend the system** — add a new node handler, tool, or provider

What's your goal?