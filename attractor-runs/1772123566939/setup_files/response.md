I now have a thorough understanding of the entire repository. Here's a comprehensive overview:

---

## Attractor — Full Repository Overview

This is a **working implementation** of the Attractor DOT-based AI pipeline runner, structured as a Node.js monorepo with four packages under `packages/`.

---

### Architecture (3-Layer Stack)

```
packages/attractor/   ← Pipeline runner (DOT DSL → execution engine)
      ↓ uses
packages/agent/       ← Agentic coding loop (LLM ↔ tools ↔ events)
      ↓ uses
packages/llm/         ← Unified LLM client (Anthropic + OpenRouter)
```

Plus:
- **`packages/attractor-mcp/`** — MCP server exposing Attractor as tools for Claude Code / OpenCode

---

### Package: `@attractor/llm`

**Unified multi-provider LLM client.**

| File | Role |
|------|------|
| `src/client.ts` | `Client` class — dispatches to named `ProviderAdapter` instances, supports middleware |
| `src/adapters/anthropic.ts` | Anthropic Messages API adapter |
| `src/adapters/openrouter.ts` | OpenRouter Chat Completions adapter (OpenAI-compatible) |
| `src/generate.ts` | High-level `generate()`, `streamGenerate()`, `generateObject()`, `executeAllTools()` |
| `src/retry.ts` | Configurable retry with exponential backoff |
| `src/sse.ts` | SSE stream parser |
| `src/types/` | `Message`, `Request`, `Response`, `StreamEvent`, `ToolCall`, `ToolResult`, `ModelId`, errors |

**98 tests passing.**

---

### Package: `@attractor/agent`

**Programmable agentic coding loop.**

| File | Role |
|------|------|
| `src/session.ts` | `Session` class — the core agentic loop; submit tasks, follow-up, async event generator |
| `src/profiles/base.ts` | `ProviderProfile` interface + `buildEnvironmentBlock()`, `discoverProjectDocs()` |
| `src/profiles/openrouter.ts` | `OpenRouterProfile` — OpenRouter-aligned profile, CORE_TOOLS, system prompt |
| `src/environment/interface.ts` | `ExecutionEnvironment` interface (abstraction layer) |
| `src/environment/local.ts` | `LocalExecutionEnvironment` — real filesystem/shell ops |
| `src/tools/core.ts` | CORE_TOOLS: `read_file`, `write_file`, `edit_file`, `shell`, `grep`, `glob` |
| `src/tools/registry.ts` | `ToolRegistry` — register + look up tool executors |
| `src/tools/truncate.ts` | Character-then-line truncation for tool output |
| `src/types/event.ts` | `SessionEvent` / `EventKind` enum (`TOOL_CALL_START`, `TOOL_CALL_END`, `ASSISTANT_TEXT_END`, `ERROR`, …) |
| `src/types/config.ts` | `SessionConfig` — `max_turns`, `max_depth`, output limits |
| `src/types/turn.ts` | `Turn` union: `UserTurn`, `AssistantTurn`, `ToolResultsTurn`, `SteeringTurn` |

Key session behaviours:
- **Loop detection** — detects repeated tool-call patterns over a sliding window
- **Subagents** — `spawn_agent`, `send_input`, `wait`, `close_agent` tools built in
- **Project doc loading** — auto-loads `AGENTS.md` + provider-specific files up to 32KB
- **Event streaming** — async generator yields `SessionEvent` for every meaningful action

**26 tests passing.**

---

### Package: `@attractor/attractor`

**The pipeline execution engine.**

#### Parser (`src/parser/dot.ts`)
- Hand-written tokenizer + recursive-descent parser for a strict DOT subset
- Supports: `digraph`, node attrs, edge attrs, chained edges (`A -> B -> C`), `node`/`edge` defaults, `subgraph cluster_*`, `//` and `/* */` comments (also inside quoted strings), `Duration` tokens (`900s`, `15m`, `2h`, etc.)

#### Graph Types (`src/types/graph.ts`)
- `Node`, `Edge`, `Graph`, `NodeAttrs`, `EdgeAttrs`
- `SHAPE_TO_HANDLER_TYPE` — maps Graphviz shapes to handler type strings
- `createGraph()` / `addEdge()` — maintain outgoing/incoming edge indices

#### Node Handler Types (by shape)
| Shape | Handler |
|-------|---------|
| `Mdiamond` | `start` |
| `Msquare` | `exit` |
| `box` | `codergen` (LLM task) |
| `hexagon` | `wait.human` |
| `diamond` | `conditional` |
| `component` | `parallel` |
| `tripleoctagon` | `parallel.fan_in` |
| `parallelogram` | `tool` (shell) |
| `house` | `stack.manager_loop` |

#### Engine (`src/engine/runner.ts`)
`Runner` class — the heart of Attractor:
- Accepts a DOT string + `RunnerConfig`; parses → transforms → validates → executes
- **Auto-creates** `AgentBackend` from `api_key` shortcut
- Traverses the graph from `start` to `exit`, calling each node's handler
- **Edge selection** — 5-step priority: condition match → preferred label → suggested next IDs → unconditional edges (by weight/lexical) → any edge
- **Retry logic** — respects `max_retries`, `retry_target`, `fallback_retry_target` at node and graph level; exponential backoff with jitter
- **Checkpointing** — saves `checkpoint.json` after each node; resumes from `resume_checkpoint`
- **Parallel execution** — fan-out via `ParallelHandler`, fan-in via `FanInHandler`
- **Goal gates** — nodes with `goal_gate=true` fail the entire pipeline if they don't succeed
- **Events** — emits `PipelineEvent` stream (`pipeline_started/completed/failed`, `stage_started/completed/failed/retrying`, `checkpoint_saved`, `parallel_*`, `interview_*`)

#### Other Handlers
- **`ConditionalHandler`** — evaluates outgoing edge conditions to pick a branch
- **`WaitHumanHandler`** — presents choices via `Interviewer`, blocks until human picks
- **`ToolHandler`** — runs a shell command (`tool_command` attr), captures stdout
- **`ManagerLoopHandler`** — supervisor polling loop with configurable `stop_condition`, `max_cycles`, `poll_interval`
- **`ParallelHandler`** + **`FanInHandler`** — concurrent branch execution with `join_policy`, `error_policy`, `max_parallel`

#### Condition Language (`src/conditions/eval.ts`)
- Grammar: `outcome=success && context.key=value`
- Keys: `outcome`, `preferred_label`, `context.<path>`
- Operators: `=`, `!=`; bare keys are truthy checks

#### Stylesheet (`src/stylesheet/parser.ts` + `src/transforms/index.ts`)
- CSS-like `model_stylesheet` attribute on graphs: `* { llm_model: claude-opus-4-6; }` / `#nodeId { ... }` / `.class { ... }`
- Applied via `stylesheetApplicationTransform` — fills in `llm_model`, `llm_provider`, `reasoning_effort` on nodes
- `variableExpansionTransform` — expands `$goal` in prompts

#### Linting (`src/lint/index.ts`)
13 built-in lint rules covering: start/exit node presence, reachability, edge target existence, start has no incoming, exit has no outgoing, condition syntax, stylesheet syntax, known handler types, valid fidelity values, retry target existence, goal gate has retry, LLM nodes have prompt.

#### History (`src/history/`)
- `PipelineRecorder` — hooks `on_event` + `on_agent_event`, builds a `PipelineRun` record, appends to `runs.jsonl`
- Tracks per-stage: model, provider, tool calls, `tool_breakdown`, LLM round-trips, token counts (input/output/total), estimated cost in USD
- `readHistory()`, `findRuns()`, `getLatestRun()`, `getRunById()`, `summarise()` for querying

#### Interviewer (`src/interviewer/index.ts`)
Five implementations: `AutoApproveInterviewer`, `ConsoleInterviewer`, `CallbackInterviewer`, `QueueInterviewer`, `RecordingInterviewer`

**87 tests passing** across parser, engine, lint, conditions, stylesheet, history, interviewer.

---

### Package: `packages/attractor-mcp/`

MCP server exposing three tools:
- `run_pipeline` — run a DOT pipeline from source text
- `validate_pipeline` — lint/validate DOT source, return diagnostics
- `load_pipeline` — run from a `.dot` file path

Configured via env vars: `OPENROUTER_API_KEY`, `ATTRACTOR_MCP_PORT` (default 3001), `ATTRACTOR_MODEL`.

---

### Key Files at Repo Root

| File | Purpose |
|------|---------|
| `.env` | API keys (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`) |
| `pipelines/example.mts` | Minimal runnable pipeline example using `Runner` + `PipelineRecorder` with colored console output |
| `pipelines/README.md` | How to run pipelines with `tsx` |
| `CLAUDE.md` | Guidance for Claude Code: describes the repo as spec-only (outdated — it's now fully implemented) |
| `attractor-spec/` | Original NLSpec markdown documents the code was built from |

---

### Test Status (all green ✅)
| Package | Tests |
|---------|-------|
| `@attractor/llm` | 98 passing |
| `@attractor/agent` | 26 passing |
| `@attractor/attractor` | 87 passing |
| **Total** | **211 passing** |

---

What would you like to work on? I'm ready to build new pipeline stages, extend the engine, add new handler types, fix bugs, or work on any other part of the system.