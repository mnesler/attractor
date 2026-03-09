# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Attractor

A DOT-based AI pipeline runner. Pipelines are defined as Graphviz directed graphs where each node shape maps to a task type (LLM call, tool execution, human gate, conditional branch, parallel fan-out/fan-in). Runs are logged to SQLite and viewable via a web dashboard. LLM calls go through OpenRouter.

## Build & Test

```sh
go build -o attractor ./cmd/attractor/          # build binary
go test ./...                                     # run all tests
go test ./internal/parser/                        # run single package tests
go run ./cmd/attractor/ run examples/simple_research.dot  # run a pipeline
```

Requires Go 1.24+ and `OPENROUTER_API_KEY` env var (or in `.env`).

## Architecture

**Entry point**: `cmd/attractor/main.go` — Cobra CLI with commands: `run`, `serve`, `pipeline`, `models`.

**Core packages** (all under `internal/`):

- **parser** — Parses DOT graph syntax into `Graph` (nodes + edges). Node shape determines type: `Mdiamond`→start, `Msquare`→exit, `box`→codergen (LLM call), `diamond`→conditional, `hexagon`→wait.human, `component`→parallel, `tripleoctagon`→parallel.fan_in, `parallelogram`→tool, `house`→stack.manager_loop.
- **engine** — Executes a parsed `Graph`. Traverses depth-first from start node, dispatching to handlers. Manages retries with exponential backoff (200ms initial, 2x factor, 60s max). Produces a `RunLog` with per-node `NodeLog` entries.
- **handlers** — Pluggable `Handler` interface (`Execute → Outcome`). `Registry` maps `NodeType` → handler. Handlers: Start, Exit, Codergen (LLM), Conditional, WaitHuman, Parallel, FanIn, Tool (shell), ManagerLoop.
- **context** — Thread-safe KV store shared across a pipeline run. Supports `$goal` and `{{variable}}` prompt templating. `Clone()` for parallel branch isolation.
- **llm** — OpenRouter API client. `Complete()` for LLM calls, `GenerateDOT()` for natural-language→pipeline generation.
- **db** — SQLite persistence (WAL mode). Tables: `pipelines`, `runs`, `node_logs`. `Open()` auto-migrates.
- **config** — Loads from `.env` files and environment variables.

**Web layer** (`web/`): HTTP server with REST API (`/api/pipelines`, `/api/runs`, `/api/models`, `/api/stats`) and SPA dashboard (`web/static/index.html`).

## Key Types & Flow

1. `parser.Parse(dotString)` → `*Graph` (nodes map + edges slice)
2. `handlers.NewRegistry(llmClient, model)` → handler lookup
3. `engine.NewEngine(registry, logsDir).Run(ctx, graph, runID, pipelineID, model)` → `*RunLog`
4. Each handler returns `context.Outcome` with `Status`, `ContextUpdates`, `SuggestedNextIDs`

## Testing Patterns

- Helper functions: `mustParse()`, `nodeOf()`, `newTestEngine()`
- Table-driven tests for multiple scenarios
- `t.TempDir()` for DB isolation
- `NewRegistry(nil, "")` creates a registry with nil LLM client for simulation/testing

## Config Environment Variables

| Variable | Default |
|---|---|
| `OPENROUTER_API_KEY` | (required) |
| `ATTRACTOR_MODEL` | `openai/gpt-4o` |
| `ATTRACTOR_DB_PATH` | `~/.attractor/attractor.db` |
| `ATTRACTOR_LOGS_DIR` | `~/.attractor/logs` |
| `ATTRACTOR_WEB_HOST` | `localhost` |
| `ATTRACTOR_WEB_PORT` | `8080` |

## Specs

Detailed specifications live in the repo root: `attractor-spec.md`, `coding-agent-loop-spec.md`, `unified-llm-spec.md`.
